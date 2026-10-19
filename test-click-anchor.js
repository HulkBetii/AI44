const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:53632');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('accounts.google.com'));
  if (!page) {
    console.log('No google page');
    return;
  }
  const frame = page.frames().find(f => f.url().includes('recaptcha/enterprise/anchor'));
  if (!frame) {
    console.log('No recaptcha frame');
    return;
  }
  console.log('Found frame:', frame.url().substring(0, 100));
  const anchor = await frame.$('#recaptcha-anchor');
  console.log('Anchor found:', !!anchor);
  if (anchor) {
    await anchor.click();
    console.log('Clicked anchor!');
    await page.waitForTimeout(4000);
    const checked = await anchor.getAttribute('aria-checked');
    console.log('Aria checked:', checked);
    await page.screenshot({ path: 'after_anchor_click.png' });
  }
  await browser.close();
})();
