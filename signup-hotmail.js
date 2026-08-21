const { chromium } = require('playwright');
const path = require('path');
const {
  initSheets, loadRows, loadPendingRows, updateStatus, updatePassword, updateResult,
} = require('./sheets');
const { getNewProxyWithRetry, parseProxyString } = require('./proxy');
const gpm = require('./gpm-api');

const FAILURE_SCREENSHOT = path.join(__dirname, 'debug-failure.png');

const LOGIN_URL = 'https://login.live.com/';

const SIGNUP_TIMEOUT_MS = 900000; // 15 min - CAPTCHA is solved by hand, allow for a break
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

const { 
  think, clickHuman, typeHuman, smoothScroll, generateRealisticName
} = require('./human-behavior');

function generatePassword() {
  const { firstName } = generateRealisticName();
  const words = ['Love', 'Life', 'Star', 'Moon', 'Sky', 'Blue', 'Green', 'Happy', 'Dream', 'Hope'];
  const word = words[Math.floor(Math.random() * words.length)];
  const year = Math.floor(Math.random() * (2005 - 1980 + 1)) + 1980;
  const special = ['@', '#', '!', '$'][Math.floor(Math.random() * 4)];
  return `${firstName}${word}${year}${special}`;
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
    await clickHuman(loginPage, PASSWORD_LINK);
    await loginPage.waitForTimeout(800 + Math.random() * 400);
  }

  // Fill password (#passwordEntry)
  step('MS login — fill password');
  await loginPage.waitForSelector('#passwordEntry', { timeout: 15000 });
  await typeHuman(loginPage, '#passwordEntry', hotmailPassword);
  await loginPage.waitForTimeout(500 + Math.random() * 300);

  // Submit password (Next button)
  step('MS login — submit password');
  await clickHuman(loginPage, 'button[data-testid="primaryButton"]');
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

  // Navigate to Outlook inbox (login.live.com redirects to account.microsoft.com by default)
  step('MS login — navigate to Outlook inbox');
  await loginPage.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded' });
  await loginPage.waitForTimeout(5000);
  console.log(`[MS] Inbox loaded: ${loginPage.url()}`);

  return loginPage;
}


// The CAPTCHA is solved by hand, and this is the only point in a run that needs a person.
// Ring the terminal bell and raise the window so the wait can be spent elsewhere, then tick
// every 30s so a live wait is distinguishable from a hung one.
async function waitForManualSignup(page) {
  const BELL = String.fromCharCode(7);
  const TICK_MS = 30000;
  const totalSec = Math.round(SIGNUP_TIMEOUT_MS / 1000);

  process.stdout.write(BELL);
  await page.bringToFront().catch(() => {});
  console.log(`⚠️  Solve the CAPTCHA in the browser window if shown (up to ${Math.round(SIGNUP_TIMEOUT_MS / 60000)} min).`);

  const started = Date.now();
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks++;
    console.log(`   …waiting ${Math.round((Date.now() - started) / 1000)}s / ${totalSec}s`);
    // Re-ring once a minute rather than every tick: enough to call someone back, not enough
    // to madden someone already sitting there.
    if (ticks % 2 === 0) process.stdout.write(BELL);
  }, TICK_MS);

  try {
    const settled = await Promise.race([
      page.waitForURL((url) => !url.toString().includes('/sign-up'), { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'url-changed').catch(() => null),
      page.waitForSelector('button:has-text("Resend")', { timeout: SIGNUP_TIMEOUT_MS })
        .then(() => 'resend-shown').catch(() => null),
    ]);
    if (!settled) {
      throw new Error(`Signup timed out after ${totalSec}s (still at ${page.url()})`);
    }
    return settled;
  } finally {
    clearInterval(ticker);
  }
}

