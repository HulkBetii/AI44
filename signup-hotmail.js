const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  initSheets,
  loadRows,
  updatePasswordAndStatusByEmail,
  updatePasswordByEmail,
  updateResultByEmail,
  updateStatusByEmail,
} = require('./sheets');
const { getNewProxyWithRetry, parseProxyString, getNewTinProxyWithRetry } = require('./proxy');
const { solveCaptcha } = require('./captcha-solver');
const gpm = require('./gpm-api');
const { withAutomationLock } = require('./automation-lock');
const { loadRuntimeConfig, resolveProxyConfig } = require('./runtime-config');
const { isEligibleForWorkflow } = require('./workflow-policy');
const { generateSecurePassword } = require('./password-generator');
const { collectSecretValues, collectUrlSecrets, redactSecrets } = require('./secret-sanitizer');
const {
  assertNoPreparedRecoveries,
  confirmRecovery,
  prepareRecovery,
  removeRecovery,
  syncConfirmedRecoveries,
} = require('./recovery-journal');

const FAILURE_SCREENSHOT = path.join(__dirname, 'debug-failure.png');
const SUCCESS_CSV = path.join(__dirname, 'success_accounts.csv');
const KEYS_TXT = path.join(__dirname, 'keys.txt');
const Q = String.fromCharCode(34);

// Hotmail passwords and recovery addresses come from the operator's sheet, so their
// contents are arbitrary: one comma would shift every later column and corrupt the
// record silently.
function csvCell(value) {
  return Q + String(value ?? '').split(Q).join(Q + Q) + Q;
}


// Appends one line, adding the separator the existing file is missing if its last byte is
// not a newline.
function appendLine(file, text) {
  let prefix = '';
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, fs.statSync(file).size - 1);
    fs.closeSync(fd);
    if (last.toString('utf8') !== '\n') prefix = '\n';
  }
  fs.appendFileSync(file, prefix + text + '\n', 'utf8');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inQuotes) {
      if (character === Q && text[index + 1] === Q) {
        cell += Q;
        index++;
      } else if (character === Q) {
        inQuotes = false;
      } else {
        cell += character;
      }
    } else if (character === Q) {
      inQuotes = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (character !== '\r') {
      cell += character;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function fileHasLine(file, expected) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).includes(expected);
}

function appendSuccessCSV(cred, elevenPassword, apiKey, proxyString) {
  const csvExists = fs.existsSync(SUCCESS_CSV);
  const alreadyInCsv = Boolean(apiKey && csvExists && parseCsvRows(
    fs.readFileSync(SUCCESS_CSV, 'utf8'),
  ).some((record, index) => index > 0 && record[5] === apiKey));
  if (!csvExists || fs.statSync(SUCCESS_CSV).size === 0) {
    fs.writeFileSync(SUCCESS_CSV,
      'Timestamp,Email,HotmailPassword,ElevenPassword,RecoveryEmail,APIKey,Proxy\n', 'utf8');
  }
  if (!alreadyInCsv) {
    const row = [
      new Date().toISOString(), cred.email, cred.password,
      elevenPassword, cred.recoveryEmail, apiKey, proxyString,
    ].map(csvCell).join(',') + '\n';
    fs.appendFileSync(SUCCESS_CSV, row, 'utf8');
  }
  
  if (apiKey && !fileHasLine(KEYS_TXT, apiKey)) {
    // A file whose last line has no newline - one written by hand, or by any other tool -
    // would otherwise have the next key appended onto the end of it, silently fusing two
    // keys into one unusable line. That already happened once to this file.
    appendLine(KEYS_TXT, apiKey);
  }
}

function persistCapturedCredentials(cred, proxyString) {
  if (!cred.apiKeyCapturedThisRun || cred.capturedCredentialsPersisted) return false;
  appendSuccessCSV(cred, cred.elevenPassword, cred.apiKey, proxyString);
  cred.capturedCredentialsPersisted = true;
  return true;
}


const SURVEY_OPTION_SELECTOR =
  '[data-agent-id^="onboarding-icon-option-"], [data-agent-id^="onboarding-illustration-option-"]';

const LOGIN_URL = 'https://login.live.com/';

const SIGNUP_TIMEOUT_MS = 900000; // 15 min - CAPTCHA is solved by hand, allow for a break
const INBOX_TIMEOUT_MS = 120000;  // 2 min — wait for ElevenLabs verify email
const MS_LOGIN_TIMEOUT_MS = 15000;
const LIST_RENDER_TIMEOUT_MS = 20000; // Outlook's message list after a cold SPA boot
const ONBOARDING_TIMEOUT_MS = 120000; // ElevenLabs adds onboarding steps; drive them in a loop
const STEP_RENDER_TIMEOUT_MS = 20000; // the app shows a blank splash before each step mounts

const LEGACY_PASSWORD_PATTERN = new RegExp(
  '^(?:James|John|Robert|Michael|William|David|Richard|Joseph|Thomas|Charles|Mary|Patricia|Jennifer|Linda|Elizabeth|Barbara|Susan|Jessica|Sarah|Karen|Emma|Olivia|Ava|Isabella|Sophia|Mia|Amelia|Harper|Evelyn|Abigail)'
  + '(?:Love|Life|Star|Moon|Sky|Blue|Green|Happy|Dream|Hope)'
  + '(?:19(?:8[0-9]|9[0-9])|200[0-5])[@#!$]$',
);

// ── Module-scope state for failure handler ───────────────────────────────────
let browser = null;
let activePage = null;
let currentStep = 'init';
// Module scope, not loop scope: a GPM profile outlives the process - it is a started browser
// plus a folder on disk - so every exit path has to be able to see it and release it.
let gpmProfileId = null;
let profileCreateInFlight = null;
let cancellationRequested = false;
let activeRowIndex = null;
let runReporter = null;
let activeAccount = null;
let activeRuntimeConfig = null;
let activeProxyString = '';
let activeAdditionalSecrets = [];

function currentSecrets(account = activeAccount, extra = []) {
  return collectSecretValues({
    account,
    runtimeConfig: activeRuntimeConfig,
    extra: [activeProxyString, ...activeAdditionalSecrets, ...extra],
  });
}

function safeErrorText(error, account = activeAccount, extra = []) {
  return redactSecrets(error?.stack || error?.message || error, currentSecrets(account, extra));
}

function sanitizeEventValue(value, secrets) {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeEventValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeEventValue(item, secrets)]),
    );
  }
  return value;
}

function emitRunEvent(type, message, data = {}, level = 'info') {
  if (!runReporter || typeof runReporter.emit !== 'function') return;
  try {
    const secrets = currentSecrets();
    runReporter.emit({
      type,
      message: redactSecrets(message, secrets),
      data: sanitizeEventValue(data, secrets),
      level,
      rowIndex: activeRowIndex,
    });
  } catch (error) {
    console.warn(`[reporter] ${safeErrorText(error)}`);
  }
}

function step(name) {
  currentStep = name;
  console.log(`[step] ${name}`);
  emitRunEvent('step.changed', name, { step: name });
}

function safePageLocation(page) {
  try {
    const url = new URL(page.url());
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[unknown page]';
  }
}

// The single place the browser connection and the GPM profile are released. Both the
// per-account finally and the signal handler go through it, so an interrupted run cleans up
// the same way a finished one does.
//
// A release in flight is shared rather than skipped. Ctrl+C landing midway through the normal
// cleanup would otherwise find gpmProfileId already nulled, return straight away, and let the
// handler's process.exit kill the delete that was still in flight - reintroducing the leak
// exactly when the operator was watching for it.
let releasing = null;
function releaseProfile() {
  if (releasing) return releasing;
  releasing = (async () => {
    if (typeof emitRunEvent === 'function') {
      emitRunEvent('cleanup.started', 'Đang đóng browser và GPM profile');
    }
    activePage = null;
    if (profileCreateInFlight) {
      const createdId = await profileCreateInFlight;
      if (!gpmProfileId) gpmProfileId = createdId;
    }
    if (browser) {
      // Just disconnect the CDP session
      await browser.close().catch(() => {});
      browser = null;
    }
    const id = gpmProfileId;
    if (!id) {
      if (typeof emitRunEvent === 'function') {
        emitRunEvent('cleanup.completed', 'Không có GPM profile cần giải phóng');
      }
      return;
    }

    step('stop and delete GPM profile');
    await gpm.stopProfile(id)
      .catch((e) => console.warn(`[GPM] stop failed for ${id}: ${safeErrorText(e)}`));
    await new Promise((r) => setTimeout(r, 2000));
    // Report what actually happened: mode=2 removes the profile folder, so a run that
    // keeps failing here silently accumulates one directory per account.
    await gpm.deleteProfile(id).catch((error) => {
      console.warn(`[GPM] DELETE FAILED for ${id}: ${safeErrorText(error)} - profile folder left on disk`);
      const cleanupError = new Error(`GPM profile cleanup failed for ${id}`);
      cleanupError.preserveAutomationLock = true;
      throw cleanupError;
    });
    gpmProfileId = null;
    console.log(`[GPM] Profile ${id} deleted.`);
    if (typeof emitRunEvent === 'function') {
      emitRunEvent('cleanup.completed', 'Đã giải phóng GPM profile');
    }
  })();
  // Cleared once settled so the next account gets its own release, not this one's result.
  return releasing.finally(() => { releasing = null; });
}

function installCliSignalHandlers(targetProcess = process) {
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    targetProcess.on(sig, () => {
      if (shuttingDown) {
        console.error(`\n[${sig}] forced exit - profile ${gpmProfileId || '(none)'} left behind.`);
        targetProcess.exit(130);
      }
      shuttingDown = true;
      console.error(`\n[${sig}] received - releasing GPM profile before exit (Ctrl+C again to force)…`);
      releaseProfile()
        .catch((e) => console.error(`[cleanup] ${safeErrorText(e)}`))
        .finally(() => targetProcess.exit(130));
    });
  }
}

const {
  think, clickHuman, typeHuman, smoothScroll, generateRealisticName, poissonIntervalDelay
} = require('./human-behavior');

function generatePassword() {
  return generateSecurePassword();
}

async function createTrackedProfile(name, proxyString) {
  if (profileCreateInFlight) throw new Error('A GPM profile create is already in flight');
  const createPromise = gpm.createProfile(name, proxyString);
  profileCreateInFlight = createPromise;
  try {
    const profileId = await createPromise;
    gpmProfileId = profileId;
    return profileId;
  } finally {
    if (profileCreateInFlight === createPromise) profileCreateInFlight = null;
  }
}

function selectWeakPasswordRows(rows) {
  return rows.filter((row) => LEGACY_PASSWORD_PATTERN.test(String(row.elevenPass || '')));
}

async function auditWeakPasswords() {
  await initSheets();
  const matches = selectWeakPasswordRows(await loadRows());
  console.log(`Found ${matches.length} account(s) using the legacy weak password pattern.`);
  for (const account of matches) console.log(`Row ${account.rowIndex}: ${account.email}`);
  return matches.map(({ rowIndex, email }) => ({ rowIndex, email }));
}

