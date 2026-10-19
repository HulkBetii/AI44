const { chromium } = require('playwright');
const gpm = require('./gpm-api');

(async () => {
  const proxy = '23.95.45.67:15920:muse:muse';
  const profileId = await gpm.createProfile('TEST_MUSE_URLS', proxy);
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

    const urls = [
      'https://muse.ai/?ref=AR8YUP',
      'https://muse.ai/join?ref=AR8YUP',
      'https://muse.ai/invite/AR8YUP',
      'https://muse.ai/redeem',
      'https://muse.ai/referral',
    ];

    for (const u of urls) {
      console.log(`\nTesting URL: ${u}`);
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        console.log(`Landed on: ${page.url()}`);
        const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 200) : '');
        console.log(`Text: ${text.replace(/\n+/g, ' ')}`);
      } catch (err) {
        console.log(`Error navigating to ${u}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await gpm.stopProfile(profileId).catch(() => {});
    await gpm.deleteProfile(profileId).catch(() => {});
  }
})();
