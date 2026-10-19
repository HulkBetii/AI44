/**
 * chatgpt-auth.js (trial-gpt)
 * Handles ChatGPT Sign Up flow with Hotmail, robust Turnstile auto-clicker,
 * bilingual support (EN/VI), visible element filtering, and automated Outlook verification.
 */

const fs = require('fs');
const path = require('path');
const {
  typeHuman,
  clickHuman,
  think,
  generateRealisticName,
} = require('../human-behavior');
const { openOutlookInbox, waitForOpenAIVerification } = require('./outlook-client');
const { solveCaptcha } = require('../captcha-solver');

const SCREENSHOT_DIR = path.join(__dirname, '..', '.runtime', 'screenshots');

async function captureDebugScreenshot(page, stepName) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `auth_${stepName}_${Date.now()}.png`;
    const fullPath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    console.log(`[screenshot] Saved: ${filename}`);
    return fullPath;
  } catch (err) {
    console.warn(`[screenshot] Failed to save screenshot (${stepName}): ${err.message}`);
    return null;
  }
}

/**
 * Handle Cloudflare Turnstile "Verify you are human" / "Xác minh bạn là con người"
 */
async function handleCloudflareTurnstile(page, timeoutMs = 25000) {
  const startTime = Date.now();
  console.log('[auth] Checking & resolving Cloudflare Turnstile challenge...');

  let cdpClient = null;
  try {
    cdpClient = await page.context().newCDPSession(page);
  } catch {}

  let authChallengeAttempts = 0;
  let loopCount = 0;
  while (Date.now() - startTime < timeoutMs) {
    loopCount++;
    const url = page.url();
    const title = await page.title().catch(() => '');
    const isChallengeTitle = /just a moment|chờ một chút|performing security/i.test(title);
    if (loopCount <= 3 || loopCount % 3 === 0) {
      console.log(`[turnstile] loop#${loopCount} url=${url.split('?')[0]} title="${title.slice(0, 60)}"`);
    }

    // Case 1: We're back on chatgpt.com and landing buttons visible → done
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      const hasLandingButtons = await page.locator('button').filter({ hasText: /Đăng ký miễn phí|Sign up for free|Đăng nhập|Log in/i }).locator('visible=true').first().isVisible({ timeout: 1000 }).catch(() => false);
      if (hasLandingButtons && !isChallengeTitle) {
        console.log('[auth] Cloudflare challenge passed. ChatGPT UI is active.');
        return true;
      }
    }

    // Case 1b: auth.openai.com challenge resolved — password/OTP/check-inbox form visible
    if (url.includes('auth.openai.com') && !isChallengeTitle) {
      const hasAuthForm = await page.locator('input[type="password"], input[name="code"], input[type="email"], input[placeholder*="Mã"], input[placeholder*="Code"]').locator('visible=true').first().isVisible({ timeout: 1000 }).catch(() => false);
      const hasContinueWithPass = await page.locator('button, a').filter({ hasText: /continue with password|tiếp tục.*mật khẩu/i }).locator('visible=true').first().isVisible({ timeout: 1000 }).catch(() => false);
      const hasCheckInbox = await page.locator('text=/check your inbox|kiểm tra/i').first().isVisible({ timeout: 500 }).catch(() => false);
      if (hasAuthForm || hasContinueWithPass || hasCheckInbox) {
        console.log('[auth] Cloudflare challenge on auth.openai.com passed. Auth form is active.');
        return true;
      }
    }

    // Case 1c: auth/error page ("Chúng tôi đã gặp sự cố khi đăng nhập")
    if (url.includes('auth/error')) {
      console.log('[auth] Detected /auth/error page (temporary OpenAI login issue).');
      const backBtn = page.locator('button:has-text("Quay lại"), button:has-text("Go back"), a:has-text("Quay lại"), a:has-text("Go back")').locator('visible=true').first();
      if (await backBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await backBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
      return false;
    }

    // Case 2: auth.openai.com challenge ("Just a moment..." or "Verify you are human")
    if (url.includes('auth.openai.com') || url.includes('challenges.cloudflare.com')) {
      authChallengeAttempts++;
      console.log(`[auth] Cloudflare challenge on auth.openai.com (attempt ${authChallengeAttempts}). Resolving...`);

      // Debug: Log DOM structure on first 2 attempts
      if (authChallengeAttempts <= 2) {
        const debugInfo = await page.evaluate(() => {
          const iframes = [...document.querySelectorAll('iframe')].map(f => ({
            src: f.src?.substring(0, 100) || '',
            width: f.width, height: f.height,
            rect: f.getBoundingClientRect ? JSON.stringify(f.getBoundingClientRect()) : '',
          }));
          const inputs = [...document.querySelectorAll('input[type="checkbox"]')].map(i => ({
            id: i.id, name: i.name, className: i.className,
          }));
          const labels = [...document.querySelectorAll('label')].map(l => l.textContent?.trim().substring(0, 50));
          const turnstile = document.querySelector('.cf-turnstile, [data-sitekey]');
          return {
            iframeCount: iframes.length, iframes,
            checkboxCount: inputs.length, inputs,
            labels: labels.slice(0, 5),
            hasTurnstileWidget: !!turnstile,
            sitekey: turnstile?.getAttribute('data-sitekey') || null,
            bodyText: document.body?.innerText?.substring(0, 200) || '',
          };
        }).catch(() => ({ error: 'failed to evaluate DOM' }));
        console.log(`[auth][debug] DOM: ${JSON.stringify(debugInfo)}`);
      }

      // 1. Check all child frames directly
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) {
          try {
            await frame.locator('input[type="checkbox"], label, span.mark, .ctp-checkbox-label').first().click({ force: true, timeout: 1500 });
            console.log('[auth] Clicked Turnstile checkbox via child frame!');
          } catch {}
        }
      }

      // 2. Direct click on iframe at checkbox position via CDP native mouse
      const iframeEl = page.locator('iframe').first();
      const box = await iframeEl.boundingBox().catch(() => null);
      if (box && cdpClient) {
        const targetX = Math.round(box.x + 28);
        const targetY = Math.round(box.y + box.height / 2);
        console.log(`[auth] Dispatching CDP mouse events to Turnstile at (${targetX}, ${targetY})...`);
        try {
          await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: targetY });
          await think(120, 250);
          await cdpClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: targetX, y: targetY, button: 'left', clickCount: 1 });
          await think(80, 160);
          await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: targetY, button: 'left', clickCount: 1 });
        } catch {}
      }

      // 3. Fallback coordinates click for standard auth.openai.com viewport layout
      if (cdpClient) {
        try {
          await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 48, y: 367 });
          await think(100, 200);
          await cdpClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 48, y: 367, button: 'left', clickCount: 1 });
          await think(80, 150);
          await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 48, y: 367, button: 'left', clickCount: 1 });
        } catch {}
      }

      await page.waitForTimeout(3000);
      continue;
    }

    // Case 3: chatgpt.com Turnstile challenge (title = "Just a moment")
    // 1. Direct iframe click
    const iframe = page.locator('iframe[src*="cloudflare"], iframe[src*="turnstile"], iframe').locator('visible=true').first();
    if (await iframe.isVisible().catch(() => false)) {
      console.log('[auth] Clicking Turnstile iframe directly...');
      await iframe.click({ position: { x: 30, y: 30 }, force: true }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // 2. Playwright FrameLocator click inside iframe
    try {
      const frame = page.frameLocator('iframe[src*="cloudflare"], iframe[src*="turnstile"], iframe').first();
      await frame.locator('input[type="checkbox"], label, span.mark, .ctp-checkbox-label, #challenge-stage, body').first().click({ force: true, timeout: 1000 }).catch(() => {});
    } catch {}

    // 3. Viewport geometry click via CDP native mouse events
    const dimensions = await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 1000,
      height: window.innerHeight || document.documentElement.clientHeight || 1000,
    })).catch(() => ({ width: 1000, height: 1000 }));

    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const turnstileCheckX = Math.round(centerX - 135);
    const turnstileCheckY = Math.round(centerY + 55);

    if (cdpClient) {
      try {
        await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: turnstileCheckX, y: turnstileCheckY });
        await cdpClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: turnstileCheckX, y: turnstileCheckY, button: 'left', clickCount: 1 });
        await think(60, 120);
        await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: turnstileCheckX, y: turnstileCheckY, button: 'left', clickCount: 1 });
      } catch {}
    }

    await page.waitForTimeout(2500);
  }

  console.log('[auth] Cloudflare verification wait finished.');
}

