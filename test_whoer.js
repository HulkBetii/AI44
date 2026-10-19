const { chromium } = require('playwright');
const gpm = require('./gpm-api');

(async () => {
  const proxy = '23.95.45.67:15920:muse:muse';
  const profileId = await gpm.createProfile('TEST_WHOER', proxy);
  console.log('Profile ID:', profileId);

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
    console.log('Navigating to https://whoer.net/ ...');
    await page.goto('https://whoer.net/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(6000);

    await page.screenshot({ path: 'test_whoer_result.png' });
    console.log('Saved test_whoer_result.png');

    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '');
    console.log('Whoer text preview:', body.replace(/\n+/g, ' '));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await gpm.stopProfile(profileId).catch(() => {});
    await gpm.deleteProfile(profileId).catch(() => {});
  }
})();
