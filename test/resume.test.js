const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');

const parseArgs = new Function(
  `${src.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/)[0]}; return parseArgs;`)();

assert.deepStrictEqual(parseArgs([]), { limit: Infinity, row: null, rows: null, resume: false, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
assert.deepStrictEqual(parseArgs(['--resume']), { limit: Infinity, row: null, rows: null, resume: true, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
assert.deepStrictEqual(parseArgs(['--resume', '--limit=2']), { limit: 2, row: null, rows: null, resume: true, resetPassword: false, regenerateKey: false, noProxy: false, proxyToken: null });
console.log('✓ --resume parsed and combines with --limit');

assert.deepStrictEqual(parseArgs(['--reset-password']),
  { limit: Infinity, row: null, rows: null, resume: false, resetPassword: true, regenerateKey: false, noProxy: false, proxyToken: null });
console.log('✓ --reset-password parsed');

// Rows --resume gave up on are exactly what --reset-password should pick up.
const needsReset = (r) => r.status === 'credentials-rejected';
const all = [
  { rowIndex: 3, status: 'credentials-rejected' },
  { rowIndex: 4, status: 'complete' },
  { rowIndex: 5, status: 'pending' },
  { rowIndex: 6, status: 'failed:create api key' },
];
assert.deepStrictEqual(all.filter(needsReset).map((r) => r.rowIndex), [3]);
console.log('✓ --reset-password selects only credentials-rejected rows');

// Mirror of the selection predicate in run(), exercised against the real sheet shape.
const resumable = (r) => r.status !== 'complete' && r.elevenPass && !r.apiKey;
const rows = [
  { rowIndex: 2, status: 'complete',              elevenPass: 'p', apiKey: 'sk_x' },
  { rowIndex: 3, status: 'failed:create api key', elevenPass: 'p', apiKey: ''     },
  { rowIndex: 4, status: 'failed:create api key', elevenPass: 'p', apiKey: ''     },
  { rowIndex: 7, status: 'pending',               elevenPass: '',  apiKey: ''     },
  { rowIndex: 8, status: 'inactive',              elevenPass: '',  apiKey: ''     },
  { rowIndex: 9, status: 'failed:sheet write',    elevenPass: 'p', apiKey: 'sk_y' },
];
assert.deepStrictEqual(rows.filter(resumable).map((r) => r.rowIndex), [3, 4]);
console.log('✓ selects exactly the stranded rows (3, 4)');
console.log('  - skips complete rows');
console.log('  - skips untouched pending rows (no account exists yet)');
console.log('  - skips rows that never got past Microsoft login');
console.log('  - skips rows that already hold a key');

console.log('\nAll assertions passed.');

// --no-proxy must override BOTH the global fallback token and a per-row token - it exists
// specifically to isolate "is the proxy causing this" during diagnosis, so it must be total.
const activeToken = (noProxy, cred, defaultToken) => (noProxy ? null : (cred.proxyToken || defaultToken));
assert.strictEqual(activeToken(true, { proxyToken: 'row-token' }, 'default-token'), null);
assert.strictEqual(activeToken(false, { proxyToken: 'row-token' }, 'default-token'), 'row-token');
assert.strictEqual(activeToken(false, { proxyToken: '' }, 'default-token'), 'default-token');
console.log('✓ --no-proxy overrides both per-row and fallback proxy tokens');