/**
 * Dismiss cookie dialog if present
 */
async function dismissCookieBanner(page) {
  try {
    const cookieBtn = page.locator('button:has-text("Chấp nhận tất cả"), button:has-text("Accept all"), button:has-text("Từ chối cookie không thiết yếu"), button:has-text("Reject non-essential")').locator('visible=true').first();
    if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[auth] Dismissing cookie banner...');
      await cookieBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  } catch {}
}

/**
 * Check if the page is currently on ChatGPT main authenticated dashboard
 */
async function isChatGPTDashboard(page) {
  try {
    const url = page.url();
    if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) return false;

    // Check if landing login/signup buttons are visible -> if yes, NOT authenticated
    const hasLoginBtn = await page.locator('button').filter({ hasText: /Đăng ký miễn phí|Sign up for free/i }).locator('visible=true').first().isVisible({ timeout: 2000 }).catch(() => false);
    if (hasLoginBtn) return false;

    // Check for authenticated user menu / avatar
    const hasUserMenu = await page.locator('button[data-testid="user-menu-button"], button[aria-label="User menu"], button[aria-label*="profile"], button[data-testid="profile-button"], img[alt="User"]').locator('visible=true').first().isVisible({ timeout: 2000 }).catch(() => false);
    if (hasUserMenu) return true;

    // Check for chat input (main indicator of authenticated dashboard)
    const hasChatInput = await page.locator('#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"][data-placeholder], textarea[placeholder*="Message"], textarea[placeholder*="Hỏi"]').locator('visible=true').first().isVisible({ timeout: 2000 }).catch(() => false);
    if (hasChatInput) return true;

    // Check for sidebar elements (authenticated-only)
    const hasSidebar = await page.locator('nav a[href="/"], nav:has-text("Đoạn chat mới"), nav:has-text("New chat")').locator('visible=true').first().isVisible({ timeout: 1500 }).catch(() => false);
    if (hasSidebar) return true;

    // Check session API
    const isSessionActive = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/session');
        const data = await res.json();
        return !!(data?.user && data?.accessToken);
      } catch {
        return false;
      }
    }).catch(() => false);

    return isSessionActive;
  } catch {
    return false;
  }
}


