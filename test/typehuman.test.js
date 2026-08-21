const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { typeHuman } = require('../human-behavior.js');

// typeHuman lives in human-behavior.js and drives real mouse and keyboard events, so it is
// exercised against a real page rather than a stub. The fixture reproduces the failure that
// prompted the repair path: a field that stops accepting typed characters partway through,
// which once produced a truncated email and a sign-in that failed three steps later.
const base = pathToFileURL(path.join(__dirname, 'fixtures', 'truncating-input.html')).href;
const EMAIL = 'averylongtestaddress99@example.com'; // 34 chars

(async () => {
  const browser = await chromium.launch();

  // Healthy field: everything typed lands, no repair needed.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(base);
    await typeHuman(page, '#field', EMAIL);
    assert.strictEqual(await page.locator('#field').inputValue(), EMAIL);
    console.log('✓ types the full value into a healthy field');
    await page.close();
  }

  // The observed failure: the field accepts only the first 10 of 34 characters.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(`${base}?cap=10`);
    await typeHuman(page, '#field', EMAIL);
    assert.strictEqual(
      await page.locator('#field').inputValue(), EMAIL,
      'truncation must be detected and repaired, not passed downstream',
    );
    console.log('✓ detects truncation at 10 of 34 chars and repairs it');
    await page.close();
  }

  // A field that refuses writes entirely must throw rather than let the caller proceed on a
  // value that was never set.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    // maxlength caps the repair path as well, so the value genuinely cannot be stored.
    await page.goto(`${base}?maxlength=5`);
    await assert.rejects(() => typeHuman(page, '#field', EMAIL), /Could not set/);
    assert.notStrictEqual(await page.locator('#field').inputValue(), EMAIL);
    console.log('✓ an unwritable field throws instead of failing silently');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
