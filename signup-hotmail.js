const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HOTMAIL_FILE = 'C:\\Users\\HulkBeoti\\Documents\\hotmail.txt';
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const FAILURE_SCREENSHOT = path.join(__dirname, 'debug-failure.png');

const MS_OAUTH_URL =
  'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize' +
  '?client_id=9199bf20-a13f-4107-85dc-02114787ef48' +
  '&scope=https%3A%2F%2Foutlook.office.com%2F.default%20openid%20profile%20offline_access' +
  '&redirect_uri=https%3A%2F%2Foutlook.office365.com%2Fmail%2F' +
  '&client-request-id=3166a2c6-aed3-80d6-a64d-4e428c914436' +
  '&response_mode=fragment' +
  '&client_info=1&clidata=1' +
  '&domain_hint=hotmail.html%3FauthRedirect%3Dtrue' +
  '&nonce=01a01e22-638c-71a9-866d-2457aa402638' +
  '&state=eyJpZCI6IjAxYTAxZTIyLTYzOGMtNzI1YS1iMDZiLWI5NTVkYmE5MWUwOSIsIm1ldGEiOnsiaW50ZXJhY3Rpb25UeXBlIjoicmVkaXJlY3QifX0%3D%7CaHR0cHM6Ly9vdXRsb29rLm9mZmljZTM2NS5jb20vbWFpbC8wLz9iTz0x' +
  '&claims=%7B%22access_token%22%3A%7B%22xms_cc%22%3A%7B%22values%22%3A%5B%22CP1%22%5D%7D%7D%7D' +
  '&x-client-SKU=msal.js.browser&x-client-VER=5.12.0' +
  '&response_type=code' +
  '&code_challenge=oqJyEmbKI1Fr0JuALEuXxXykbuS4N9ZC3AouhpPzda8' +
  '&code_challenge_method=S256' +
  '&sso_reload=true';

const SIGNUP_TIMEOUT_MS = 300000; // 5 min — CAPTCHA may need manual solve
const INBOX_TIMEOUT_MS = 120000;  // 2 min — wait for ElevenLabs verify email

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\VibeCoding\\mail-temp\\chrome-profile';

// ── Module-scope state for failure handler ───────────────────────────────────
let context = null;
let activePage = null;
let currentStep = 'init';

function step(name) {
  currentStep = name;
  console.log(`[step] ${name}`);
}

// ── Persistence ──────────────────────────────────────────────────────────────
function saveAccount(record) {
  const accounts = fs.existsSync(ACCOUNTS_FILE)
    ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
    : [];
  const id = accounts.reduce((max, a) => Math.max(max, a.id ?? 0), 0) + 1;
  accounts.push({ id, ...record, createdAt: new Date().toISOString() });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  console.log(`[✓] Account #${id} saved to accounts.json`);
  return id;
}

// ── Parse hotmail.txt ────────────────────────────────────────────────────────
// Line format (after "N. " prefix):
//   email|password|msaToken|tenantGuid|recoveryEmail
function parseHotmailFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const accounts = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Lines look like: "1. email@hotmail.com|password|token|guid|recovery@..."
    const match = trimmed.match(/^\d+\.\s+(.+)$/);
    if (!match) continue;
    const parts = match[1].split('|');
    if (parts.length < 5) continue;
    accounts.push({
      email: parts[0].trim(),
      password: parts[1].trim(),
      msaToken: parts[2].trim(),
      tenantGuid: parts[3].trim(),
      recoveryEmail: parts[4].trim(),
    });
  }
  return accounts;
}

// ── Human-like typing ────────────────────────────────────────────────────────
async function typeHuman(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, '');
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 80 });
  }
}

function generatePassword() {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const specials = '!@#$%^&*';
  const rand = (str) => str[Math.floor(Math.random() * str.length)];
  return Array.from({ length: 6 }, () => rand(letters)).join('') + rand(numbers) + rand(specials);
}

