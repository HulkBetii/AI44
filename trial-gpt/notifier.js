/**
 * notifier.js (trial-gpt)
 * Telegram notification service for Trial GPT Plus alerts and batch reporting.
 */

const fs = require('fs');
const https = require('https');
const { loadTrialConfig } = require('./config');

/**
 * Send a raw Telegram message via Bot API
 */
async function sendTelegramMessage(text, parseMode = 'HTML') {
  const config = loadTrialConfig();
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;

  if (!token || !chatId) {
    console.warn('[notifier] Telegram Bot Token or Chat ID not configured. Skipping alert.');
    return false;
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: false,
  });

  return new Promise((resolve) => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.ok) {
              resolve(true);
            } else {
              console.error(`[notifier] Telegram API error: ${data.description}`);
              resolve(false);
            }
          } catch {
            resolve(false);
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error(`[notifier] Failed to send Telegram message: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('[notifier] Telegram request timed out.');
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send an alert when a Trial checkout is detected
 */
async function sendTrialAlert({ email, password, momoLink, checkoutUrl, duration }) {
  const timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  
  const lines = [
    '🔥 <b>[TRIAL DETECTED] ChatGPT Plus Trial Found!</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📧 <b>Email:</b> <code>${email}</code>`,
    `🔑 <b>Password:</b> <code>${password}</code>`,
    '',
    momoLink
      ? `👉 <a href="${momoLink}"><b>[ BẤM VÀO ĐÂY ĐỂ THANH TOÁN MOMO ]</b></a>\n<code>${momoLink}</code>`
      : '⚠️ <i>Không lấy được direct link MoMo, vui lòng kiểm tra browser hoặc link checkout.</i>',
    '',
    checkoutUrl ? `🔗 <b>Checkout URL:</b> <code>${checkoutUrl}</code>` : '',
    `⏱ <b>Thời gian xử lý:</b> ${duration || 'N/A'}`,
    `⏰ <b>Thời điểm:</b> ${timeStr}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '⚡ <i>Hãy mở app MoMo và quét/hoàn tất thanh toán ngay trước khi session hết hạn!</i>',
  ].filter(Boolean);

  return sendTelegramMessage(lines.join('\n'));
}

/**
 * Send batch execution summary
 */
async function sendBatchSummary({ total, trialCount, noTrialCount, errorCount, elapsedMinutes }) {
  const timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const lines = [
    '📊 <b>[BÁO CÁO] Hoàn Tất Batch Trial GPT Plus</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🎯 <b>Tổng account đã chạy:</b> ${total}`,
    `🎉 <b>Trúng Trial:</b> ${trialCount}`,
    `❌ <b>Không có Trial (No Trial):</b> ${noTrialCount}`,
    `⚠️ <b>Lỗi / Bỏ qua:</b> ${errorCount}`,
    `⏱ <b>Tổng thời gian:</b> ${elapsedMinutes} phút`,
    `⏰ <b>Hoàn tất lúc:</b> ${timeStr}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];

  return sendTelegramMessage(lines.join('\n'));
}

module.exports = {
  sendTelegramMessage,
  sendTrialAlert,
  sendBatchSummary,
};
