const path = require('path');
const { spawn } = require('child_process');
const { acquireAutomationLock } = require('./automation-lock');
const signup = require('./signup-hotmail');
const sheets = require('./sheets');
const { loadRuntimeConfig, resolveProxyConfig } = require('./runtime-config');
const { FULL_CYCLE_PHASES, isEligibleForWorkflow } = require('./workflow-policy');
const { GPM_CREATE_UNCERTAIN } = require('./gpm-api');

let releaseLock = null;
let running = false;
let errorCount = 0;
let cancelRequested = false;
let finishing = false;
let proxyCheckChild = null;
let cleanupFailureReported = false;

function send(message) {
  if (process.send) process.send(message);
}

const reporter = {
  emit(event) {
    if (event.type === 'account.failed') errorCount++;
    send({ kind: 'event', event });
  },
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateAcceptedAccounts(accounts, workflowId) {
  if (workflowId === 'proxyCheck') return [];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Worker requires acceptedAccounts with stable row and email identity');
  }
  const normalizedEmails = new Set();
  return accounts.map((account) => {
    const rowIndex = Number(account?.rowIndex);
    const email = String(account?.email || '').trim();
    if (!Number.isInteger(rowIndex) || rowIndex < 2 || !email) {
      throw new Error('Worker received an invalid accepted account identity');
    }
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmails.has(normalizedEmail)) {
      throw new Error(`Worker received duplicate accepted account identity: ${email}`);
    }
    normalizedEmails.add(normalizedEmail);
    return { rowIndex, email };
  });
}

function findAccountByEmail(rows, account) {
  const matches = rows.filter((row) => normalizeEmail(row.email) === normalizeEmail(account.email));
  if (matches.length !== 1) {
    throw new Error(`Account identity changed for ${account.email}: found ${matches.length} matching Sheet rows`);
  }
  return { rowIndex: matches[0].rowIndex, email: matches[0].email, row: matches[0] };
}

function assertWorkflowEligible(row, workflowId, { explicitReset = false } = {}) {
  if (!isEligibleForWorkflow(row, workflowId, { explicitReset })) {
    throw new Error(`Account ${row.email} is no longer eligible for ${workflowId}`);
  }
}

function assertFullCycleProcessed(processedAccounts) {
  if (processedAccounts === 0) {
    throw new Error('Full cycle completed without processing any account');
  }
}

async function resolveCurrentAccount(account, workflowId, eligibilityOptions) {
  const current = findAccountByEmail(await sheets.loadRows(), account);
  if (workflowId) assertWorkflowEligible(current.row, workflowId, eligibilityOptions);
  return current;
}

function assertAccountProcessed(result, email) {
  if (result?.processedAccounts !== 1) {
    throw new Error(`Workflow completed without processing ${email}`);
  }
}

function isExplicitResetRequest(request) {
  return request.selection?.mode !== 'allEligible';
}

async function runFullCycle(originalAccounts, request) {
  const initialRows = await sheets.loadRows();
  const initialAccounts = originalAccounts.map((account) => findAccountByEmail(initialRows, account));
  const hasEligiblePhase = initialAccounts.some(({ row }) =>
    FULL_CYCLE_PHASES.some((phase) => isEligibleForWorkflow(row, phase.workflowId)));
  if (!hasEligiblePhase) throw new Error('Full cycle has no currently eligible automated phase');

  let processedAccounts = 0;
  for (const phase of FULL_CYCLE_PHASES) {
    if (cancelRequested) throw new Error('Job cancelled');
    const phaseRows = await sheets.loadRows();
    const currentAccounts = originalAccounts.map(
      (account) => findAccountByEmail(phaseRows, account),
    );
    const eligibleAccounts = currentAccounts
      .filter(({ row }) => isEligibleForWorkflow(row, phase.workflowId))
      .map(({ rowIndex, email }) => ({ rowIndex, email }));
    reporter.emit({
      type: 'phase.started',
      level: 'info',
      message: `Bắt đầu phase ${phase.phaseId}: ${eligibleAccounts.length}/${originalAccounts.length} account hợp lệ`,
      data: {
        phaseId: phase.phaseId,
        workflowId: phase.workflowId,
        currentEligible: eligibleAccounts.length,
        maxAccounts: originalAccounts.length,
        dynamic: phase.dynamic,
      },
    });
    await runRows(eligibleAccounts, phase.modeArgs, request, {
      workflowId: phase.workflowId,
      explicitReset: false,
    });
    processedAccounts += eligibleAccounts.length;
    reporter.emit({
      type: 'phase.completed',
      level: 'info',
      message: `Hoàn thành phase ${phase.phaseId}`,
      data: {
        phaseId: phase.phaseId,
        workflowId: phase.workflowId,
        processedAccounts: eligibleAccounts.length,
      },
    });
  }
  assertFullCycleProcessed(processedAccounts);
}

