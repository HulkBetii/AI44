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
    console.log('[1] URL after loginMicrosoft:', page.url());
    await page.waitForTimeout(4000);
    console.log('[2] URL at 4s:', page.url());

    if (page.url().includes('microsoft.com') && !page.url().includes('outlook.live.com')) {
      console.log('[3] On marketing page. Finding Sign in link...');
      // Nút Sign in trên header desktop
      const headerSignIn = page.locator('a[id*="signin" i]:visible, a:has-text("Sign in"):visible, a[data-bi-name="SignIn"]:visible').first();
      await headerSignIn.click({ force: true });
      console.log('[4] Clicked Sign in. Waiting for OAuth page...');
      await page.waitForURL(url => url.toString().includes('login.microsoftonline.com') || url.toString().includes('outlook.live.com'), { timeout: 15000 });
      console.log('[5] URL after click:', page.url());
    }

    if (page.url().includes('login.microsoftonline.com')) {
      console.log('[6] On login.microsoftonline.com. Waiting for content...');
      await page.waitForSelector('text=miaroderickmary1@hotmail.com, #usernameEntry, input[type="email"]', { timeout: 15000 });
      console.log('[7] Content loaded. Inspecting HTML...');
      const matched = page.locator('*:has-text("miaroderickmary1@hotmail.com")').last();
      console.log('[8] Clicking matched tile/text...');
      await matched.click({ force: true });
      console.log('[9] Clicked! Waiting for navigation to Outlook...');
      await page.waitForURL(url => url.toString().includes('outlook.live.com'), { timeout: 25000 });
      console.log('[10] Landed on:', page.url());
    }

    await page.waitForTimeout(5000);
    console.log('[11] URL at 5s after reaching outlook:', page.url());
    await page.screenshot({ path: 'test_success_outlook.png' });
    const count = await page.locator('[role="option"], [data-convid], #O365_MainLink_Logo').count();
    console.log('[12] Inbox elements count:', count);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('[13] Body preview:', body.replace(/\n+/g, ' '));
  } catch (err) {
    console.error('[ERROR]', err);
    await page?.screenshot({ path: 'test_error_state.png' }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
})();
