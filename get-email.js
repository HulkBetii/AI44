const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://temp-mail.org/vi', { waitUntil: 'domcontentloaded' });

  // Chờ input xuất hiện trước
  await page.waitForSelector('#mail', { timeout: 10000 });

  // Debug: xem giá trị hiện tại
  const initialVal = await page.$eval('#mail', el => el.value);
  console.error('Initial value:', initialVal);

  // Đợi cho đến khi input có email thực
  await page.waitForFunction(() => {
    const el = document.querySelector('#mail');
    return el && el.value && el.value.includes('@');
  }, { timeout: 30000 });

  const email = await page.$eval('#mail', el => el.value);
  console.log(email);

  await browser.close();
})();
