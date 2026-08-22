const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const FAILURE_SCREENSHOT = path.join(__dirname, 'debug-failure.png');

const SIGNUP_TIMEOUT_MS = 300000;
const INBOX_TIMEOUT_MS = 120000;

// Tracked at module scope so the failure handler can screenshot the page that broke
// and still persist whatever credentials were already created.
let context = null;
let activePage = null;
let currentStep = 'init';
let account = null;

function step(name) {
  currentStep = name;
  console.log(`[step] ${name}`);
}

function saveAccount(record) {
  const accounts = fs.existsSync(ACCOUNTS_FILE)
    ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
    : [];
  // Derive from max id, not length: deleting a middle entry would otherwise collide.
  const id = accounts.reduce((max, a) => Math.max(max, a.id ?? 0), 0) + 1;
  accounts.push({ id, ...record, createdAt: new Date().toISOString() });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  console.log(`[✓] Account #${id} saved to accounts.json`);
  return id;
}

// ── mail.tm REST API ────────────────────────────────────────────────────────
async function createMailTmAccount() {
  const base = 'https://api.mail.tm';

  // Get available domains
  const domainsRes = await fetch(`${base}/domains?page=1`);
  const domainsJson = await domainsRes.json();
  const domain = domainsJson['hydra:member'][0].domain;

  const username = Math.random().toString(36).slice(2, 10);
  const password = 'Passw0rd!';
  const address = `${username}@${domain}`;

  // Create account
  const createRes = await fetch(`${base}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (!createRes.ok) throw new Error(`Create account failed: ${createRes.status}`);

  // Get token
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const { token } = await tokenRes.json();

  return { address, password, token };
}

async function pollMailTmInbox(token, timeoutMs = 120000) {
  const base = 'https://api.mail.tm';
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    const messages = json['hydra:member'];

    // Scan every message, not just the newest: any unrelated mail arriving first would
    // otherwise mask the verification mail until the timeout expires.
    for (const { id } of messages ?? []) {
      const msgRes = await fetch(`${base}/messages/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const msg = await msgRes.json();
      const body = [...(msg.html ?? []), msg.text ?? ''].join(' ');

      // Extract ElevenLabs verify URL
      const match = body.match(/href="(https:\/\/elevenlabs\.io\/app\/action[^"]+)"/);
      if (match) return match[1].replace(/&amp;/g, '&');
    }

    console.log('[5] No email yet, waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timeout: no verification email received');
}

function generatePassword() {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const specials = '!@#$%^&*';
  const rand = (str) => str[Math.floor(Math.random() * str.length)];
  return Array.from({ length: 6 }, () => rand(letters)).join('') + rand(numbers) + rand(specials);
}

function safePageLocation(page) {
  try {
    const url = new URL(page.url());
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[unknown page]';
  }
}

// Human-like typing
async function typeHuman(page, selector, text) {
  await page.click(selector);
  // Clear first: browser autofill can pre-populate the field, which would corrupt the value.
  await page.fill(selector, '');
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 80 });
  }
}

