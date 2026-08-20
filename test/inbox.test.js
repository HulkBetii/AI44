const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/async function pollOutlookInbox\([\s\S]*?\n\}/)[0];
const pollOutlookInbox = new Function('INBOX_TIMEOUT_MS', `return ${fn}`)(20000);

// Mailbox holding BOTH an old verification mail and a newer reset mail - the exact situation
// that made the old "take the first ElevenLabs message" logic return the wrong link.
const VERIFY = 'https://elevenlabs.io/app/action?mode=verifyEmail&amp;oobCode=OLDVERIFY';
const RESET  = 'https://elevenlabs.io/app/action?mode=resetPassword&amp;oobCode=NEWRESET';

function mailbox(bodies) {
  return `<!doctype html><html><body>
    <div id="list"></div><div id="pane"></div>
    <script>
      const bodies = ${JSON.stringify(bodies)};
      const list = document.getElementById('list');
      bodies.forEach((html, i) => {
        const row = document.createElement('div');
        row.setAttribute('role', 'option');
        row.textContent = 'ElevenLabs message ' + i;
        row.addEventListener('click', () => { document.getElementById('pane').innerHTML = html; });
        list.appendChild(row);
      });
    </script></body></html>`;
}

const TMP = require('os').tmpdir();
const write = (name, bodies) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, mailbox(bodies));
  return pathToFileURL(file).href;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Newest-first ordering puts the stale verification mail first.
  await page.goto(write('mbox-both.html', [`<a href="${VERIFY}">Verify</a>`, `<a href="${RESET}">Reset</a>`]));
  const reset = await pollOutlookInbox(page, 20000, 'resetPassword');
  assert.strictEqual(reset, 'https://elevenlabs.io/app/action?mode=resetPassword&oobCode=NEWRESET');
  console.log('✓ picks the reset link past a stale verification mail');

  await page.goto(write('mbox-both2.html', [`<a href="${VERIFY}">Verify</a>`, `<a href="${RESET}">Reset</a>`]));
  const verify = await pollOutlookInbox(page, 20000, 'verifyEmail');
  assert.strictEqual(verify, 'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=OLDVERIFY');
  console.log('✓ picks the verify link when that is what is asked for');

  await page.goto(write('mbox-default.html', [`<a href="${VERIFY}">Verify</a>`]));
  assert.strictEqual(await pollOutlookInbox(page, 20000), 'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=OLDVERIFY');
  console.log('✓ defaults to verifyEmail (existing callers unchanged)');

  // Wrong-kind-only mailbox must time out, not return the wrong link.
  await page.goto(write('mbox-verify-only.html', [`<a href="${VERIFY}">Verify</a>`]));
  await assert.rejects(() => pollOutlookInbox(page, 6000, 'resetPassword'), /no ElevenLabs resetPassword email/);
  console.log('✓ times out rather than returning a link of the wrong kind');

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
