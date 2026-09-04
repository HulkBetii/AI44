/**
 * index.js (catch-all-signup)
 * High-Throughput Entry point and Multi-Worker execution loop for Catch-All ElevenLabs registration.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const gpm = require('../gpm-api');
const { withAutomationLock } = require('../automation-lock');
const { getNewProxyWithRetry, getNewTinProxyWithRetry } = require('../proxy');
const { poissonIntervalDelay } = require('../human-behavior');
const { loadRuntimeConfig, resolveProxyConfig } = require('../runtime-config');

const { loadCatchAllConfig } = require('./config');
const {
  initSignupSheets,
  ensureHeaderRow,
  loadRows,
  loadPendingAccounts,
  appendAccountsToSheet,
  resetRows,
} = require('./sheets');
const { generateBatch } = require('./email-generator');
const { registerAccount } = require('./elevenlabs-signup');

const KEYS_TXT = path.join(__dirname, '..', 'keys.txt');
const SUCCESS_CSV = path.join(__dirname, '..', 'success_accounts.csv');
const Q = String.fromCharCode(34);

// Active worker session tracking for clean shutdown
const activeWorkerSessions = new Map();
let cancellationRequested = false;

function csvCell(value) {
  return Q + String(value ?? '').split(Q).join(Q + Q) + Q;
}

function appendSuccessRecord(email, password, apiKey, proxyString) {
  if (!apiKey) return;
  try {
    const csvExists = fs.existsSync(SUCCESS_CSV);
    if (!csvExists || fs.statSync(SUCCESS_CSV).size === 0) {
      fs.writeFileSync(
        SUCCESS_CSV,
        'Timestamp,Email,Password,APIKey,Proxy\n',
        'utf8'
      );
    }

    const line = [
      new Date().toISOString(),
      email,
      password,
      apiKey,
      proxyString,
    ].map(csvCell).join(',') + '\n';
    fs.appendFileSync(SUCCESS_CSV, line, 'utf8');

    // Append to keys.txt
    let keyContent = '';
    if (fs.existsSync(KEYS_TXT)) {
      keyContent = fs.readFileSync(KEYS_TXT, 'utf8');
    }
    const lines = keyContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.includes(apiKey.trim())) {
      const prefix = keyContent.length > 0 && !keyContent.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(KEYS_TXT, prefix + apiKey.trim() + '\n', 'utf8');
    }
  } catch (err) {
    console.error(`[export] Error writing local success record: ${err.message}`);
  }
}

function parseArgs(argv) {
  let limit = Infinity;
  let row = null;
  let generate = 0;
  let dryRun = false;
  let noProxy = false;
  let resetFailed = false;
  let interval = 1;
  let concurrency = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--limit=')) {
      const parsed = parseInt(arg.split('=')[1], 10);
      limit = isNaN(parsed) ? Infinity : parsed;
    }
    if (arg.startsWith('--row=')) row = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--generate=')) generate = parseInt(arg.split('=')[1], 10) || 0;
    if (arg === '--dry-run') dryRun = true;
    if (arg === '--no-proxy') noProxy = true;
    if (arg === '--reset-failed') resetFailed = true;
    if (arg.startsWith('--interval=')) interval = parseFloat(arg.split('=')[1]) || 1;
    if (arg.startsWith('--concurrency=')) concurrency = Math.max(1, parseInt(arg.split('=')[1], 10) || 1);
    if (arg === '-c' && i + 1 < argv.length) concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    if (arg.startsWith('-c=')) concurrency = Math.max(1, parseInt(arg.split('=')[1], 10) || 1);
  }

  return { limit, row, generate, dryRun, noProxy, resetFailed, interval, concurrency };
}

async function cleanupWorkerSession(workerId) {
  const session = activeWorkerSessions.get(workerId);
  if (!session) return;

  if (session.browser) {
    try {
      await session.browser.close();
    } catch {}
  }
  if (session.gpmProfileId) {
    try {
      await gpm.stopProfile(session.gpmProfileId);
    } catch {}
    try {
      await gpm.deleteProfile(session.gpmProfileId);
    } catch {}
  }
  activeWorkerSessions.delete(workerId);
}

async function cleanupAllActiveProfiles() {
  const workerIds = Array.from(activeWorkerSessions.keys());
  await Promise.all(workerIds.map((id) => cleanupWorkerSession(id)));
}

function installSignalHandlers() {
  const handler = async (signal) => {
    console.log(`\n[catch-all-signup] Received ${signal}. Shutting down all workers cleanly...`);
    cancellationRequested = true;
    await cleanupAllActiveProfiles();
    process.exit(0);
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}

async function runWorker(workerId, queue, totalTasks, proxyConfig, options) {
  const prefix = `[Worker ${workerId}]`;
  console.log(`${prefix} Initialized.`);

  // Stagger start: delay each subsequent worker by 8 seconds to prevent concurrency spikes
  if (workerId > 1) {
    const staggerDelay = (workerId - 1) * 8000;
    console.log(`${prefix} Staggering start (waiting ${staggerDelay / 1000}s)...`);
    await new Promise((r) => setTimeout(r, staggerDelay));
  }

  while (queue.length > 0 && !cancellationRequested) {
    const account = queue.shift();
    if (!account) break;

    const remaining = queue.length;
    console.log(`\n${prefix} ▶ [${totalTasks - remaining}/${totalTasks}] Processing ${account.email} (Row ${account.rowIndex})`);

    let proxyString = '';
    if (proxyConfig.provider !== 'none') {
      try {
        if (proxyConfig.provider === 'tinproxy') {
          console.log(`${prefix} [proxy] Acquiring TinProxy...`);
          const p = await getNewTinProxyWithRetry(proxyConfig.apiKey);
          proxyString = p.proxy;
        } else if (proxyConfig.provider === 'sp07') {
          console.log(`${prefix} [proxy] Acquiring SP07 Proxy...`);
          const p = await getNewProxyWithRetry(proxyConfig.apiKey);
          proxyString = p.proxy;
        }
        console.log(`${prefix} [proxy] Proxy acquired successfully.`);
      } catch (proxyErr) {
        console.error(`${prefix} [proxy] ❌ Failed to rotate proxy: ${proxyErr.message}`);
        continue;
      }
    }

    let gpmProfileId = null;
    let browser = null;

    try {
      console.log(`${prefix} [GPM] Creating profile for ${account.email}...`);
      gpmProfileId = await gpm.createProfile(account.email, proxyString);
      console.log(`${prefix} [GPM] Created profile ${gpmProfileId}`);

      console.log(`${prefix} [GPM] Starting profile browser...`);
      const debugAddress = await gpm.startProfile(gpmProfileId);
      console.log(`${prefix} [GPM] CDP Debug Address: ${debugAddress}`);

      await new Promise((r) => setTimeout(r, 3000));

      console.log(`${prefix} [CDP] Connecting Playwright...`);
      browser = await chromium.connectOverCDP(`http://${debugAddress}`);
      const contexts = browser.contexts();
      const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();

      // Register session for signal cleanup
      activeWorkerSessions.set(workerId, { gpmProfileId, browser });

      // Execute registration
      const result = await registerAccount(ctx, account, proxyString);
      if (result && result.apiKey) {
        appendSuccessRecord(account.email, account.password, result.apiKey, proxyString);
      }
    } catch (err) {
      console.error(`${prefix} ❌ FAILED [${account.email}]: ${err.message}`);
    } finally {
      await cleanupWorkerSession(workerId);
    }

    // Delay between accounts for this worker
    if (queue.length > 0 && !cancellationRequested) {
      const delayMs = poissonIntervalDelay(options.interval);
      console.log(`\n${prefix} [Anti-Detection] Resting for ${Math.round(delayMs / 1000)}s...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(`${prefix} ✅ Completed all assigned accounts.`);
}

async function run(argv = process.argv.slice(2)) {
  cancellationRequested = false;
  const { limit, row, generate, dryRun, noProxy, resetFailed, interval, concurrency } = parseArgs(argv);

  const catchAllConfig = loadCatchAllConfig();
  const runtimeConfig = loadRuntimeConfig();
  const proxyConfig = noProxy ? { provider: 'none', apiKey: null } : resolveProxyConfig(runtimeConfig);

  console.log('============================================================');
  console.log('🚀 CATCH-ALL ELEVENLABS AUTOMATION PIPELINE (HIGH-THROUGHPUT)');
  console.log('============================================================');
  console.log(`• Domain: @${catchAllConfig.catchAllDomain}`);
  console.log(`• Gmail IMAP: ${catchAllConfig.gmailUser}`);
  console.log(`• Proxy: ${noProxy ? 'None (Direct / VPN)' : proxyConfig.provider}`);
  console.log(`• Google Sheet Tab: ${catchAllConfig.regSheetName}`);
  console.log(`• Concurrency Workers: ${concurrency}`);
  console.log('============================================================\n');

  await initSignupSheets();
  await ensureHeaderRow();

  // Reset failed accounts if requested
  if (resetFailed) {
    const allRows = await loadRows();
    const failedRows = allRows.filter((r) => r.status && r.status.startsWith('failed:'));
    if (failedRows.length > 0) {
      console.log(`[reset] Found ${failedRows.length} failed account(s). Resetting to 'pending'...`);
      await resetRows(failedRows.map((r) => r.rowIndex));
    } else {
      console.log('[reset] No failed accounts found to reset.');
    }
  }

  // Pre-generate accounts if requested
  if (generate > 0) {
    console.log(`[generator] Generating ${generate} new account identities...`);
    const newAccounts = generateBatch(generate, { domain: catchAllConfig.catchAllDomain });
    const appended = await appendAccountsToSheet(newAccounts);
    console.log(`[generator] Appended ${appended} accounts to Google Sheet.`);
    if (dryRun) {
      console.log('[dry-run] Generation complete. Exiting without launching browser.');
      return { processed: appended };
    }
  }

  let pending = await loadPendingAccounts();
  if (row !== null) {
    pending = pending.filter((r) => r.rowIndex === row);
    if (pending.length === 0) {
      console.log(`Row ${row} is not pending or does not exist. Exiting.`);
      return { processed: 0 };
    }
  }

  if (pending.length > limit) {
    pending = pending.slice(0, limit);
    console.log(`[limit] Capped to first ${limit} account(s).`);
  }

  if (pending.length === 0) {
    console.log('No pending accounts in queue. All done!');
    return { processed: 0 };
  }

  const totalTasks = pending.length;
  console.log(`Loaded ${totalTasks} pending account(s). Launching ${Math.min(concurrency, totalTasks)} worker(s)...\n`);

  // Shared FIFO Queue
  const queue = [...pending];
  const actualConcurrency = Math.min(concurrency, totalTasks);
  const workerPromises = [];

  for (let workerId = 1; workerId <= actualConcurrency; workerId++) {
    workerPromises.push(runWorker(workerId, queue, totalTasks, proxyConfig, { interval }));
  }

  await Promise.all(workerPromises);

  console.log('\n============================================================');
  console.log('✅ All assigned accounts processed across all workers.');
  console.log('============================================================');
  return { processed: totalTasks };
}

if (require.main === module) {
  installSignalHandlers();
  withAutomationLock('catch-all-signup', () => run())
    .catch((err) => {
      console.error('\n❌ Fatal error in pipeline:', err.message);
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  run,
  cleanupAllActiveProfiles,
};
