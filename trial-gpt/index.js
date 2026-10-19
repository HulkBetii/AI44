/**
 * index.js (trial-gpt)
 * Master CLI Entry Point and Multi-Worker Orchestration for Trial GPT Plus.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const gpm = require('../gpm-api');
const { withAutomationLock } = require('../automation-lock');
const { getNewProxyWithRetry, getNewTinProxyWithRetry } = require('../proxy');
const { poissonIntervalDelay } = require('../human-behavior');
const { loadRuntimeConfig, resolveProxyConfig } = require('../runtime-config');

const { loadTrialConfig } = require('./config');
const { initSheets, ensureTargetTab, loadSourceAccounts, recordTrialResult } = require('./sheets');
const { authenticateChatGPT } = require('./chatgpt-auth');
const { openCheckoutPage, detectTrialVariant, proceedMoMoCheckout } = require('./trial-detector');
const { sendTrialAlert, sendBatchSummary, sendTelegramMessage } = require('./notifier');

// Track active sessions for clean shutdown
const activeWorkerSessions = new Map();
let isShuttingDown = false;

function parseArgs(argv) {
  let limit = Infinity;
  let startRow = null;
  let interval = 1;
  let concurrency = 1;
  let dryRun = false;
  let noProxy = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--limit=')) {
      const p = parseInt(arg.split('=')[1], 10);
      limit = isNaN(p) ? Infinity : p;
    }
    if (arg.startsWith('--start-row=')) {
      startRow = parseInt(arg.split('=')[1], 10) || 152;
    }
    if (arg.startsWith('--interval=')) {
      interval = parseFloat(arg.split('=')[1]) || 1;
    }
    if (arg.startsWith('--concurrency=')) {
      concurrency = Math.max(1, parseInt(arg.split('=')[1], 10) || 1);
    }
    if (arg === '-c' && i + 1 < argv.length) {
      concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    }
    if (arg === '--dry-run') dryRun = true;
    if (arg === '--no-proxy') noProxy = true;
  }

  return { limit, startRow, interval, concurrency, dryRun, noProxy };
}

async function connectCDPWithRetry(debugAddress, maxAttempts = 10, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://${debugAddress}`);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.log(`[playwright] Waiting for GPM CDP port to be ready (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function processSingleAccount(account, options = {}) {
  const { dryRun = false, noProxy = false } = options;
  const startTime = Date.now();
  let profileId = null;
  let browser = null;
  let proxyString = '';

  console.log(`\n======================================================`);
  console.log(`[worker] Processing Row ${account.rowIndex}: ${account.email}`);
  console.log(`======================================================`);

  try {
    // 1. Resolve proxy
    if (!noProxy) {
      const runtimeConfig = loadRuntimeConfig();
      const proxyConfig = resolveProxyConfig(runtimeConfig);
      if (proxyConfig.provider === 'tinproxy' && proxyConfig.apiKey) {
        console.log('[proxy] Fetching new TinProxy...');
        proxyString = await getNewTinProxyWithRetry(proxyConfig.apiKey);
      } else if (proxyConfig.provider === 'tmproxy' && proxyConfig.apiKey) {
        console.log('[proxy] Fetching new TMProxy...');
        proxyString = await getNewProxyWithRetry(proxyConfig.apiKey);
      }
    }

    // 2. Create & start GPM Profile
    console.log(`[gpm] Creating profile for ${account.email}...`);
    profileId = await gpm.createProfile(`GPT_${account.email}`, proxyString);
    activeWorkerSessions.set(account.email, { profileId, browser: null });

    console.log(`[gpm] Starting profile ${profileId}...`);
    const debugAddress = await gpm.startProfile(profileId);

    // Wait a brief moment for browser process initialization
    await new Promise((r) => setTimeout(r, 2500 + Math.floor(Math.random() * 2000)));

    // 3. Connect Playwright
    console.log(`[playwright] Connecting via CDP to ${debugAddress}...`);
    browser = await connectCDPWithRetry(debugAddress);
    activeWorkerSessions.get(account.email).browser = browser;

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // 4. Authenticate ChatGPT
    const authOk = await authenticateChatGPT(page, account.email, account.password);
    if (!authOk) {
      throw new Error('ChatGPT authentication or onboarding failed');
    }

    // 5. Open checkout & detect trial
    await openCheckoutPage(page);
    const detection = await detectTrialVariant(page);

    let momoLink = '';
    const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

    if (detection.isTrial) {
      console.log(`🎉 [TRIAL DETECTED] Account: ${account.email}`);

      if (!dryRun) {
        momoLink = await proceedMoMoCheckout(page);
      }

      await sendTrialAlert({
        email: account.email,
        password: account.password,
        momoLink,
        checkoutUrl: detection.checkoutUrl,
        duration,
      });

      await recordTrialResult({
        sourceRowIndex: account.rowIndex,
        email: account.email,
        password: account.password,
        status: 'trial_found',
        trialDetected: true,
        momoLink,
      });

      return { outcome: 'trial', email: account.email };
    } else {
      console.log(`❌ [NO TRIAL] Account: ${account.email} showed standard checkout.`);

      await recordTrialResult({
        sourceRowIndex: account.rowIndex,
        email: account.email,
        password: account.password,
        status: 'no_trial',
        trialDetected: false,
      });

      return { outcome: 'no_trial', email: account.email };
    }
  } catch (err) {
    const isWrongPassword = err.code === 'WRONG_PASSWORD' || /wrong_password|incorrect password|sai mật khẩu/i.test(err.message);
    const status = isWrongPassword ? 'wrong_password' : 'error';
    const errorDetail = isWrongPassword ? 'Wrong password (SKIPPED)' : err.message;

    console.error(`[worker] Error processing ${account.email}: ${errorDetail}`);

    await recordTrialResult({
      sourceRowIndex: account.rowIndex,
      email: account.email,
      password: account.password,
      status,
      trialDetected: false,
      errorDetail,
    }).catch(() => {});

    return { outcome: status, email: account.email, error: errorDetail };
  } finally {
    // Clean up browser & GPM profile
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (profileId) {
      try {
        await gpm.stopProfile(profileId);
        await gpm.deleteProfile(profileId);
      } catch (cleanErr) {
        console.warn(`[gpm] Cleanup warning for ${profileId}: ${cleanErr.message}`);
      }
    }
    activeWorkerSessions.delete(account.email);
  }
}

async function runMaster() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadTrialConfig();
  const startRow = args.startRow || config.startRow || 152;

  console.log('======================================================');
  console.log('🚀 Trial GPT Plus Automation Engine');
  console.log(`   Source Sheet:  ${config.sourceSheetName} (Starting from row ${startRow})`);
  console.log(`   Target Sheet:  ${config.targetSheetName}`);
  console.log(`   Concurrency:   ${args.concurrency}`);
  console.log(`   Interval:      ${args.interval} min(s)`);
  console.log(`   Proxy Mode:    ${args.noProxy ? 'OFF (Direct)' : 'ON'}`);
  console.log(`   Dry Run:       ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('======================================================\n');

  // Init Google Sheets
  await initSheets();
  await ensureTargetTab();

  // Load accounts
  const accounts = await loadSourceAccounts({
    startRow,
    limit: args.limit,
  });

  if (accounts.length === 0) {
    console.log('[main] No accounts found to process.');
    return;
  }

  console.log(`[main] Loaded ${accounts.length} account(s) ready for execution.`);

  const stats = {
    total: accounts.length,
    trialCount: 0,
    noTrialCount: 0,
    errorCount: 0,
    startTime: Date.now(),
  };

  // Process accounts with concurrency control
  let accountIndex = 0;

  async function workerLoop(workerId) {
    while (accountIndex < accounts.length && !isShuttingDown) {
      const currentAccount = accounts[accountIndex++];
      console.log(`[worker-${workerId}] Picked up ${currentAccount.email} (${accountIndex}/${accounts.length})`);

      const result = await processSingleAccount(currentAccount, args);

      if (result.outcome === 'trial') stats.trialCount++;
      else if (result.outcome === 'no_trial') stats.noTrialCount++;
      else stats.errorCount++;

      if (accountIndex < accounts.length && !isShuttingDown) {
        const delayMs = poissonIntervalDelay(args.interval);
        console.log(`[worker-${workerId}] Waiting ${(delayMs / 1000).toFixed(1)}s (Poisson randomized interval) before next account...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  const workers = [];
  for (let w = 1; w <= args.concurrency; w++) {
    workers.push(workerLoop(w));
  }

  await Promise.all(workers);

  const elapsedMinutes = ((Date.now() - stats.startTime) / 60000).toFixed(1);
  console.log('\n======================================================');
  console.log('🏁 Batch Finished!');
  console.log(`   Total:       ${stats.total}`);
  console.log(`   Trials:      ${stats.trialCount}`);
  console.log(`   No Trial:    ${stats.noTrialCount}`);
  console.log(`   Errors:      ${stats.errorCount}`);
  console.log(`   Time:        ${elapsedMinutes} min(s)`);
  console.log('======================================================');

  await sendBatchSummary({
    total: stats.total,
    trialCount: stats.trialCount,
    noTrialCount: stats.noTrialCount,
    errorCount: stats.errorCount,
    elapsedMinutes,
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[main] Received SIGINT (Ctrl+C). Cleaning up active browser sessions...');

  for (const [email, session] of activeWorkerSessions.entries()) {
    console.log(`[main] Closing session for ${email}...`);
    try {
      if (session.browser) await session.browser.close();
      if (session.profileId) {
        await gpm.stopProfile(session.profileId);
        await gpm.deleteProfile(session.profileId);
      }
    } catch {}
  }

  process.exit(0);
});

if (require.main === module) {
  withAutomationLock({
    runtimeDirectory: loadTrialConfig().runtimeDirectory,
    owner: { name: 'trial-gpt', pid: process.pid },
  }, runMaster).catch((err) => {
    console.error(`[main] Fatal runtime error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  processSingleAccount,
  runMaster,
};
