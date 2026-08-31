const assert = require('assert');
const { parseBatchArgs, selectBatchAccounts } = require('../batch');
const { findAccountByEmail } = require('../automation-worker');
const { isEligibleForWorkflow } = require('../workflow-policy');

assert.deepStrictEqual(parseBatchArgs(['--row=49', '--limit=1', '--interval=2', '--no-proxy']), {
  row: 49,
  limit: 1,
  intervalMinutes: 2,
  noProxy: true,
});
assert.throws(() => parseBatchArgs(['--resume']), /accepts only/);

const initialRows = [
  { rowIndex: 49, email: 'scoped@example.com', status: 'pending', elevenPass: '', apiKey: '' },
  { rowIndex: 50, email: 'unrelated@example.com', status: 'pending', elevenPass: '', apiKey: '' },
];
const scope = selectBatchAccounts(initialRows, { row: 49, limit: Infinity });
assert.deepStrictEqual(scope, [{ rowIndex: 49, email: 'scoped@example.com' }]);

const laterRows = [
  { rowIndex: 70, email: 'scoped@example.com', status: 'credentials-rejected', elevenPass: '', apiKey: '' },
  { rowIndex: 50, email: 'unrelated@example.com', status: 'credentials-rejected', elevenPass: '', apiKey: '' },
];
const resetPhase = scope
  .map((account) => findAccountByEmail(laterRows, account))
  .filter(({ row }) => isEligibleForWorkflow(row, 'resetPassword'))
  .map(({ rowIndex }) => rowIndex);
assert.deepStrictEqual(resetPhase, [70]);
console.log('✓ batch keeps a stable email scope across phase transitions and row moves');

assert.throws(() => selectBatchAccounts([
  { rowIndex: 2, email: 'duplicate@example.com', status: 'pending', elevenPass: '', apiKey: '' },
  { rowIndex: 3, email: 'DUPLICATE@example.com', status: 'pending', elevenPass: '', apiKey: '' },
], { row: null, limit: Infinity }), /one unique Sheet row/);
console.log('✓ batch rejects ambiguous email identities before automation starts');
