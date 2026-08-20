const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/async function grantAllPermissions\(page\) \{[\s\S]*?\n\}/)[0];
const grantAllPermissions = new Function(`return ${fn}`)();

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(require('url').pathToFileURL(path.join(__dirname, 'fixtures', 'perms-dialog.html')).href);

  const before = await page.locator('button[id$="-trigger-none"][aria-selected="true"]').count();
  assert.strictEqual(before, 9, 'fixture should start with every row on No Access');
  console.log(`✓ fixture starts with all ${before} rows on No Access`);

  await grantAllPermissions(page);

  const stillNone = await page.locator('button[id$="-trigger-none"][aria-selected="true"]').count();
  assert.strictEqual(stillNone, 0);
  console.log('✓ no row left on No Access');

  const writes = await page.locator('button[id$="-trigger-write"][aria-selected="true"]').count();
  assert.strictEqual(writes, 4, 'all four 3-tab rows should land on Write');
  console.log('✓ rows offering Write get Write (4/4)');

  const access = await page.locator('button[id$="-trigger-access"][aria-selected="true"]').count();
  assert.strictEqual(access, 5, 'the five 2-tab rows should land on Access');
  console.log('✓ rows without Write get Access (5/5)');

  assert.strictEqual(await page.locator('#restrict').getAttribute('aria-checked'), 'true');
  console.log('✓ Restrict Key left ON (endpoint list stays present)');

  assert.strictEqual(await page.locator('#ip').getAttribute('aria-checked'), 'false');
  assert.strictEqual(await page.locator('#leak').getAttribute('aria-checked'), 'true');
  console.log('✓ "Restrict by IP" and "Auto-disable if leaked" untouched');

  // Idempotence: a second pass must not toggle anything back.
  await grantAllPermissions(page);
  assert.strictEqual(await page.locator('button[id$="-trigger-none"][aria-selected="true"]').count(), 0);
  assert.strictEqual(await page.locator('#restrict').getAttribute('aria-checked'), 'true');
  console.log('✓ running twice is idempotent');

  // Regression: a row that refuses to change must throw, not pass silently.
  await page.evaluate(() => {
    const tl = document.querySelector('[role="tablist"]');
    tl.replaceWith(tl.cloneNode(true)); // strip the click handler
  });
  await page.locator('[role="tablist"]').first().locator('button[id$="-trigger-none"]')
    .evaluate((b) => b.setAttribute('aria-selected', 'true'));
  await assert.rejects(() => grantAllPermissions(page), /still set to No Access/);
  console.log('✓ an unresponsive row throws instead of creating a crippled key');

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