async function runRows(accounts, modeArgs, request, {
  regenerateKey = false,
  workflowId = regenerateKey ? 'regenerateKey' : 'signup',
  explicitReset = false,
} = {}) {
  for (let index = 0; index < accounts.length; index++) {
    if (cancelRequested) throw new Error('Job cancelled');
    const current = await resolveCurrentAccount(accounts[index], workflowId, { explicitReset });
    const mode = regenerateKey
      ? ['--regenerate-key', `--rows=${current.rowIndex}`]
      : [...modeArgs, `--row=${current.rowIndex}`, '--limit=1'];
    const result = await signup.run([
      ...mode,
      `--expected-email=${current.email}`,
      `--interval=${request.options.intervalMinutes}`,
      ...(request.options.noProxy ? ['--no-proxy'] : []),
    ], reporter, { explicitReset });
    assertAccountProcessed(result, current.email);
    if (index < accounts.length - 1) await waitForNextAccount(request.options.intervalMinutes);
  }
}

function waitForNextAccount(avgMinutes) {
  const meanMs = avgMinutes * 60 * 1000;
  const delayMs = Math.min(Math.max(1000, -Math.log(1 - Math.random()) * meanMs), meanMs * 3);
  send({ kind: 'event', event: { type: 'step.changed', level: 'info', message: `Đợi ${Math.round(delayMs / 1000)} giây trước account tiếp theo`, data: { step: 'inter-account delay', delayMs } } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const poll = setInterval(() => {
      if (!cancelRequested) return;
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error('Job cancelled'));
    }, 250);
    timer.unref?.();
    setTimeout(() => clearInterval(poll), delayMs + 100).unref?.();
  });
}

async function runProxyCheck() {
  const env = { ...process.env };
  delete env.MAIL_TEMP_LOCK_HELD;
  if (releaseLock?.token) env.MAIL_TEMP_LOCK_TOKEN = releaseLock.token;
  const child = spawn(process.execPath, [path.join(__dirname, 'check-proxy.js')], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxyCheckChild = child;
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw new Error(`Proxy diagnostic exited with code ${code}`);
  } finally {
    if (proxyCheckChild === child) proxyCheckChild = null;
  }
}

async function terminateChild(child, {
  forceAfterMs = 5000,
  failAfterMs = 15000,
  onUnresolved = () => {},
} = {}) {
  await new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), forceAfterMs);
    const failureTimer = setTimeout(() => {
      try {
        onUnresolved(new Error('Proxy diagnostic did not close after forced termination'));
      } catch {}
    }, failAfterMs);
    child.once('close', () => {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      resolve();
    });
    try {
      child.kill();
    } catch (error) {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      reject(error);
    }
  });
}

async function cancelProxyCheck() {
  const child = proxyCheckChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await terminateChild(child, {
    onUnresolved(error) {
      if (cleanupFailureReported) return;
      cleanupFailureReported = true;
      send({ kind: 'cleanup-failed', error: error.message });
    },
  });
  if (proxyCheckChild === child) proxyCheckChild = null;
}

function preserveLockOnCleanupFailure(lockRelease) {
  lockRelease?.preserve?.();
}

