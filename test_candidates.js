const { chromium } = require('playwright');
const { initSheets, loadRows } = require('./sheets');
const { loginMicrosoft } = require('./signup-hotmail');

(async () => {
  await initSheets();
  const allRows = await loadRows();
  const candidates = allRows.filter(r => r.rowIndex >= 161 && r.rowIndex <= 175 && r.email && r.password);

  console.log(`Kiểm tra ${candidates.length} tài khoản từ dòng 161 đến 175...`);

  for (const acc of candidates) {
    console.log(`\n========================================`);
    console.log(`[Test] Dòng ${acc.rowIndex}: ${acc.email} | Pass: ${acc.password}`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();

    try {
      const page = await loginMicrosoft(ctx, acc.email, acc.password);
      await page.waitForTimeout(2000);
      const url = page.url();
      console.log(`URL sau loginMicrosoft: ${url}`);

      if (url.includes('outlook.live.com/mail')) {
        console.log(`✅✅✅ THÀNH CÔNG! Dòng ${acc.rowIndex} VÀO THẲNG INBOX! URL: ${url}`);
        await browser.close();
        process.exit(0);
      } else {
        console.log(`Bị redirect: ${url.slice(0, 80)}`);
      }
    } catch (err) {
      console.log(`Lỗi đăng nhập: ${err.message.slice(0, 80)}`);
    } finally {
      await browser.close().catch(() => {});
    }
  }
})();
