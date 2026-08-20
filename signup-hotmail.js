const { chromium } = require('playwright');
const path = require('path');
const {
  initSheets, loadPendingRows, updateStatus, updatePassword, updateResult,
} = require('./sheets');

const FAILURE_SCREENSHOT = path.join(__dirname, 'debug-failure.png');

const LOGIN_URL = 'https://login.live.com/';

const SIGNUP_TIMEOUT_MS = 300000; // 5 min — CAPTCHA may need manual solve
const INBOX_TIMEOUT_MS = 120000;  // 2 min — wait for ElevenLabs verify email
const MS_LOGIN_TIMEOUT_MS = 15000;

// ── Module-scope state for failure handler ───────────────────────────────────
let browser = null;
let activePage = null;
let currentStep = 'init';

function step(name) {
  currentStep = name;
  console.log(`[step] ${name}`);
}

// ── Human-like typing ────────────────────────────────────────────────────────
async function typeHuman(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, '');
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 80 });
  }

  // A React re-render mid-typing silently drops the remaining characters, which previously
  // produced a truncated email and a sign-in that failed three steps later. Verify and repair.
  const landed = await page.inputValue(selector);
  if (landed !== text) {
    console.warn(`[type] field truncated (${landed.length}/${text.length} chars) - repairing`);
    await page.fill(selector, text);
    const repaired = await page.inputValue(selector);
    if (repaired !== text) {
      throw new Error(`Could not set ${selector}: wanted ${text.length} chars, field holds ${repaired.length}`);
    }
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
// login.live.com → fill creds → redirect to Outlook inbox
async function loginMicrosoft(ctx, hotmailEmail, hotmailPassword) {
  step('MS login — open login page');
  const loginPage = await ctx.newPage();
  activePage = loginPage;

  await loginPage.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // Fill email (#usernameEntry)
  step('MS login — fill email');
  await loginPage.waitForSelector('#usernameEntry', { timeout: 20000 });
  await typeHuman(loginPage, '#usernameEntry', hotmailEmail);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Click Next
  await loginPage.click('button[data-testid="primaryButton"]');
  await loginPage.waitForTimeout(1500 + Math.random() * 500);

  // The passkey/authenticator interstitial is conditional — accounts without one land on the
  // password field directly. Race the two so a missing prompt is not treated as a failure.
  step('MS login — switch to password');
  const PASSWORD_LINK = 'span[role="button"]:has-text("Use your password")';
  const route = await Promise.race([
    loginPage.waitForSelector(PASSWORD_LINK, { timeout: MS_LOGIN_TIMEOUT_MS })
      .then(() => 'link').catch(() => null),
    loginPage.waitForSelector('#passwordEntry', { timeout: MS_LOGIN_TIMEOUT_MS })
      .then(() => 'password').catch(() => null),
  ]);
  if (!route) {
    throw new Error('MS login: neither the passkey link nor the password field appeared');
  }
  if (route === 'link') {
    await loginPage.click(PASSWORD_LINK);
    await loginPage.waitForTimeout(800 + Math.random() * 400);
  }

  // Fill password (#passwordEntry)
  step('MS login — fill password');
  await loginPage.waitForSelector('#passwordEntry', { timeout: 15000 });
  await typeHuman(loginPage, '#passwordEntry', hotmailPassword);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Submit password (Next button)
  step('MS login — submit password');
  await loginPage.click('button[data-testid="primaryButton"]');
  await loginPage.waitForTimeout(2000);

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
    await loginPage.click('button:has-text("OK")');
    await loginPage.waitForTimeout(1500);
    // After OK, No button may appear
    const noBtn = await loginPage.waitForSelector('button:has-text("No")', { timeout: 10000 }).catch(() => null);
    if (noBtn) {
      await noBtn.click();
      await loginPage.waitForTimeout(1500);
    }
  } else if (prompt === 'no') {
    await loginPage.click('button:has-text("No")');
    await loginPage.waitForTimeout(1500);
  }

  // Navigate to Outlook inbox (login.live.com redirects to account.microsoft.com by default)
  step('MS login — navigate to Outlook inbox');
  await loginPage.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded' });
  await loginPage.waitForTimeout(5000);
  console.log(`[MS] Inbox loaded: ${loginPage.url()}`);

  return loginPage;
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
async function processAccount(ctx, cred) {
  const { rowIndex, email: hotmailEmail, password: hotmailPassword, recoveryEmail } = cred;
  const elevenPassword = generatePassword();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`▶ ${hotmailEmail}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ElevenLabs password: ${elevenPassword}`);

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

  // The ElevenLabs account exists from here on. Record its password immediately so a later
  // failure (verify, onboarding, key creation) cannot leave the account unrecoverable.
  await updatePassword(rowIndex, elevenPassword)
    .catch((e) => console.error(`[sheet] password write failed: ${e.message}`));

  // 4. Poll Outlook inbox
  step('poll Outlook inbox for verify email');
  activePage = outookPage;
  const verifyUrl = await pollOutlookInbox(outookPage, INBOX_TIMEOUT_MS);
  console.log('[4] Verify URL found:', verifyUrl.substring(0, 80) + '...');

  // 5. Open verify URL
  step('open verify URL');
  const verifyPage = await ctx.newPage();
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
  // Let hydration finish before typing - the signup step already does this.
  await verifyPage.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(verifyPage, '[data-testid="sign-in-email-input"]', hotmailEmail);
  await verifyPage.waitForTimeout(300);
  await typeHuman(verifyPage, '[data-testid="sign-in-password-input"]', elevenPassword);
  await verifyPage.waitForTimeout(400);
  await verifyPage.click('[data-testid="sign-in-submit-button"]');

  // Fail here rather than letting an unauthenticated session drift into onboarding and the
  // key dialog, where the real cause is three steps behind the reported error.
  const signedIn = await verifyPage
    .waitForURL((url) => !url.toString().includes('/sign-in'), { timeout: 30000 })
    .then(() => true).catch(() => false);
  if (!signedIn) {
    const shown = await verifyPage.locator('[data-testid="sign-in-email-input"]')
      .inputValue().catch(() => '<no field>');
    throw new Error(`Sign-in did not complete; still at ${verifyPage.url()} (email field: "${shown}")`);
  }
  await verifyPage.waitForTimeout(3000);

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

  // Leaving "Restrict Key" on produces a key with no endpoint access - it is created and
  // stored but every API call is rejected. Turn it off; checking state first keeps this
  // correct if the default ever flips.
  const restrictToggle = verifyPage.getByRole('dialog').getByRole('switch');
  if (await restrictToggle.count() > 0) {
    if (await restrictToggle.first().getAttribute('aria-checked') === 'true') {
      await restrictToggle.first().click();
      await verifyPage.waitForTimeout(500);
      console.log('[9] Restrict Key toggled off (key gets full access)');
    }
  } else {
    console.warn('[9] Restrict Key toggle not found - key may be created without permissions');
  }

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

  // Write results back to Google Sheet. If this throws, the caller marks the row failed
  // but leaves F/G alone - and the key is on stdout above, so it is not lost silently.
  await updateResult(rowIndex, apiKey, elevenPassword, 'complete');
  console.log(`\n✅ Done: ${hotmailEmail} | ${elevenPassword} | ${apiKey}`);
}

