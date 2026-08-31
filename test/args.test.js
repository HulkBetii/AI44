const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Lift parseArgs out of the script so it can be exercised without launching a browser.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const fn = src.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/)[0];
const parseArgs = new Function(`${fn}; return parseArgs;`)();
const identityFn = src.match(/function assertSafeAccountIdentities\(selectedRows, allRows = selectedRows\) \{[\s\S]*?\n\}/)[0];
const assertSafeAccountIdentities = new Function(`${identityFn}; return assertSafeAccountIdentities;`)();
const defaults = {
  limit: Infinity, row: null, rows: null, resume: false, resetPassword: false,
  regenerateKey: false, noProxy: false, interval: 1, expectedEmail: null,
  auditWeakPasswords: false,
};

assert.deepStrictEqual(parseArgs([]), defaults);
console.log('✓ no flags → process everything');

assert.throws(
  () => assertSafeAccountIdentities([{ rowIndex: 2, email: '' }]),
  /no email identity/,
);
assert.throws(
  () => assertSafeAccountIdentities(
    [{ rowIndex: 2, email: 'duplicate@example.com' }],
    [
      { rowIndex: 2, email: 'duplicate@example.com' },
      { rowIndex: 8, email: 'DUPLICATE@example.com' },
    ],
  ),
  /not unique/,
);
console.log('✓ blank and duplicate Sheet identities fail before browser automation starts');

assert.deepStrictEqual(parseArgs(['--limit=2']), { ...defaults, limit: 2 });
console.log('✓ --limit=2 parsed');

assert.deepStrictEqual(parseArgs(['--row=7']), { ...defaults, row: 7 });
console.log('✓ --row=7 parsed');

assert.deepStrictEqual(parseArgs(['--row=7', '--limit=1']), { ...defaults, limit: 1, row: 7 });
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
  ...defaults, rows: [2, 5, 6], regenerateKey: true,
});
console.log('✓ --regenerate-key with --rows parsed');

assert.deepStrictEqual(parseArgs(['--regenerate-key', '--rows= 2 , 5 ']).rows, [2, 5]);
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

assert.strictEqual(parseArgs(['--interval=5']).interval, 5);
assert.strictEqual(parseArgs(['--interval=0.5']).interval, 0.5);
console.log('✓ --interval parsed (fractional minutes allowed)');

// The message says "positive number", so zero and empty must be rejected rather than
// silently becoming 0 via Number('').
for (const bad of ['--interval=0', '--interval=-2', '--interval=abc', '--interval=']) {
  assert.throws(() => parseArgs([bad]), /--interval must be/, `should reject ${bad}`);
}
console.log('✓ invalid --interval rejected (zero, negative, non-numeric, empty)');

assert.deepStrictEqual(parseArgs(['--expected-email=User@Example.com', '--row=7']), {
  ...defaults, row: 7, expectedEmail: 'User@Example.com',
});
assert.throws(() => parseArgs(['--expected-email=user@example.com']), /requires exactly one/);
console.log('✓ internal expected-email requires one stable row target');

assert.deepStrictEqual(parseArgs(['--audit-weak-passwords']), {
  ...defaults, auditWeakPasswords: true,
});
assert.throws(() => parseArgs(['--audit-weak-passwords', '--row=7']), /cannot be combined/);
console.log('✓ weak-password audit is a standalone read-only mode');

assert.throws(() => parseArgs(['--reset']), /Use --reset-password instead/);
for (const bad of ['--proxy-token=secret', 'row=7']) {
  assert.throws(() => parseArgs([bad]), /Unknown option/);
}
assert.throws(() => parseArgs(['--resume', '--reset-password']), /mutually exclusive/);
assert.throws(() => parseArgs(['--row=7', '--row=8']), /only be provided once/);
assert.throws(() => parseArgs(['--rows=2']), /only valid with --regenerate-key/);
console.log('✓ unknown, conflicting and duplicate options are rejected');

console.log('\nAll assertions passed.');