function normalizeChoiceText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function microsoftLoginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function detectMicrosoftLoginIssue(page) {
  return page.evaluate(() => {
    const isVisible = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    };
    const visibleText = (selector) => {
      const element = document.querySelector(selector);
      if (!element || !isVisible(selector)) return '';
      return (element.textContent || '').trim();
    };
    const credentialError = visibleText('#usernameError') || visibleText('#passwordError');
    if (credentialError) {
      const normalizedError = credentialError.replace(/\s+/g, ' ').trim().toLowerCase();
      const confirmedCredentialPatterns = [
        // English
        'your account or password is incorrect',
        'the account or password is incorrect',
        'your password is incorrect',
        "that microsoft account doesn't exist",
        "we couldn't find an account with that username",
        // Vietnamese
        'mật khẩu đó không đúng',
        'tài khoản hoặc mật khẩu không đúng',
        'không tìm thấy tài khoản microsoft',
        'tên người dùng không tồn tại',
      ];
      const code = confirmedCredentialPatterns.some((pattern) => normalizedError.includes(pattern))
        ? 'MS_BAD_CREDENTIALS'
        : 'MS_UI_CHANGED';
      return { code, message: credentialError };
    }
    const hasPasswordChoice = [...document.querySelectorAll('span[role="button"], a, button, [role="button"]')]
      .some((element) => {
        const style = getComputedStyle(element);
        const visible = style.display !== 'none' && style.visibility !== 'hidden'
          && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
        const text = String(element.textContent || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return visible && (text.includes('use your password') || text.includes('su dung mat khau cua ban'));
      });
    if (hasPasswordChoice) return null;
    if (isVisible('#iProofEmail')) {
      return { code: 'MS_RECOVERY_REQUIRED', message: 'Microsoft requested manual account recovery' };
    }
    return null;
  }).catch(() => null);
}

async function throwMicrosoftLoginIssue(page, fallbackMessage) {
  const issue = await detectMicrosoftLoginIssue(page);
  if (issue) throw microsoftLoginError(issue.code, `MS login: ${issue.message}`);
  throw microsoftLoginError('MS_UI_CHANGED', fallbackMessage);
}

async function findVisiblePasswordChoice(page) {
  const candidates = page.locator('span[role="button"], a, button, [role="button"]');
  const count = await candidates.count();
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = normalizeChoiceText(await candidate.innerText().catch(() => ''));
    if (text.includes('use your password') || text.includes('su dung mat khau cua ban')) {
      return candidate;
    }
  }
  return null;
}

async function activateMicrosoftPasswordRoute(page, route, click = clickHuman) {
  let selectedRoute = route;
  let passwordChoice = await findVisiblePasswordChoice(page);
  if (passwordChoice) selectedRoute = 'link';
  if (selectedRoute === 'proof' && !passwordChoice) {
    passwordChoice = await page.waitForTimeout(1500).then(() => findVisiblePasswordChoice(page));
    if (passwordChoice) selectedRoute = 'link';
  }
  if (selectedRoute === 'proof' && !passwordChoice) {
    throw microsoftLoginError(
      'MS_RECOVERY_REQUIRED',
      'MS login: Microsoft is asking for manual account recovery (iProofEmail).',
    );
  }
  if (selectedRoute === 'link' && !passwordChoice) {
    throw microsoftLoginError('MS_UI_CHANGED', 'MS login: password choice disappeared before click');
  }
  if (selectedRoute === 'link') {
    await click(page, passwordChoice);
    await page.waitForTimeout(800 + Math.random() * 400);
  }
  return selectedRoute;
}

// ── Microsoft Outlook login ──────────────────────────────────────────────────
// login.live.com → fill creds → redirect to Outlook inbox
async function loginMicrosoft(ctx, hotmailEmail, hotmailPassword) {
  step('MS login — open login page');
  const loginPage = await ctx.newPage();
  activePage = loginPage;

  await loginPage.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // Fill email (#usernameEntry)
  step('MS login — fill email');
  await loginPage.waitForSelector('#usernameEntry', { timeout: 20000 });
  
  await think(1500, 3000);
  await smoothScroll(loginPage);

  await typeHuman(loginPage, '#usernameEntry', hotmailEmail);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Click Next
  await clickHuman(loginPage, 'button[data-testid="primaryButton"]');
  await loginPage.waitForTimeout(1500 + Math.random() * 500);

  // The passkey/authenticator interstitial is conditional — accounts without one land on the
  // password field directly. Race the two so a missing prompt is not treated as a failure.
  step('MS login — switch to password');
  let route = await firstOutcome([
    {
      promise: loginPage.waitForFunction(() => {
        const normalize = (value) => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return [...document.querySelectorAll('span[role="button"], a, button, [role="button"]')]
          .some((element) => {
            const style = getComputedStyle(element);
            const visible = style.display !== 'none' && style.visibility !== 'hidden'
              && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
            const text = normalize(element.textContent);
            return visible && (text.includes('use your password') || text.includes('su dung mat khau cua ban'));
          });
      }, { timeout: MS_LOGIN_TIMEOUT_MS }),
      value: 'link',
    },
    { promise: loginPage.waitForSelector('#passwordEntry', { timeout: MS_LOGIN_TIMEOUT_MS }), value: 'password' },
    { promise: loginPage.waitForSelector('#iProofEmail', { timeout: MS_LOGIN_TIMEOUT_MS }), value: 'proof' },
  ], MS_LOGIN_TIMEOUT_MS + 100);

  if (!route) {
    await throwMicrosoftLoginIssue(
      loginPage,
      'MS login: neither the password choice nor the password field appeared',
    );
  }

  route = await activateMicrosoftPasswordRoute(loginPage, route);

  // Fill password (#passwordEntry)
  step('MS login — fill password');
  await loginPage.waitForSelector('#passwordEntry', { timeout: 15000 });
  await typeHuman(loginPage, '#passwordEntry', hotmailPassword);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Submit password (Next button)
  step('MS login — submit password');
  await clickHuman(loginPage, 'button[data-testid="primaryButton"]');
  await loginPage.waitForTimeout(2000);
  const submittedIssue = await detectMicrosoftLoginIssue(loginPage);
  if (submittedIssue) {
    throw microsoftLoginError(submittedIssue.code, `MS login: ${submittedIssue.message}`);
  }

  // Dismiss passkey dialog if it appears (native OS dialog)
  step('MS login — dismiss passkey dialog');
  for (let i = 0; i < 3; i++) {
    await loginPage.keyboard.press('Escape');
    await loginPage.waitForTimeout(300);
  }

  // After password, OK or "Stay signed in?" may appear — handle both
  step('MS login — post-login prompts');
  // Wait for either OK or No button to appear
  const prompt = await Promise.race([
    loginPage.waitForSelector('button:has-text("OK")', { timeout: 10000 }).then(() => 'ok').catch(() => null),
    loginPage.waitForSelector('button:has-text("No")', { timeout: 10000 }).then(() => 'no').catch(() => null),
  ]);

  if (prompt === 'ok') {
    await clickHuman(loginPage, 'button:has-text("OK")');
    await loginPage.waitForTimeout(1500);
    // After OK, No button may appear
    const noBtn = await loginPage.waitForSelector('button:has-text("No")', { timeout: 10000 }).catch(() => null);
    if (noBtn) {
      await clickHuman(loginPage, noBtn);
      await loginPage.waitForTimeout(1500);
    }
  } else if (prompt === 'no') {
    await clickHuman(loginPage, 'button:has-text("No")');
    await loginPage.waitForTimeout(1500);
  }

  const delayedIssue = await detectMicrosoftLoginIssue(loginPage);
  if (delayedIssue) {
    throw microsoftLoginError(delayedIssue.code, `MS login: ${delayedIssue.message}`);
  }

  // Wait for post-login redirect to settle
  await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
  await loginPage.waitForTimeout(2000);

  // Navigate to Outlook inbox. For fresh Hotmail accounts that have never used Outlook Web,
  // outlook.live.com/mail/ redirects to the Microsoft marketing page. Try progressively more
  // direct URLs until we land on outlook.live.com.
  step('MS login — navigate to Outlook inbox');
  const INBOX_URLS = [
    'https://outlook.live.com/mail/0/inbox',
    'https://outlook.live.com/owa/',
    'https://outlook.live.com/mail/',
  ];
  let reachedInbox = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const currentUrl = loginPage.url();
    if (currentUrl.includes('outlook.live.com')) {
      reachedInbox = true;
      break;
    }
    const targetUrl = INBOX_URLS[Math.min(attempt - 1, INBOX_URLS.length - 1)];
    console.log(`[MS] Navigating to inbox (attempt ${attempt}): ${targetUrl}`);
    try {
      await loginPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      if (/interrupted|net::ERR_ABORTED|net::ERR_NETWORK_CHANGED|net::ERR_CONNECTION_RESET|net::ERR_TIMED_OUT|net::ERR_NAME_NOT_RESOLVED/i.test(err.message)) {
        console.log(`[MS] Transient network error (attempt ${attempt}): ${err.message.split('\n')[0]}`);
        await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
        await loginPage.waitForTimeout(3000);
      } else {
        throw err;
      }
    }
    await loginPage.waitForTimeout(3000);
  }
  // The inbox may temporarily reflect the correct URL before a JS redirect kicks in.
  // Wait explicitly for either an inbox DOM element, or the marketing page URL.
  const outcome = await Promise.race([
    loginPage.waitForSelector('#O365_MainLink_Logo, [role="option"]', { timeout: 15000 }).then(() => 'inbox'),
    loginPage.waitForURL(url => url.toString().includes('microsoft.com') && url.toString().includes('outlook'), { timeout: 15000 }).then(() => 'marketing')
  ]).catch(() => 'timeout');

  const finalUrl = loginPage.url();

  if (outcome === 'marketing' || (outcome === 'timeout' && !finalUrl.includes('mail/0') && !finalUrl.includes('owa') && !finalUrl.includes('outlook.live.com/mail'))) {
    if (finalUrl.includes('microsoft.com') && finalUrl.includes('outlook')) {
      console.log('[MS] Landed on marketing page. Attempting Sign in click to reach webmail...');
      const signInLink = loginPage.locator('a[data-bi-name="SignIn"], a:has-text("Đăng nhập"), a:has-text("Sign in")').first();
      if (await signInLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await signInLink.click().catch(() => {});
        await loginPage.waitForTimeout(4000);
      } else {
        await loginPage.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await loginPage.waitForTimeout(3000);
      }

      if (loginPage.url().includes('outlook.live.com')) {
        console.log(`[MS] Successfully recovered to Outlook inbox: ${loginPage.url()}`);
      } else {
        // Check page body: "high demand" / "try again later" = server overload, not bad credentials.
        const bodyText = await loginPage.evaluate(() => document.body.innerText || '').catch(() => '');
        const isOverloaded = /high demand|try again later|experiencing.*demand/i.test(bodyText);
        if (isOverloaded) {
          throw microsoftLoginError('MS_NETWORK',
            `MS login: Microsoft server overloaded — redirected to Outlook marketing page (${loginPage.url()})`);
        }
        throw microsoftLoginError('MS_BAD_CREDENTIALS',
          `MS login: password rejected — redirected to Outlook marketing page (${loginPage.url()})`);
      }
    } else {
      // If it's not the marketing page, but still not the inbox, we throw a general issue
      await throwMicrosoftLoginIssue(
        loginPage,
        `MS login did not reach Outlook inbox; redirected to ${safePageLocation(loginPage)}`,
      );
    }
  }
  await dismissConsentDialog(loginPage);
  console.log(`[MS] Inbox loaded: ${safePageLocation(loginPage)}`);

  return loginPage;
}


