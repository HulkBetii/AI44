const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// waitForManualSignup used to recognise only two outcomes: the app navigating off /sign-up,
// or the Resend button appearing. When ElevenLabs refuses the address it does neither - it
// reports the reason inline and stays put - so the run sat out the full 15-minute CAPTCHA
// budget, ringing the bell once a minute for a CAPTCHA that was not on screen. Sheet row 25
// reached 'failed:sign-up elevenlabs' with no password recorded, which is what that looks
// like from the outside.
//
// Extracted rather than required: signup-hotmail.js calls run() at import time.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');

const rejectedSrc = src.match(/const SIGNUP_REJECTED = .*;/);
assert.ok(rejectedSrc, 'SIGNUP_REJECTED not found in signup-hotmail.js');
const fnSrc = src.match(/async function waitForManualSignup\(page\) \{[\s\S]*?\n\}/);
assert.ok(fnSrc, 'waitForManualSignup not found in signup-hotmail.js');

// Bound to the real declaration so the test tracks the shipped pattern, not a copy of it.
const SIGNUP_REJECTED = new Function(`${rejectedSrc[0]} return SIGNUP_REJECTED;`)();

const build = (timeoutMs) => new Function(
  'SIGNUP_TIMEOUT_MS', 'SIGNUP_REJECTED', 'console', 'process',
  `${fnSrc[0]}; return waitForManualSignup;`,
)(timeoutMs, SIGNUP_REJECTED, { log() {} }, { stdout: { write() {} } });

const url = 'file://' + path.join(__dirname, 'fixtures', 'sign-up.html').replace(/\\/g, '/');

// ── the pattern itself ───────────────────────────────────────────────────────
// "Already have an account?" is standing text on the sign-up page. A looser matcher would
// abort every signup on sight, which is far worse than the hang it replaces.
for (const safe of [
  'Already have an account? Log in',
  'Already a member? Sign in',
  'Create your account',
  'Solve the CAPTCHA to continue',
]) {
  assert.ok(!SIGNUP_REJECTED.test(safe), `must not fire on normal page text: ${safe}`);
}
console.log('✓ does not fire on "Already have an account?" or other standing text');

for (const rejection of [
  'This email is already in use',
  'That email is already registered',
  'An account with this email already exists',
  'Email has already been taken',
  'This address is already taken',
]) {
  assert.ok(SIGNUP_REJECTED.test(rejection), `must fire on a rejection: ${rejection}`);
}
console.log('✓ fires on the usual phrasings of an already-registered address');

(async () => {
  const browser = await chromium.launch();
  const page = async (qs) => {
    const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await p.goto(`${url}?${qs}`);
    return p;
  };

  // The bug. Without the third branch this waits out the whole budget; with it, it must fail
  // in about the time the message takes to appear.
  {
    const wait = build(8000);
    const p = await page('reject=This%20email%20is%20already%20in%20use&after=300');
    const started = Date.now();
    await assert.rejects(() => wait(p), /refused the address/);
    const took = Date.now() - started;
    assert.ok(took < 4000, `must fail as soon as the message renders, took ${took}ms`);
    console.log(`✓ a refused address fails in ${took}ms instead of waiting out the budget`);
    await p.close();
  }

  // The regex is a guess at ElevenLabs' wording, so the error has to quote what the page
  // actually said - that sentence is how the operator finds out whether the guess was right.
  {
    const wait = build(8000);
    const p = await page('reject=That%20email%20is%20already%20registered&after=200');
    await assert.rejects(() => wait(p), (e) => {
      assert.match(e.message, /That email is already registered/);
      return true;
    });
    console.log('✓ the error quotes the message the page actually showed');
    await p.close();
  }

  // Both original outcomes must be untouched. The new branch polls the whole body, so a
  // regression here would look like every successful signup suddenly failing.
  {
    const wait = build(8000);
    const p = await page('resend=1&after=300');
    assert.strictEqual(await wait(p), 'resend-shown');
    console.log('✓ the normal verification screen still resolves as resend-shown');
    await p.close();
  }
  {
    const wait = build(8000);
    const p = await page('navigate=1&after=300');
    assert.strictEqual(await wait(p), 'url-changed');
    console.log('✓ navigating off /sign-up still resolves as url-changed');
    await p.close();
  }

  // A page that just sits there - CAPTCHA never solved - must still time out with the old
  // message, not be mistaken for a rejection.
  {
    const wait = build(2500);
    const p = await page('idle=1');
    await assert.rejects(() => wait(p), /Signup timed out/);
    console.log('✓ an idle page still times out, and is not misreported as a refusal');
    await p.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
