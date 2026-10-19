const { chromium } = require('playwright');
const gpm = require('./gpm-api');
const { loginMicrosoft } = require('./signup-hotmail');

async function connectCDPWithRetry(debugAddress, maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://${debugAddress}`);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

(async () => {
  const proxy = '200.229.24.106:19448:muse:muse';
  console.log('[Test GPM Outlook] Tạo profile GPM với proxy US:', proxy);
  const profileId = await gpm.createProfile('TEST_GPM_OUTLOOK', proxy);
  console.log('[Test GPM Outlook] Profile ID:', profileId);

  let browser = null;
  try {
    const debugAddress = await gpm.startProfile(profileId);
    console.log('[Test GPM Outlook] Debug address:', debugAddress);

    browser = await connectCDPWithRetry(debugAddress);
    const context = browser.contexts()[0] || (await browser.newContext());
    
    console.log('[Test GPM Outlook] Đăng nhập Microsoft cho samsoncyrilmarcus5@hotmail.com trên GPM...');
    const page = await loginMicrosoft(context, 'samsoncyrilmarcus5@hotmail.com', 'VpH8V7923');
    
    await page.waitForTimeout(6000);
    console.log('[Test GPM Outlook] URL sau đăng nhập:', page.url());
    
    await page.screenshot({ path: 'test_gpm_samson_outlook.png' });
    console.log('Saved test_gpm_samson_outlook.png');

    const inboxCount = await page.locator('[role="option"], [data-convid], #O365_MainLink_Logo').count();
    console.log(`[Test GPM Outlook] Inbox count: ${inboxCount}`);

    const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '');
    console.log('[Test GPM Outlook] Text preview:', text.replace(/\n+/g, ' '));
  } catch (err) {
    console.error('[Test GPM Outlook ERROR]', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await gpm.stopProfile(profileId).catch(() => {});
    await gpm.deleteProfile(profileId).catch(() => {});
  }
})();
