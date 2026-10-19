/**
 * trial-detector.js (trial-gpt)
 * Navigates to ChatGPT Plus checkout, analyzes DOM for A/B trial indicators,
 * triggers MoMo selection, and captures redirect links.
 */

const fs = require('fs');
const path = require('path');
const { think } = require('../human-behavior');

const SCREENSHOT_DIR = path.join(__dirname, '..', '.runtime', 'screenshots');

async function captureCheckoutScreenshot(page, label) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `checkout_${label}_${Date.now()}.png`;
    const fullPath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    console.log(`[screenshot] Saved checkout image: ${filename}`);
    return fullPath;
  } catch (err) {
    console.warn(`[screenshot] Failed to save checkout screenshot: ${err.message}`);
    return null;
  }
}

/**
 * Dismiss any blocking modal/dialog (e.g. "Bạn đã hoàn tất" onboarding completion)
 */
async function dismissAllOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const hasCompletion = await page.locator('text=/Bạn đã hoàn tất|You\'re all set|You are all set|Chào mừng bạn đến với ChatGPT|Welcome to ChatGPT/i').first().isVisible({ timeout: 1000 }).catch(() => false);
    const continueBtn = page.locator('dialog[open] button, [role="dialog"] button, button').filter({ hasText: /^(Tiếp tục|Continue|Done|Xong|Bắt đầu|Okay, let's go|Get started)$/i }).locator('visible=true').first();

    if (hasCompletion || await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('[detector] Dismissing completion/terms modal ("Tiếp tục" / "Continue")...');
      await continueBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      break;
    }
  }
}

/**
 * Open ChatGPT Plus checkout dialog or page
 */
async function openCheckoutPage(page) {
  console.log('[detector] Opening ChatGPT upgrade / checkout page...');

  // Dismiss any initial blocking modal/dialog
  await dismissAllOverlays(page);

  // Try clicking UI "Upgrade" button first
  const upgradeBtn = page.locator('button:has-text("Upgrade"), button:has-text("Nâng cấp"), a:has-text("Upgrade")').first();
  if (await upgradeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log('[detector] Clicking UI Upgrade button...');
    await upgradeBtn.click({ force: true });
    await page.waitForTimeout(2000);
  } else {
    // Navigate directly
    console.log('[detector] Navigating to https://chatgpt.com/#pricing...');
    await page.goto('https://chatgpt.com/#pricing', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // Dismiss any modal/dialog that appeared upon landing on pricing page
  await dismissAllOverlays(page);

  // Click "Upgrade to Plus" / "Get Plus" inside the plan selection modal
  const plusBtn = page.locator('button:has-text("Upgrade to Plus"), button:has-text("Get Plus"), button:has-text("Nâng cấp lên Plus"), button:has-text("Upgrade plan")').first();
  if (await plusBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
    console.log('[detector] Clicking "Upgrade to Plus" plan button...');
    await plusBtn.click({ force: true });
    await page.waitForTimeout(5000);
  }

  // Wait for payment options container to render
  console.log('[detector] Waiting for checkout payment methods to render...');
  await page.waitForSelector('text=MoMo, button:has-text("MoMo"), div:has-text("MoMo")', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);

  await captureCheckoutScreenshot(page, 'rendered');
}

/**
 * Detect whether the current checkout page is the Trial A/B variant
 */
async function detectTrialVariant(page) {
  const currentUrl = page.url();
  console.log(`[detector] Analyzing checkout page layout at: ${currentUrl}`);

  // Count visible MoMo options
  const momoElements = await page.locator('button:has-text("MoMo"), div:has-text("MoMo"), [data-payment-method="momo"]').all();
  const hasMoMo = momoElements.length > 0;

  let isTrial = false;
  let detectedReason = '';

  if (!hasMoMo) {
    console.log('[detector] MoMo payment method not visible on page.');
    return { isTrial: false, detectedReason: 'No MoMo options rendered', checkoutUrl: currentUrl };
  }

  // 1. Check for specific redirect text present only on Trial checkout flow
  const pageContent = await page.content().catch(() => '');
  const hasRedirectText = /After submission,\s*you will be redirected to securely complete next steps/i.test(pageContent) ||
                          /Sau khi gửi đơn hàng,\s*bạn sẽ được chuyển hướng để an toàn hoàn tất các bước tiếp theo/i.test(pageContent);

  if (hasRedirectText) {
    isTrial = true;
    detectedReason = 'Detected Trial redirect disclaimer text';
  }

  // 2. Check for "OR" separator divider (A/B layout signature)
  const orDividers = await page.locator('text="OR", text="Hoặc", div:has-text("OR")').all();
  let hasVisibleOr = false;
  for (const div of orDividers) {
    if (await div.isVisible().catch(() => false)) {
      hasVisibleOr = true;
      break;
    }
  }

  if (hasVisibleOr) {
    isTrial = true;
    detectedReason = detectedReason ? `${detectedReason} + 'OR' divider` : "Detected 'OR' divider layout";
  }

  // 3. Check for multiple MoMo instances (Trial layout has primary and secondary groups)
  if (momoElements.length > 1) {
    isTrial = true;
    detectedReason = detectedReason ? `${detectedReason} + Multiple MoMo boxes` : 'Found multiple MoMo payment options';
  }

  console.log(`[detector] Found ${momoElements.length} MoMo element(s). Trial Detected: ${isTrial ? 'YES' : 'NO'}`);
  if (detectedReason) {
    console.log(`[detector] Detection clue: ${detectedReason}`);
  }

  await captureCheckoutScreenshot(page, isTrial ? 'trial_yes' : 'trial_no');

  return {
    isTrial,
    detectedReason,
    checkoutUrl: currentUrl,
  };
}

/**
 * Trigger MoMo checkout and capture redirect payment URL
 */
async function proceedMoMoCheckout(page) {
  console.log('[detector] Selecting MoMo payment option in Trial section...');

  // If multiple MoMo buttons exist, pick the second one (Trial container)
  const momoButtons = await page.locator('button:has-text("MoMo"), div:has-text("MoMo")').all();
  if (momoButtons.length > 1) {
    await momoButtons[1].click().catch(() => momoButtons[0].click());
  } else if (momoButtons.length === 1) {
    await momoButtons[0].click();
  }
  await think(500, 1000);

  let capturedUrl = '';

  // Listen for popup / new pages
  page.context().on('page', async (newPage) => {
    try {
      await newPage.waitForLoadState('domcontentloaded');
      const url = newPage.url();
      if (url.includes('momo') || url.includes('pay')) {
        capturedUrl = url;
        console.log(`[detector] Captured MoMo popup URL: ${url}`);
      }
    } catch {}
  });

  // Submit / Continue button
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Sau khi gửi đơn hàng")',
    'button:has-text("Subscribe")',
    'button:has-text("Đăng ký")',
    'button:has-text("Tiếp tục")',
    'button:has-text("Thanh toán")',
    'button:has-text("Submit")',
  ];

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[detector] Clicking checkout submit button (${sel})...`);
      await btn.click();
      break;
    }
  }

  // Wait for redirect URL
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const url = page.url();
    if (url.includes('momo.vn') || url.includes('payment') || url.includes('gateway')) {
      capturedUrl = url;
      break;
    }
    if (capturedUrl) break;
  }

  await captureCheckoutScreenshot(page, 'after_submit');
  console.log(`[detector] Final captured MoMo link: ${capturedUrl || '(Stayed on page or QR rendered)'}`);
  return capturedUrl;
}

module.exports = {
  openCheckoutPage,
  detectTrialVariant,
  proceedMoMoCheckout,
};
