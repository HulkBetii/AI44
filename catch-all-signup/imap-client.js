/**
 * imap-client.js
 * Gmail IMAP client for automated verification link extraction.
 */

const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const { loadCatchAllConfig } = require('./config');
const { collectSecretValues, redactSecrets } = require('../secret-sanitizer');

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes
const DEFAULT_POLL_INTERVAL_MS = 3000; // 3 seconds

function sanitizeError(err, password) {
  const secrets = collectSecretValues({ extra: [password] });
  return redactSecrets(err.message || String(err), secrets);
}

/**
 * Open an IMAP connection to Gmail
 */
async function openImapConnection(customConfig = {}) {
  const config = loadCatchAllConfig(customConfig);
  if (!config.gmailUser || !config.gmailAppPassword) {
    throw new Error('Gmail IMAP requires gmailUser and gmailAppPassword in config.local.json or environment.');
  }

  const imapConfig = {
    imap: {
      user: config.gmailUser,
      password: config.gmailAppPassword,
      host: config.imapHost || 'imap.gmail.com',
      port: config.imapPort || 993,
      tls: config.imapTls !== false,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  try {
    const connection = await imaps.connect(imapConfig);
    return connection;
  } catch (err) {
    throw new Error(`Gmail IMAP connection failed: ${sanitizeError(err, config.gmailAppPassword)}`);
  }
}

/**
 * Extract ElevenLabs verification URL from raw HTML/Text content
 */
function extractVerifyUrl(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return null;

  // Clean common HTML entities and MIME artifacts
  const normalized = rawContent
    .replace(/=\r?\n/g, '') // Remove soft line breaks from quoted-printable
    .replace(/&amp;/g, '&')
    .replace(/&#x3D;/g, '=')
    .replace(/&#x2F;/g, '/');

  // Match ElevenLabs verify link patterns:
  // e.g. https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=...
  // or https://elevenlabs.io/verify-email?token=...
  const match = normalized.match(/https:\/\/elevenlabs\.io\/[^\s"'<>]+(?:verifyEmail|verify-email|action\?mode=verifyEmail)[^\s"'<>]+/i)
    || normalized.match(/https:\/\/elevenlabs\.io\/app\/action\?[^\s"'<>]+/i);

  if (!match) return null;

  let url = match[0];
  // Trim trailing punctuation if any
  url = url.replace(/[.,;:)\]]+$/, '');
  return url;
}

/**
 * Poll Gmail inbox for ElevenLabs verification email sent to a specific alias
 * @param {string} toAddress - Email alias (e.g. user123@mrhulkstore.store)
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=120000] - Max wait time in ms
 * @param {number} [opts.pollIntervalMs=3000] - Polling interval in ms
 * @param {Date|number} [opts.sentAfter] - Only check emails received after this timestamp
 * @param {Function} [opts.onPoll] - Progress callback
 */
async function waitForElevenLabsVerifyEmail(toAddress, opts = {}) {
  const config = loadCatchAllConfig();
  const timeoutMs = opts.timeoutMs || config.imapTimeoutMs || DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs || config.imapPollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const sentAfter = opts.sentAfter ? new Date(opts.sentAfter) : new Date(Date.now() - 120000); // look back 2m by default
  const onPoll = opts.onPoll || (() => {});

  const cleanTarget = String(toAddress || '').trim().toLowerCase();
  console.log(`[imap] Connecting to ${config.gmailUser} to wait for email to ${cleanTarget}...`);

  let connection = null;
  const startTime = Date.now();
  let attempt = 0;

  try {
    connection = await openImapConnection();
    await connection.openBox('INBOX');

    while (Date.now() - startTime < timeoutMs) {
      attempt++;
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      onPoll({ attempt, elapsedSec, target: cleanTarget });

      // Build search query: search since the date of registration
      const searchCriteria = [
        ['SINCE', sentAfter],
      ];

      const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        struct: true,
      };

      const messages = await connection.search(searchCriteria, fetchOptions);

      if (Array.isArray(messages) && messages.length > 0) {
        // Sort newest first
        messages.reverse();

        for (const item of messages) {
          const rawHeader = item.parts.find((p) => p.which === 'HEADER')?.body || {};
          const rawFull = item.parts.find((p) => p.which === '')?.body || '';

          // Check subjects and headers
          const subject = Array.isArray(rawHeader.subject) ? rawHeader.subject[0] : (rawHeader.subject || '');
          const from = Array.isArray(rawHeader.from) ? rawHeader.from[0] : (rawHeader.from || '');
          const to = Array.isArray(rawHeader.to) ? rawHeader.to[0] : (rawHeader.to || '');
          const deliveredTo = Array.isArray(rawHeader['delivered-to']) ? rawHeader['delivered-to'][0] : (rawHeader['delivered-to'] || '');
          const forwardedTo = Array.isArray(rawHeader['x-forwarded-to']) ? rawHeader['x-forwarded-to'][0] : (rawHeader['x-forwarded-to'] || '');

          const headerText = `${to} ${deliveredTo} ${forwardedTo} ${subject} ${from}`.toLowerCase();
          const isElevenLabs = /elevenlabs|eleven\s*labs/i.test(`${from} ${subject}`);

          // Parse full MIME message with mailparser for robust HTML body extraction
          let parsedBodyText = '';
          let parsedHtml = '';
          if (rawFull) {
            try {
              const parsed = await simpleParser(rawFull);
              parsedBodyText = parsed.text || '';
              parsedHtml = parsed.html || '';
            } catch {
              parsedBodyText = String(rawFull);
            }
          }

          // Check message arrival date
          const messageDate = item.attributes?.date ? new Date(item.attributes.date).getTime() : 0;
          if (sentAfter && messageDate > 0 && messageDate < (new Date(sentAfter).getTime() - 60000)) {
            continue; // Skip emails received before registration started
          }

          const combinedText = `${headerText} ${parsedBodyText} ${parsedHtml}`.toLowerCase();

          // Match recipient: target alias must be present in email headers or body
          const recipientMatches = cleanTarget ? combinedText.includes(cleanTarget) : true;
          const isVerifyEmail = isElevenLabs || /verify|action\?mode=verifyemail/i.test(combinedText);

          if (recipientMatches && isVerifyEmail) {
            const verifyUrl = extractVerifyUrl(parsedHtml || parsedBodyText || rawFull);
            if (verifyUrl) {
              console.log(`[imap] ✅ Found verification link for ${cleanTarget} after ${elapsedSec}s!`);
              return {
                verifyUrl,
                subject,
                from,
                to: cleanTarget,
                receivedAt: new Date(),
              };
            }
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timed out waiting for ElevenLabs verification email for ${cleanTarget} after ${Math.round(timeoutMs / 1000)}s`);
  } finally {
    if (connection) {
      try {
        connection.end();
      } catch {}
    }
  }
}

module.exports = {
  openImapConnection,
  extractVerifyUrl,
  waitForElevenLabsVerifyEmail,
};
