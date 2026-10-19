const { chromium } = require('playwright');
const gpm = require('./gpm-api');

(async () => {
  const proxy = '200.229.24.106:19448:muse:muse';
  const profileId = await gpm.createProfile('TEST_MUSE_INPUT', proxy);
  console.log('Profile ID:', profileId);

  let browser = null;
  try {
    const debugAddress = await gpm.startProfile(profileId);
    console.log('Debug Address:', debugAddress);

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
    await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);

    const input = page.locator('input[placeholder*="Mobile number or email" i], input[type="text"], input[type="email"]').first();
    console.log('Input count:', await input.count());
    await input.click();
    await page.waitForTimeout(500);

    // Gõ bằng bàn phím kiểu người dùng thật từng ký tự
    const testEmail = 'lucas.test882@mrhulkstore.store';
    await page.keyboard.type(testEmail, { delay: 80 });
    await page.waitForTimeout(1000);

    const val = await input.inputValue();
    console.log('Input value after typing:', val);

    const btn = page.locator('button:has-text("Continue")').first();
    console.log('Button isEnabled:', await btn.isEnabled());

    await page.screenshot({ path: 'test_typed_email.png' });
    console.log('Saved test_typed_email.png');

    console.log('Clicking Continue...');
    await btn.click();
    await page.waitForTimeout(5000);

    console.log('URL after click:', page.url());
    await page.screenshot({ path: 'test_after_continue.png' });
    console.log('Saved test_after_continue.png');

    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '');
    console.log('Body after continue:', bodyText.replace(/\n+/g, ' '));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await gpm.stopProfile(profileId).catch(() => {});
    await gpm.deleteProfile(profileId).catch(() => {});
  }
})();