/**
 * Handle first-time ChatGPT onboarding screen (Name / Age / Birthday / Terms)
 */
async function handleChatGPTOnboarding(page) {
  console.log('[auth] Checking for ChatGPT onboarding / profile completion...');
  await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
  await dismissCookieBanner(page);

  const randomName = generateRealisticName();
  const fullName = randomName.fullName || `${randomName.firstName} ${randomName.lastName}`;

  // Find all visible editable inputs in the onboarding form (exclude readonly)
  const inputs = page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([readonly])').locator('visible=true');
  const inputCount = await inputs.count().catch(() => 0);

  if (inputCount > 0) {
    console.log(`[auth] Detected ${inputCount} potential onboarding input field(s).`);

    // Filter genuinely editable inputs
    const editableInputs = [];
    for (let i = 0; i < inputCount; i++) {
      const input = inputs.nth(i);
      const isEditable = await input.isEditable().catch(() => false);
      if (isEditable) {
        editableInputs.push(input);
      }
    }

    console.log(`[auth] Found ${editableInputs.length} genuinely editable field(s).`);

    if (editableInputs.length > 0) {
      // First input: Full Name
      const nameInput = editableInputs[0];
      console.log(`[auth] Filling onboarding name: ${fullName}`);
      await think(400, 800);
      await nameInput.fill('');
      await nameInput.pressSequentially(fullName, { delay: 60 + Math.floor(Math.random() * 40) });
      await think(400, 800);

      // Second input (if present): Age / Birthday
      if (editableInputs.length > 1) {
        const ageInput = editableInputs[1];
        const placeholder = await ageInput.getAttribute('placeholder').catch(() => '') || '';
        const ariaLabel = await ageInput.getAttribute('aria-label').catch(() => '') || '';

        console.log(`[auth] Filling onboarding age/birthday field (placeholder: "${placeholder}", label: "${ariaLabel}")...`);
        await ageInput.fill('');

        if (/MM|DD|YYYY|ngày sinh|birthday/i.test(placeholder + ariaLabel)) {
          await ageInput.pressSequentially('05/15/1996', { delay: 60 + Math.floor(Math.random() * 40) });
        } else {
          // Default to realistic age number (24 - 32)
          const randomAge = String(24 + Math.floor(Math.random() * 9));
          await ageInput.pressSequentially(randomAge, { delay: 60 + Math.floor(Math.random() * 40) });
        }
        await think(400, 800);
      }

      // Submit / Agree button (EN/VI)
      const agreeBtn = page.locator('button:has-text("Tiếp tục"), button:has-text("Continue"), button:has-text("Agree"), button[type="submit"]:has-text("Next"), button:has-text("Đồng ý")').locator('visible=true').first();
      if (await agreeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[auth] Clicking Agree / Continue...');
        await think(300, 700);
        await agreeBtn.click();
        await page.waitForTimeout(4000 + Math.floor(Math.random() * 2000));
      }
    }
  }

  // Check for "Okay, let's go" / "Bắt đầu" or welcome modal
  const okBtn = page.locator('button:has-text("Okay, let\'s go"), button:has-text("Next"), button:has-text("Done"), button:has-text("Bắt đầu"), button:has-text("Xong")').locator('visible=true').first();
  if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('[auth] Dismissing welcome modal...');
    await think(300, 600);
    await okBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Dismiss any remaining dialog (e.g. "Bạn đã hoàn tất" completion dialog)
  const completionDialog = page.locator('dialog[open]');
  if (await completionDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    const dialogDismiss = completionDialog.locator('button:has-text("Okay"), button:has-text("Bắt đầu"), button:has-text("Done"), button:has-text("Xong"), button:has-text("Close"), button:has-text("OK"), button:has-text("Tiếp tục"), button:has-text("Continue")').first();
    if (await dialogDismiss.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[auth] Dismissing completion dialog...');
      await dialogDismiss.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape');
      console.log('[auth] Dismissed completion dialog via Escape.');
    }
    await page.waitForTimeout(1500);
  }
}