async function run() {
  // ── STEP 1: Create mail.tm account ─────────────────────────────────────────
  step('1/10 create mail.tm account');
  const { address: email, password: mailboxPassword, token: mailToken } = await createMailTmAccount();
  const password = generatePassword();

  // Registered early so a mid-run failure still persists the usable credentials.
  account = { email, password, mailboxPassword, mailboxToken: mailToken, apiKey: null };

  console.log(`✅ Email: ${email}`);
  console.log('✅ Password generated and stored securely.');

  // ── STEP 2: Launch real Chrome with copied user profile ────────────────────
  const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const PROFILE_DIR = 'D:\\VibeCoding\\mail-temp\\chrome-profile';

  step('2/10 launch chrome');
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_EXE,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--profile-directory=Default',
      // Earlier crashed runs left the profile dirty; this suppresses the leftover prompt.
      '--hide-crash-restore-bubble',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    slowMo: 50,
    // navigator.clipboard.readText() throws without this (used to read the generated API key).
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  // Hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ── STEP 3: Sign up on ElevenLabs ──────────────────────────────────────────
  step('3/10 open sign-up page');
  const page = await context.newPage();
  activePage = page;

  // Clear all ElevenLabs cookies + storage to avoid existing session interference
  await context.clearCookies({ domain: 'elevenlabs.io' });
  console.log('[3] Cleared ElevenLabs cookies.');

  await page.goto('https://elevenlabs.io', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  console.log('[3] Cleared ElevenLabs localStorage/sessionStorage.');

  // Not 'networkidle': the site keeps analytics/websocket traffic alive, so it never settles.
  // The waitForSelector below is the real readiness signal.
  await page.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sign-up-email-input"]', { timeout: 15000 });

  // Human-like delay before typing
  await page.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(page, '[data-testid="sign-up-email-input"]', email);
  await page.waitForTimeout(400 + Math.random() * 300);
  await typeHuman(page, '[data-testid="sign-up-password-input"]', password);
  await page.waitForTimeout(600 + Math.random() * 400);

  console.log('[3] Clicking Sign up...');
  await page.click('button[style*="view-transition-name: submit"]');

  // ── STEP 4: Handle CAPTCHA if present ──────────────────────────────────────
  step('4/10 wait for signup to clear (CAPTCHA may need manual solving)');
  console.log(`[4] Page after submit: ${safePageLocation(page)}`);

  // Still on the signup page means the submit has not gone through yet.
  if (page.url().includes('sign-up')) {
    console.log('\n⚠️  Solve the CAPTCHA in the browser window if one is shown.');
    // Either the URL leaves /sign-up, or a "Resend" button appears (= verification email sent).
    // Both branches swallow their own timeout so the losing promise cannot reject unhandled
    // after the race has already settled.
    const settled = await Promise.race([
      page.waitForURL(url => !url.toString().includes('/sign-up'), { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'url-changed').catch(() => null),
      page.waitForSelector('button:has-text("Resend")', { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'resend-shown').catch(() => null),
    ]);
    if (!settled) {
      throw new Error(`Signup did not complete within ${SIGNUP_TIMEOUT_MS}ms (still at ${safePageLocation(page)})`);
    }
    console.log(`[4] Signup complete (${settled}). Page: ${safePageLocation(page)}`);
  }

  // ── STEP 5: Poll mail.tm for verify email ──────────────────────────────────
  step('5/10 poll mail.tm for verification email');
  const verifyUrl = await pollMailTmInbox(mailToken, INBOX_TIMEOUT_MS);
  console.log('[5] Verify URL found securely.');

  // ── STEP 6: Open verify URL ─────────────────────────────────────────────────
  step('6/10 open verify URL');
  const verifyPage = await context.newPage();
  activePage = verifyPage;
  await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
  console.log(`[4] Verification page: ${safePageLocation(verifyPage)}`);

  // ── STEP 7: Click Continue ──────────────────────────────────────────────────
  step('7/10 click Continue');
  await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
  await verifyPage.click('button:has-text("Continue")');
  await verifyPage.waitForTimeout(2000);

  // ── STEP 8: Sign in ─────────────────────────────────────────────────────────
  step('8/10 sign in');
  await verifyPage.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 15000 });
  await typeHuman(verifyPage, '[data-testid="sign-in-email-input"]', email);
  await verifyPage.waitForTimeout(300);
  await typeHuman(verifyPage, '[data-testid="sign-in-password-input"]', password);
  await verifyPage.waitForTimeout(400);
  await verifyPage.click('[data-testid="sign-in-submit-button"]');
  await verifyPage.waitForTimeout(5000);

  // ── STEP 9: Onboarding ──────────────────────────────────────────────────────
  step('9/10 onboarding');
  const firstName = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley'][Math.floor(Math.random() * 6)];

  // Click first "Continue" (post-verify landing)
  await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 10000 }).then(() =>
    verifyPage.click('button:has-text("Continue")')
  ).catch(() => {});
  await verifyPage.waitForTimeout(1500);

  // Fill first name
  const firstNameInput = await verifyPage.$('#firstname');
  if (firstNameInput) {
    await typeHuman(verifyPage, '#firstname', firstName);
    await verifyPage.waitForTimeout(500);
    // Check the age confirmation checkbox (custom div hitarea)
    const ageCheckbox = await verifyPage.$('.checkbox-hitarea');
    if (ageCheckbox) { await ageCheckbox.click(); await verifyPage.waitForTimeout(300); }
    await verifyPage.click('button[type="submit"]:has-text("Next")');
    await verifyPage.waitForTimeout(1500);
  }

  // Skip ×3
  for (let i = 0; i < 3; i++) {
    const skip = await verifyPage.$('button:has-text("Skip")');
    if (skip) { await skip.click(); await verifyPage.waitForTimeout(1000); }
  }

  // ── STEP 10: Create API key ─────────────────────────────────────────────────
  step('10/10 create API key');
  await verifyPage.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'domcontentloaded' });
  await verifyPage.waitForTimeout(2000);

  // Dismiss "Platform switch has moved" → "Got it"
  await verifyPage.waitForSelector('button:has-text("Got it")', { timeout: 5000 })
    .then(() => verifyPage.click('button:has-text("Got it")'))
    .catch(() => {});
  await verifyPage.waitForTimeout(500);

  // Dismiss Chrome "Restore pages?" if present (press Escape)
  await verifyPage.keyboard.press('Escape');
  await verifyPage.waitForTimeout(300);

  // Click "+ Create Key" button
  await verifyPage.waitForSelector('button:has-text("Create Key")', { timeout: 10000 });
  await verifyPage.click('button:has-text("Create Key")');
  await verifyPage.waitForTimeout(1000);

  // Fill key name
  const keyName = 'Key-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await verifyPage.waitForSelector('input[placeholder="API Key Name"]', { timeout: 10000 });
  await verifyPage.fill('input[placeholder="API Key Name"]', '');
  await verifyPage.fill('input[placeholder="API Key Name"]', keyName);
  await verifyPage.waitForTimeout(500);

  // Submit the "Create API Key" dialog. Its button shares the "Create Key" label with the
  // page-level one, so scope by dialog: the button's only id is React's generated
  // data-agent-id, which changes on every render.
  console.log('[10] Submitting Create API Key dialog...');
  await verifyPage
    .getByRole('dialog')
    .getByRole('button', { name: 'Create Key', exact: true })
    .last()
    .click({ timeout: 10000 });
  await verifyPage.waitForTimeout(1000);

  // A second "No Permissions Selected" dialog appears when the key was left with no endpoint
  // access. It is conditional, so treat its absence as normal rather than an error.
  const confirmCreate = verifyPage.locator('button[data-agent-protected="true"]', {
    hasText: 'Create Key',
  });
  if (await confirmCreate.count() > 0) {
    console.log('[10] Confirming "No Permissions Selected"...');
    await confirmCreate.last().click({ timeout: 10000 });
    await verifyPage.waitForTimeout(1500);
  }

  // Click "Copy to Clipboard"
  const keyDialog = verifyPage.getByRole('dialog');
  await verifyPage
    .getByRole('button', { name: 'Copy to Clipboard', exact: true })
    .click({ timeout: 15000 });
  await verifyPage.waitForTimeout(500);

  // The dialog renders the key in a readonly input. Read it there rather than from the
  // clipboard: no permission grant or window focus required, so it cannot silently fail.
  let apiKey = await keyDialog.locator('input[readonly]').first().inputValue().catch(() => '');
  if (!apiKey) {
    await verifyPage.bringToFront();
    apiKey = await verifyPage.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  }
  if (!apiKey.startsWith('sk_')) {
    throw new Error('API key was not captured in the expected format');
  }
  console.log('[10] API key captured securely.');

  console.log(`\n✅ Done!`);
  console.log(`   Email: ${email}`);
  console.log('   Password: [REDACTED]');
  console.log('   API Key: [REDACTED]');

  account = { ...account, apiKey, apiKeyName: keyName, firstName, status: 'complete' };
  saveAccount(account);
  account = null; // Persisted; stop the failure handler from writing a duplicate.
}

