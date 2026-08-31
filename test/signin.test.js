const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const { typeHuman, clickHuman } = require('../human-behavior.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const pick = (re) => src.match(re)[0];
const bundle = [
  pick(/const SIGN_IN = \{[^}]*\};/),
  pick(/const SIGN_IN_EMAIL_SELECTOR = [^;]*;/),
  pick(/const SIGN_IN_PASSWORD_SELECTOR = [^;]*;/),
  pick(/const SIGN_IN_SUBMIT_SELECTOR = [^;]*;/),
  pick(/function firstOutcome\(candidates, timeoutMs\) \{[\s\S]*?\n\}/),
  pick(/async function attemptSignIn\(page, email, elevenPassword\) \{[\s\S]*?\n\}/),
  'return { attemptSignIn, SIGN_IN };',
].join('\n');
const { attemptSignIn, SIGN_IN } = new Function('step', 'typeHuman', 'clickHuman', bundle)(() => {}, typeHuman, clickHuman);

const url = (mode) =>
  pathToFileURL(path.join(__dirname, 'fixtures', 'signin', 'sign-in.html')).href + '?mode=' + mode;

(async () => {
  const browser = await chromium.launch();

  for (const [mode, expected] of [
    ['ok', SIGN_IN.OK],
    ['unverified', SIGN_IN.UNVERIFIED],
    ['rejected', SIGN_IN.REJECTED],
  ]) {
    console.log(`Starting test for mode: ${mode}`);
    const page = await browser.newPage();
    await page.goto(url(mode));
    const got = await attemptSignIn(page, 'test@example.com', 'Passw0rd!');
    assert.strictEqual(got, expected, `mode=${mode} should classify as ${expected}, got ${got}`);
    console.log(`✓ ${mode.padEnd(11)} → ${got}`);
    await page.close();
  }

  // A page that answers with none of the three must throw, not guess.
  const page = await browser.newPage();
  await page.goto(url('silent'));
  await assert.rejects(
    () => attemptSignIn(page, 'test@example.com', 'Passw0rd!'),
    /no recognised outcome/,
  );
  console.log('✓ unrecognised    → throws instead of guessing');
  await page.close();


  // Real-markup guards: the submit button ships disabled, and a visibility toggle overlays
  // the password input's right edge.
  {
    const page = await browser.newPage();
    await page.goto(url('ok'));
    assert.strictEqual(await page.locator('[data-testid="sign-in-submit-button"]').isDisabled(), true);
    const got = await attemptSignIn(page, 'test@example.com', 'Passw0rd!');
    assert.strictEqual(got, SIGN_IN.OK, 'must wait out the disabled submit button');
    console.log('✓ submit button starts disabled and is still clicked');
    await page.close();
  }
  {
    const page = await browser.newPage();
    await page.goto(url('unverified'));
    await attemptSignIn(page, 'test@example.com', 'Passw0rd!');
    const toggled = await page.evaluate(() => window.__toggleClicked || 0);
    assert.strictEqual(toggled, 0, 'typing must not hit the visibility toggle');
    assert.strictEqual(await page.locator('[data-testid="sign-in-password-input"]').inputValue(), 'Passw0rd!');
    console.log('✓ password typed in full; visibility toggle never intercepted');
    await page.close();
  }


  // An already-authenticated context: /app/sign-in redirects into the app, so no form is
  // rendered. This is what --regenerate-key hits, and it must read as success, not failure.
  {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(__dirname, 'fixtures', 'signin', 'home.html')).href);
    const got = await attemptSignIn(page, 'test@example.com', 'Passw0rd!');
    assert.strictEqual(got, SIGN_IN.OK, 'no form + off the sign-in route means already signed in');
    console.log('✓ already-authenticated page reads as signed in');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
