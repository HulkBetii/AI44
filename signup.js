const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function saveAccount(email, password, apiKey) {
  const accounts = fs.existsSync(ACCOUNTS_FILE)
    ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
    : [];
  const id = accounts.length + 1;
  accounts.push({ id, email, password, apiKey, createdAt: new Date().toISOString() });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  console.log(`[✓] Account #${id} saved to accounts.json`);
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

    if (messages && messages.length > 0) {
      // Get full message to find verify link
      const msgRes = await fetch(`${base}/messages/${messages[0].id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const msg = await msgRes.json();
      const body = msg.html?.[0] || msg.text || '';

      // Extract ElevenLabs verify URL
      const match = body.match(/href="(https:\/\/elevenlabs\.io\/app\/action[^"]+)"/);
      if (match) return match[1].replace(/&amp;/g, '&');
    }

    console.log('[3] No email yet, waiting 5s...');
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

// Human-like typing
async function typeHuman(page, selector, text) {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 80 });
  }
}

(async () => {
  // ── STEP 1: Create mail.tm account ─────────────────────────────────────────
  console.log('[1] Creating mail.tm account...');
  const { address: email, token: mailToken } = await createMailTmAccount();
  const password = generatePassword();
  console.log(`✅ Email: ${email}`);
  console.log(`✅ Password: ${password}`);

  // ── STEP 2: Launch real Chrome with copied user profile ────────────────────
  const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const PROFILE_DIR = 'D:\\VibeCoding\\mail-temp\\chrome-profile';

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_EXE,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--profile-directory=Default',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    slowMo: 50,
  });
  // Hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ── STEP 3: Sign up on ElevenLabs ──────────────────────────────────────────
  console.log('[2] Opening ElevenLabs sign-up...');
  const page = await context.newPage();

  // Clear all ElevenLabs cookies + storage to avoid existing session interference
  await context.clearCookies({ domain: 'elevenlabs.io' });
  console.log('[2] Cleared ElevenLabs cookies.');

  await page.goto('https://elevenlabs.io', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  console.log('[2] Cleared ElevenLabs localStorage/sessionStorage.');

  await page.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="sign-up-email-input"]', { timeout: 15000 });

  // Human-like delay before typing
  await page.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(page, '[data-testid="sign-up-email-input"]', email);
  await page.waitForTimeout(400 + Math.random() * 300);
  await typeHuman(page, '[data-testid="sign-up-password-input"]', password);
  await page.waitForTimeout(600 + Math.random() * 400);

  console.log('[2] Clicking Sign up...');
  await page.click('button[style*="view-transition-name: submit"]');

  // ── STEP 4: Handle CAPTCHA if present ──────────────────────────────────────
  // Wait up to 60s for either: CAPTCHA disappears OR URL changes
  console.log('[2] Waiting for CAPTCHA to be solved or page to change...');
  try {
    await page.waitForFunction(
      () => !document.querySelector('[class*="captcha"], iframe[src*="captcha"]') || 
             window.location.href !== 'https://elevenlabs.io/app/sign-up',
      { timeout: 120000 }
    );
  } catch {
    // Try anyway
  }

  const urlAfter = page.url();
  console.log(`[2] URL after signup: ${urlAfter}`);

  // If still on signup page, CAPTCHA may need solving - wait for user
  if (page.url().includes('sign-up')) {
    console.log('\n⚠️  CAPTCHA detected. Please solve it in the browser window.');
    // Wait for either: URL changes OR "Resend" button appears (= verification email sent)
    await Promise.race([
      page.waitForURL(url => !url.toString().includes('/sign-up'), { timeout: 300000 }),
      page.waitForSelector('button:has-text("Resend")', { timeout: 300000 }),
    ]);
    console.log('[2] Signup complete! URL:', page.url());
  }

  // ── STEP 5: Poll mail.tm for verify email ──────────────────────────────────
  console.log('[3] Polling mail.tm for verification email...');
  const verifyUrl = await pollMailTmInbox(mailToken, 120000);
  console.log('[3] Verify URL found:', verifyUrl.substring(0, 80) + '...');

  // ── STEP 6: Open verify URL ─────────────────────────────────────────────────
  console.log('[4] Opening verify URL...');
  const verifyPage = await context.newPage();
  await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
  console.log(`[4] URL: ${verifyPage.url()}`);

  // ── STEP 7: Click Continue ──────────────────────────────────────────────────
  console.log('[5] Clicking Continue...');
  await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
  await verifyPage.click('button:has-text("Continue")');
  await verifyPage.waitForTimeout(2000);

  // ── STEP 8: Sign in ─────────────────────────────────────────────────────────
  console.log('[6] Signing in...');
  await verifyPage.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 15000 });
  await typeHuman(verifyPage, '[data-testid="sign-in-email-input"]', email);
  await verifyPage.waitForTimeout(300);
  await typeHuman(verifyPage, '[data-testid="sign-in-password-input"]', password);
  await verifyPage.waitForTimeout(400);
  await verifyPage.click('[data-testid="sign-in-submit-button"]');
  await verifyPage.waitForTimeout(5000);

  // ── STEP 9: Onboarding ──────────────────────────────────────────────────────
  console.log('[7] Onboarding...');
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
  console.log('[8] Creating API key...');
  await verifyPage.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'networkidle' });
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

  // Click "Create Key" in dialog (the protected one)
  await verifyPage.click('[data-agent-protected="true"]:has-text("Create Key")');
  await verifyPage.waitForTimeout(2000);

  // Click "Copy to Clipboard"
  await verifyPage.waitForSelector('button:has-text("Copy to Clipboard")', { timeout: 10000 });
  await verifyPage.click('button:has-text("Copy to Clipboard")');
  await verifyPage.waitForTimeout(500);

  // Read clipboard
  const apiKey = await verifyPage.evaluate(() => navigator.clipboard.readText());
  console.log(`[8] API Key: ${apiKey}`);

  console.log(`\n✅ Done!`);
  console.log(`   Email: ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   API Key: ${apiKey}`);

  saveAccount(email, password, apiKey);
})();