async function execute(request, acceptedAccounts) {
  resolveProxyConfig(loadRuntimeConfig(), { required: request.workflowId === 'proxyCheck' });
  if (request.workflowId !== 'proxyCheck') await sheets.initSheets();

  switch (request.workflowId) {
    case 'signup':
      await runRows(acceptedAccounts, [], request, { workflowId: 'signup' });
      break;
    case 'resume':
      await runRows(acceptedAccounts, ['--resume'], request, { workflowId: 'resume' });
      break;
    case 'resetPassword':
      await runRows(acceptedAccounts, ['--reset-password'], request, {
        workflowId: 'resetPassword',
        explicitReset: isExplicitResetRequest(request),
      });
      break;
    case 'regenerateKey':
      await runRows(acceptedAccounts, [], request, { regenerateKey: true, workflowId: 'regenerateKey' });
      break;
    case 'retryPending':
      for (const account of acceptedAccounts) {
        const current = await resolveCurrentAccount(account, 'retryPending');
        await sheets.updateStatusByEmail(current.email, 'pending');
      }
      await runRows(acceptedAccounts, [], request, { workflowId: 'signup' });
      break;
    case 'fullCycle':
      await runFullCycle(acceptedAccounts, request);
      break;
    case 'proxyCheck':
      await runProxyCheck();
      break;
    default:
      throw new Error(`Unsupported workflow: ${request.workflowId}`);
  }
}

process.on('message', async (message) => {
  if (message.kind === 'focus') {
    const focused = await signup.focusActiveBrowser().catch(() => false);
    send({ kind: 'focus-result', focused });
    return;
  }

  if (message.kind === 'cancel') {
    cancelRequested = true;
    try {
      await Promise.all([signup.cancelActiveRun(), cancelProxyCheck()]);
      if (releaseLock) releaseLock();
      if (!cleanupFailureReported) {
        send({ kind: 'cancelled' });
        process.exit(130);
      }
      process.exit(1);
    } catch (error) {
      preserveLockOnCleanupFailure(releaseLock);
      send({ kind: 'cleanup-failed', error: error.message });
      process.exit(1);
    }
  }

  if (message.kind !== 'start' || running) return;
  running = true;
  try {
    releaseLock = acquireAutomationLock(`ui-job:${message.jobId}`);
    delete process.env.MAIL_TEMP_LOCK_HELD;
    process.env.MAIL_TEMP_LOCK_TOKEN = releaseLock.token;
    const accounts = validateAcceptedAccounts(message.acceptedAccounts, message.request.workflowId);
    await execute(message.request, accounts);
    send({ kind: 'completed', errorCount });
    process.exitCode = 0;
  } catch (error) {
    if (error?.preserveAutomationLock) preserveLockOnCleanupFailure(releaseLock);
    send({
      kind: error.code === GPM_CREATE_UNCERTAIN ? 'cleanup-failed' : 'fatal',
      error: error.stack || error.message,
      errorCount,
    });
    process.exitCode = 1;
  } finally {
    finishing = true;
    await signup.releaseProfile().catch((error) => {
      preserveLockOnCleanupFailure(releaseLock);
      send({ kind: 'cleanup-failed', error: error.message });
      process.exitCode = 1;
    });
    if (releaseLock) releaseLock();
    if (process.connected) process.disconnect();
    setImmediate(() => process.exit(process.exitCode || 0));
  }
});

process.on('disconnect', async () => {
  if (!running || finishing) return;
  cancelRequested = true;
  try {
    await Promise.all([signup.cancelActiveRun(), cancelProxyCheck()]);
    if (releaseLock) releaseLock();
    process.exit(130);
  } catch {
    preserveLockOnCleanupFailure(releaseLock);
    process.exit(1);
  }
});

module.exports = {
  FULL_CYCLE_PHASES,
  assertAccountProcessed,
  assertFullCycleProcessed,
  assertWorkflowEligible,
  cancelProxyCheck,
  findAccountByEmail,
  isEligibleForWorkflow,
  isExplicitResetRequest,
  preserveLockOnCleanupFailure,
  runFullCycle,
  runRows,
  terminateChild,
  validateAcceptedAccounts,
};
