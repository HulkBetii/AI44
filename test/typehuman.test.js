const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/async function typeHuman\(page, selector, text\) \{[\s\S]*?\n\}/)[0];
const typeHuman = new Function(`return ${fn}`)();

// Fake page that drops every character after `cap`, reproducing the React-rerender truncation.
function makePage(cap) {
  let value = '';
  const p = {
    fills: 0,
    async click() {},
    async fill(_sel, v) { value = v; p.fills++; },
    async inputValue() { return value; },
    keyboard: { async type(ch) { if (value.length < cap) value += ch; } },
  };
  return p;
}

(async () => {
  const EMAIL = 'averylongtestaddress99@example.com';

  // 1. Healthy field: typed through, no repair needed.
  const ok = makePage(Infinity);
  await typeHuman(ok, '#e', EMAIL);
  assert.strictEqual(await ok.inputValue(), EMAIL);
  assert.strictEqual(ok.fills, 1, 'only the initial clear');
  console.log('✓ untruncated input needs no repair');

  // 2. The observed failure: truncated at 10 chars -> repaired via fill().
  const trunc = makePage(10);
  await typeHuman(trunc, '#e', EMAIL);
  assert.strictEqual(await trunc.inputValue(), EMAIL);
  assert.strictEqual(trunc.fills, 2, 'clear + repair');
  console.log('✓ truncation at 10 chars is detected and repaired');

  // 3. Field that refuses writes entirely must throw, not proceed silently.
  const dead = { ...makePage(0), async fill() {}, async inputValue() { return ''; } };
  dead.click = async () => {};
  dead.keyboard = { async type() {} };
  await assert.rejects(() => typeHuman(dead, '#e', EMAIL), /Could not set #e/);
  console.log('✓ unwritable field throws instead of failing silently');

  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