// ── Microsoft Outlook login ──────────────────────────────────────────────────
// Returns the page after it has redirected to outlook.office365.com/mail/
async function loginMicrosoft(hotmailEmail, hotmailPassword) {
  step('MS login — open OAuth URL');
  const loginPage = await context.newPage();
  activePage = loginPage;

  await loginPage.goto(MS_OAUTH_URL, { waitUntil: 'domcontentloaded' });

  // Fill email
  step('MS login — fill email');
  await loginPage.waitForSelector('#i0116', { timeout: 15000 });
  await typeHuman(loginPage, '#i0116', hotmailEmail);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Click Next
  await loginPage.click('#idSIButton9');
  await loginPage.waitForTimeout(1000 + Math.random() * 500);

  // Click "Use your password"
  step('MS login — switch to password');
  await loginPage.waitForSelector('span[role="button"]:has-text("Use your password")', { timeout: 15000 });
  await loginPage.click('span[role="button"]:has-text("Use your password")');
  await loginPage.waitForTimeout(800 + Math.random() * 400);

  // Fill password
  step('MS login — fill password');
  await loginPage.waitForSelector('#passwordEntry', { timeout: 15000 });
  await typeHuman(loginPage, '#passwordEntry', hotmailPassword);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Click "No" (don't stay signed in prompt)
  await loginPage.click('button[type="submit"][data-testid="secondaryButton"]:has-text("No")');

  // Wait for redirect into Outlook inbox
  step('MS login — wait for Outlook inbox');
  await loginPage.waitForURL(url => url.toString().includes('outlook.office365.com/mail'), {
    timeout: 30000,
  });
  console.log(`[MS] Inbox loaded: ${loginPage.url()}`);

  return loginPage; // now the live Outlook inbox page
}

// ── Poll Outlook inbox via DOM ────────────────────────────────────────────────
async function pollOutlookInbox(outookPage, timeoutMs = INBOX_TIMEOUT_MS) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await outookPage.reload({ waitUntil: 'domcontentloaded' });
      await outookPage.waitForTimeout(2000);

      // Outlook renders each message row with role="option"
      const emailRow = await outookPage.$(
        '[role="option"]:has-text("ElevenLabs"), [aria-label*="ElevenLabs"]'
      );

      if (emailRow) {
        await emailRow.click();
        await outookPage.waitForTimeout(2000);

        // Extract verify link from reading pane HTML
        const body = await outookPage.evaluate(() => document.body.innerHTML);
        const match = body.match(/href="(https:\/\/elevenlabs\.io\/app\/action[^"]+)"/);
        if (match) {
          return match[1].replace(/&amp;/g, '&');
        }
      }
    } catch (e) {
      console.log(`[inbox] scan error: ${e.message}`);
    }

    console.log('[inbox] No verify email yet, waiting 5s...');
    await outookPage.waitForTimeout(5000);
  }

  throw new Error('Timeout: no ElevenLabs verification email in Outlook inbox');
}

