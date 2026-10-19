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
    // Thử với dòng 161: kristalclituscaradoc4@hotmail.com
    const { initSheets, loadRows } = require('./sheets');
    await initSheets();
    const rows = await loadRows();
    const row161 = rows.find(r => r.rowIndex === 161);
    console.log('Testing Row 161:', row161.email, row161.password);

    const page = await loginMicrosoft(ctx, row161.email, row161.password);
    console.log('URL after loginMicrosoft:', page.url());
    await page.waitForTimeout(5000);
    console.log('URL at 5s:', page.url());

    await page.screenshot({ path: 'test_row161_inbox.png' });
    console.log('Saved test_row161_inbox.png');

    const inboxElements = await page.locator('#O365_MainLink_Logo, [role="option"], [data-convid]').count();
    console.log('Inbox elements count for Row 161:', inboxElements);
  } catch (err) {
    console.error('Error testing Row 161:', err.message);
  } finally {
    await browser.close().catch(() => {});
  }
})();
