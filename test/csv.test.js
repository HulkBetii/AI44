const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The success CSV is the only place some of this data is written down outside the sheet, so a
// row that silently shifts a column is worse than no row at all. Hotmail passwords and
// recovery addresses come from the operator's sheet, so their contents are arbitrary.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');

const SUCCESS_CSV = path.join(os.tmpdir(), `success-test-${process.pid}.csv`);
const KEYS_TXT = path.join(os.tmpdir(), `keys-test-${process.pid}.txt`);
const build = () => new Function('fs', 'SUCCESS_CSV', 'KEYS_TXT', 'Q', `
  ${src.match(/function csvCell\(value\) \{[\s\S]*?\n\}/)[0]}
  ${src.match(/function appendSuccessCSV\([\s\S]*?\n\}/)[0]}
  return appendSuccessCSV;
`)(fs, SUCCESS_CSV, KEYS_TXT, String.fromCharCode(34));

const appendSuccessCSV = build();

// Minimal RFC4180 reader, so the assertions check what a real consumer would parse rather
// than what the writer happened to emit.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

for (const f of [SUCCESS_CSV, KEYS_TXT]) { try { fs.unlinkSync(f); } catch {} }

// A password containing a comma is the case that silently corrupted every later column.
appendSuccessCSV(
  { email: 'a@example.com', password: 'p,ss,word', recoveryEmail: 'r@example.com' },
  'Eleven,Pass"quoted"',
  'sk_abc123',
  '1.2.3.4:8080:user:pass',
);

const rows = parseCsv(fs.readFileSync(SUCCESS_CSV, 'utf8'));
assert.strictEqual(rows.length, 2, 'header plus one record');
assert.deepStrictEqual(rows[0],
  ['Timestamp', 'Email', 'HotmailPassword', 'ElevenPassword', 'RecoveryEmail', 'APIKey', 'Proxy']);
console.log('✓ header intact');

const [, record] = rows;
assert.strictEqual(record.length, 7, `a comma in a field must not add columns, got ${record.length}`);
assert.strictEqual(record[1], 'a@example.com');
assert.strictEqual(record[2], 'p,ss,word', 'embedded commas survive the round trip');
assert.strictEqual(record[3], 'Eleven,Pass"quoted"', 'embedded quotes survive the round trip');
assert.strictEqual(record[5], 'sk_abc123', 'the API key stays in the APIKey column');
assert.strictEqual(record[6], '1.2.3.4:8080:user:pass');
console.log('✓ commas and quotes round-trip without shifting columns');

// A missing recovery address must leave an empty cell, not the string "undefined".
appendSuccessCSV({ email: 'b@example.com', password: 'pw' }, 'ev', 'sk_def456', '');
const after = parseCsv(fs.readFileSync(SUCCESS_CSV, 'utf8'));
assert.strictEqual(after.length, 3);
assert.strictEqual(after[2][4], '', 'absent recoveryEmail must be empty, not "undefined"');
assert.strictEqual(after[2][6], '', 'absent proxy must be empty');
console.log('✓ missing fields become empty cells, not "undefined"');

// The guard that decides whether a row is written at all. loadRows fills apiKey from column F,
// so without the per-run reset a failed --regenerate-key wrote a success row carrying the
// stale key and an undefined password.
const guardSrc = src.match(/cred\.apiKey = null;\s*\n\s*cred\.elevenPassword = null;/);
assert.ok(guardSrc, 'per-run reset of cred.apiKey/elevenPassword is missing from the loop');
console.log('✓ the run loop clears cred.apiKey before each account');

// keys.txt is a second sink for the same secret, so it gets the same treatment: one key
// per line, in order.
const keyLines = fs.readFileSync(KEYS_TXT, 'utf8').trim().split('\n');
assert.deepStrictEqual(keyLines, ['sk_abc123', 'sk_def456']);
console.log('✓ keys.txt receives one key per line');

for (const f of [SUCCESS_CSV, KEYS_TXT]) { try { fs.unlinkSync(f); } catch {} }
console.log('\nAll assertions passed.');
