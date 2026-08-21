const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const { generateRealisticName } = require('../human-behavior.js');
// generatePassword still lives in signup-hotmail.js but now depends on a module import,
// so inject it rather than hoisting the whole module.
const generatePassword = new Function('generateRealisticName',
  `return ${src.match(/function generatePassword\(\) \{[\s\S]*?\n\}/)[0]}`)(generateRealisticName);

const url = pathToFileURL(path.join(__dirname, 'fixtures', 'reset', 'new-password.html')).href;

// The form states: minimum 8, at least one number, at least one special character.
const meetsRules = (v) => v.length >= 8 && /[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v);

(async () => {
  // Generator must satisfy the displayed rules on every draw, not just usually.
  for (let i = 0; i < 500; i++) {
    const pw = generatePassword();
    assert.ok(meetsRules(pw), `generated password fails the form rules: ${pw}`);
  }
  const sample = generatePassword();
  console.log(`✓ 500/500 generated passwords meet the stated rules (len=${sample.length})`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });

  const fields = page.locator('input[type="password"]:visible');
  assert.strictEqual(await fields.count(), 2);
  console.log('✓ both password fields located');

  const submit = page.getByRole('button', { name: 'Change Password', exact: true });
  assert.strictEqual(await submit.isDisabled(), true);
  console.log('✓ "Change Password" starts disabled');

  const pw = generatePassword();
  for (let i = 0; i < 2; i++) await fields.nth(i).fill(pw);

  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button[type="submit"]')]
      .find((el) => el.textContent.includes('Change Password'));
    return b ? !b.disabled : false;
  }, { timeout: 10000 });
  console.log('✓ filling both fields unlocks the button');

  assert.strictEqual(await page.evaluate(() => window.__toggleClicked || 0), 0);
  console.log('✓ neither visibility toggle was intercepted by fill()');

  await submit.click({ timeout: 10000 });
  await page.waitForURL((u) => !u.toString().includes('/app/action') && u.toString().includes('done.html'),
    { timeout: 20000 });
  console.log('✓ success navigates away, confirming the change');
  await page.close();

  // A password the validator rejects must surface the rules, not hang on click.
  const bad = await browser.newPage();
  await bad.goto(url);
  const badFields = bad.locator('input[type="password"]:visible');
  for (let i = 0; i < 2; i++) await badFields.nth(i).fill('short');
  const unlocked = await bad.waitForFunction(() => {
    const b = [...document.querySelectorAll('button[type="submit"]')]
      .find((el) => el.textContent.includes('Change Password'));
    return b ? !b.disabled : false;
  }, { timeout: 3000 }).then(() => true).catch(() => false);
  assert.strictEqual(unlocked, false);
  const rules = await bad.evaluate(() =>
    [...document.querySelectorAll('p.text-xs')].map((el) => el.textContent.trim()));
  assert.deepStrictEqual(rules, ['Minimum 8 letters', 'At least one number', 'At least one special character']);
  console.log('✓ rejected password leaves it disabled and the rules are readable for the log');

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
