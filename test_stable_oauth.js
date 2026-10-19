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

    if (page.url().includes('microsoft.com') && !page.url().includes('outlook.live.com')) {
      console.log('[2] On marketing page. Finding Sign in link...');
      const headerSignIn = page.locator('a[id*="signin" i]:visible, a:has-text("Sign in"):visible').first();
      await headerSignIn.click({ force: true });
      console.log('[3] Clicked Sign in. Waiting for redirection...');
    }

    // Đợi trang select_account xuất hiện
    console.log('[4] Waiting for account tile to appear...');
    const accountTile = page.locator('div, button, small, span, p').filter({ hasText: 'miaroderickmary1@hotmail.com' }).last();
    await accountTile.waitFor({ state: 'visible', timeout: 25000 });
    console.log('[5] Account tile visible! Clicking it...');
    await accountTile.click({ force: true });

    // Đợi điều hướng về Outlook Inbox
    console.log('[6] Waiting for Outlook Inbox...');
    await page.waitForURL(url => url.toString().includes('outlook.live.com/mail'), { timeout: 35000 });
    await page.waitForSelector('[role="option"], [data-convid], #O365_MainLink_Logo', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(4000);

    console.log('[7] Landed URL:', page.url());
    await page.screenshot({ path: 'test_inbox_PASSED.png' });
    console.log('Saved test_inbox_PASSED.png');

    const inboxCount = await page.locator('[role="option"], [data-convid]').count();
    console.log(`[8] 🎉 INBOX MESSAGES COUNT: ${inboxCount}`);

    const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 600) : '');
    console.log('[9] Inbox text preview:', text.replace(/\n+/g, ' '));
  } catch (err) {
    console.error('[ERROR]', err);
    await page?.screenshot({ path: 'test_error_click.png' }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
})();
