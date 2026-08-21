const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

// Covers the "Forgot your password?" request form. The new-password form that the emailed
// link opens is covered separately in newpassword.test.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const { typeHuman } = require('../human-behavior.js');
const firstPresent = new Function(
  `return ${src.match(/async function firstPresent\(page, selectors, what\) \{[\s\S]*?\n\}/)[0]}`)();

const url = pathToFileURL(path.join(__dirname, 'fixtures', 'reset', 'forgot-password.html')).href;
const EMAIL = 'resettestuser@example.com';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForSelector('[data-testid="forgot-password-email-input"]', { timeout: 15000 });

  // The form ships a hidden password input for autocomplete; :visible must exclude it, or
  // filling every password field would stall on Playwright's actionability check.
  const allPw = await page.locator('input[type="password"]').count();
  const visiblePw = await page.locator('input[type="password"]:visible').count();
  assert.strictEqual(allPw, 1);
  assert.strictEqual(visiblePw, 0);
  console.log(`✓ hidden autocomplete input excluded (${allPw} total → ${visiblePw} visible)`);

  assert.strictEqual(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true);
  console.log('✓ Continue starts disabled');

  await typeHuman(page, '[data-testid="forgot-password-email-input"]', EMAIL);
  assert.strictEqual(
    await page.locator('[data-testid="forgot-password-email-input"]').inputValue(), EMAIL);
  console.log('✓ full address typed into the reset field (no truncation)');

  await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15000 });
  await page.getByText('Check your Inbox', { exact: false }).waitFor({ timeout: 20000 });
  console.log('✓ click waits out the disabled state and reaches "Check your Inbox"');
  await page.close();

  // firstPresent is the fallback used where markup is unobserved: it must report, not guess.
  const unknown = await browser.newPage();
  await unknown.setContent('<button data-testid="mystery">Proceed</button>');
  await assert.rejects(
    () => firstPresent(unknown, ['button[type="submit"]', '#nope'], 'save password button'),
    /save password button not found/,
  );
  console.log('✓ unknown layout throws and dumps the page controls');

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
