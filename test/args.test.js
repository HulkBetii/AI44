const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Lift parseArgs out of the script so it can be exercised without launching a browser.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/)[0];
const parseArgs = new Function(`${fn}; return parseArgs;`)();

assert.deepStrictEqual(parseArgs([]), { limit: Infinity, row: null, resume: false, resetPassword: false });
console.log('✓ no flags → process everything');

assert.deepStrictEqual(parseArgs(['--limit=2']), { limit: 2, row: null, resume: false, resetPassword: false });
console.log('✓ --limit=2 parsed');

assert.deepStrictEqual(parseArgs(['--row=7']), { limit: Infinity, row: 7, resume: false, resetPassword: false });
console.log('✓ --row=7 parsed');

assert.deepStrictEqual(parseArgs(['--row=7', '--limit=1']), { limit: 1, row: 7, resume: false, resetPassword: false });
console.log('✓ flags combine');

for (const bad of ['--limit=0', '--limit=-3', '--limit=abc', '--limit=1.5']) {
  assert.throws(() => parseArgs([bad]), /--limit must be/, `should reject ${bad}`);
}
console.log('✓ invalid --limit rejected (0, negative, non-numeric, fractional)');

for (const bad of ['--row=1', '--row=0', '--row=xyz']) {
  assert.throws(() => parseArgs([bad]), /--row must be/, `should reject ${bad}`);
}
console.log('✓ invalid --row rejected (header row, zero, non-numeric)');

console.log('\nAll assertions passed.');
