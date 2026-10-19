const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('download', async (download) => {
    console.log('Download triggered:', download.url());
    const dest = download.suggestedFilename();
    await download.saveAs(dest);
    console.log('Saved installer to', dest);
  });

  await page.goto('https://www.urban-vpn.com/thank-you/', { timeout: 30000 });
  await page.waitForTimeout(5000);
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h && h.includes('.exe'));
  });
  console.log('Exe links on thank you page:', links);
  await browser.close();
})();
