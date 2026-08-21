const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { clickHuman, think } = require('../human-behavior.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/async function pollOutlookInbox\([\s\S]*?\n\}/)[0];
// dismissConsentDialog lives in signup-hotmail.js too; the fixture never shows the modal, so
// a no-op stand-in is enough to satisfy the reference.
const pollOutlookInbox = new Function(
  'INBOX_TIMEOUT_MS', 'LIST_RENDER_TIMEOUT_MS', 'clickHuman', 'dismissConsentDialog', 'think',
  `return ${fn}`)(20000, 20000, clickHuman, async () => false, async () => {});

// Mailbox holding BOTH an old verification mail and a newer reset mail - the exact situation
// that made the old "take the first ElevenLabs message" logic return the wrong link.
const VERIFY = 'https://elevenlabs.io/app/action?mode=verifyEmail&amp;oobCode=OLDVERIFY';
const RESET  = 'https://elevenlabs.io/app/action?mode=resetPassword&amp;oobCode=NEWRESET';

function mailbox(bodies, renderDelayMs = 0) {
  return `<!doctype html><html><body style="margin:0;font-family:sans-serif">
    <div id="list"></div><div id="pane"></div>
    <script>
      const bodies = ${JSON.stringify(bodies)};
      const list = document.getElementById('list');
      // Outlook fetches and renders its message list well after domcontentloaded.
      setTimeout(() => {
      bodies.forEach((html, i) => {
        const row = document.createElement('div');
        row.setAttribute('role', 'option');
        row.textContent = 'ElevenLabs message ' + i;
        row.style.padding = '8px';
        row.addEventListener('click', () => { document.getElementById('pane').innerHTML = html; });
        list.appendChild(row);
      });
      }, ${renderDelayMs});
    </script></body></html>`;
}

// pollOutlookInbox now navigates to real outlook.live.com folder URLs rather than reloading,
// so the fixture is served by intercepting that host. This also exercises the inbox/junk
// alternation: whichever folder it asks for, it gets the same mailbox back.
async function serveMailbox(page, bodies, seen, renderDelayMs = 0) {
  await page.route('https://outlook.live.com/**', (route) => {
    if (seen) seen.push(new URL(route.request().url()).pathname);
    route.fulfill({ status: 200, contentType: 'text/html', body: mailbox(bodies, renderDelayMs) });
  });
}

(async () => {
  const browser = await chromium.launch();

  // Newest-first ordering puts the stale verification mail first.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveMailbox(page, [`<a href="${VERIFY}">Verify</a>`, `<a href="${RESET}">Reset</a>`]);
    const reset = await pollOutlookInbox(page, 20000, 'resetPassword');
    assert.strictEqual(reset, 'https://elevenlabs.io/app/action?mode=resetPassword&oobCode=NEWRESET');
    console.log('✓ picks the reset link past a stale verification mail');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveMailbox(page, [`<a href="${VERIFY}">Verify</a>`, `<a href="${RESET}">Reset</a>`]);
    const verify = await pollOutlookInbox(page, 20000, 'verifyEmail');
    assert.strictEqual(verify, 'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=OLDVERIFY');
    console.log('✓ picks the verify link when that is what is asked for');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveMailbox(page, [`<a href="${VERIFY}">Verify</a>`]);
    assert.strictEqual(await pollOutlookInbox(page, 20000),
      'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=OLDVERIFY');
    console.log('✓ defaults to verifyEmail (existing callers unchanged)');
    await page.close();
  }

  // A wrong-kind-only mailbox must time out rather than return the wrong link, and while
  // waiting it must alternate between Inbox and Junk so spam-routed mail is still found.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const folders = [];
    await serveMailbox(page, [`<a href="${VERIFY}">Verify</a>`], folders);
    await assert.rejects(() => pollOutlookInbox(page, 12000, 'resetPassword'),
      /no ElevenLabs resetPassword email/);
    console.log('✓ times out rather than returning a link of the wrong kind');

    assert.ok(folders.some((f) => f.includes('inbox')), `never checked Inbox: ${folders}`);
    assert.ok(folders.some((f) => f.includes('junkemail')), `never checked Junk: ${folders}`);
    console.log(`✓ alternates between Inbox and Junk while waiting (${folders.length} navigations)`);
    await page.close();
  }


  // Regression: navigating to a different folder every pass forces a cold SPA boot, and the
  // fixed 3s sleep that replaced the old warm reload was not long enough. A live run timed out
  // while the verification mail sat plainly visible in the inbox. The loop must wait for the
  // message list to exist rather than sleeping a guessed amount.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveMailbox(page, [`<a href="${VERIFY}">Verify</a>`], null, 6000);
    const link = await pollOutlookInbox(page, 40000, 'verifyEmail');
    assert.strictEqual(link, 'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=OLDVERIFY');
    console.log('✓ finds mail that renders 6s after domcontentloaded (slow SPA boot)');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