// ── Poll Outlook inbox via DOM ────────────────────────────────────────────────
async function pollOutlookInbox(outookPage, timeoutMs = INBOX_TIMEOUT_MS, mode = 'verifyEmail') {
  const start = Date.now();
  const wanted = `mode=${mode}`;

  while (Date.now() - start < timeoutMs) {
    try {
      await outookPage.reload({ waitUntil: 'domcontentloaded' });
      await outookPage.waitForTimeout(2000);

      // Outlook renders each message row with role="option".
      const rows = outookPage.locator('[role="option"]').filter({ hasText: 'ElevenLabs' });
      const count = await rows.count();

      // Open each ElevenLabs message in turn rather than only the newest: the mailbox can
      // already hold a message of the other kind - an old verification link when a reset
      // link is wanted - and taking the first match would return the wrong one.
      for (let i = 0; i < count; i++) {
        await clickHuman(outookPage, rows.nth(i));
        await outookPage.waitForTimeout(2000);

        const body = await outookPage.evaluate(() => document.body.innerHTML);
        const link = [...body.matchAll(/href="(https:\/\/elevenlabs\.io\/app\/action[^"]+)"/g)]
          .map((m) => m[1].replace(/&amp;/g, '&'))
          .find((u) => u.includes(wanted));
        if (link) return link;
      }
    } catch (e) {
      console.log(`[inbox] scan error: ${e.message}`);
    }

    console.log(`[inbox] No ${mode} email yet, waiting 5s...`);
    await outookPage.waitForTimeout(5000);
  }

  throw new Error(`Timeout: no ElevenLabs ${mode} email in Outlook inbox`);
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
  // Wait for the full app shell to mount (avoids hitting the blank IIElevenLabs loading screen)
  await signupPage.waitForSelector('[data-testid="sign-up-email-input"]', { state: 'visible', timeout: 25000 });

  await think(1500, 3500);
  await smoothScroll(signupPage);

  await signupPage.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(signupPage, '[data-testid="sign-up-email-input"]', hotmailEmail);
  await signupPage.waitForTimeout(400 + Math.random() * 300);
  await typeHuman(signupPage, '[data-testid="sign-up-password-input"]', elevenPassword);
  await signupPage.waitForTimeout(600 + Math.random() * 400);

  console.log('[2] Clicking Sign up...');
  await clickHuman(signupPage, 'button[style*="view-transition-name: submit"]');

  // 3. Handle CAPTCHA
  step('wait for signup (CAPTCHA may need manual solve)');
  if (signupPage.url().includes('sign-up')) {
    const settled = await waitForManualSignup(signupPage);
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
  await clickHuman(verifyPage, 'button:has-text("Continue")');
  await verifyPage.waitForTimeout(2000);

  await signInAndCreateKey(verifyPage, rowIndex, hotmailEmail, elevenPassword);
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

async function attemptSignIn(page, email, elevenPassword) {
  step('sign in ElevenLabs');

  const formShown = await page.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!formShown) {
    // No form, and the URL has left the sign-in route: an existing session was reused and
    // the app went straight through. Nothing to submit.
    if (!page.url().includes('/sign-in')) return SIGN_IN.OK;
    throw new Error(`Sign-in form never appeared at ${page.url()}`);
  }

  // Let hydration finish before typing - the signup step already does this.
  await page.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(page, '[data-testid="sign-in-email-input"]', email);
  await page.waitForTimeout(300);
  await typeHuman(page, '[data-testid="sign-in-password-input"]', elevenPassword);
  await page.waitForTimeout(400);
  await clickHuman(page, '[data-testid="sign-in-submit-button"]');

  const SETTLE_MS = 30000;
  const outcome = await firstOutcome([
    { value: SIGN_IN.OK,
      promise: page.waitForURL((url) => !url.toString().includes('/sign-in'), { timeout: SETTLE_MS }) },
    // ElevenLabs keeps the URL on /sign-in for both of these, so match on the message.
    { value: SIGN_IN.UNVERIFIED,
      promise: page.getByText('verification link', { exact: false }).waitFor({ timeout: SETTLE_MS }) },
    { value: SIGN_IN.REJECTED,
      promise: page.getByText('No user is found', { exact: false }).waitFor({ timeout: SETTLE_MS }) },
  ], SETTLE_MS);

  if (!outcome) {
    const shown = await page.locator('[data-testid="sign-in-email-input"]')
      .inputValue().catch(() => '<no field>');
    throw new Error(`Sign-in gave no recognised outcome; still at ${page.url()} (email field: "${shown}")`);
  }
  return outcome;
}

async function signInAndCreateKey(page, rowIndex, email, elevenPassword) {
  const outcome = await attemptSignIn(page, email, elevenPassword);
  if (outcome !== SIGN_IN.OK) {
    throw new Error(`Sign-in did not complete (${outcome}) at ${page.url()}`);
  }
  await page.waitForTimeout(3000);

  await finishOnboardingAndKey(page, rowIndex, email, elevenPassword);
}

// Onboarding, key creation and the sheet write. Split out so --resume can reach it
// without repeating the sign-up half of the pipeline.
async function finishOnboardingAndKey(page, rowIndex, email, elevenPassword) {
  // 8. Onboarding
  step('onboarding');
  const { firstName } = generateRealisticName();

  await page.waitForSelector('button:has-text("Continue")', { timeout: 10000 })
    .then(() => clickHuman(page, 'button:has-text("Continue")'))
    .catch(() => {});
  await page.waitForTimeout(1500);

  const firstNameInput = await page.$('#firstname');
  if (firstNameInput) {
    await typeHuman(page, '#firstname', firstName);
    await page.waitForTimeout(500);
    const ageCheckbox = await page.$('input[type="checkbox"][name*="age"]');
    if (ageCheckbox) { await clickHuman(page, ageCheckbox); await page.waitForTimeout(300); }
    await clickHuman(page, 'button[type="submit"]:has-text("Next")');
    await page.waitForTimeout(1500);
  }

  for (let i = 0; i < 3; i++) {
    const skip = await page.$('button:has-text("Skip")');
    if (skip) { await clickHuman(page, skip); await page.waitForTimeout(1000); }
  }

  // Acknowledge welcome banners
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
    throw new Error(`API key not captured (got: ${JSON.stringify(apiKey)})`);
  }

  console.log(`[9] API Key: ${apiKey}`);

  // Write results back to Google Sheet. If this throws, the caller marks the row failed
  // but leaves F/G alone - and the key is on stdout above, so it is not lost silently.
  await updateResult(rowIndex, apiKey, elevenPassword, 'complete');
  console.log(`\n✅ Done: ${email} | ${elevenPassword} | ${apiKey}`);
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
  console.error(`[reset] ${what} not found at ${page.url()}. Controls on the page:`);
  for (const c of controls) console.error('   ', JSON.stringify(c));
  throw new Error(`${what} not found`);
}

