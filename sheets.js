const { google } = require('googleapis');

const SHEET_ID = '1nNAzzC34zSvX2S_AJ4jB6njhKnKRWs8KeZ0mJ5oSkTU';
const SHEET_NAME = 'hotmail';

// Columns (0-indexed into a row array): A=email B=password C=msaToken D=tenantGuid
//                                       E=recoveryEmail F=apiKey G=elevenPass H=status I=proxyToken
const COL = {
  email: 0, password: 1, msaToken: 2, tenantGuid: 3, recoveryEmail: 4,
  apiKey: 5, elevenPass: 6, status: 7, proxyToken: 8,
};

let sheetsClient = null;

function loadCredentials() {
  try {
    return require('./service-account.json');
  } catch {
    throw new Error(
      'service-account.json not found in the project root. Place the Google service account ' +
      'key there; it is gitignored and never committed.');
  }
}

// Credentials are injectable so tests can drive the sheet helpers without a real key file.
async function initSheets(credentials = loadCredentials()) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function client() {
  if (!sheetsClient) throw new Error('initSheets() must be called first');
  return sheetsClient;
}

// Returns every data row with its 1-based sheet row index (header occupies row 1).
async function loadRows() {
  const res = await client().spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:I`,
  });
  const rows = res.data.values || [];
  return rows.slice(1).map((r, i) => ({
    rowIndex: i + 2, // slice(1) dropped the header, so data starts at sheet row 2
    email: r[COL.email] || '',
    password: r[COL.password] || '',
    msaToken: r[COL.msaToken] || '',
    tenantGuid: r[COL.tenantGuid] || '',
    recoveryEmail: r[COL.recoveryEmail] || '',
    apiKey: r[COL.apiKey] || '',
    elevenPass: r[COL.elevenPass] || '',
    status: (r[COL.status] || '').trim().toLowerCase(),
    proxyToken: (r[COL.proxyToken] || '').trim(),
  }));
}

async function loadPendingRows() {
  return (await loadRows()).filter((r) => r.status === 'pending');
}

async function writeRange(range, values) {
  await client().spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${range}`,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
}

// Status-only write. Every failure path uses this: it cannot touch F or G, so credentials
// already recorded for a partially-created account survive the failure.
async function updateStatus(rowIndex, status) {
  await writeRange(`H${rowIndex}:H${rowIndex}`, [status]);
  console.log(`[sheet] Row ${rowIndex} → status: ${status}`);
}

// Records the ElevenLabs password as soon as the account exists, before the key step can fail.
async function updatePassword(rowIndex, elevenPass) {
  await writeRange(`G${rowIndex}:G${rowIndex}`, [elevenPass]);
  console.log(`[sheet] Row ${rowIndex} → password stored`);
}

// Success path only.
async function updateResult(rowIndex, apiKey, elevenPass, status) {
  await writeRange(`F${rowIndex}:H${rowIndex}`, [apiKey, elevenPass, status]);
  console.log(`[sheet] Row ${rowIndex} → status: ${status}`);
}

// Clears F/G and returns status to 'pending' for the given rows, in one batched request.
async function resetRows(rowIndexes) {
  if (rowIndexes.length === 0) return;
  await client().spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: rowIndexes.map((rowIndex) => ({
        range: `${SHEET_NAME}!F${rowIndex}:H${rowIndex}`,
        values: [['', '', 'pending']],
      })),
    },
  });
}

module.exports = {
  SHEET_ID, SHEET_NAME, COL,
  initSheets, loadRows, loadPendingRows,
  updateStatus, updatePassword, updateResult, resetRows,
};
