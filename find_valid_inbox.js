const { chromium } = require('playwright');
const { initSheets, loadRows } = require('./sheets');
const { loginMicrosoft } = require('./signup-hotmail');

(async () => {
  await initSheets();
  const allRows = await loadRows();
  const pendingRows = allRows.filter(r => r.rowIndex >= 161 && r.status === 'pending' && r.email && r.password);
  console.log(`Tìm thấy ${pendingRows.length} tài khoản pending từ dòng 161 trở đi.`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  for (const acc of pendingRows.slice(0, 10)) {
    console.log(`\n-----------------------------------------`);
    console.log(`[Kiểm tra] Dòng ${acc.rowIndex}: ${acc.email}`);
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    try {
      const page = await loginMicrosoft(ctx, acc.email, acc.password);
      await page.waitForTimeout(3000);
      const url = page.url();
      console.log(`URL sau đăng nhập: ${url}`);

      if (url.includes('identity/confirm') || url.includes('proof') || url.includes('Abuse') || url.includes('Cancel')) {
        console.log(`❌ Tài khoản yêu cầu verify identity / khóa: ${url}`);
        continue;
      }

      if (url.includes('microsoft.com/en-us/microsoft-365/outlook')) {
        console.log(`⚠️ Bị redirect sang marketing page, kiểm tra xem có dính identity/confirm không...`);
        const headerSignIn = page.locator('a[id*="signin" i]:visible, a:has-text("Sign in"):visible').first();
        if (await headerSignIn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await headerSignIn.click({ force: true });
          await page.waitForTimeout(4000);
          const afterClickUrl = page.url();
          console.log(`URL sau khi click Sign In: ${afterClickUrl}`);
          if (afterClickUrl.includes('identity/confirm') || afterClickUrl.includes('Abuse')) {
            console.log(`❌ Tài khoản bị cắm cờ identity confirm!`);
            continue;
          }
        }
      }

      // Kiểm tra inbox elements
      const inboxCount = await page.locator('[role="option"], [data-convid], #O365_MainLink_Logo').count().catch(() => 0);
      console.log(`Inbox elements count: ${inboxCount}`);

      if (url.includes('outlook.live.com/mail') || inboxCount > 0) {
        console.log(`\n🎯🎯🎯 TÌM THẤY TÀI KHOẢN INBOX LIVE HOÀN HẢO: Dòng ${acc.rowIndex}: ${acc.email} | Pass: ${acc.password} 🎯🎯🎯\n`);
        await page.screenshot({ path: `found_live_${acc.rowIndex}.png` });
        await ctx.close();
        break;
      }
    } catch (err) {
      console.log(`❌ Lỗi đăng nhập dòng ${acc.rowIndex}: ${err.message}`);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});
})();
