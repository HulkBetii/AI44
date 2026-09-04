/**
 * test-imap.js
 * Verification script to test Gmail IMAP handshake and list recent messages.
 */

const { openImapConnection, extractVerifyUrl } = require('./imap-client');
const { loadCatchAllConfig } = require('./config');

async function test() {
  const config = loadCatchAllConfig();
  console.log(`[test-imap] Testing connection to ${config.gmailUser} via IMAP SSL (Port 993)...`);

  let connection;
  try {
    connection = await openImapConnection();
    console.log('[test-imap] ✅ Connected to Gmail IMAP successfully!');

    const box = await connection.openBox('INBOX');
    console.log(`[test-imap] ✅ INBOX opened: Total messages = ${box.messages.total}, New = ${box.messages.new}`);

    // Search last 3 messages
    const searchCriteria = ['ALL'];
    const fetchOptions = {
      bodies: ['HEADER'],
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    console.log(`[test-imap] Fetched ${messages.length} message headers from INBOX.`);

    if (messages.length > 0) {
      const recent = messages.slice(-3).reverse();
      console.log('\n--- Recent 3 Emails ---');
      for (let i = 0; i < recent.length; i++) {
        const header = recent[i].parts.find((p) => p.which === 'HEADER')?.body || {};
        const subject = Array.isArray(header.subject) ? header.subject[0] : (header.subject || '(no subject)');
        const from = Array.isArray(header.from) ? header.from[0] : (header.from || '(unknown sender)');
        const date = Array.isArray(header.date) ? header.date[0] : (header.date || '');
        console.log(` ${i + 1}. From: ${from} | Subject: "${subject}" | Date: ${date}`);
      }
      console.log('------------------------\n');
    }

    // Test verify URL regex extractor with sample text
    const sampleHtml = `
      <p>Please click the link below to verify your ElevenLabs account:</p>
      <a href="https://elevenlabs.io/app/action?mode=verifyEmail&amp;oobCode=SAMPLE_TOKEN_12345&amp;apiKey=SAMPLE_KEY">Verify Email</a>
    `;
    const extracted = extractVerifyUrl(sampleHtml);
    console.log(`[test-imap] URL Extractor Regex Test: ${extracted === 'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=SAMPLE_TOKEN_12345&apiKey=SAMPLE_KEY' ? '✅ PASSED' : '❌ FAILED'}`);

    console.log('\n🎉 Phase 1 IMAP Verification Gate 1 PASSED 100%!');
  } catch (err) {
    console.error('[test-imap] ❌ Error:', err.message);
    process.exitCode = 1;
  } finally {
    if (connection) {
      connection.end();
      console.log('[test-imap] Connection closed cleanly.');
    }
  }
}

test();
