const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Lift parseArgs out of the script so it can be exercised without launching a browser.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/)[0];
const parseArgs = new Function(`${fn}; return parseArgs;`)();

assert.deepStrictEqual(parseArgs([]), { limit: Infinity, row: null, rows: null, resume: false, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
console.log('✓ no flags → process everything');

assert.deepStrictEqual(parseArgs(['--limit=2']), { limit: 2, row: null, rows: null, resume: false, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
console.log('✓ --limit=2 parsed');

assert.deepStrictEqual(parseArgs(['--row=7']), { limit: Infinity, row: 7, rows: null, resume: false, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
console.log('✓ --row=7 parsed');

assert.deepStrictEqual(parseArgs(['--row=7', '--limit=1']), { limit: 1, row: 7, rows: null, resume: false, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
console.log('✓ flags combine');

for (const bad of ['--limit=0', '--limit=-3', '--limit=abc', '--limit=1.5']) {
  assert.throws(() => parseArgs([bad]), /--limit must be/, `should reject ${bad}`);
}
console.log('✓ invalid --limit rejected (0, negative, non-numeric, fractional)');

for (const bad of ['--row=1', '--row=0', '--row=xyz']) {
  assert.throws(() => parseArgs([bad]), /--row must be/, `should reject ${bad}`);
}
console.log('✓ invalid --row rejected (header row, zero, non-numeric)');

assert.deepStrictEqual(parseArgs(['--regenerate-key', '--rows=2,5,6']), {
  limit: Infinity, row: null, rows: [2, 5, 6], resume: false, resetPassword: false, regenerateKey: true, noProxy: false, proxyToken: null,
});
console.log('✓ --regenerate-key with --rows parsed');

assert.deepStrictEqual(parseArgs(['--rows= 2 , 5 ']).rows, [2, 5]);
console.log('✓ --rows tolerates spaces');

// Re-keying without naming rows would silently do nothing, so it must be rejected.
assert.throws(() => parseArgs(['--regenerate-key']), /needs --rows=/);
console.log('✓ --regenerate-key without --rows is rejected');

for (const bad of ['--rows=1', '--rows=0', '--rows=2,abc', '--rows=2,1']) {
  assert.throws(() => parseArgs([bad]), /--rows must be/, `should reject ${bad}`);
}
console.log('✓ invalid --rows rejected (header row, zero, non-numeric, mixed)');

assert.strictEqual(parseArgs(['--no-proxy']).noProxy, true);
assert.strictEqual(parseArgs([]).noProxy, false);
console.log('✓ --no-proxy parsed');

assert.strictEqual(parseArgs(['--proxy-token=abc123']).proxyToken, 'abc123');
assert.strictEqual(parseArgs([]).proxyToken, null);
console.log('✓ --proxy-token parsed');

// Asking to both skip the proxy and use a specific one is a contradiction; silently
// honouring one would make a diagnostic run lie about what it tested.
assert.throws(
  () => parseArgs(['--no-proxy', '--proxy-token=abc123']),
  /mutually exclusive/,
);
console.log('✓ --no-proxy and --proxy-token together are rejected');

console.log('\nAll assertions passed.');