// ── Process one hotmail account end-to-end ───────────────────────────────────
async function processAccount(cred) {
  const { email: hotmailEmail, password: hotmailPassword, recoveryEmail } = cred;
  const elevenPassword = generatePassword();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`▶ ${hotmailEmail}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ElevenLabs password: ${elevenPassword}`);

  // 1. Login Microsoft → get Outlook inbox page
  const outookPage = await loginMicrosoft(hotmailEmail, hotmailPassword);
  activePage = outookPage;

  // 2. Sign up on ElevenLabs
  step('sign-up ElevenLabs');
  const signupPage = await context.newPage();
  activePage = signupPage;

  await context.clearCookies({ domain: 'elevenlabs.io' });
  await signupPage.goto('https://elevenlabs.io', { waitUntil: 'domcontentloaded' });
  await signupPage.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

  await signupPage.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'domcontentloaded' });
  await signupPage.waitForSelector('[data-testid="sign-up-email-input"]', { timeout: 15000 });

  await signupPage.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(signupPage, '[data-testid="sign-up-email-input"]', hotmailEmail);
  await signupPage.waitForTimeout(400 + Math.random() * 300);
  await typeHuman(signupPage, '[data-testid="sign-up-password-input"]', elevenPassword);
  await signupPage.waitForTimeout(600 + Math.random() * 400);

  console.log('[2] Clicking Sign up...');
  await signupPage.click('button[style*="view-transition-name: submit"]');

  // 3. Handle CAPTCHA
  step('wait for signup (CAPTCHA may need manual solve)');
  if (signupPage.url().includes('sign-up')) {
    console.log('\n⚠️  Solve the CAPTCHA in the browser window if shown.');
    const settled = await Promise.race([
      signupPage.waitForURL(url => !url.toString().includes('/sign-up'), { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'url-changed').catch(() => null),
      signupPage.waitForSelector('button:has-text("Resend")', { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'resend-shown').catch(() => null),
    ]);
    if (!settled) {
      throw new Error(`Signup timed out (still at ${signupPage.url()})`);
    }
    console.log(`[3] Signup complete (${settled})`);
  }

  // 4. Poll Outlook inbox
  step('poll Outlook inbox for verify email');
  activePage = outookPage;
  const verifyUrl = await pollOutlookInbox(outookPage, INBOX_TIMEOUT_MS);
  console.log('[4] Verify URL found:', verifyUrl.substring(0, 80) + '...');

  // 5. Open verify URL
  step('open verify URL');
  const verifyPage = await context.newPage();
  activePage = verifyPage;
  await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded' });

  // 6. Continue
  step('click Continue');
  await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
  await verifyPage.click('button:has-text("Continue")');
  await verifyPage.waitForTimeout(2000);

  // 7. Sign in
  step('sign in ElevenLabs');
  await verifyPage.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 15000 });
  await typeHuman(verifyPage, '[data-testid="sign-in-email-input"]', hotmailEmail);
  await verifyPage.waitForTimeout(300);
  await typeHuman(verifyPage, '[data-testid="sign-in-password-input"]', elevenPassword);
  await verifyPage.waitForTimeout(400);
  await verifyPage.click('[data-testid="sign-in-submit-button"]');
  await verifyPage.waitForTimeout(5000);

  // 8. Onboarding
  step('onboarding');
  const firstName = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley'][Math.floor(Math.random() * 6)];

  await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 10000 })
    .then(() => verifyPage.click('button:has-text("Continue")'))
    .catch(() => {});
  await verifyPage.waitForTimeout(1500);

  const firstNameInput = await verifyPage.$('#firstname');
  if (firstNameInput) {
    await typeHuman(verifyPage, '#firstname', firstName);
    await verifyPage.waitForTimeout(500);
    const ageCheckbox = await verifyPage.$('.checkbox-hitarea');
    if (ageCheckbox) { await ageCheckbox.click(); await verifyPage.waitForTimeout(300); }
    await verifyPage.click('button[type="submit"]:has-text("Next")');
    await verifyPage.waitForTimeout(1500);
  }

  for (let i = 0; i < 3; i++) {
    const skip = await verifyPage.$('button:has-text("Skip")');
    if (skip) { await skip.click(); await verifyPage.waitForTimeout(1000); }
  }

  // 9. Create API key
  step('create API key');
  await verifyPage.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'domcontentloaded' });
  await verifyPage.waitForTimeout(2000);

  await verifyPage.waitForSelector('button:has-text("Got it")', { timeout: 5000 })
    .then(() => verifyPage.click('button:has-text("Got it")'))
    .catch(() => {});
  await verifyPage.waitForTimeout(500);
  await verifyPage.keyboard.press('Escape');
  await verifyPage.waitForTimeout(300);

  await verifyPage.waitForSelector('button:has-text("Create Key")', { timeout: 10000 });
  await verifyPage.click('button:has-text("Create Key")');
  await verifyPage.waitForTimeout(1000);

  const keyName = 'Key-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await verifyPage.waitForSelector('input[placeholder="API Key Name"]', { timeout: 10000 });
  await verifyPage.fill('input[placeholder="API Key Name"]', '');
  await verifyPage.fill('input[placeholder="API Key Name"]', keyName);
  await verifyPage.waitForTimeout(500);

  await verifyPage
    .getByRole('dialog')
    .getByRole('button', { name: 'Create Key', exact: true })
    .last()
    .click({ timeout: 10000 });
  await verifyPage.waitForTimeout(1000);

  // Confirm "No Permissions Selected" dialog if it appears
  const confirmCreate = verifyPage.locator('button[data-agent-protected="true"]', { hasText: 'Create Key' });
  if (await confirmCreate.count() > 0) {
    await confirmCreate.last().click({ timeout: 10000 });
    await verifyPage.waitForTimeout(1500);
  }

  const keyDialog = verifyPage.getByRole('dialog');
  await verifyPage
    .getByRole('button', { name: 'Copy to Clipboard', exact: true })
    .click({ timeout: 15000 });
  await verifyPage.waitForTimeout(500);

  let apiKey = await keyDialog.locator('input[readonly]').first().inputValue().catch(() => '');
  if (!apiKey) {
    await verifyPage.bringToFront();
    apiKey = await verifyPage.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  }
  if (!apiKey.startsWith('sk_')) {
    throw new Error(`API key not captured (got: ${JSON.stringify(apiKey)})`);
  }

  console.log(`[9] API Key: ${apiKey}`);
  console.log(`\n✅ Done: ${hotmailEmail} | ${elevenPassword} | ${apiKey}`);

  saveAccount({
    email: hotmailEmail,
    password: elevenPassword,
    hotmailPassword,
    recoveryEmail,
    apiKey,
    apiKeyName: keyName,
    firstName,
    status: 'complete',
  });

  // Close this account's tabs; browser stays open for the next account
  await signupPage.close().catch(() => {});
  await verifyPage.close().catch(() => {});
  await outookPage.close().catch(() => {});
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function run() {
  const hotmailAccounts = parseHotmailFile(HOTMAIL_FILE);
  console.log(`Loaded ${hotmailAccounts.length} accounts from hotmail.txt`);

  step('launch Chrome');
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_EXE,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--profile-directory=Default',
      '--hide-crash-restore-bubble',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    slowMo: 50,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  for (let i = 0; i < hotmailAccounts.length; i++) {
    const cred = hotmailAccounts[i];
    console.log(`\n[${i + 1}/${hotmailAccounts.length}] ${cred.email}`);

    try {
      await processAccount(cred);
    } catch (err) {
      console.error(`\n❌ FAILED [${cred.email}] at step: ${currentStep}`);
      console.error(err.stack || err.message);

      saveAccount({
        email: cred.email,
        hotmailPassword: cred.password,
        recoveryEmail: cred.recoveryEmail,
        status: 'incomplete',
        failedAt: currentStep,
      });

      if (activePage && !activePage.isClosed()) {
        try {
          await activePage.screenshot({ path: FAILURE_SCREENSHOT, fullPage: true });
          console.error(`[debug] Screenshot saved.`);
        } catch (_) {}
      }

      console.log('Continuing to next account...');
    }

    activePage = null;
  }

  console.log('\n✅ All accounts processed.');
}

run()
  .catch(async (err) => {
    console.error('\n❌ Fatal error:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (context) {
      await context.close().catch((err) => console.error(`[cleanup] ${err.message}`));
    }
  });