// Recovers a row whose stored password no longer opens the account, by driving the
// "Forgot your password?" flow through the account's own Hotmail mailbox and choosing a
// fresh password. Reuses loginMicrosoft and pollOutlookInbox from the main pipeline.
async function resetPasswordAndCreateKey(ctx, cred) {
  const { rowIndex, email, password: hotmailPassword } = cred;
  const newPassword = generatePassword();

  console.log(`
${'═'.repeat(60)}`);
  console.log(`▶ RESET ${email} (sheet row ${rowIndex})`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  New ElevenLabs password: ${newPassword}`);

  step('reset — request reset email');
  let page = await ctx.newPage();
  activePage = page;
  // The form has its own route, so go straight there instead of hunting for the link.
  await page.goto('https://elevenlabs.io/app/sign-in/forgot-password', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="forgot-password-email-input"]', { timeout: 15000 });
  await page.waitForTimeout(800 + Math.random() * 500);

  await typeHuman(page, '[data-testid="forgot-password-email-input"]', email);
  await page.waitForTimeout(400);

  // Continue starts disabled and enables once the address validates; click() waits for that.
  await clickHuman(page, page.getByRole('button', { name: 'Continue', exact: true }));

  // Confirm the request actually went out. Without this a silent failure would send us to
  // the mailbox to wait two minutes for an email that was never sent.
  await page.getByText('Check your Inbox', { exact: false })
    .waitFor({ timeout: 20000 })
    .catch(() => {
      throw new Error(`Reset request not confirmed; still at ${page.url()}`);
    });
  console.log('[reset] Reset email requested.');

  step('reset — MS login for reset link');
  const outlookPage = await loginMicrosoft(ctx, email, hotmailPassword);
  activePage = outlookPage;

  step('reset — poll Outlook for reset link');
  const resetUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS, 'resetPassword');
  console.log('[reset] Reset URL found:', resetUrl.substring(0, 80) + '...');

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
    await fields.nth(i).fill(newPassword);
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

  await saveButton.click({ timeout: 10000 });

  // Confirm the reset landed before trusting the new password. The page leaves /app/action
  // on success; a lingering action URL means it did not take.
  const changed = await page.waitForURL((url) => !url.toString().includes('/app/action'), { timeout: 20000 })
    .then(() => true).catch(() => false);
  if (!changed) {
    throw new Error(`Password change not confirmed; still at ${page.url()} (new password: ${newPassword})`);
  }

  // Persist only once the change is confirmed, so column G never holds a password that was
  // never actually set.
  await updatePassword(rowIndex, newPassword);

  step('reset — sign in with new password');
  // ElevenLabs returns to the login form by itself once the password is changed, so stay on
  // this page. Opening a second tab raced that redirect and left an unnavigated about:blank.
  if (!page.url().includes('/app/sign-in')) {
    await page.goto('https://elevenlabs.io/app/sign-in', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 20000 });
  await page.waitForTimeout(1000);

  const outcome = await attemptSignIn(page, email, newPassword);
  if (outcome !== SIGN_IN.OK) {
    throw new Error(`Sign-in still failed after password reset (${outcome})`);
  }
  await page.waitForTimeout(3000);

  await finishOnboardingAndKey(page, rowIndex, email, newPassword);
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
  await finishOnboardingAndKey(page, rowIndex, email, elevenPass);
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
    await updateStatus(rowIndex, 'credentials-rejected');
    return;
  }

  if (outcome === SIGN_IN.UNVERIFIED) {
    console.log('[resume] Account exists but its email is unverified; fetching the link.');

    step('resume — MS login for verify link');
    const outlookPage = await loginMicrosoft(ctx, email, hotmailPassword);
    activePage = outlookPage;

    step('resume — poll Outlook for verify email');
    const verifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS);
    console.log('[resume] Verify URL found:', verifyUrl.substring(0, 80) + '...');

    step('resume — open verify URL');
    page = await ctx.newPage();
    activePage = page;
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });

    step('resume — click Continue');
    await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
    await clickHuman(page, 'button:has-text("Continue")');
    await page.waitForTimeout(2000);

    outcome = await attemptSignIn(page, email, elevenPass);
    if (outcome !== SIGN_IN.OK) {
      throw new Error(`Sign-in still failed after verifying (${outcome})`);
    }
    await page.waitForTimeout(3000);

    await finishOnboardingAndKey(page, rowIndex, email, elevenPass);
    return;
  }

  await page.waitForTimeout(3000);
  await finishOnboardingAndKey(page, rowIndex, email, elevenPass);
}

// ── Main loop ────────────────────────────────────────────────────────────────
// --limit N  process at most N accounts (default: all)
// --row N    process only the account on sheet row N
function parseArgs(argv) {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const rowArg = argv.find((a) => a.startsWith('--row='));
  const resume = argv.includes('--resume');
  const resetPassword = argv.includes('--reset-password');
  const regenerateKey = argv.includes('--regenerate-key');
  const noProxy = argv.includes('--no-proxy');
  const proxyTokenArg = argv.find((a) => a.startsWith('--proxy-token='));
  const proxyToken = proxyTokenArg ? proxyTokenArg.slice('--proxy-token='.length) : null;
  const rowsArg = argv.find((a) => a.startsWith('--rows='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  const row = rowArg ? Number(rowArg.split('=')[1]) : null;
  if (limitArg && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got: ${limitArg.split('=')[1]}`);
  }
  if (rowArg && (!Number.isInteger(row) || row < 2)) {
    throw new Error(`--row must be a sheet row >= 2 (row 1 is the header), got: ${rowArg.split('=')[1]}`);
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

  if (noProxy && proxyToken) {
    throw new Error('--no-proxy and --proxy-token are mutually exclusive');
  }

  return { limit, row, rows, resume, resetPassword, regenerateKey, noProxy, proxyToken };
}

