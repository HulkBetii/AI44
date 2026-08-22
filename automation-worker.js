const path = require('path');
const { spawn } = require('child_process');
const { acquireAutomationLock } = require('./automation-lock');
const signup = require('./signup-hotmail');
const sheets = require('./sheets');

let releaseLock = null;
let running = false;
let errorCount = 0;
let cancelRequested = false;
let finishing = false;

const FULL_CYCLE_PHASES = [
  { phaseId: 'signup', workflowId: 'signup', modeArgs: [], dynamic: false },
  { phaseId: 'resume-1', workflowId: 'resume', modeArgs: ['--resume'], dynamic: true },
  { phaseId: 'reset-password', workflowId: 'resetPassword', modeArgs: ['--reset-password'], dynamic: true },
  { phaseId: 'resume-2', workflowId: 'resume', modeArgs: ['--resume'], dynamic: true },
];

function send(message) {
  if (process.send) process.send(message);
}

const reporter = {
  emit(event) {
    if (event.type === 'account.failed') errorCount++;
    send({ kind: 'event', event });
  },
};

function proxyArgs(request) {
  if (request.options.proxyMode === 'none') return ['--no-proxy'];
  if (request.options.proxyMode === 'override') return [`--proxy-token=${request.options.proxyTokenOverride}`];
  return [];
}

function isEligibleForWorkflow(row, workflowId) {
  const status = String(row.status || '').trim().toLowerCase();
  const hasPassword = Boolean(row.elevenPass);
  const hasKey = Boolean(row.apiKey);
  if (['inactive', 'need to recover password'].includes(status) || hasKey) return false;
  if (workflowId === 'signup') return status === 'pending' && !hasPassword;
  if (workflowId === 'resume') {
    return status !== 'complete'
      && hasPassword
      && !['credentials-rejected', 'already-registered'].includes(status);
  }
  if (workflowId === 'resetPassword') {
    return ['credentials-rejected', 'already-registered'].includes(status);
  }
  return false;
}

async function runFullCycle(originalRows, request) {
  await sheets.initSheets();
  const originalScope = new Set(originalRows);
  for (const phase of FULL_CYCLE_PHASES) {
    if (cancelRequested) throw new Error('Job cancelled');
    const eligibleRows = (await sheets.loadRows())
      .filter((row) => originalScope.has(row.rowIndex) && isEligibleForWorkflow(row, phase.workflowId))
      .map((row) => row.rowIndex);
    reporter.emit({
      type: 'phase.started',
      level: 'info',
      message: `Bắt đầu phase ${phase.phaseId}: ${eligibleRows.length}/${originalRows.length} account hợp lệ`,
      data: {
        phaseId: phase.phaseId,
        workflowId: phase.workflowId,
        currentEligible: eligibleRows.length,
        maxAccounts: originalRows.length,
        dynamic: phase.dynamic,
      },
    });
    await runRows(eligibleRows, phase.modeArgs, request);
    reporter.emit({
      type: 'phase.completed',
      level: 'info',
      message: `Hoàn thành phase ${phase.phaseId}`,
      data: {
        phaseId: phase.phaseId,
        workflowId: phase.workflowId,
        processedAccounts: eligibleRows.length,
      },
    });
  }
}

async function runRows(rows, modeArgs, request) {
  for (let index = 0; index < rows.length; index++) {
    if (cancelRequested) throw new Error('Job cancelled');
    const rowIndex = rows[index];
    await signup.run([
      ...modeArgs,
      `--row=${rowIndex}`,
      '--limit=1',
      `--interval=${request.options.intervalMinutes}`,
      ...proxyArgs(request),
    ], reporter);
    if (index < rows.length - 1) await waitForNextAccount(request.options.intervalMinutes);
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

async function runProxyCheck(request) {
  const child = spawn(process.execPath, [path.join(__dirname, 'check-proxy.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      MAIL_TEMP_LOCK_HELD: '1',
      ...(request.options.proxyMode === 'override' ? { MAIL_TEMP_PROXY_TOKEN_OVERRIDE: request.options.proxyTokenOverride } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`Proxy diagnostic exited with code ${code}`);
}

async function execute(request, acceptedRows) {
  const common = { ...request };
  switch (request.workflowId) {
    case 'signup':
      await runRows(acceptedRows, [], common);
      break;
    case 'resume':
      await runRows(acceptedRows, ['--resume'], common);
      break;
    case 'resetPassword':
      await runRows(acceptedRows, ['--reset-password'], common);
      break;
    case 'regenerateKey':
      for (let index = 0; index < acceptedRows.length; index++) {
        if (cancelRequested) throw new Error('Job cancelled');
        const rowIndex = acceptedRows[index];
        await signup.run([
          '--regenerate-key',
          `--rows=${rowIndex}`,
          `--interval=${request.options.intervalMinutes}`,
          ...proxyArgs(request),
        ], reporter);
        if (index < acceptedRows.length - 1) await waitForNextAccount(request.options.intervalMinutes);
      }
      break;
    case 'retryPending':
      await sheets.initSheets();
      for (const rowIndex of acceptedRows) await sheets.updateStatus(rowIndex, 'pending');
      await runRows(acceptedRows, [], common);
      break;
    case 'fullCycle':
      await runFullCycle(acceptedRows, common);
      break;
    case 'proxyCheck':
      await runProxyCheck(request);
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
      await signup.cancelActiveRun();
      if (releaseLock) releaseLock();
      send({ kind: 'cancelled' });
      process.exit(130);
    } catch (error) {
      send({ kind: 'cleanup-failed', error: error.message });
      process.exit(1);
    }
  }

  if (message.kind !== 'start' || running) return;
  running = true;
  try {
    releaseLock = acquireAutomationLock(`ui-job:${message.jobId}`);
    process.env.MAIL_TEMP_LOCK_HELD = '1';
    await execute(message.request, message.acceptedRows);
    send({ kind: 'completed', errorCount });
    process.exitCode = 0;
  } catch (error) {
    send({ kind: 'fatal', error: error.stack || error.message, errorCount });
    process.exitCode = 1;
  } finally {
    finishing = true;
    await signup.releaseProfile().catch((error) => {
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
  await signup.cancelActiveRun().catch(() => { process.exitCode = 1; });
  if (releaseLock) releaseLock();
  process.exit(130);
});

module.exports = { FULL_CYCLE_PHASES, isEligibleForWorkflow };
