const { chromium } = require('playwright');
const gpm = require('./gpm-api');

(async () => {
  const proxy = '200.229.24.106:19448:muse:muse';
  const profileId = await gpm.createProfile('TEST_WAITLIST_EXPLORE', proxy);
  let browser = null;

  try {
    const debugAddress = await gpm.startProfile(profileId);
    for (let i = 0; i < 10; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://${debugAddress}`);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    // Mở Muse AI
    console.log('Navigating to https://muse.ai/ ...');
    await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('Page URL:', page.url());
    console.log('Page text:', (await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n+/g, ' '));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await gpm.stopProfile(profileId).catch(() => {});
    await gpm.deleteProfile(profileId).catch(() => {});
  }
})();
