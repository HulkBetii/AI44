const assert = require('assert');
const {
  parseArgs,
  selectResetPasswordRows,
  selectWorkflowRows,
} = require('../signup-hotmail');

const defaults = {
  limit: Infinity, row: null, rows: null, resume: false, resetPassword: false,
  regenerateKey: false, noProxy: false, interval: 1, expectedEmail: null,
  auditWeakPasswords: false,
};

assert.deepStrictEqual(parseArgs([]), defaults);
assert.deepStrictEqual(parseArgs(['--resume']), { ...defaults, resume: true });
assert.deepStrictEqual(parseArgs(['--resume', '--limit=2']), { ...defaults, resume: true, limit: 2 });
console.log('✓ --resume parsed and combines with --limit');

assert.deepStrictEqual(parseArgs(['--reset-password']), { ...defaults, resetPassword: true });
console.log('✓ --reset-password parsed');

const all = [
  { rowIndex: 3, status: 'credentials-rejected', elevenPass: '', apiKey: '' },
  { rowIndex: 4, status: 'complete', elevenPass: 'p', apiKey: 'sk_done' },
  { rowIndex: 5, status: 'pending', elevenPass: '', apiKey: '' },
  { rowIndex: 6, status: 'failed:create api key', elevenPass: 'p', apiKey: '' },
  { rowIndex: 7, status: 'already-registered', elevenPass: '', apiKey: '' },
  { rowIndex: 8, status: 'inactive', elevenPass: 'p', apiKey: '' },
];
assert.deepStrictEqual(selectResetPasswordRows(all, null).map((row) => row.rowIndex), [3, 7]);
assert.deepStrictEqual(selectResetPasswordRows(all, 4).map((row) => row.rowIndex), [4]);
assert.deepStrictEqual(selectResetPasswordRows(all, 49), []);
console.log('✓ bulk reset follows state policy while a directly named row remains an override');

const rows = [
  { rowIndex: 2, status: 'complete', elevenPass: 'p', apiKey: 'sk_x' },
  { rowIndex: 3, status: 'failed:create api key', elevenPass: 'p', apiKey: '' },
  { rowIndex: 4, status: 'pending', elevenPass: 'p', apiKey: '' },
  { rowIndex: 7, status: 'pending', elevenPass: '', apiKey: '' },
  { rowIndex: 8, status: 'inactive', elevenPass: 'p', apiKey: '' },
  { rowIndex: 9, status: 'failed:sheet write', elevenPass: 'p', apiKey: 'sk_y' },
];
assert.deepStrictEqual(selectWorkflowRows(rows, 'resume').map((row) => row.rowIndex), [3, 4]);
assert.deepStrictEqual(selectWorkflowRows(rows, 'signup').map((row) => row.rowIndex), [7]);
assert.deepStrictEqual(selectWorkflowRows(all, 'resetPassword').map((row) => row.rowIndex), [3, 7]);
console.log('✓ signup, resume, and bulk reset share the workflow policy exclusions');

console.log('\nAll assertions passed.');