/**
 * Handle OpenAI Email Verification / OTP flow using Outlook Web in a separate tab
 */
async function handleEmailVerification(page, email, password) {
  console.log('[auth] Email verification required. Launching Outlook tab to extract OTP/link...');
  await captureDebugScreenshot(page, 'verify_prompt');

  const context = page.context();
  let mailPage = null;

  try {
    mailPage = await openOutlookInbox(context, email, password);
    const verification = await waitForOpenAIVerification(mailPage, 90000);

    await page.bringToFront();

    if (verification.type === 'otp') {
      console.log(`[auth] Entering OTP ${verification.code} into ChatGPT verification form...`);
      const otpInput = page.locator('input[name="code"], input[type="text"][maxlength="6"], input[autocomplete="one-time-code"], input[placeholder*="code"], input[placeholder*="mã"], input[type="text"]').locator('visible=true').first();

      if (await otpInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await otpInput.fill('');
        await otpInput.pressSequentially(verification.code, { delay: 80 });
        await think(300, 600);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);

        // After OTP, may need to create password (first-time signup)
        await handleCloudflareTurnstile(page);
        const postOtpPassInput = page.locator('input[type="password"]').locator('visible=true').first();
        if (await postOtpPassInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('[auth] Post-OTP: Password creation required...');
          let newPass = password;
          if (newPass.length < 12) newPass = newPass + 'Aa1!'.repeat(Math.ceil((12 - newPass.length) / 4)).slice(0, 12 - newPass.length);
          await postOtpPassInput.fill('');
          await postOtpPassInput.pressSequentially(newPass, { delay: 60 });
          await think(300, 600);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(4000);
          await handleCloudflareTurnstile(page);
        }
      }
    } else if (verification.type === 'link') {
      console.log(`[auth] Navigating to verification link: ${verification.url}...`);
      await page.goto(verification.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }
  } finally {
    if (mailPage) {
      try { await mailPage.close(); } catch {}
    }
  }
}

