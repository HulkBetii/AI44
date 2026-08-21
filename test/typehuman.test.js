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


  // The sign-in field arrives pre-filled after email verification. typeHuman used to type on
  // top of that, producing exactly double the intended value - a live run logged 58 chars for
  // a 29-char address, and again 26 for a 13-char password.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(`${base}?prefill=${encodeURIComponent(EMAIL)}`);
    assert.strictEqual(await page.locator('#field').inputValue(), EMAIL, 'fixture must start pre-filled');

    // The repair path would rescue the value either way, so assert the field was cleared up
    // front: a repair here means typeHuman typed on top of existing text.
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      await typeHuman(page, '#field', EMAIL);
    } finally {
      console.warn = realWarn;
    }

    assert.strictEqual(await page.locator('#field').inputValue(), EMAIL);
    assert.deepStrictEqual(
      warnings, [],
      `typing into a pre-filled field must replace it, not append: ${warnings.join(' | ')}`,
    );
    console.log('✓ a pre-filled field is cleared before typing, not appended to');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
