/**
 * outlook-inbox.js (reg-museai)
 * Handles Outlook Web login and polling for Muse / Meta verification OTP code.
 * Uses a clean direct browser instance (no datacenter proxy) to avoid Microsoft IP blocks.
 */

const { chromium } = require('playwright');
const { loginMicrosoft } = require('../signup-hotmail');

/**
 * Open Outlook Webmail directly and poll for the 6-digit confirmation code from Muse AI / Meta.
 * @param {string} email
 * @param {string} password
 * @param {number} timeoutMs
 * @returns {Promise<{ code: string }>}
 */
async function fetchMuseOtpFromOutlook(email, password, timeoutMs = 90000) {
  console.log(`[outlook] Đang mở trình duyệt trực tiếp (không qua proxy) để đọc mã OTP cho ${email}...`);
  const mailBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const mailCtx = await mailBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  try {
    let mailPage = await loginMicrosoft(mailCtx, email, password);

    // Kiểm tra xem có tab Outlook thực tế nào được mở trong context
    for (const p of mailCtx.pages()) {
      if (p.url().includes('outlook.live.com/mail')) {
        mailPage = p;
        break;
      }
    }

    // Nếu vẫn dính trang marketing, điều hướng thẳng vào inbox
    if (!mailPage.url().includes('outlook.live.com/mail')) {
      console.log('[outlook] Điều hướng trực tiếp vào https://outlook.live.com/mail/0/ ...');
      await mailPage.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await mailPage.waitForTimeout(3000);
    }

    console.log(`[outlook] Đang ở giao diện hộp thư: ${mailPage.url()}`);
    console.log('[outlook] Bắt đầu quét hộp thư để nhận mã xác nhận từ Muse / Meta...');
    const startTime = Date.now();
    let checkJunk = false;
    let pollIteration = 0;

    while (Date.now() - startTime < timeoutMs) {
      pollIteration++;
      try {
        // Nếu bị redirect ra marketing page giữa chừng, đưa lại về /mail/0/
        if (mailPage.url().includes('microsoft.com') && !mailPage.url().includes('outlook.live.com')) {
          console.log('[outlook] Phục hồi điều hướng từ marketing về https://outlook.live.com/mail/0/ ...');
          await mailPage.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await mailPage.waitForTimeout(3000);
        }
        // Chuyển đổi linh hoạt giữa Inbox và Junk Email bằng UI click
        if (pollIteration > 1 && pollIteration % 3 === 0) {
          checkJunk = !checkJunk;
          const targetText = checkJunk ? /Junk|Thư rác/i : /Inbox|Hộp thư đến/i;
          console.log(`[outlook] Chuyển kiểm tra thư mục: ${checkJunk ? 'Junk Email' : 'Inbox'}...`);
          const folderBtn = mailPage.locator('span, [role="treeitem"]').filter({ hasText: targetText }).first();
          if (await folderBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await folderBtn.click().catch(() => {});
            await mailPage.waitForTimeout(2000);
          }
        }

        await mailPage.waitForSelector('[role="option"], [data-convid]', { timeout: 6000 }).catch(() => {});
        await mailPage.waitForTimeout(1000);

        // Đóng popup cookie nếu có
        const rejectBtn = mailPage.locator('#onetrust-reject-all-handler, button:has-text("Reject"), button:has-text("Từ chối")').first();
        if (await rejectBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await rejectBtn.click().catch(() => {});
        }

        // Tìm thư từ Muse, Meta, hoặc có tiêu đề code / confirm
        let rows = mailPage.locator('[role="option"], [data-convid]')
          .filter({ hasText: /Muse|Meta|confirmation|confirm|code|xác nhận|mã/i });
        let count = await rows.count().catch(() => 0);

        if (count === 0) {
          const otherTab = mailPage.locator('button[role="tab"]:has-text("Other"), button[role="tab"]:has-text("Khác")').first();
          if (await otherTab.isVisible({ timeout: 500 }).catch(() => false)) {
            await otherTab.click().catch(() => {});
            await mailPage.waitForTimeout(1500);
            rows = mailPage.locator('[role="option"], [data-convid]')
              .filter({ hasText: /Muse|Meta|confirmation|confirm|code|xác nhận|mã/i });
            count = await rows.count().catch(() => 0);
          }
        }

        if (count > 0) {
          const newestRow = rows.first();
          const rowText = await newestRow.innerText().catch(() => '');

          // Bỏ qua nếu là thư cũ từ các ngày trước
          const isFromPast = /\b(?:Yesterday|Hôm qua|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Th [2-7]|CN|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i.test(rowText);
          if (!isFromPast) {
            console.log(`[outlook] Tìm thấy ${count} email phù hợp. Đang đọc mã xác thực mới nhất...`);
            // 1. Kiểm tra ngay trong snippet preview
            const snippetMatch = rowText.match(/\b([0-9]{6})\b/);
            if (snippetMatch) {
              const code = snippetMatch[1];
              console.log(`[outlook] ✅ Đã trích xuất mã OTP Muse AI trực tiếp từ snippet danh sách thư: ${code}`);
              return { code };
            }

            // 2. Mở thư để đọc chi tiết
            await newestRow.click({ force: true }).catch(() => {});
            await mailPage.waitForTimeout(2000);

            const bodyContent = await mailPage.locator('div[aria-label="Message body"], div.rps_, #ReadingPaneContainerId').first().innerText().catch(() => '')
              || await mailPage.content();

            const otpMatch = bodyContent.match(/\b([0-9]{6})\b/);
            if (otpMatch) {
              const code = otpMatch[1];
              console.log(`[outlook] ✅ Đã trích xuất mã OTP Muse AI từ nội dung thư: ${code}`);
              return { code };
            }
          }
        }
      } catch (err) {
        console.warn(`[outlook] Cảnh báo lượt quét email: ${err.message}`);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[outlook] Đang đợi email mã xác nhận... (${elapsed}s / ${Math.round(timeoutMs / 1000)}s)`);
      await mailPage.waitForTimeout(4000);
    }

    const outlookFailShot = `debug-outlook-${email}.png`;
    await mailPage.screenshot({ path: outlookFailShot }).catch(() => {});
    console.warn(`[outlook] Đã lưu ảnh chụp hộp thư Outlook: ${outlookFailShot}`);

    throw new Error(`Hết thời gian chờ (${Math.round(timeoutMs / 1000)}s) không nhận được mã xác nhận từ Muse AI trong Outlook.`);
  } finally {
    await mailBrowser.close().catch(() => {});
  }
}

module.exports = {
  fetchMuseOtpFromOutlook,
};
