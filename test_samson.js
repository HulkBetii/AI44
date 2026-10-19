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
    console.log('Testing login for samsoncyrilmarcus5@hotmail.com...');
    const page = await loginMicrosoft(ctx, 'samsoncyrilmarcus5@hotmail.com', 'VpH8V7923');
    await page.waitForTimeout(5000);
    console.log('URL for samsoncyrilmarcus5:', page.url());

    await page.screenshot({ path: 'test_samson_inbox.png' });
    console.log('Saved test_samson_inbox.png');

    const inboxCount = await page.locator('[role="option"], [data-convid], #O365_MainLink_Logo').count();
    console.log('Inbox elements count:', inboxCount);
  } catch (err) {
    console.error('Error with samsoncyrilmarcus5:', err.message);
  } finally {
    await browser.close().catch(() => {});
  }
})();
