const { chromium } = require('playwright');

function generatePassword() {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const specials = '!@#$%^&*';
  const rand = (str) => str[Math.floor(Math.random() * str.length)];
  const base = Array.from({ length: 6 }, () => rand(letters)).join('');
  return base + rand(numbers) + rand(specials);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // ── STEP 1: Get temp email ──────────────────────────────────────────────────
  console.log('[1] Getting temp email...');
  const mailPage = await context.newPage();
  await mailPage.goto('https://temp-mail.org/vi', { waitUntil: 'domcontentloaded' });
  await mailPage.waitForSelector('#mail', { timeout: 10000 });
  await mailPage.waitForFunction(
    () => { const el = document.querySelector('#mail'); return el && el.value && el.value.includes('@'); },
    { timeout: 30000 }
  );
  const email = await mailPage.$eval('#mail', el => el.value);
  const password = generatePassword();
  console.log(`[1] Email: ${email}`);
  console.log(`[1] Password: ${password}`);

  // Extract the token from the page for API polling later
  // temp-mail stores a token in localStorage or cookie
  const token = await mailPage.evaluate(() => {
    // Try localStorage
    for (const key of Object.keys(localStorage)) {
      if (localStorage[key] && key.toLowerCase().includes('token')) return localStorage[key];
    }
    // Try cookie
    return document.cookie;
  });
  console.log('[1] Auth token/cookie:', token?.substring(0, 100));

  // ── STEP 2: Sign up on ElevenLabs ──────────────────────────────────────────
  console.log('[2] Navigating to ElevenLabs sign-up...');
  const signupPage = await context.newPage();
  await signupPage.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'networkidle' });

  // Capture any console errors
  signupPage.on('console', msg => { if (msg.type() === 'error') console.log('[2 console error]', msg.text()); });

  await signupPage.waitForSelector('[data-testid="sign-up-email-input"]', { timeout: 15000 });

  // Check button state before filling
  const btnDisabledBefore = await signupPage.$eval('button[style*="view-transition-name: submit"]', b => b.disabled);
  console.log('[2] Button disabled before fill:', btnDisabledBefore);

  await signupPage.fill('[data-testid="sign-up-email-input"]', email);
  await signupPage.waitForTimeout(500);
  await signupPage.fill('[data-testid="sign-up-password-input"]', password);
  await signupPage.waitForTimeout(1000);

  const btnDisabledAfter = await signupPage.$eval('button[style*="view-transition-name: submit"]', b => b.disabled);
  console.log('[2] Button disabled after fill:', btnDisabledAfter);

  // Take screenshot before clicking
  await signupPage.screenshot({ path: 'debug-before-signup.png' });

  if (btnDisabledAfter) {
    console.log('[2] Button still disabled! Checking password requirements...');
    // Check validation messages
    const msgs = await signupPage.$$eval('[class*="error"], [class*="invalid"], [class*="hint"]', els => els.map(e => e.textContent.trim()));
    console.log('[2] Validation messages:', msgs);
  }

  await signupPage.click('button[style*="view-transition-name: submit"]', { force: true });
  console.log('[2] Clicked Sign up (force=true)');

  // Wait and take screenshot after click
  await signupPage.waitForTimeout(5000);
  await signupPage.screenshot({ path: 'debug-after-signup.png' });
  console.log('[2] Current URL after signup:', signupPage.url());

  // Check for error messages on page
  const pageText = await signupPage.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('[2] Page text after signup:', pageText);

  // ── STEP 3: Poll temp-mail API directly ────────────────────────────────────
  console.log('[3] Polling temp-mail inbox via API...');
  await mailPage.bringToFront();

  // Get the email hash (md5) — temp-mail API uses md5 of email
  const emailForApi = email.trim().toLowerCase();
  
  let verifyLink = null;
  for (let i = 0; i < 24; i++) {
    console.log(`[3] Checking inbox via API... attempt ${i + 1}/24`);
    
    try {
      // Use temp-mail's internal API endpoint
      const apiResult = await mailPage.evaluate(async (addr) => {
        const md5 = async (str) => {
          // Simple fetch to temp-mail API
          return str;
        };
        const res = await fetch(`https://temp-mail.org/api/v3/email/messages`, {
          headers: { 'Content-Type': 'application/json' }
        });
        return res.status + ' ' + (await res.text()).substring(0, 200);
      }, emailForApi);
      console.log('[3] API response:', apiResult);
    } catch(e) {
      console.log('[3] API error:', e.message);
    }

    // Also check DOM
    const liCount = await mailPage.$$eval('.inbox-dataList li', els => els.length);
    const visibleLi = await mailPage.$$eval('.inbox-dataList li:not(.hide)', els => els.length);
    console.log(`[3] Total li: ${liCount}, visible li: ${visibleLi}`);
    
    if (visibleLi > 0) {
      const elevenLabsItem = await mailPage.$('.inbox-dataList li:not(.hide) a[href*="/view/"]');
      if (elevenLabsItem) {
        await elevenLabsItem.click();
        await mailPage.waitForTimeout(3000);
        verifyLink = await mailPage.$('a[href*="elevenlabs.io/app/action"]');
        if (verifyLink) break;
      }
    }

    await mailPage.waitForTimeout(5000);
  }

  if (!verifyLink) {
    console.error('[3] No verification email found after all attempts.');
    console.log('Screenshots saved: debug-before-signup.png, debug-after-signup.png');
    // Don't close so user can inspect
    return;
  }

  // ── STEP 4: Click verify link ───────────────────────────────────────────────
  console.log('[4] Clicking Verify email...');
  const [verifyTab] = await Promise.all([
    context.waitForEvent('page'),
    verifyLink.click(),
  ]);
  await verifyTab.waitForLoadState('domcontentloaded');
  console.log(`[4] Tab URL: ${verifyTab.url()}`);

  // ── STEP 5: Click Continue ─────────────────────────────────────────────────
  await verifyTab.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
  await verifyTab.click('button:has-text("Continue")');
  console.log('[5] Clicked Continue.');
  await verifyTab.waitForTimeout(2000);

  // ── STEP 6: Sign in ────────────────────────────────────────────────────────
  console.log('[6] Signing in...');
  await verifyTab.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 15000 });
  await verifyTab.fill('[data-testid="sign-in-email-input"]', email);
  await verifyTab.fill('[data-testid="sign-in-password-input"]', password);
  await verifyTab.click('[data-testid="sign-in-submit-button"]');
  await verifyTab.waitForTimeout(5000);
  
  console.log('✅ Done! Final URL:', verifyTab.url());
  console.log(`   Email: ${email}`);
  console.log(`   Password: ${password}`);
})();
