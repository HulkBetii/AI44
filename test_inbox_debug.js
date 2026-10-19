const { chromium } = require('playwright');
const { loginMicrosoft } = require('./signup-hotmail');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await loginMicrosoft(ctx, 'miaroderickmary1@hotmail.com', 'b0aJQY5770');
    console.log('[DEBUG] Initial URL returned from loginMicrosoft:', page.url());
    await page.waitForTimeout(4000);

    if (page.url().includes('microsoft.com') && !page.url().includes('outlook.live.com')) {
      console.log('[DEBUG] Landed on marketing page. Looking for visible Sign in buttons...');
      const visibleSignIn = page.locator('a:visible, button:visible').filter({ hasText: /^Sign in$/i }).first();
      if (await visibleSignIn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[DEBUG] Clicking visible Sign in...');
        await visibleSignIn.click();
        await page.waitForTimeout(5000);
      }
    }

    console.log('[DEBUG] URL after Sign in click:', page.url());

    // Nếu gặp trang OAuth Account Picker: "We found an account you can use here:"
    const accountTile = page.locator('div, button, small, span').filter({ hasText: 'miaroderickmary1@hotmail.com' }).first();
    if (await accountTile.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('[DEBUG] Found account tile for miaroderickmary1@hotmail.com! Clicking it...');
      await accountTile.click();
      await page.waitForTimeout(8000);
    }

    console.log('[DEBUG] Final Page URL:', page.url());
    await page.screenshot({ path: 'test_after_picker.png' }).catch(() => {});

    const elements = await page.locator('#O365_MainLink_Logo, [role="option"], [data-convid]').count().catch(() => 0);
    console.log(`[DEBUG] Inbox elements count: ${elements}`);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    console.log('[DEBUG] Body text preview:', bodyText.replace(/\n+/g, ' '));
  } catch (err) {
    console.error('[DEBUG ERROR]', err);
  } finally {
    await browser.close().catch(() => {});
  }
})();