/**
 * Main authenticate & signup orchestration
 */
async function authenticateChatGPT(page, email, password) {
  console.log(`[auth] Navigating to ChatGPT for ${email}...`);
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);

  // 1. Resolve initial Cloudflare challenge
  await handleCloudflareTurnstile(page);

  if (await isChatGPTDashboard(page)) {
    console.log('[auth] Already authenticated on ChatGPT.');
    return true;
  }

  await captureDebugScreenshot(page, 'landing_page');
  await dismissCookieBanner(page);

  // 2. Click the visible Sign up / Register button at top-right
  console.log('[auth] Clicking visible Sign up / Log in button at top-right...');
  const visibleButtons = page.locator('button').filter({ hasText: /Đăng ký miễn phí|Sign up for free|Đăng nhập|Log in/i }).locator('visible=true');
  const count = await visibleButtons.count().catch(() => 0);

  if (count > 0) {
    const targetBtn = visibleButtons.last();
    console.log(`[auth] Found ${count} visible auth button(s). Clicking target button...`);
    await targetBtn.click({ force: true });
    await page.waitForTimeout(1500);
  }

  // 3. Wait for the modal dialog and VISIBLE email input
  console.log('[auth] Waiting for visible email input on modal...');
  const emailInput = page.locator('input#email, #modal-no-auth-login input[type="email"], [role="dialog"] input[type="email"], input[name="email"]').locator('visible=true').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);

  await captureDebugScreenshot(page, 'signup_modal_ready');

  console.log(`[auth] Entering signup email: ${email}...`);
  await think(400, 800);
  await emailInput.fill('');
  await emailInput.pressSequentially(email, { delay: 60 });
  await think(400, 700);

  // Submit email via Enter key or Continue button
  console.log('[auth] Submitting email via Enter key...');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  // If still on modal with email input visible, click submit button as fallback
  if (await emailInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    const modalSubmitBtn = page.locator('button[type="submit"], button:has-text("Tiếp tục"), button:has-text("Continue")').locator('visible=true').first();
    if (await modalSubmitBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[auth] Clicking modal submit button as fallback...');
      await modalSubmitBtn.click().catch(() => {});
    }
  }

  // Wait for transition away from login_with intermediate redirect
  await page.waitForURL(u => !u.href.includes('auth/login_with'), { timeout: 15000 }).catch(() => {});

  // Check for Cloudflare challenge on auth.openai.com transition
  await handleCloudflareTurnstile(page);

  await captureDebugScreenshot(page, 'after_email_submit');

  // 4a. Check for "Continue with password" / "Tiếp tục với mật khẩu" button (existing account flow, EN/VI)
  const continueWithPassBtn = page.locator('button, a').filter({ hasText: /continue with password|tiếp tục.*mật khẩu/i }).locator('visible=true').first();
  if (await continueWithPassBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log('[auth] Detected existing account — clicking "Continue with password"...');
    await continueWithPassBtn.click();
    await page.waitForTimeout(2000);
  }

  // 4b. Enter Password (EN/VI)
  const passInput = page.locator('#modal-no-auth-login input[type="password"], [role="dialog"] input[type="password"], input#password, input[type="password"]').locator('visible=true').first();
  const passVisible = await passInput.isVisible({ timeout: 8000 }).catch(() => false);

  if (passVisible) {
    // OpenAI requires minimum 12 characters for password
    let effectivePassword = password;
    if (effectivePassword.length < 12) {
      effectivePassword = effectivePassword + 'Aa1!'.repeat(Math.ceil((12 - effectivePassword.length) / 4)).slice(0, 12 - effectivePassword.length);
      console.log(`[auth] Password padded to ${effectivePassword.length} chars (OpenAI requires ≥12).`);
    }

    console.log(`[auth] Entering password for signup/login...`);
    await think(400, 800);
    await passInput.fill('');
    await passInput.pressSequentially(effectivePassword, { delay: 60 });
    await think(400, 700);

    console.log('[auth] Submitting password via Enter key...');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // Check if still on password page (validation error like "at least 12 characters")
    const stillOnPasswordPage = await page.locator('input[type="password"]').locator('visible=true').first().isVisible({ timeout: 1500 }).catch(() => false);
    const hasValidationError = await page.evaluate(() => document.body?.innerText || '').then(t => /12 ký tự|12 characters|at least 12|ít nhất 12/i.test(t)).catch(() => false);

    if (stillOnPasswordPage && hasValidationError) {
      console.log('[auth] Password validation failed (< 12 chars). Retrying with stronger password...');
      const strongPassword = password + 'Secure2024!';
      const retryInput = page.locator('input[type="password"]').locator('visible=true').first();
      await retryInput.fill('');
      await retryInput.pressSequentially(strongPassword, { delay: 60 });
      await think(300, 600);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }

    // Check for Cloudflare challenge after password submit
    await handleCloudflareTurnstile(page);

    // Check for wrong password error (EN/VI)
    const pageBodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const isWrongPassword = /wrong password|incorrect password|invalid password|mật khẩu không đúng|sai mật khẩu|mật khẩu không chính xác|your password was incorrect/i.test(pageBodyText) ||
      await page.locator('[role="alert"], #error-element-password, .error-message').locator('text=/password|mật khẩu/i').isVisible({ timeout: 1500 }).catch(() => false);

    if (isWrongPassword) {
      console.log(`❌ [auth] Wrong password detected for ${email}! Skipping account.`);
      await captureDebugScreenshot(page, 'wrong_password_error');
      const err = new Error(`WRONG_PASSWORD: Password is incorrect for ${email}`);
      err.code = 'WRONG_PASSWORD';
      throw err;
    }
  }

  // 5. Check if Email Verification (OTP / Link) screen appeared (EN/VI)
  const pageContent = await page.content().catch(() => '');
  const needsVerification = /check your inbox|verify your email|xác thực email|check your email|kiểm tra email|mã xác minh|mã bảo mật|enter the verification code/i.test(pageContent) ||
    await page.locator('input[name="code"], input[autocomplete="one-time-code"], input[placeholder*="Code"], input[placeholder*="mã"]').locator('visible=true').first().isVisible({ timeout: 3000 }).catch(() => false);

  if (needsVerification && !await isChatGPTDashboard(page)) {
    console.log('[auth] Email verification (OTP/Link) required. Launching Outlook tab to extract OTP/link...');
    await handleEmailVerification(page, email, password);
  }

  // 6. Wait for redirect back to ChatGPT
  console.log('[auth] Waiting for return to ChatGPT...');
  await page.waitForURL(/chatgpt\.com|chat\.openai\.com/, { timeout: 45000 }).catch(() => {});

  // 7. Handle onboarding (Name, Birthday/Age)
  await handleChatGPTOnboarding(page);

  // 8. Handle Server 500 / error pages with retry
  for (let retry = 0; retry < 3; retry++) {
    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const hasServerError = /server error|oops.*error|error occurred|lỗi.*không xác định|rất tiếc/i.test(pageText);
    const tryAgainBtn = page.locator('button:has-text("Try again"), button:has-text("Thử lại"), a:has-text("Try again"), a:has-text("Thử lại")').locator('visible=true').first();

    if (hasServerError || await tryAgainBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log(`[auth] Server error detected (retry ${retry + 1}/3). Navigating to chatgpt.com...`);
      await captureDebugScreenshot(page, `server_error_retry_${retry + 1}`);

      // Navigate directly to chatgpt.com instead of clicking "Try again"
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(8000); // Longer wait for server recovery

      // Check if we're now on the dashboard (account may have been created successfully)
      if (await isChatGPTDashboard(page)) {
        console.log('[auth] Dashboard loaded after retry — account created successfully!');
        break;
      }

      // Re-check onboarding after retry
      await handleChatGPTOnboarding(page);
    } else {
      break;
    }
  }

  // 9. Verify dashboard
  const isSuccess = await isChatGPTDashboard(page);
  if (!isSuccess) {
    await page.waitForTimeout(4000);
  }

  await captureDebugScreenshot(page, `auth_final_${isSuccess ? 'success' : 'pending'}`);
  console.log(`[auth] Authentication result for ${email}: ${isSuccess ? 'SUCCESS' : 'PENDING_VERIFY'}`);
  return isSuccess;
}

module.exports = {
  isChatGPTDashboard,
  authenticateChatGPT,
};
