/**
 * imap-otp.js (reg-museai)
 * Connects directly to Gmail IMAP SSL to retrieve the 6-digit OTP verification code
 * sent from Meta / Muse AI to any @mrhulkstore.store catch-all email alias.
 */

const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const { loadMuseConfig } = require('./config');

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes
const POLL_INTERVAL_MS = 3000;    // 3 seconds

/**
 * Open IMAP connection to Gmail
 */
async function openImapConnection(config) {
  const imapConfig = {
    imap: {
      user: config.gmailUser,
      password: config.gmailAppPassword,
      host: config.imapHost || 'imap.gmail.com',
      port: config.imapPort || 993,
      tls: true,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  try {
    return await imaps.connect(imapConfig);
  } catch (err) {
    throw new Error(`Gmail IMAP connection failed: ${err.message}`);
  }
}

/**
 * Poll Gmail inbox for 6-digit verification OTP code from Muse AI / Meta sent to a specific catch-all alias.
 * @param {string} targetEmail - e.g. kate.evans.92@mrhulkstore.store
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=120000]
 * @param {number|Date} [options.sentAfter]
 * @returns {Promise<{ code: string, subject: string, from: string }>}
 */
async function fetchMuseOtpFromImap(targetEmail, options = {}) {
  const config = loadMuseConfig(options);
  const timeoutMs = options.timeoutMs || config.otpTimeoutMs || DEFAULT_TIMEOUT_MS;
  const sentAfter = options.sentAfter ? new Date(options.sentAfter) : new Date(Date.now() - 120000);
  const cleanTarget = String(targetEmail || '').trim().toLowerCase();

  console.log(`[imap-otp] Đang kết nối tới ${config.gmailUser} để chờ mã OTP gửi tới ${cleanTarget}...`);

  let connection = null;
  const startTime = Date.now();
  let attempt = 0;

  try {
    connection = await openImapConnection(config);
    await connection.openBox('INBOX');

    while (Date.now() - startTime < timeoutMs) {
      attempt++;
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);

      const searchCriteria = [['SINCE', sentAfter]];
      const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        struct: true,
      };

      const messages = await connection.search(searchCriteria, fetchOptions);

      if (Array.isArray(messages) && messages.length > 0) {
        // Mới nhất lên đầu
        messages.reverse();

        for (const item of messages) {
          const rawHeader = item.parts.find((p) => p.which === 'HEADER')?.body || {};
          const rawFull = item.parts.find((p) => p.which === '')?.body || '';

          const subject = Array.isArray(rawHeader.subject) ? rawHeader.subject[0] : (rawHeader.subject || '');
          const from = Array.isArray(rawHeader.from) ? rawHeader.from[0] : (rawHeader.from || '');
          const to = Array.isArray(rawHeader.to) ? rawHeader.to[0] : (rawHeader.to || '');
          const deliveredTo = Array.isArray(rawHeader['delivered-to']) ? rawHeader['delivered-to'][0] : (rawHeader['delivered-to'] || '');
          const forwardedTo = Array.isArray(rawHeader['x-forwarded-to']) ? rawHeader['x-forwarded-to'][0] : (rawHeader['x-forwarded-to'] || '');

          const headerText = `${to} ${deliveredTo} ${forwardedTo} ${subject} ${from}`.toLowerCase();

          // Phân tích nội dung email
          let bodyText = '';
          let bodyHtml = '';
          if (rawFull) {
            try {
              const parsed = await simpleParser(rawFull);
              bodyText = parsed.text || '';
              bodyHtml = parsed.html || '';
            } catch {
              bodyText = String(rawFull);
            }
          }

          const combinedText = `${headerText} ${bodyText} ${bodyHtml}`.toLowerCase();

          // Kiểm tra xem email có gửi tới đúng địa chỉ target alias không
          const isTargetMatch = cleanTarget ? combinedText.includes(cleanTarget) : true;
          // Kiểm tra nguồn gửi hoặc từ khóa liên quan đến Muse / Meta / confirmation code
          const isMetaOrMuse = /muse|meta|confirmation|confirm|verification|verify|code|mã/i.test(`${from} ${subject}`);

          if (isTargetMatch && isMetaOrMuse) {
            // Tìm mã OTP 6 chữ số
            const allTextToSearch = `${subject} ${bodyText} ${bodyHtml}`;
            const matches = allTextToSearch.match(/\b([0-9]{6})\b/g);

            if (matches && matches.length > 0) {
              const code = matches[0];
              console.log(`[imap-otp] ✅ Đã tìm thấy mã OTP Muse AI cho ${cleanTarget} sau ${elapsedSec}s: ${code} (Từ: ${from} | Tiêu đề: "${subject}")`);
              return {
                code,
                subject,
                from,
              };
            }
          }
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[imap-otp] Đang đợi email mã xác nhận... (${elapsed}s / ${Math.round(timeoutMs / 1000)}s)`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Hết thời gian chờ (${Math.round(timeoutMs / 1000)}s) không nhận được mã xác nhận từ Muse AI cho ${cleanTarget} trong Gmail.`);
  } finally {
    if (connection) {
      try {
        connection.end();
      } catch {}
    }
  }
}

module.exports = {
  fetchMuseOtpFromImap,
};