// ── Main loop ────────────────────────────────────────────────────────────────
// --limit N  process at most N accounts (default: all)
// --row N    process only the account on sheet row N
function parseArgs(argv) {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const rowArg = argv.find((a) => a.startsWith('--row='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const row = rowArg ? Number(rowArg.split('=')[1]) : null;
  if (limitArg && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got: ${limitArg.split('=')[1]}`);
  }
  if (rowArg && (!Number.isInteger(row) || row < 2)) {
    throw new Error(`--row must be a sheet row >= 2 (row 1 is the header), got: ${rowArg.split('=')[1]}`);
  }
  return { limit, row };
}

async function run() {
  const { limit, row } = parseArgs(process.argv.slice(2));

  await initSheets();
  let pendingRows = await loadPendingRows();
  console.log(`Loaded ${pendingRows.length} pending accounts from Google Sheet`);

  if (row !== null) {
    pendingRows = pendingRows.filter((r) => r.rowIndex === row);
    if (pendingRows.length === 0) {
      console.log(`Row ${row} is not pending (or does not exist). Exiting.`);
      return;
    }
  }

  if (pendingRows.length > limit) {
    pendingRows = pendingRows.slice(0, limit);
    console.log(`Limited to first ${limit} account(s) by --limit.`);
  }

  if (pendingRows.length === 0) {
    console.log('No pending accounts. Exiting.');
    return;
  }

  step('launch Chromium');
  browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    slowMo: 50,
  });

  for (let i = 0; i < pendingRows.length; i++) {
    const cred = pendingRows[i];
    console.log(`\n[${i + 1}/${pendingRows.length}] ${cred.email} (sheet row ${cred.rowIndex})`);

    // Reset before the try: otherwise a throw raised before this account's first step() call
    // would be attributed to the previous account's last step.
    currentStep = 'account start';

    // One context per account. A fresh context drops cookies, localStorage and IndexedDB, so
    // the previous account's Microsoft session cannot leak into this login. Closing it also
    // disposes every tab the account opened.
    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
      await processAccount(ctx, cred);
      // processAccount writes the success row itself via updateResult.
    } catch (err) {
      console.error(`\n❌ FAILED [${cred.email}] at step: ${currentStep}`);
      console.error(err.stack || err.message);

      // Classify failure: MS login steps = account inactive/bad creds
      const isInactive = currentStep.startsWith('MS login');
      const failStatus = isInactive ? 'inactive' : `failed:${currentStep}`;

      // Status column only. Never blank F/G here: the ElevenLabs account may already exist
      // with its password recorded, and losing it would orphan the account for good.
      await updateStatus(cred.rowIndex, failStatus)
        .catch((e) => console.error(`[sheet] status write failed: ${e.message}`));

      if (activePage && !activePage.isClosed()) {
        try {
          console.error(`[debug] URL: ${activePage.url()}`);
          const text = await activePage.evaluate(() => document.body.innerText.slice(0, 600));
          console.error(`[debug] Visible text:\n${text}`);
          // Per-row filename: a shared path meant each failure erased the previous evidence.
          const shot = FAILURE_SCREENSHOT.replace(/\.png$/, `-row${cred.rowIndex}.png`);
          await activePage.screenshot({ path: shot, fullPage: true });
          console.error(`[debug] Screenshot: ${shot}`);
        } catch (e) {
          console.error(`[debug] Capture failed: ${e.message}`);
        }
      }

      console.log('Continuing to next account...');
    } finally {
      activePage = null;
      await ctx.close().catch((e) => console.error(`[cleanup] ${e.message}`));
    }
  }

  console.log('\n✅ All accounts processed.');
}

run()
  .catch(async (err) => {
    console.error('\n❌ Fatal error:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) {
      await browser.close().catch((err) => console.error(`[cleanup] ${err.message}`));
    }
  });