async function captureFailure(err) {
  console.error(`\n❌ FAILED at step: ${currentStep}`);
  console.error(err.stack || err.message);

  // The mailbox and ElevenLabs account already exist at this point, so persist them even
  // though the run failed. Losing them means the CAPTCHA was solved for nothing.
  if (account) {
    saveAccount({ ...account, status: 'incomplete', failedAt: currentStep });
  }

  if (!activePage || activePage.isClosed()) {
    console.error('[debug] No live page to inspect.');
    return;
  }
  // Page state at the moment of failure is the only thing that explains a selector timeout.
  try {
    console.error(`[debug] Page: ${safePageLocation(activePage)}`);
    const text = await activePage.evaluate(() => document.body.innerText.slice(0, 800));
    console.error(`[debug] Visible text:\n${text}`);
    await activePage.screenshot({ path: FAILURE_SCREENSHOT, fullPage: true });
    console.error(`[debug] Screenshot: ${FAILURE_SCREENSHOT}`);
  } catch (captureErr) {
    console.error(`[debug] Capture failed: ${captureErr.message}`);
  }
}

run()
  .catch(async (err) => {
    await captureFailure(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Always release the persistent profile, otherwise the next run hits a profile lock.
    if (context) {
      await context.close().catch((err) => console.error(`[cleanup] ${err.message}`));
    }
  });
