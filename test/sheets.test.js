const assert = require('assert');
const fs = require('fs');
const path = require('path');

const signupSource = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
assert.ok(!/await update(?:Status|Password|PasswordAndStatus|Result)\(/.test(signupSource));
for (const helper of [
  'updateStatusByEmail',
  'updatePasswordByEmail',
  'updatePasswordAndStatusByEmail',
  'updateResultByEmail',
]) {
  assert.ok(signupSource.includes(helper));
}
console.log('✓ automation Sheet mutations use stable email identity helpers');

// Stub googleapis before sheets.js pulls it in, so no network or real credentials are used.
const gapi = require('googleapis');
const calls = [];
let getResponse = { data: { values: [] } };
gapi.google.auth.GoogleAuth = function () { return {}; };
gapi.google.sheets = () => ({
  spreadsheets: {
    values: {
      get: async (a) => { calls.push(['get', a.range]); return getResponse; },
      update: async (a) => { calls.push(['update', a.range, a.requestBody.values]); },
      batchUpdate: async (a) => { calls.push(['batchUpdate', a.requestBody.data.map(d => d.range)]); },
      append: async (a) => { calls.push(['append', a.range, a.requestBody.values]); return { data: { updates: { updatedRows: a.requestBody.values.length } } }; },
    },
  },
});

const S = require('../sheets.js');

(async () => {
  // Injected credentials: the suite must not need the real service-account.json, which is
  // gitignored and absent on a fresh clone.
  await S.initSheets({ client_email: 'test@example.invalid', private_key: 'test-key' });

  // 1. Failure path must write column H and nothing else.
  calls.length = 0;
  await S.updateStatus(7, 'inactive');
  assert.deepStrictEqual(calls[0], ['update', 'hotmail!H7:H7', [['inactive']]]);
  assert.ok(!/[FG]\d/.test(calls[0][1]), 'failure path must never target F or G');
  console.log('✓ updateStatus writes H only');

  // 2. Early password persistence targets G only.
  calls.length = 0;
  await S.updatePassword(7, 'Abc1!');
  assert.deepStrictEqual(calls[0], ['update', 'hotmail!G7:G7', [['Abc1!']]]);
  console.log('✓ updatePassword writes G only');

  // 3. Success path writes the full F:H triple.
  calls.length = 0;
  await S.updateResult(7, 'sk_abc', 'Abc1!', 'complete');
  assert.deepStrictEqual(calls[0], ['update', 'hotmail!F7:H7', [['sk_abc', 'Abc1!', 'complete']]]);
  console.log('✓ updateResult writes F:H');

  // 4. Row indexing: header is sheet row 1, so the first data row is 2.
  getResponse = { data: { values: [
    ['email', 'password', 'msaToken', 'tenantGuid', 'recoveryEmail', 'apiKey', 'elevenPass', 'status'],
    ['a@x.com', 'p1', '', '', '', '', '', 'pending'],
    ['b@x.com', 'p2', '', '', '', '', '', 'complete'],
    ['c@x.com', 'p3', '', '', '', '', '', 'inactive'],
  ] } };
  const rows = await S.loadRows();
  assert.deepStrictEqual(rows.map(r => r.rowIndex), [2, 3, 4]);
  assert.strictEqual(rows[0].email, 'a@x.com');
  console.log('✓ loadRows maps header-offset row indexes');

  const pending = await S.loadPendingRows();
  assert.deepStrictEqual(pending.map(r => r.rowIndex), [2]);
  console.log('✓ loadPendingRows filters to pending');

  // 5. Short rows (Sheets omits trailing empty cells) must not throw.
  getResponse = { data: { values: [['email'], ['d@x.com', 'p4']] } };
  const short = await S.loadRows();
  assert.strictEqual(short[0].status, '');
  assert.strictEqual(short[0].apiKey, '');
  console.log('✓ short rows tolerated');

  // 6. Identity writes re-read the sheet and follow a row move instead of using a stale index.
  getResponse = { data: { values: [
    ['email', 'password', 'msaToken', 'tenantGuid', 'recoveryEmail', 'apiKey', 'elevenPass', 'status'],
    ['other@x.com', 'p1', '', '', '', '', '', 'pending'],
    ['', '', '', '', '', '', '', ''],
    ['Moved@Example.com', 'p2', '', '', '', '', 'old-pass', 'pending'],
  ] } };
  calls.length = 0;
  const moved = await S.updatePasswordByEmail('moved@example.com', 'new-pass');
  assert.strictEqual(moved.rowIndex, 4);
  assert.deepStrictEqual(calls, [
    ['get', 'hotmail!A:I'],
    ['update', 'hotmail!G4:G4', [['new-pass']]],
  ]);
  console.log('✓ identity writes follow the unique email after a Sheet row move');

  getResponse = { data: { values: [
    ['email'],
    ['duplicate@example.com'],
    ['DUPLICATE@example.com'],
  ] } };
  calls.length = 0;
  await assert.rejects(
    () => S.updateResultByEmail('duplicate@example.com', 'sk_x', 'pass', 'complete'),
    /found 2/,
  );
  assert.deepStrictEqual(calls, [['get', 'hotmail!A:I']]);
  await assert.rejects(() => S.updateStatusByEmail('missing@example.com', 'pending'), /found 0/);
  assert.strictEqual(calls.filter(([kind]) => kind === 'update').length, 0);
  console.log('✓ missing and duplicate email identities fail before any Sheet mutation');

  // 7. Reset batches into one request.
  calls.length = 0;
  await S.resetRows([2, 4]);
  assert.deepStrictEqual(calls[0], ['batchUpdate', ['hotmail!F2:H2', 'hotmail!F4:H4']]);
  assert.strictEqual(calls.length, 1, 'reset must be a single batched request');
  console.log('✓ resetRows batches into one call');

  // 8. Append rows
  calls.length = 0;
  await S.appendRows([['user@x.com', 'p1', 'tok', 'guid', '', '', '', 'pending', '']]);
  assert.deepStrictEqual(calls[0], ['append', 'hotmail!A:I', [['user@x.com', 'p1', 'tok', 'guid', '', '', '', 'pending', '']]]);
  console.log('✓ appendRows writes to A:I');

  calls.length = 0;
  await S.appendRows([]);
  assert.strictEqual(calls.length, 0);
  console.log('✓ appendRows no-ops on empty input');

  console.log('\nAll assertions passed.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
