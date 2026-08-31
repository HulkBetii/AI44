const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const pattern = src.match(/const LEGACY_PASSWORD_PATTERN = new RegExp\([\s\S]*?\n\);/);
const selector = src.match(/function selectWeakPasswordRows\(rows\) \{[\s\S]*?\n\}/);
assert.ok(pattern && selector, 'legacy weak-password selector not found');
const selectWeakPasswordRows = new Function(
  `${pattern[0]}\n${selector[0]}\nreturn selectWeakPasswordRows;`,
)();

const rows = [
  { rowIndex: 2, email: 'first@example.com', elevenPass: 'JamesLove1980@' },
  { rowIndex: 3, email: 'last@example.com', elevenPass: 'AbigailHope2005$' },
  { rowIndex: 4, email: 'wrong-name@example.com', elevenPass: 'UnknownLove1990@' },
  { rowIndex: 5, email: 'wrong-year@example.com', elevenPass: 'JamesLove2006@' },
  { rowIndex: 6, email: 'new@example.com', elevenPass: 'A7#nPx2$kLm9!qRs4@Vb' },
  { rowIndex: 7, email: 'blank@example.com', elevenPass: '' },
];

assert.deepStrictEqual(
  selectWeakPasswordRows(rows).map(({ rowIndex, email }) => ({ rowIndex, email })),
  [
    { rowIndex: 2, email: 'first@example.com' },
    { rowIndex: 3, email: 'last@example.com' },
  ],
);
console.log('✓ audit selects only exact passwords produced by the legacy generator');

const audit = src.match(/async function auditWeakPasswords\(\) \{[\s\S]*?\n\}/)[0];
assert.ok(audit.includes('initSheets()') && audit.includes('loadRows()'));
assert.ok(!/updateStatus|updatePassword|updateResult|createProfile|resolveProxyConfig/.test(audit));
assert.ok(audit.includes('({ rowIndex, email })'));
assert.ok(
  src.indexOf('if (auditOnly) return auditWeakPasswords();')
    < src.indexOf('const runtimeConfig = loadRuntimeConfig();'),
  'audit must branch before proxy/recovery automation setup',
);
console.log('✓ audit path is read-only and exposes only row/email');