async function run() {
  const { limit, row, rows, resume, resetPassword, regenerateKey, noProxy, proxyToken } = parseArgs(process.argv.slice(2));

  await initSheets();

  // --resume targets accounts that already exist: a password was recorded but no key was
  // ever captured. Returning these to 'pending' would not work - signup rejects the email
  // as already registered - so they are selected by content, not by status.
  let pendingRows;
  if (regenerateKey) {
    // Named explicitly: nothing in the sheet records how a key's permissions were granted,
    // so which rows need re-keying is a judgement only the operator can make.
    const all = await loadRows();
    pendingRows = all.filter((r) => rows.includes(r.rowIndex));
    const missing = rows.filter((n) => !pendingRows.some((r) => r.rowIndex === n));
    if (missing.length) throw new Error(`No such row(s) in the sheet: ${missing.join(', ')}`);
    const noPassword = pendingRows.filter((r) => !r.elevenPass);
    if (noPassword.length) {
      throw new Error(`Row(s) ${noPassword.map((r) => r.rowIndex).join(', ')} have no stored password to sign in with`);
    }
    console.log(`Re-keying ${pendingRows.length} account(s): rows ${rows.join(', ')}`);
  } else if (resetPassword) {
    // Rows --resume gave up on: the account exists but the stored password does not open it.
    pendingRows = (await loadRows()).filter((r) => r.status === 'credentials-rejected');
    console.log(`Loaded ${pendingRows.length} account(s) needing a password reset`);
  } else if (resume) {
    pendingRows = (await loadRows()).filter(
      (r) => r.status !== 'complete' && r.elevenPass && !r.apiKey,
    );
    console.log(`Loaded ${pendingRows.length} resumable accounts from Google Sheet`);
  } else {
    pendingRows = await loadPendingRows();
    console.log(`Loaded ${pendingRows.length} pending accounts from Google Sheet`);
  }

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
    const what = resetPassword ? 'accounts needing a reset' : resume ? 'resumable accounts' : 'pending accounts';
    console.log(`No ${what}. Exiting.`);
    return;
  }

  // Find a default proxy token if user only filled one cell
  let defaultToken = null;
  if (proxyToken) {
    defaultToken = proxyToken;
    console.log('\n[proxy] Using --proxy-token for this run (overrides the sheet).');
  } else if (noProxy) {
    console.log('\n[proxy] --no-proxy: skipping proxy rotation for this run.');
  } else {
    const allRowsForToken = await loadRows();
    const availableTokens = [...new Set(allRowsForToken.map((r) => r.proxyToken).filter(Boolean))];
    defaultToken = availableTokens.length > 0 ? availableTokens[0] : null;
    if (defaultToken) {
      console.log(`\n[proxy] Global proxy token found (${availableTokens.length} total). Will fallback to this token if a row is empty.`);
    }
  }

  // The browser will be launched per-account via GPM-Login API.
  for (let i = 0; i < pendingRows.length; i++) {
    const cred = pendingRows[i];
    console.log(`\n[${i + 1}/${pendingRows.length}] ${cred.email} (sheet row ${cred.rowIndex})`);

    // Reset before the try: otherwise a throw raised before this account's first step() call
    // would be attributed to the previous account's last step.
    currentStep = 'account start';

    // One context per account. A fresh context drops cookies, localStorage and IndexedDB, so
    // the previous account's Microsoft session cannot leak into this login. Closing it also
    // disposes every tab the account opened.
    
    let proxyString = '';
    const activeToken = noProxy ? null : (proxyToken || cred.proxyToken || defaultToken);
    if (activeToken) {
      step('rotate proxy');
      console.log(`[proxy] Fetching new proxy using token...`);
      try {
        const proxyData = await getNewProxyWithRetry(activeToken);
        proxyString = proxyData.proxy; // Dạng IP:Port:User:Pass
        console.log(`[proxy] Got proxy: ${proxyString}`);
      } catch (err) {
        console.error(`\n❌ FAILED [${cred.email}] at step: proxy rotation`);
        console.error(err.stack || err.message);
        await updateStatus(cred.rowIndex, 'failed:proxy_api').catch(() => {});
        continue;
      }
    }

    let gpmProfileId = null;
    let ctx = null;

    try {
      step('create GPM profile');
      gpmProfileId = await gpm.createProfile(cred.email, proxyString);
      console.log(`[GPM] Created profile ${gpmProfileId}`);
      
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
      if (regenerateKey) await regenerateAccountKey(ctx, cred);
      else if (resetPassword) await resetPasswordAndCreateKey(ctx, cred);
      else if (resume) await resumeAccount(ctx, cred);
      else await processAccount(ctx, cred);
    } catch (err) {
      console.error(`\n❌ FAILED [${cred.email}] at step: ${currentStep}`);
      console.error(err.stack || err.message);

      // Classify failure: MS login steps = account inactive/bad creds.
      // But a transport failure (proxy refusing, connection closed, DNS) says nothing about
      // the mailbox - the credentials were never even submitted. Calling that 'inactive'
      // tells the operator to write off a perfectly good account; observed when a US proxy
      // could not reach login.live.com and the row was marked dead.
      const isNetworkError = /net::ERR_/.test(err.message || '');
      const isInactive = !resume && !resetPassword && !regenerateKey
        && currentStep.startsWith('MS login') && !isNetworkError;
      const failStatus = isNetworkError ? 'failed:network' : isInactive ? 'inactive' : `failed:${currentStep}`;

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
      if (browser) {
        // Just disconnect the CDP session
        await browser.close().catch(() => {});
        browser = null;
      }
      if (gpmProfileId) {
        step('stop and delete GPM profile');
        await gpm.stopProfile(gpmProfileId).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        await gpm.deleteProfile(gpmProfileId).catch(() => {});
        console.log(`[GPM] Profile ${gpmProfileId} deleted.`);
      }
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
