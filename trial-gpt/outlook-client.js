/**
 * outlook-client.js (trial-gpt)
 * Handles Outlook Web login and polling for OpenAI / ChatGPT verification OTP and links.
 * Reuses battle-tested loginMicrosoft from root signup-hotmail.js.
 */

const { loginMicrosoft } = require('../signup-hotmail');

/**
 * Log in to Outlook Webmail in the browser context using existing login engine
 */
async function openOutlookInbox(ctx, email, password) {
  console.log(`[outlook] Logging in to Outlook Web for ${email}...`);
  const mailPage = await loginMicrosoft(ctx, email, password);
  return mailPage;
}

/**
 * Poll Outlook inbox and junk email for OpenAI verification code (OTP) or link
 */
async function waitForOpenAIVerification(page, timeoutMs = 90000) {
  console.log('[outlook] Polling Outlook inbox for OpenAI verification message...');
  const startTime = Date.now();
  let checkJunk = false;
  let pollIteration = 0;

  while (Date.now() - startTime < timeoutMs) {
    pollIteration++;
    try {
      // Only switch folders every 3rd iteration (approx 20s) to allow SPA to render and stream emails
      if (pollIteration === 1 || pollIteration % 3 === 0) {
        const folder = checkJunk ? 'junkemail' : 'inbox';
        checkJunk = !checkJunk;
        console.log(`[outlook] Checking folder: ${folder}...`);
        await page.goto(`https://outlook.live.com/mail/0/${folder}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      }

      // Wait for message list to render
      await page.waitForSelector('[role="option"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // Dismiss cookie / privacy popup if present
      const rejectBtn = page.locator('#onetrust-reject-all-handler, button:has-text("Reject"), button:has-text("Từ chối"), button:has-text("No"), button:has-text("Không")').first();
      if (await rejectBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await rejectBtn.click().catch(() => {});
      }

      // Check message list for OpenAI or ChatGPT emails
      let rows = page.locator('[role="option"], [data-convid], [aria-label*="OpenAI"], [aria-label*="ChatGPT"]').filter({ hasText: /OpenAI|ChatGPT|verification|xác thực|code|mã/i });
      let count = await rows.count().catch(() => 0);

      if (count === 0) {
        // Check "Other" / "Khác" tab if present
        const otherTab = page.locator('button[role="tab"]:has-text("Other"), button[role="tab"]:has-text("Khác"), [role="tab"][aria-label*="Other"], [role="tab"][aria-label*="Khác"]').first();
        if (await otherTab.isVisible({ timeout: 1000 }).catch(() => false)) {
          await otherTab.click().catch(() => {});
          await page.waitForTimeout(2000);
          rows = page.locator('[role="option"], [data-convid], [aria-label*="OpenAI"], [aria-label*="ChatGPT"]').filter({ hasText: /OpenAI|ChatGPT|verification|xác thực|code|mã/i });
          count = await rows.count().catch(() => 0);
        }
      }

      if (count > 0) {
        console.log(`[outlook] Found ${count} matching OpenAI message(s). Opening newest...`);
        const firstRow = rows.first();
        await firstRow.click();
        await page.waitForTimeout(3000);

        // Read email body content
        const bodyContent = await page.locator('div[aria-label="Message body"], div.rps_, #ReadingPaneContainerId').first().innerText().catch(() => '') ||
                            await page.content();

        // 1. Check for 6-digit OTP code
        const otpMatch = bodyContent.match(/\b([0-9]{6})\b/);
        if (otpMatch) {
          const otp = otpMatch[1];
          console.log(`[outlook] Extracted OpenAI OTP Code: ${otp}`);
          return { type: 'otp', code: otp };
        }

        // 2. Check for verification link
        const linkMatch = bodyContent.match(/https:\/\/auth0?\.openai\.com\/u\/[^\s"'>]+/i) ||
                          bodyContent.match(/https:\/\/[^\s"'>]*openai\.com\/[^\s"'>]*verification[^\s"'>]*/i);

        if (linkMatch) {
          const link = linkMatch[0];
          console.log(`[outlook] Extracted OpenAI Verification Link: ${link}`);
          return { type: 'link', url: link };
        }
      }
    } catch (err) {
      console.warn(`[outlook] Polling iteration warning: ${err.message}`);
    }

    console.log(`[outlook] Waiting for verification email (${Math.round((Date.now() - startTime) / 1000)}s)...`);
    await page.waitForTimeout(4000);
  }

  throw new Error(`Timed out waiting for OpenAI verification email after ${timeoutMs / 1000}s`);
}

module.exports = {
  openOutlookInbox,
  waitForOpenAIVerification,
};