// The CAPTCHA is solved by hand, and this is the only point in a run that needs a person.
// Ring the terminal bell and raise the window so the wait can be spent elsewhere, then tick
// every 30s so a live wait is distinguishable from a hung one.
// A third outcome the sign-up wait had no branch for. When ElevenLabs refuses the address -
// most often because an earlier attempt already registered it - it reports the reason inline
// and stays on /sign-up with no Resend button, so neither of the other two branches can ever
// fire. The run then sat out the full 15 minutes while the console kept asking for a CAPTCHA
// that was not on the screen.
//
// Deliberately narrow. "Already have an account? Log in" is standing text on this very page,
// so anything looser than this would abort every signup instead of the rejected ones.
const SIGNUP_REJECTED = /(?:(?:(?:this|that)\s+)?(?:email|address)\s+(?:is\s+already\s+(?:in use|registered|taken)|has\s+already\s+been\s+(?:registered|taken|used))|an?\s+account\s+(?:already\s+exists\s+with\s+(?:this|that)\s+(?:email|address)|with\s+(?:this|that)\s+(?:email|address)\s+already\s+exists))/i;

async function waitForManualSignup(page) {
  const BELL = String.fromCharCode(7);

  // First, check synchronously if it's already rejected.
  // This prevents race conditions if the error is already on screen (e.g. after a long CAPTCHA timeout).
  const isAlreadyRejected = await page.evaluate((source) => {
    return new RegExp(source, 'i').test(document.body.innerText || '');
  }, SIGNUP_REJECTED.source).catch(() => false);

  if (isAlreadyRejected) {
    const said = await page.evaluate((source) => {
      const re = new RegExp(source, 'i');
      return (document.body.innerText || '').split('\n')
        .map((l) => l.trim()).find((l) => re.test(l)) || '';
    }, SIGNUP_REJECTED.source).catch(() => '');
    const refused = new Error(`ElevenLabs refused the address: ${said || '(message not captured)'}`);
    refused.code = 'ALREADY_REGISTERED';
    throw refused;
  }

  process.stdout.write(BELL);
  await page.bringToFront().catch(() => {});
  console.log(`⚠️  Solve the CAPTCHA in the browser window if shown (up to ${Math.round(SIGNUP_TIMEOUT_MS / 60000)} min).`);
  if (typeof emitRunEvent === 'function') {
    emitRunEvent('attention.required', 'Cần xử lý CAPTCHA trong cửa sổ GPM', { kind: 'captcha' }, 'warning');
  }

  const started = Date.now();
  let ticks = 0;
  const totalSec = Math.round(SIGNUP_TIMEOUT_MS / 1000);
  const TICK_MS = 3000;
  const ticker = setInterval(() => {
    ticks++;
    console.log(`   ⏳ waiting ${Math.round((Date.now() - started) / 1000)}s / ${totalSec}s`);
    if (ticks % 2 === 0) process.stdout.write(BELL);
  }, TICK_MS);

  try {
    const settled = await Promise.race([
      page.waitForURL((url) => !url.toString().includes('/sign-up'), { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'url-changed').catch(() => null),
      page.waitForSelector('text=/Check your email|Check your inbox|verify your email/i', { state: 'visible', timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'resend-shown').catch(() => null),
      page.waitForSelector('button:has-text("Resend")', { state: 'visible', timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'resend-shown').catch(() => null),
      page.waitForFunction(
        (source) => new RegExp(source, 'i').test(document.body.innerText || ''),
        SIGNUP_REJECTED.source,
        { timeout: SIGNUP_TIMEOUT_MS, polling: 500 },
      ).then(() => 'rejected').catch(() => null),
    ]);
    if (settled === 'rejected') {
      // Quote what the page actually said. The regex is a guess at ElevenLabs' wording, so the
      // real sentence is what tells the operator whether it guessed right.
      const said = await page.evaluate((source) => {
        const re = new RegExp(source, 'i');
        return (document.body.innerText || '').split('\n')
          .map((l) => l.trim()).find((l) => re.test(l)) || '';
      }, SIGNUP_REJECTED.source).catch(() => '');
      // Tagged, not just worded: the caller classifies on this to pick a recovery, and
      // matching on message text would break the moment the wording changed.
      const refused = new Error(`ElevenLabs refused the address: ${said || '(message not captured)'}`);
      refused.code = 'ALREADY_REGISTERED';
      throw refused;
    }
    if (!settled) {
      throw new Error(`Signup timed out after ${totalSec}s`);
    }
    return settled;
  } finally {
    clearInterval(ticker);
    if (typeof emitRunEvent === 'function') {
      emitRunEvent('attention.cleared', 'CAPTCHA đã được xử lý hoặc bước đăng ký đã kết thúc');
    }
  }
}

// A fresh GPM profile gets Outlook's cookie/consent modal on first load, and it overlays the
// whole mailbox - a run timed out "finding no mail" while the verification message sat
// visible behind it. Decline rather than accept: nothing here needs the optional tracking.
async function dismissConsentDialog(page) {
  const reject = page.getByRole('button', { name: /^(Reject|Reject all|Decline)$/i }).first();
  if (await reject.count().catch(() => 0) === 0) return false;
  if (!await reject.isVisible().catch(() => false)) return false;

  await reject.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  console.log('[outlook] Dismissed the cookie consent dialog (Reject).');
  return true;
}

// ── Poll Outlook inbox via DOM ────────────────────────────────────────────────
async function pollOutlookInbox(
  outookPage,
  timeoutMs = INBOX_TIMEOUT_MS,
  mode = 'verifyEmail',
  notBefore = null,
) {
  await think(3000, 7000); // Tầng 4: Nhịp thở tự nhiên khi nhận OTP

  const start = Date.now();
  const wanted = `mode=${mode}`;
  let checkJunkNext = false;

  while (Date.now() - start < timeoutMs) {
    try {
      // Alternate between Inbox and Junk Email to catch spam-routed emails
      const targetFolder = checkJunkNext ? 'junkemail' : 'inbox';
      await outookPage.goto(`https://outlook.live.com/mail/0/${targetFolder}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      checkJunkNext = !checkJunkNext;

      // Wait for message list or folder to render
      await outookPage.waitForSelector('[role="option"]', { timeout: LIST_RENDER_TIMEOUT_MS })
        .catch(() => {});

      if (outookPage.url().includes('microsoft.com') || outookPage.url().includes('login.live.com')) {
        throw new Error(`MS session dropped during polling; redirected to ${outookPage.url()}`);
      }

      // Each folder navigation can re-raise the consent modal, and it covers the message list.
      await dismissConsentDialog(outookPage);

      const rows = outookPage.locator('[role="option"]').filter({ hasText: 'ElevenLabs' });
      const count = await rows.count();

      // Open each ElevenLabs message in turn rather than only the newest: the mailbox can
      // already hold a message of the other kind - an old verification link when a reset
      // link is wanted - and taking the first match would return the wrong one.
      for (let i = 0; i < count; i++) {
        // Outlook renders each message row with role="option".
        const rowLocator = outookPage.locator('[role="option"]').filter({ hasText: 'ElevenLabs' }).nth(i);
        const sender = await rowLocator.evaluate((row) => row.querySelector('[class*="Persona"], span[title]')?.textContent || '').catch(() => '');
        const subject = await rowLocator.evaluate((row) => row.querySelector('[class*="subject"], [title]')?.textContent || row.getAttribute('aria-label') || '').catch(() => '');
        
        const isElevenLabs = /ElevenLabs/i.test(sender) || /ElevenLabs/i.test(subject);
        if (!isElevenLabs) continue;

        if (mode === 'resetPassword' && !/Reset your password/i.test(subject) && !/password/i.test(subject)) {
          console.log(`[inbox] Email ${i} is not a reset password email (subject: "${subject}"), skipping.`);
          continue;
        }
        if (mode === 'verifyEmail' && !/Verify your email/i.test(subject)) {
          console.log(`[inbox] Email ${i} is not a verification email (subject: "${subject}"), skipping.`);
          continue;
        }

        const receivedAt = await rowLocator.evaluate((row) => {
            const time = row.querySelector('time[datetime]');
            const raw = (time?.getAttribute('datetime')
              || row.getAttribute('data-received-at')
              || row.getAttribute('data-timestamp')
              || row.getAttribute('title')
              || row.getAttribute('aria-label')
              || time?.textContent
              || '').trim();
            const numeric = Number(raw);
            if (Number.isFinite(numeric) && numeric > 1e12) return { raw, parsed: numeric };
            let parsed = Date.parse(raw);
            if (!Number.isFinite(parsed)) {
              const dayMatch = raw.match(/\b(?:Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
              if (dayMatch) {
                parsed = 0; // Not from today
              } else {
                const clockMatch = raw.match(/\b(\d{1,2}:\d{2}(?:\s*(?:[ap]m|sa|ch))?)\b/i);
                if (clockMatch) {
                  let timeStr = clockMatch[1].toLowerCase();
                  timeStr = timeStr.replace('sa', 'am').replace('ch', 'pm');
                  parsed = Date.parse(new Date().toDateString() + ' ' + timeStr);
                }
              }
            }
            return { raw, parsed: Number.isFinite(parsed) ? parsed : null };
          }).catch(() => ({ raw: 'error', parsed: null }));
          
          console.log(`[inbox] Email ${i} time raw: "${receivedAt.raw}", parsed: ${receivedAt.parsed}`);
          
          if (notBefore) {
            // Outlook UI times are localized to the IP's timezone (e.g. UTC-10), while Date.parse
            // runs in the host's timezone (e.g. UTC+7). This causes massive offsets (e.g. 17 hours).
            // Since timezone offsets are multiples of 30 mins, and we poll rapidly, we can deduce
            // the exact offset by comparing the parsed time to Date.now().
            const rawDiff = Date.now() - receivedAt.parsed;
            const tzOffset = Math.round(rawDiff / 1800000) * 1800000; // Nearest 30 mins
            const trueTimestamp = receivedAt.parsed + tzOffset;
            
            // Allow a 60s grace period since Outlook UI truncates seconds (e.g. 12:17:19 -> 12:17:00)
            const notBeforeGrace = notBefore - 60000;
            if (Number.isFinite(receivedAt.parsed) && trueTimestamp < notBeforeGrace) {
              console.log(`[inbox] Email ${i} is older than notBefore (adjusted: ${trueTimestamp} < ${notBeforeGrace}), skipping.`);
              continue;
            }
          }
        await clickHuman(outookPage, rowLocator);
        await outookPage.waitForTimeout(2000);

        const body = await outookPage.evaluate(() => document.body.innerHTML);
        const links = [...body.matchAll(/href="(https:\/\/elevenlabs\.io\/app\/action[^"]+)"/g)]
          .map((m) => m[1].replace(/&amp;/g, '&'))
          .filter((u) => u.includes(wanted));
        if (links.length > 0) return links[links.length - 1];
      }
    } catch (err) {
      if (err.message.includes('MS session dropped')) throw err;
      console.error(`[inbox] scan error: ${err}`);
    }

    console.log(`[inbox] No ${mode} email yet, waiting 5s...`);
    await outookPage.waitForTimeout(5000);
  }

  throw new Error(`Timeout: no ElevenLabs ${mode} email in Outlook inbox or junk folder`);
}
// ── Process one hotmail account end-to-end ───────────────────────────────────
async function processAccount(ctx, cred, proxyString = '') {
  const { rowIndex, email: hotmailEmail, password: hotmailPassword, recoveryEmail } = cred;
  const elevenPassword = generatePassword();
  cred.elevenPassword = elevenPassword;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`▶ ${hotmailEmail}`);
  console.log(`${'═'.repeat(60)}`);
  console.log('  ElevenLabs password: [generated and stored securely]');

  ctx.on('request', (req) => {
    const url = req.url();
    if (url.includes('hcaptcha.com') && (url.includes('req=') || url.includes('rqdata='))) {
      const m = url.match(/[?&](?:req|rqdata)=([^&]+)/);
      if (m) {
        const rqdata = decodeURIComponent(m[1]);
        const p = req.frame()?.page();
        if (p) p.evaluate((r) => { window.__intercepted_rqdata = r; }, rqdata).catch(() => {});
      }
    }
  });

  // 1. Login Microsoft → get Outlook inbox page
  const outookPage = await loginMicrosoft(ctx, hotmailEmail, hotmailPassword);
  activePage = outookPage;

  // 2. Sign up on ElevenLabs
  step('sign-up ElevenLabs');
  const signupPage = await ctx.newPage();
  activePage = signupPage;

  await signupPage.goto('https://elevenlabs.io', { waitUntil: 'domcontentloaded' });
  await signupPage.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

  await signupPage.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'domcontentloaded' });
  // Wait for the full app shell to mount (avoids hitting the blank IIElevenLabs loading screen)
  await signupPage.waitForSelector('[data-testid="sign-up-email-input"]', { state: 'visible', timeout: 25000 });

  await think(1500, 3500);
  await smoothScroll(signupPage);

  await signupPage.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(signupPage, '[data-testid="sign-up-email-input"]', hotmailEmail);
  await signupPage.waitForTimeout(400 + Math.random() * 300);
  await typeHuman(signupPage, '[data-testid="sign-up-password-input"]', elevenPassword);
  await signupPage.waitForTimeout(600 + Math.random() * 400);

  const verificationRequestedAt = Date.now();
  const recoveryEntry = prepareRecovery({
    operation: 'signup',
    email: hotmailEmail,
    originalRowIndex: rowIndex,
    elevenPassword,
  });
  console.log('[2] Clicking Sign up...');
  try {
    await clickHuman(signupPage, 'button[style*="view-transition-name: submit"]');

    // 3. Handle CAPTCHA — try auto-solve first, fall back to manual
    step('wait for signup (CAPTCHA may need manual solve)');
    if (signupPage.url().includes('sign-up')) {
      const autoResult = await solveCaptcha(signupPage, proxyString).catch((err) => {
        console.warn(`[captcha] Auto-solve threw: ${safeErrorText(err)}`);
        return { solved: false, reason: err.message };
      });

      if (autoResult.solved) {
        console.log(`[3] CAPTCHA auto-solved (${autoResult.solver}: ${autoResult.provider})`);
        emitRunEvent('step.changed', `CAPTCHA auto-solved via ${autoResult.solver} (${autoResult.provider})`);
        await signupPage.waitForTimeout(1500);

        if (signupPage.url().includes('sign-up')) {
          const submitBtn = await signupPage.$('button[style*="view-transition-name: submit"]');
          if (submitBtn) {
            console.log('[captcha] Submitting signup form with solved token...');
            await submitBtn.evaluate(b => b.click()).catch(() => {});
          }
        }
        console.log('[captcha] Waiting for page transition...');
        await signupPage.waitForTimeout(8000);
      }

      if (signupPage.url().includes('sign-up')) {
        if (!autoResult.solved) {
          console.log(`[captcha] Auto-solve skipped: ${autoResult.reason}`);
        } else {
          console.log('[captcha] Token injected but page did not advance — falling back to manual');
        }
        const settled = await waitForManualSignup(signupPage);
        console.log(`[3] Signup complete (${settled})`);
      }
    }
  } catch (error) {
    if (error.code === 'ALREADY_REGISTERED' || error.code === 'CAPTCHA_TIMEOUT') removeRecovery(recoveryEntry.id);
    throw error;
  }

  // 4. Poll Outlook inbox
  step('poll Outlook inbox for verify email');
  activePage = outookPage;
  const verifyUrl = await pollOutlookInbox(
    outookPage,
    INBOX_TIMEOUT_MS,
    'verifyEmail',
    verificationRequestedAt,
  );
  activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl));
  console.log('[4] Verify URL found securely.');

  // A fresh verification email is positive evidence that the remote account was created.
  confirmRecovery(recoveryEntry.id);
  await updatePasswordByEmail(hotmailEmail, elevenPassword);
  removeRecovery(recoveryEntry.id);

  // 5. Open verify URL
  step('open verify URL');
  const verifyPage = await ctx.newPage();
  activePage = verifyPage;
  await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded' });

  // 6. Continue
  step('click Continue');
  await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
  await clickHuman(verifyPage, 'button:has-text("Continue")');
  await verifyPage.waitForTimeout(2000);

  await signInAndCreateKey(verifyPage, cred, elevenPassword);
}

// Grants every endpoint in the Create API Key dialog its most permissive setting.
//
// "Restrict Key" must stay ON: switching it off hides the endpoint list entirely, leaving
// nothing to grant. Each endpoint renders as a Radix tablist whose tab ids carry a random
// prefix but a stable suffix - -trigger-none / -trigger-access / -trigger-write - so the
// suffix is what we match on. Rows offering Write get Write; the rest get Access.
async function grantAllPermissions(page) {
  const dialog = page.getByRole('dialog');

  // The first switch in the dialog is Restrict Key; the later ones are "Restrict by IP
  // address" and "Auto-disable if leaked", which are deliberately left as they are.
  const restrictToggle = dialog.getByRole('switch').first();
  if (await restrictToggle.count() === 0) {
    throw new Error('Restrict Key toggle not found - dialog layout changed');
  }
  if (await restrictToggle.getAttribute('aria-checked') !== 'true') {
    await clickHuman(page, restrictToggle);
    await page.waitForTimeout(400);
  }

  const groups = dialog.locator('[role="tablist"]');
  const total = await groups.count();
  if (total === 0) throw new Error('No endpoint permission groups found in the dialog');

  let granted = 0;
  for (let i = 0; i < total; i++) {
    const group = groups.nth(i);
    const write = group.locator('button[id$="-trigger-write"]');
    const target = (await write.count()) > 0
      ? write.first()
      : group.locator('button[id$="-trigger-access"]').first();

    if (await target.count() === 0) continue;
    if (await target.getAttribute('aria-selected') !== 'true') {
      await clickHuman(page, target);
      await page.waitForTimeout(80);
    }
    granted++;
  }

  // Verify rather than assume: a row still on "No Access" means the click did not register.
  const stillNone = await dialog.locator('button[id$="-trigger-none"][aria-selected="true"]').count();
  if (stillNone > 0) {
    throw new Error(`${stillNone} endpoint(s) still set to No Access after granting`);
  }
  console.log(`[9] Granted max permissions on ${granted}/${total} endpoint group(s)`);
}

// Sign in, clear onboarding, mint an API key and record the result. Shared by the full
// pipeline and by --resume, where the account already exists and only the key is missing.
// Submits the sign-in form and reports which of the three outcomes occurred. The caller
// decides what to do, because the right response differs: a verified account proceeds, an
// unverified one needs its mailbox, and rejected credentials cannot be recovered here.
const SIGN_IN = { OK: 'ok', UNVERIFIED: 'unverified', REJECTED: 'rejected' };

// Promise.race settles on the first promise to *settle*, and a rejection settles too - so a
// branch that fails fast would otherwise beat a slower success. Losing branches drop out of
// the race entirely; only a positive outcome or the overall timeout can decide it.
function firstOutcome(candidates, timeoutMs) {
  const NEVER = new Promise(() => {});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([
    ...candidates.map(({ promise, value }) => promise.then(() => value).catch(() => NEVER)),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

const SIGN_IN_EMAIL_SELECTOR = '#sign-in-form input[type="email"], #sign-in-form input[name="email"], [data-testid="sign-in-email-input"]';
const SIGN_IN_PASSWORD_SELECTOR = '#sign-in-form input[type="password"], #sign-in-form input[name="password"], [data-testid="sign-in-password-input"]';
const SIGN_IN_SUBMIT_SELECTOR = '[data-testid="sign-in-submit-button"], #sign-in-form button[type="submit"], #sign-in-form button:has(.sr-only)';

async function attemptSignIn(page, email, elevenPassword) {
  step('sign in ElevenLabs');

  const formShown = await page.waitForSelector(SIGN_IN_EMAIL_SELECTOR, { timeout: 10000 })
    .then(() => true).catch(() => false);
  if (!formShown) {
    // No form, and the URL has left the sign-in route: an existing session was reused and
    // the app went straight through. Nothing to submit.
    if (!page.url().includes('sign-in')) return SIGN_IN.OK;
    throw new Error('Sign-in form never appeared');
  }

  // Let hydration finish before typing - the signup step already does this.
  await page.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(page, SIGN_IN_EMAIL_SELECTOR, email);
  await page.waitForTimeout(300);
  await typeHuman(page, SIGN_IN_PASSWORD_SELECTOR, elevenPassword);
  await page.waitForTimeout(400);
  await clickHuman(page, SIGN_IN_SUBMIT_SELECTOR);
  await page.waitForTimeout(600);
  if (page.url().includes('sign-in')) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  const rejectionMatcher = page.locator('text=/No user is found|Incorrect email|Incorrect password|Invalid credentials|Wrong password|Invalid email/i')
    .or(page.getByText('No user is found', { exact: false }))
    .or(page.getByText('Incorrect email', { exact: false }))
    .or(page.getByText('Incorrect password', { exact: false }))
    .or(page.getByText('Invalid credentials', { exact: false }));

  const SETTLE_MS = 30000;
  const outcome = await firstOutcome([
    { value: SIGN_IN.OK,
      promise: page.waitForURL((url) => !url.toString().includes('sign-in'), { timeout: SETTLE_MS }) },
    // ElevenLabs keeps the URL on /sign-in for both of these, so match on the message.
    { value: SIGN_IN.UNVERIFIED,
      promise: page.getByText('verification link', { exact: false }).waitFor({ timeout: SETTLE_MS }) },
    { value: SIGN_IN.REJECTED,
      promise: rejectionMatcher.first().waitFor({ timeout: SETTLE_MS }) },
  ], SETTLE_MS);

  // If URL already left sign-in, the navigation won regardless of what the race returned.
  if (!page.url().includes('sign-in')) return SIGN_IN.OK;

  if (!outcome) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/No user is found|Incorrect email|Incorrect password|Invalid credentials|Wrong password|Invalid email/i.test(bodyText)) {
      return SIGN_IN.REJECTED;
    }
    if (/verification link/i.test(bodyText)) {
      return SIGN_IN.UNVERIFIED;
    }
    const shown = await page.locator(SIGN_IN_EMAIL_SELECTOR).first()
      .inputValue().catch(() => '<no field>');
    throw new Error(`Sign-in gave no recognised outcome (email field: "${shown}")`);
  }
  return outcome;
}

async function signInAndCreateKey(page, cred, elevenPassword) {
  const outcome = await attemptSignIn(page, cred.email, elevenPassword);
  if (outcome !== SIGN_IN.OK) {
    throw new Error(`Sign-in did not complete (${outcome})`);
  }
  await page.waitForTimeout(3000);

  await finishOnboardingAndKey(page, cred, elevenPassword);
}

// Onboarding, key creation and the sheet write. Split out so --resume can reach it
// without repeating the sign-up half of the pipeline.
async function finishOnboardingAndKey(page, cred, elevenPassword) {
  // 8. Onboarding
  step('onboarding');
  const { firstName } = generateRealisticName();

  // ElevenLabs keeps adding steps here - a "Choose your platform" screen appeared and the
  // previous fixed sequence (one Continue, then the name form, then three Skips) walked past
  // it, leaving onboarding unfinished. Navigating to the API keys page then bounced straight
  // back and failed looking for a button that was never going to exist.
  //
  // Drive it as a loop instead: while the app is still on /app/onboarding, fill the name form
  // if it is showing and otherwise press whatever advance control is present. That absorbs
  // new steps without needing to know their order.
  const ADVANCE_BUTTONS = ['Continue', 'Next', 'Skip', 'Get started', 'Got it'];
  const onboardingDeadline = Date.now() + ONBOARDING_TIMEOUT_MS;
  let lastSeen = '(nothing observed)';

  while (page.url().includes('/app/onboarding')) {
    if (Date.now() > onboardingDeadline) {
      throw new Error(
        `Onboarding did not finish within ${ONBOARDING_TIMEOUT_MS}ms.
Last seen: ${lastSeen}`);
    }

    // Wait for the step to render. Right after sign-in the app paints a blank splash, and
    // it also re-routes between steps - checking for controls during either window finds
    // nothing.
    await page.waitForFunction(() => document.body.innerText.trim().length > 0,
      { timeout: STEP_RENDER_TIMEOUT_MS }).catch(() => {});
      
    // Tầng 4: Nhịp thở tự nhiên (Thinking Time) khi quan sát giao diện mới
    await think(1200, 3800);

    // Tầng 4: Randomized Action Graph - Chọn ngẫu nhiên survey thay vì luôn Skip.
    // Matched by the ids ElevenLabs gives its answer tiles, not by excluding navigation text:
    // an exclusion list left "Select plan" as the only candidate on the pricing screen and
    // left "Back" selectable on both question screens. Those controls carry generic
    // button-_r_* ids, so matching the semantic prefixes rules them out structurally.
    if (Math.random() < 0.70) {
      const surveyOptions = page.locator(SURVEY_OPTION_SELECTOR);
      const optCount = await surveyOptions.count().catch(() => 0);

      if (optCount > 0) {
        const randIdx = Math.floor(Math.random() * optCount);
        const opt = surveyOptions.nth(randIdx);
        if (await opt.isVisible().catch(() => false)) {
          const label = await opt.getAttribute('aria-label').catch(() => null);
          console.log(`[onboarding] Phân tán hành vi: chọn "${label || randIdx}" (${optCount} lựa chọn)`);
          await clickHuman(page, opt).catch((e) => {
            console.warn(`[onboarding] random option click failed: ${safeErrorText(e)}`);
          });
          await think(800, 1500);
        }
      }
    }

    // The age confirmation is a Radix checkbox: the hidden input is name="adult" (not "age"),
    // and the thing that takes the click is the button, which wraps a .checkbox-hitarea.
    if (await page.$('#firstname')) {
      await typeHuman(page, '#firstname', firstName);
      await page.waitForTimeout(500);

      const ageCheckbox = await page.$('button[role="checkbox"]')
        || await page.$('.checkbox-hitarea')
        || await page.$('input[type="checkbox"][name*="adult"]');
      if (ageCheckbox) {
        if (await ageCheckbox.getAttribute('aria-checked') !== 'true') {
          await clickHuman(page, ageCheckbox);
          await page.waitForTimeout(400);
        }
      } else {
        console.warn('[onboarding] age confirmation checkbox not found - Next will stay disabled');
      }
    }

    // Record what this screen looks like, so a timeout can say what it kept seeing rather
    // than reporting an empty string.
    const heading = await page.evaluate(
      () => (document.querySelector('h1, h5')?.innerText || document.body.innerText.slice(0, 120)).trim(),
    ).catch(() => '');
    // Some of these buttons are whole cards containing a feature list, so their innerText
    // runs to dozens of lines. Collapse each to a single short label - this log is the main
    // diagnostic when a step is not recognised, and it has to stay readable.
    const labels = await page.evaluate(
      () => [...document.querySelectorAll('button')]
        .map((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map((t) => (t.length > 30 ? `${t.slice(0, 30)}…` : t))
        .slice(0, 12),
    ).catch(() => []);
    lastSeen = `"${heading}" with buttons [${labels.join(', ')}]`;

    let advanced = false;
    for (const label of ADVANCE_BUTTONS) {
      // ElevenLabs also ships clickable text with no button tag or ARIA role, so fall back
      // to matching the visible text.
      const byRole = page.getByRole('button', { name: label, exact: true });
      const byText = page.getByText(label, { exact: true });
      let control = null;
      for (const candidate of [byRole, byText]) {
        const first = candidate.first();
        if (await first.count().catch(() => 0) === 0) continue;
        if (!await first.isVisible().catch(() => false)) continue;
        control = first;
        break;
      }
      if (!control) continue;

      console.log(`[onboarding] ${lastSeen} -> "${label}"`);
      await clickHuman(page, control).catch((e) => {
        console.warn(`[onboarding] click on "${label}" failed: ${safeErrorText(e)}`);
      });
      await page.waitForTimeout(1500);
      advanced = true;
      break;
    }

    // Nothing matched. Do not call it stuck: the app may still be routing between steps, or
    // rendering one. Keep looking until the overall deadline decides.
    if (!advanced) await page.waitForTimeout(1000);
  }

  // Acknowledge welcome banners that appear once onboarding is behind us.
  await page.waitForSelector('button:has-text("Got it")', { timeout: 3000 })
    .then(() => clickHuman(page, 'button:has-text("Got it")'))
    .catch(() => {});

  // 9. Create API key
  step('create API key');
  await page.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  await page.waitForSelector('button:has-text("Got it")', { timeout: 5000 })
    .then(() => page.click('button:has-text("Got it")'))
    .catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.waitForSelector('button:has-text("Create Key")', { timeout: 10000 });
  await clickHuman(page, 'button:has-text("Create Key")');
  await page.waitForTimeout(1000);

  const keyName = 'Key-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await page.waitForSelector('input[placeholder="API Key Name"]', { timeout: 10000 });
  await page.fill('input[placeholder="API Key Name"]', '');
  await page.fill('input[placeholder="API Key Name"]', keyName);
  await page.waitForTimeout(500);

  await grantAllPermissions(page);

  // From this click onward the dialog may contain the one-time API key, even if reading it fails.
  cred.apiKeyMayBeVisible = true;
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create Key', exact: true })
    .last()
    .click({ timeout: 10000 });
  await page.waitForTimeout(1000);

  // Confirm "No Permissions Selected" dialog if it appears
  const confirmCreate = page.locator('button[data-agent-protected="true"]', { hasText: 'Create Key' });
  if (await confirmCreate.count() > 0) {
    await clickHuman(page, confirmCreate.last());
    await page.waitForTimeout(1500);
  }

  const keyDialog = page.getByRole('dialog');
  await page
    .getByRole('button', { name: 'Copy to Clipboard', exact: true })
    .click({ timeout: 15000 });
  await page.waitForTimeout(500);

  let apiKey = await keyDialog.locator('input[readonly]').first().inputValue().catch(() => '');
  if (!apiKey) {
    await page.bringToFront();
    apiKey = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  }
  if (!apiKey.startsWith('sk_')) {
    throw new Error('API key was not captured in the expected format');
  }

  console.log('[9] API Key captured and stored securely.');

  // Keep the captured values on the run record before the sheet write. If Google rejects the
  // update, the outer export still persists them locally without leaking them to stdout/logs.
  cred.apiKey = apiKey;
  cred.elevenPassword = elevenPassword;
  cred.apiKeyCapturedThisRun = true;

  await updateResultByEmail(cred.email, apiKey, elevenPassword, 'complete');

  console.log(`\n✅ Done: ${cred.email}`);
  return apiKey;
}

// Returns the first selector that exists on the page. Used where the exact markup has not
// been observed yet: on failure it prints the controls the page actually has, so a single
// real run is enough to pin the right selector down.
async function firstPresent(page, selectors, what) {
  for (const selector of selectors) {
    if (await page.locator(selector).count() > 0) return selector;
  }
  const controls = await page.evaluate(() =>
    [...document.querySelectorAll('input, button')].slice(0, 30).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      testid: el.getAttribute('data-testid'),
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      text: (el.textContent || '').trim().slice(0, 40),
    })));
  console.error(`[reset] ${what} not found. Controls on the page:`);
  for (const c of controls) console.error('   ', JSON.stringify(c));
  throw new Error(`${what} not found`);
}

// Recovers a row whose stored password no longer opens the account, by driving the
// "Forgot your password?" flow through the account's own Hotmail mailbox and choosing a
// fresh password. Reuses loginMicrosoft and pollOutlookInbox from the main pipeline.
async function resetPasswordAndCreateKey(ctx, cred) {
  const { rowIndex, email, password: hotmailPassword } = cred;
  const newPassword = generatePassword();
  cred.elevenPassword = newPassword;

  console.log(`
${'═'.repeat(60)}`);
  console.log(`▶ RESET ${email} (sheet row ${rowIndex})`);
  console.log(`${'═'.repeat(60)}`);
  console.log('  New ElevenLabs password: [generated and stored securely]');

  step('reset — MS login for reset link');
  const outlookPage = await loginMicrosoft(ctx, email, hotmailPassword);
  activePage = outlookPage;

  step('reset — request reset email');
  let page = await ctx.newPage();
  activePage = page;
  // The form has its own route, so go straight there instead of hunting for the link.
  await page.goto('https://elevenlabs.io/app/sign-in/forgot-password', { waitUntil: 'domcontentloaded' });
  const FORGOT_PASSWORD_EMAIL_SELECTOR = '[data-testid="forgot-password-email-input"], input[type="email"], input[name="email"], input[placeholder*="email" i]';
  await page.waitForSelector(FORGOT_PASSWORD_EMAIL_SELECTOR, { timeout: 20000 });
  await page.waitForTimeout(800 + Math.random() * 500);

  await typeHuman(page, FORGOT_PASSWORD_EMAIL_SELECTOR, email);
  await page.waitForTimeout(400);

  // Continue starts disabled and enables once the address validates; clickHuman waits for that.
  const resetRequestedAt = Date.now();
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true })
    .or(page.locator('button:has-text("Continue"), button[type="submit"]'));
  await clickHuman(page, continueBtn);

  // Confirm the request actually went out. Without this a silent failure would send us to
  // the mailbox to wait two minutes for an email that was never sent.
  await page.locator('text=/Check your Inbox|Check your email|sent you a link|sent a link/i')
    .or(page.getByText('Check your Inbox', { exact: false }))
    .or(page.getByText('Check your email', { exact: false }))
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {
      throw new Error(`Reset request not confirmed; still at ${safePageLocation(page)}`);
    });
  console.log('[reset] Reset email requested.');

  step('reset — poll Outlook for reset link');
  const resetUrl = await pollOutlookInbox(
    outlookPage,
    INBOX_TIMEOUT_MS,
    'resetPassword',
    resetRequestedAt,
  );
  activeAdditionalSecrets.push(...collectUrlSecrets(resetUrl));
  console.log('[reset] Reset URL found securely.');

  step('reset — set new password');
  page = await ctx.newPage();
  activePage = page;
  await page.goto(resetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.waitForTimeout(1000);

  // "Your new password" and "Repeat new password". Neither carries a data-testid, and each
  // has a visibility toggle overlaying its right edge - fill() sets the value without
  // clicking, so the toggle cannot intercept. :visible guards against the hidden
  // autocomplete input ElevenLabs ships on its other auth forms.
  const fields = page.locator('input[type="password"]:visible');
  const fieldCount = await fields.count();
  if (fieldCount === 0) {
    await firstPresent(page, ['input[type="password"]:visible'], 'new password field');
  }
  for (let i = 0; i < fieldCount; i++) {
    const field = fields.nth(i);
    await field.click();
    await field.fill('');
    // typeHuman expects a selector string; use keyboard directly after focusing via click
    await page.keyboard.type(newPassword, { delay: 40 + Math.random() * 60 });
    await page.waitForTimeout(200);
  }
  console.log(`[reset] Filled ${fieldCount} password field(s).`);

  const saveButton = page.getByRole('button', { name: 'Change Password', exact: true });

  // The button unlocks only once every rule passes. Waiting on click() alone would burn the
  // full timeout and report nothing useful, so surface which rule rejected the password.
  const enabled = await saveButton.waitFor({ state: 'attached', timeout: 10000 })
    .then(() => page.waitForFunction(
      () => {
        const b = [...document.querySelectorAll('button[type="submit"]')]
          .find((el) => el.textContent.includes('Change Password'));
        return b ? !b.disabled : false;
      },
      { timeout: 10000 },
    ).then(() => true).catch(() => false))
    .catch(() => false);

  if (!enabled) {
    const rules = await page.evaluate(() =>
      [...document.querySelectorAll('p.text-xs')].map((el) => el.textContent.trim()));
    console.error(`[reset] "Change Password" stayed disabled for a ${newPassword.length}-char password.`);
    console.error(`[reset] Form requirements: ${rules.join(' | ')}`);
    throw new Error('New password rejected by the form validator');
  }

  const recoveryEntry = prepareRecovery({
    operation: 'resetPassword',
    email,
    originalRowIndex: rowIndex,
    elevenPassword: newPassword,
  });
  await clickHuman(page, saveButton);

  // ElevenLabs shows the success message ("Password has been changed") ON the same
  // /sign-in/reset-password URL — it does not navigate away on success.
  // An expired link also lands on /sign-in/reset-password but shows "Something went wrong".
  // Therefore URL alone is useless; body text is the only reliable signal.
  await page.waitForTimeout(2000);
  console.log(`[reset] Post-reset page location: ${safePageLocation(page)}`);

  const postResetText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const passwordChanged = /password has been changed|successfully changed your password/i.test(postResetText);
  const resetFailed = /something went wrong|expired|invalid link/i.test(postResetText);

  if (!passwordChanged) {
    if (resetFailed) {
      throw new Error(`Password reset rejected by ElevenLabs: ${postResetText.split('\n')[0] || 'Unknown error'}`);
    }
    // Neither success nor known failure — URL might have navigated elsewhere
    if (page.url().includes('/app/action')) {
      throw new Error('Password change was not confirmed — still on action URL');
    }
    // If we reached a completely different page without success text, assume expired
    if (page.url().includes('/sign-in/reset-password')) {
      throw new Error(`Password reset page showed no confirmation. Body: ${postResetText.split('\n')[0]}`);
    }
  }

  step('reset — sign in with new password');
  // ElevenLabs shows a "Password has been changed" confirmation with "Continue to Sign In"
  const continueToSignInBtn = page.getByRole('button', { name: 'Continue to Sign In' })
    .or(page.getByRole('link', { name: 'Continue to Sign In' }))
    .or(page.locator('button:has-text("Continue to Sign In"), a:has-text("Continue to Sign In")'));
  if (await continueToSignInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await clickHuman(page, continueToSignInBtn);
    await page.waitForTimeout(1500);
  }

  const currentUrl = page.url();
  if (currentUrl !== 'https://elevenlabs.io/app/sign-in' && !currentUrl.endsWith('/app/sign-in')) {
    await page.goto('https://elevenlabs.io/app/sign-in', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector(SIGN_IN_EMAIL_SELECTOR, { timeout: 20000 });
  await page.waitForTimeout(1000);

  // ElevenLabs may take a few seconds to propagate the new password — retry with backoff.
  let outcome = SIGN_IN.REJECTED;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.log(`[reset] Sign-in attempt ${attempt}/3 after password reset (waiting 5s)...`);
      await page.waitForTimeout(5000);
      await page.goto('https://elevenlabs.io/app/sign-in', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      // If already logged in, the server redirects straight to /app/home or /app/onboarding
      const afterGotoUrl = page.url();
      if (afterGotoUrl.includes('/app/home') || afterGotoUrl.includes('/app/onboarding')
        || afterGotoUrl.includes('/app/') && !afterGotoUrl.includes('/app/sign-in')) {
        console.log(`[reset] Already signed in (redirected to ${afterGotoUrl}), treating as OK`);
        outcome = SIGN_IN.OK;
        break;
      }
      await page.waitForSelector(SIGN_IN_EMAIL_SELECTOR, { timeout: 20000 });
      await page.waitForTimeout(1000);
    }
    outcome = await attemptSignIn(page, email, newPassword);
    if (outcome === SIGN_IN.OK) break;
    console.log(`[reset] Sign-in attempt ${attempt}/3 result: ${outcome}`);

    if (outcome === SIGN_IN.UNVERIFIED && attempt === 1) {
      console.log('[reset] Account is unverified (fresh link auto-sent by ElevenLabs). Polling Outlook...');
      const verifyRequestedAt = Date.now() - 30000;
      step('reset — poll Outlook for verify email');
      const verifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS, 'verifyEmail', verifyRequestedAt);
      activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl));
      
      step('reset — open verify URL');
      await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      
      step('reset — click Continue');
      await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
      await clickHuman(page, 'button:has-text("Continue")');
      await page.waitForTimeout(2000);
    } else if (outcome === SIGN_IN.UNVERIFIED) {
      const resendBtn = page.getByRole('button', { name: 'Resend', exact: true }).or(page.locator('button:has-text("Resend")'));
      if (await resendBtn.count() > 0) {
        console.log('[reset] Clicking Resend...');
        const requestedAt = Date.now();
        await clickHuman(page, resendBtn.first());
        step('reset — poll Outlook for resend verify email');
        const verifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS, 'verifyEmail', requestedAt);
        activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl));
        await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
        await clickHuman(page, 'button:has-text("Continue")');
        await page.waitForTimeout(2000);
      }
    }
  }
  if (outcome !== SIGN_IN.OK) {
    throw new Error(`Sign-in still failed after password reset (${outcome})`);
  }

  // Navigation away from the action URL can also be an expired/error redirect. Only a
  // successful sign-in proves the new password is safe to persist.
  confirmRecovery(recoveryEntry.id);
  await updatePasswordByEmail(email, newPassword);
  removeRecovery(recoveryEntry.id);
  await page.waitForTimeout(3000);

  if (cred.apiKey) {
    cred.elevenPassword = newPassword;
    await updatePasswordAndStatusByEmail(email, newPassword, 'complete');
    console.log(`[reset] Existing API key preserved for ${email}.`);
    return cred.apiKey;
  }

  await finishOnboardingAndKey(page, cred, newPassword);
}

// Mints a fresh key on an account that already works, for rows whose original key was
// created before permissions were granted explicitly. Signs in with the stored password;
// no mailbox and no CAPTCHA are involved. The previous key stays live on the account -
// column F simply stops pointing at it.
async function regenerateAccountKey(ctx, cred) {
  const { rowIndex, email, elevenPass } = cred;

  console.log(`
${'='.repeat(60)}`);
  console.log(`> RE-KEY ${email} (sheet row ${rowIndex})`);
  console.log(`${'='.repeat(60)}`);

  step('re-key - open sign-in');
  const page = await ctx.newPage();
  activePage = page;
  await page.goto('https://elevenlabs.io/app/sign-in', { waitUntil: 'domcontentloaded' });

  const outcome = await attemptSignIn(page, email, elevenPass);
  if (outcome !== SIGN_IN.OK) {
    throw new Error(`Cannot sign in to re-key (${outcome})`);
  }
  await page.waitForTimeout(3000);

  // Onboarding is already done for these accounts; every step in there is optional and
  // no-ops when its control is absent.
  await finishOnboardingAndKey(page, cred, elevenPass);
}

// Picks up an account that already exists but has no key. Three states are possible and
// they need different handling, so the sign-in outcome drives the branch:
//   ok         - verified account, go straight to the key dialog
//   unverified - signup landed but the verify link was never completed; fetch it from Outlook
//   rejected   - the stored password does not open the account; nothing to do here
async function resumeAccount(ctx, cred) {
  const { rowIndex, email, password: hotmailPassword, elevenPass } = cred;

  console.log(`
${'═'.repeat(60)}`);
  console.log(`▶ RESUME ${email} (sheet row ${rowIndex})`);
  console.log(`${'═'.repeat(60)}`);

  step('resume — open sign-in');
  let page = await ctx.newPage();
  activePage = page;
  await page.goto('https://elevenlabs.io/app/sign-in', { waitUntil: 'domcontentloaded' });

  let outcome = await attemptSignIn(page, email, elevenPass);

  if (outcome === SIGN_IN.REJECTED) {
    // Most likely the signup password was truncated before typeHuman verified its input, so
    // the stored password never matched. Recovering needs a password reset, which this script
    // does not do - flag it distinctly instead of leaving a misleading 'failed:<step>'.
    console.error(`[resume] Credentials rejected for ${email}; a password reset is required.`);
    await updateStatusByEmail(email, 'credentials-rejected');
    return false;
  }

  if (outcome === SIGN_IN.UNVERIFIED) {
    console.log('[resume] Account exists but its email is unverified; fetching the link.');

    step('resume — MS login for verify link');
    const outlookPage = await loginMicrosoft(ctx, email, hotmailPassword);
    activePage = outlookPage;

    step('resume — poll Outlook for verify email');
    const verifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS);
    activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl));
    console.log('[resume] Verify URL found securely.');

    step('resume — open verify URL');
    page = await ctx.newPage();
    activePage = page;
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });

    step('resume — click Continue');
    await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
    await clickHuman(page, 'button:has-text("Continue")');
    await page.waitForTimeout(2000);

    outcome = await attemptSignIn(page, email, elevenPass);
    if (outcome === SIGN_IN.UNVERIFIED) {
      console.log('[resume] Unverified notice shown on sign-in (fresh link auto-sent by ElevenLabs). Polling Outlook for fresh email...');
      const verifyRequestedAt = Date.now() - 30000;

      step('resume — poll Outlook for fresh verify email');
      const freshVerifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS, 'verifyEmail', verifyRequestedAt);
      activeAdditionalSecrets.push(...collectUrlSecrets(freshVerifyUrl));

      step('resume — open fresh verify URL');
      await page.goto(freshVerifyUrl, { waitUntil: 'domcontentloaded' });

      step('resume — click Continue');
      await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
      await clickHuman(page, 'button:has-text("Continue")');
      await page.waitForTimeout(2000);

      outcome = await attemptSignIn(page, email, elevenPass);
    }
    if (outcome !== SIGN_IN.OK) {
      throw new Error(`Sign-in still failed after verifying (${outcome})`);
    }
    await page.waitForTimeout(3000);

    await finishOnboardingAndKey(page, cred, elevenPass);
    return;
  }

  await page.waitForTimeout(3000);
  await finishOnboardingAndKey(page, cred, elevenPass);
}
// ── Main loop ────────────────────────────────────────────────────────────────
// --limit N  process at most N accounts (default: all)
// --row N    process only the account on sheet row N
function parseArgs(argv) {
  const booleanOptions = new Set([
    '--resume',
    '--reset-password',
    '--regenerate-key',
    '--no-proxy',
    '--audit-weak-passwords',
  ]);
  const valueOptions = ['--limit=', '--row=', '--rows=', '--interval=', '--expected-email='];
  for (const option of argv) {
    if (booleanOptions.has(option) || valueOptions.some((prefix) => option.startsWith(prefix))) continue;
    if (option === '--reset') {
      throw new Error('Unknown option: --reset. Use --reset-password instead.');
    }
    throw new Error(`Unknown option: ${option}`);
  }

  const findValueOption = (prefix) => {
    const matches = argv.filter((option) => option.startsWith(prefix));
    if (matches.length > 1) throw new Error(`Option ${prefix.slice(0, -1)} may only be provided once`);
    return matches[0] || null;
  };

  const limitArg = findValueOption('--limit=');
  const rowArg = findValueOption('--row=');
  const resume = argv.includes('--resume');
  const resetPassword = argv.includes('--reset-password');
  const regenerateKey = argv.includes('--regenerate-key');
  const noProxy = argv.includes('--no-proxy');
  const auditWeakPasswords = argv.includes('--audit-weak-passwords');
  const rowsArg = findValueOption('--rows=');
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const row = rowArg ? Number(rowArg.split('=')[1]) : null;
  const intervalArg = findValueOption('--interval=');
  const interval = intervalArg ? Number(intervalArg.split('=')[1]) : 1; // Mặc định 1 phút
  const expectedEmailArg = findValueOption('--expected-email=');
  const expectedEmail = expectedEmailArg ? expectedEmailArg.slice('--expected-email='.length).trim() : null;

  if (limitArg && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got: ${limitArg.split('=')[1]}`);
  }
  if (rowArg && (!Number.isInteger(row) || row < 2)) {
    throw new Error(`--row must be a sheet row >= 2 (row 1 is the header), got: ${rowArg.split('=')[1]}`);
  }
  if (intervalArg && (!Number.isFinite(interval) || interval <= 0)) {
    throw new Error(`--interval must be a positive number, got: ${intervalArg.split('=')[1]}`);
  }
  if (expectedEmailArg && !expectedEmail) {
    throw new Error('--expected-email must not be empty');
  }

  let rows = null;
  if (rowsArg) {
    rows = rowsArg.split('=')[1].split(',').map((n) => Number(n.trim()));
    if (rows.some((n) => !Number.isInteger(n) || n < 2)) {
      throw new Error(`--rows must be sheet rows >= 2 (row 1 is the header), got: ${rowsArg.split('=')[1]}`);
    }
  }
  if (regenerateKey && !rows) {
    throw new Error('--regenerate-key needs --rows=<n,n,...> naming the rows to re-key');
  }
  if (rows && !regenerateKey) {
    throw new Error('--rows is only valid with --regenerate-key');
  }
  if (row !== null && rows) throw new Error('--row and --rows are mutually exclusive');
  if ([resume, resetPassword, regenerateKey, auditWeakPasswords].filter(Boolean).length > 1) {
    throw new Error('Workflow mode options are mutually exclusive');
  }
  for (const option of booleanOptions) {
    if (argv.filter((candidate) => candidate === option).length > 1) {
      throw new Error(`Option ${option} may only be provided once`);
    }
  }
  if (expectedEmail && row === null && (!rows || rows.length !== 1)) {
    throw new Error('--expected-email requires exactly one --row or --rows target');
  }
  if (auditWeakPasswords && (limitArg || rowArg || rowsArg || intervalArg || expectedEmailArg || noProxy)) {
    throw new Error('--audit-weak-passwords cannot be combined with automation options');
  }

  return {
    limit,
    row,
    rows,
    resume,
    resetPassword,
    regenerateKey,
    noProxy,
    interval,
    expectedEmail,
    auditWeakPasswords,
  };
}

function selectWorkflowRows(allRows, workflowId, { row = null, explicitReset = false } = {}) {
  return allRows.filter((account) => (row === null || account.rowIndex === row)
    && isEligibleForWorkflow(account, workflowId, { explicitReset }));
}

function selectResetPasswordRows(allRows, row, { explicitReset = row !== null } = {}) {
  return selectWorkflowRows(allRows, 'resetPassword', { row, explicitReset });
}

function assertSafeAccountIdentities(selectedRows, allRows = selectedRows) {
  for (const account of selectedRows) {
    const normalizedEmail = String(account.email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      throw new Error(`Sheet row ${account.rowIndex} has no email identity; refusing automation`);
    }
    const matches = allRows.filter(
      (candidate) => String(candidate.email || '').trim().toLowerCase() === normalizedEmail,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Account identity ${account.email} is not unique; found ${matches.length} matching Sheet rows`,
      );
    }
  }
  return selectedRows;
}

async function run(argv = process.argv.slice(2), reporter = null, executionOptions = {}) {
  cancellationRequested = false;
  runReporter = reporter;
  const {
    limit, row, rows, resume, resetPassword, regenerateKey, noProxy, interval, expectedEmail,
    auditWeakPasswords: auditOnly,
  } = parseArgs(argv);

  if (auditOnly) {
    try {
      return await auditWeakPasswords();
    } finally {
      runReporter = null;
    }
  }

  const explicitReset = executionOptions.explicitReset
    ?? (resetPassword && row !== null && !expectedEmail);

  const runtimeConfig = loadRuntimeConfig();
  activeRuntimeConfig = runtimeConfig;
  const proxyConfig = noProxy
    ? { provider: 'none', apiKey: null }
    : resolveProxyConfig(runtimeConfig);

  await initSheets();
  await syncConfirmedRecoveries({ updatePasswordByEmail });
  assertNoPreparedRecoveries();
  const allRows = await loadRows();
  if (expectedEmail) {
    const expectedRowIndex = row === null ? rows[0] : row;
    const current = allRows.find((account) => account.rowIndex === expectedRowIndex);
    if (!current || current.email.trim().toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(`Sheet row identity changed; expected ${expectedEmail} at row ${expectedRowIndex}`);
    }
    const workflowId = regenerateKey ? 'regenerateKey'
      : resetPassword ? 'resetPassword'
      : resume ? 'resume'
      : 'signup';
    if (!isEligibleForWorkflow(current, workflowId, { explicitReset })) {
      throw new Error(`Account ${expectedEmail} is no longer eligible for ${workflowId}`);
    }
  }

  // --resume targets accounts that already exist: a password was recorded but no key was
  // ever captured. Returning these to 'pending' would not work - signup rejects the email
  // as already registered - so they are selected by content, not by status.
  let pendingRows;
  if (regenerateKey) {
    // Named explicitly: nothing in the sheet records how a key's permissions were granted,
    // so which rows need re-keying is a judgement only the operator can make.
    pendingRows = allRows.filter((r) => rows.includes(r.rowIndex));
    const missing = rows.filter((n) => !pendingRows.some((r) => r.rowIndex === n));
    if (missing.length) throw new Error(`No such row(s) in the sheet: ${missing.join(', ')}`);
    const noPassword = pendingRows.filter((r) => !r.elevenPass);
    if (noPassword.length) {
      throw new Error(`Row(s) ${noPassword.map((r) => r.rowIndex).join(', ')} have no stored password to sign in with`);
    }
    console.log(`Re-keying ${pendingRows.length} account(s): rows ${rows.join(', ')}`);
  } else if (resetPassword) {
    // Bulk mode remains conservative, while an explicitly named row is an operator override.
    pendingRows = selectResetPasswordRows(allRows, row, { explicitReset });
    console.log(row === null
      ? `Loaded ${pendingRows.length} account(s) needing a password reset`
      : `Loaded ${pendingRows.length} account(s) selected for password reset`);
  } else if (resume) {
    pendingRows = selectWorkflowRows(allRows, 'resume');
    console.log(`Loaded ${pendingRows.length} resumable accounts from Google Sheet`);
  } else {
    pendingRows = selectWorkflowRows(allRows, 'signup');
    console.log(`Loaded ${pendingRows.length} pending accounts from Google Sheet`);
  }

  if (row !== null) {
    pendingRows = pendingRows.filter((r) => r.rowIndex === row);
    if (pendingRows.length === 0) {
      console.log(resetPassword
        ? `Row ${row} does not exist. Exiting.`
        : `Row ${row} is not pending (or does not exist). Exiting.`);
      runReporter = null;
      activeRuntimeConfig = null;
      return { processedAccounts: 0 };
    }
  }

  if (pendingRows.length > limit) {
    pendingRows = pendingRows.slice(0, limit);
    console.log(`Limited to first ${limit} account(s) by --limit.`);
  }

  if (pendingRows.length === 0) {
    const what = resetPassword ? 'accounts needing a reset' : resume ? 'resumable accounts' : 'pending accounts';
    console.log(`No ${what}. Exiting.`);
    runReporter = null;
    activeRuntimeConfig = null;
    return { processedAccounts: 0 };
  }

  assertSafeAccountIdentities(pendingRows, allRows);

  if (noProxy) {
    console.log('\n[proxy] --no-proxy: skipping proxy for this run.');
  }

  // The browser will be launched per-account via GPM-Login API.
  for (let i = 0; i < pendingRows.length; i++) {
    const cred = pendingRows[i];
    const existingApiKey = cred.apiKey;
    activeAccount = cred;
    activeProxyString = '';
    activeAdditionalSecrets = [existingApiKey];
    activeRowIndex = cred.rowIndex;
    console.log(`\n[${i + 1}/${pendingRows.length}] ${cred.email} (sheet row ${cred.rowIndex})`);
    emitRunEvent('account.started', `Bắt đầu ${cred.email}`, {
      email: cred.email,
      accountNumber: i + 1,
      totalAccounts: pendingRows.length,
    });

    // Reset before the try: otherwise a throw raised before this account's first step() call
    // would be attributed to the previous account's last step.
    currentStep = 'account start';

    // loadRows fills apiKey from column F, so a row that already had a key would otherwise
    // look successful even when this run failed - a failed --regenerate-key wrote a CSV entry
    // carrying the stale key and an undefined password. Only this run may set these.
    cred.apiKey = resetPassword ? existingApiKey : null;
    cred.elevenPassword = null;
    cred.apiKeyMayBeVisible = false;
    cred.apiKeyCapturedThisRun = false;
    cred.capturedCredentialsPersisted = false;

    // One context per account. A fresh context drops cookies, localStorage and IndexedDB, so
    // the previous account's Microsoft session cannot leak into this login. Closing it also
    // disposes every tab the account opened.
    
    let proxyString = '';
    // --- Proxy rotation: TinProxy FPT or SP07 ---
    if (proxyConfig.provider !== 'none') {
      if (proxyConfig.provider === 'tinproxy') {
        step('rotate proxy (TinProxy)');
        try {
          const proxyData = await getNewTinProxyWithRetry(proxyConfig.apiKey);
          proxyString = proxyData.proxy;
          activeProxyString = proxyString;
          console.log('[proxy] Proxy acquired securely.');
        } catch (err) {
          console.error(`\n❌ FAILED [${cred.email}] at step: proxy rotation`);
          console.error(safeErrorText(err));
          await updateStatusByEmail(cred.email, 'failed:proxy_api');
          emitRunEvent('account.failed', 'Không thể rotate proxy', {
            email: cred.email,
            step: 'proxy rotation',
            status: 'failed:proxy_api',
            error: err.message,
          }, 'error');
          activeAccount = null;
          activeProxyString = '';
          activeAdditionalSecrets = [];
          continue;
        }
      } else if (proxyConfig.provider === 'sp07') {
        step('rotate proxy (SP07)');
        console.log('[proxy] Fetching new proxy from SP07...');
        try {
          const proxyData = await getNewProxyWithRetry(proxyConfig.apiKey);
          proxyString = proxyData.proxy;
          activeProxyString = proxyString;
          console.log('[proxy] Proxy acquired securely.');
        } catch (err) {
          console.error(`\n❌ FAILED [${cred.email}] at step: proxy rotation`);
          console.error(safeErrorText(err));
          await updateStatusByEmail(cred.email, 'failed:proxy_api');
          emitRunEvent('account.failed', 'Không thể rotate proxy', {
            email: cred.email,
            step: 'proxy rotation',
            status: 'failed:proxy_api',
            error: err.message,
          }, 'error');
          activeAccount = null;
          activeProxyString = '';
          activeAdditionalSecrets = [];
          continue;
        }
      }
    }

    gpmProfileId = null;
    let ctx = null;

    try {
      step('create GPM profile');
      gpmProfileId = await createTrackedProfile(cred.email, proxyString);
      console.log(`[GPM] Created profile ${gpmProfileId}`);
      if (cancellationRequested) throw new Error('Job cancelled');
      
      step('start GPM profile');
      const debugAddress = await gpm.startProfile(gpmProfileId);
      console.log(`[GPM] Started, debug address: ${debugAddress}`);
      // Đợi trình duyệt GPM thực sự sẵn sàng
      await new Promise(r => setTimeout(r, 3000));

      step('connect to GPM via CDP');
      browser = await chromium.connectOverCDP(`http://${debugAddress}`);
      const contexts = browser.contexts();
      ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();

      // Every path writes its own success row via updateResult.
      let workflowResult;
      if (regenerateKey) workflowResult = await regenerateAccountKey(ctx, cred);
      else if (resetPassword) workflowResult = await resetPasswordAndCreateKey(ctx, cred);
      else if (resume) workflowResult = await resumeAccount(ctx, cred);
      else workflowResult = await processAccount(ctx, cred, proxyString);
      if (workflowResult === false) {
        emitRunEvent('account.failed', 'Credential ElevenLabs bị từ chối; cần reset mật khẩu', {
          email: cred.email,
          step: currentStep,
          status: 'credentials-rejected',
        }, 'error');
      } else {
        emitRunEvent('account.succeeded', `Hoàn thành ${cred.email}`, { email: cred.email });
      }
    } catch (err) {
      console.error(`\n❌ FAILED [${cred.email}] at step: ${currentStep}`);
      console.error(safeErrorText(err));

      // Classify failure: MS login steps = account inactive/bad creds.
      // But a transport failure (proxy refusing, connection closed, DNS) says nothing about
      // the mailbox - the credentials were never even submitted. Calling that 'inactive'
      // tells the operator to write off a perfectly good account; observed when a US proxy
      // could not reach login.live.com and the row was marked dead.
      const isNetworkError = err.code === 'MS_NETWORK'
        || /net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed/i
          .test(`${err.code || ''} ${err.message || ''}`);
      const isInactive = err.code === 'MS_BAD_CREDENTIALS';
      // A refused address and an unsolved CAPTCHA both fail on the sign-up step, but they need
      // opposite recoveries: one is a plain retry, the other means an ElevenLabs account
      // already exists whose password was never recorded, so only --reset-password can reach
      // it. Sharing one 'failed:<step>' label would hide that, exactly as network failures
      // once hid behind 'inactive'.
      const failStatus = err.code === 'ALREADY_REGISTERED' ? 'already-registered'
        : err.code === 'MS_RECOVERY_REQUIRED' ? 'need to recover password'
        : isNetworkError ? 'failed:network'
        : isInactive ? 'inactive'
        : `failed:${currentStep}`;

      // Status column only. Never blank F/G here: the ElevenLabs account may already exist
      // with its password recorded, and losing it would orphan the account for good.
      await updateStatusByEmail(cred.email, failStatus)
        .catch((e) => {
          console.error(`[sheet] status write failed: ${safeErrorText(e)}`);
          throw e;
        });
      emitRunEvent('account.failed', `Thất bại tại ${currentStep}`, {
        email: cred.email,
        step: currentStep,
        status: failStatus,
        error: err.message,
      }, 'error');

      if (err.code === gpm.GPM_CREATE_UNCERTAIN) throw err;

      if (!activePage || activePage.isClosed()) {
        console.error(`[debug] No page to capture (activePage ${activePage ? 'was closed' : 'was never set'})`);
      }
      if (cred.apiKeyMayBeVisible) {
        console.error('[debug] Screenshot skipped because the page may contain a captured API key.');
      } else if (activePage && !activePage.isClosed()) {
        try {
          console.error(`[debug] Page: ${safePageLocation(activePage)}`);
          const text = await activePage.evaluate(() => document.body.innerText.slice(0, 600));
          console.error(`[debug] Visible text:\n${redactSecrets(text, currentSecrets())}`);
          // Per-row filename: a shared path meant each failure erased the previous evidence.
          const shot = FAILURE_SCREENSHOT.replace(/\.png$/, `-row${cred.rowIndex}.png`);
          await activePage.screenshot({
            path: shot,
            fullPage: true,
            mask: [activePage.locator('input[type="password"]')],
          });
          console.error(`[debug] Screenshot: ${shot}`);
          emitRunEvent('artifact.created', 'Đã lưu screenshot lỗi', { path: shot, kind: 'screenshot' }, 'warning');
        } catch (e) {
          console.error(`[debug] Capture failed: ${safeErrorText(e)}`);
        }
      }

      // An uncertain remote password mutation must stop this batch before another account
      // starts. The journal is the operator's recovery boundary, not just a startup check.
      assertNoPreparedRecoveries();
      console.log('Continuing to next account...');
    } finally {
      let persistenceError = null;
      let cleanupError = null;
      try {
        persistCapturedCredentials(cred, proxyString);
      } catch (error) {
        persistenceError = error;
        console.error(`[export] Captured credential persistence failed: ${safeErrorText(error)}`);
      }
      try {
        await releaseProfile();
      } catch (error) {
        cleanupError = error;
      }
      activeAccount = null;
      activeProxyString = '';
      activeAdditionalSecrets = [];
      if (persistenceError && cleanupError) {
        const combinedError = new AggregateError(
          [persistenceError, cleanupError],
          'Captured credential persistence and GPM profile cleanup both failed',
        );
        combinedError.preserveAutomationLock = true;
        throw combinedError;
      }
      if (persistenceError) throw persistenceError;
      if (cleanupError) throw cleanupError;
    }

    // Tầng 4: Phân bố Poisson - Delay ngẫu nhiên giữa các luồng
    if (i < pendingRows.length - 1) {
      const delayMs = poissonIntervalDelay(interval);
      console.log(`\n[Anti-Graph] Đợi ${Math.round(delayMs / 1000)}s trước khi chạy tài khoản tiếp theo...`);

      // A silent multi-minute setTimeout is indistinguishable from a hang, which is why
      // the CAPTCHA wait ticks. Same answer here for anything over a minute.
      const until = Date.now() + delayMs;
      const ticker = delayMs > 60000
        ? setInterval(() => console.log(`   …còn ${Math.round((until - Date.now()) / 1000)}s`), 30000)
        : null;
      try {
        await new Promise((r) => setTimeout(r, delayMs));
      } finally {
        if (ticker) clearInterval(ticker);
      }
    }
  }

  console.log('\n✅ All accounts processed.');
  activeRowIndex = null;
  activeAccount = null;
  activeProxyString = '';
  activeAdditionalSecrets = [];
  runReporter = null;
  activeRuntimeConfig = null;
  return { processedAccounts: pendingRows.length };
}

async function cancelActiveRun() {
  cancellationRequested = true;
  emitRunEvent('job.state', 'Đang hủy lượt chạy', { status: 'cancelling' }, 'warning');
  await releaseProfile();
}

async function focusActiveBrowser() {
  if (!activePage || activePage.isClosed()) return false;
  await activePage.bringToFront();
  return true;
}

if (require.main === module) {
  installCliSignalHandlers();
  const executeCli = process.argv.slice(2).includes('--audit-weak-passwords')
    ? () => run()
    : () => withAutomationLock('signup-cli', () => run());
  executeCli()
    .catch(async (err) => {
      console.error('\n❌ Fatal error:', safeErrorText(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      // A throw outside the per-account try - proxy setup, sheet init - skips the finally that
      // normally releases the profile, so the outer path has to release it too.
      await releaseProfile().catch((err) => console.error(`[cleanup] ${safeErrorText(err)}`));
    });
}

module.exports = {
  activateMicrosoftPasswordRoute,
  assertSafeAccountIdentities,
  auditWeakPasswords,
  cancelActiveRun,
  focusActiveBrowser,
  loginMicrosoft,
  parseArgs,
  releaseProfile,
  run,
  selectResetPasswordRows,
  selectWorkflowRows,
  selectWeakPasswordRows,
};
