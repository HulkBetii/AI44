const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('./runtime-config');

const initialConfig = loadRuntimeConfig();
const SHEET_ID = initialConfig.sheetId;
const SHEET_NAME = initialConfig.sheetName;
let activeSheetId = SHEET_ID;
let activeSheetName = SHEET_NAME;
let activeServiceAccountPath = initialConfig.serviceAccountPath;

// Columns (0-indexed into a row array): A=email B=password C=msaToken D=tenantGuid
//                                       E=recoveryEmail F=apiKey G=elevenPass H=status
const COL = {
  email: 0, password: 1, msaToken: 2, tenantGuid: 3, recoveryEmail: 4,
  apiKey: 5, elevenPass: 6, status: 7,
};
const SHEET_IDENTITY_UNSAFE = 'SHEET_IDENTITY_UNSAFE';

let sheetsClient = null;

function loadCredentials() {
  const credentialsPath = activeServiceAccountPath
    ? path.resolve(activeServiceAccountPath)
    : path.join(__dirname, 'service-account.json');
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch {
    throw new Error(
      `Google service account credentials could not be read at ${credentialsPath}. ` +
      'Set GOOGLE_SERVICE_ACCOUNT_PATH or place service-account.json in the project root.');
  }
}

function configureSheets({ sheetId, sheetName, serviceAccountPath } = {}) {
  if (sheetId) activeSheetId = sheetId;
  if (sheetName) activeSheetName = sheetName;
  if (serviceAccountPath) activeServiceAccountPath = serviceAccountPath;
  sheetsClient = null;
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
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!A:I`,
  });
  const rows = res.data.values || [];
  return rows.slice(1).map((r, i) => ({
    rowIndex: i + 2, // slice(1) dropped the header, so data starts at sheet row 2
    email: r[COL.email] || '',
    password: r[COL.password] || '',
    msaToken: r[COL.msaToken] || '',
    tenantGuid: r[COL.tenantGuid] || '',
    recoveryEmail: r[COL.recoveryEmail] || '',
    apiKey: (r[COL.apiKey] || '').trim(),
    elevenPass: (r[COL.elevenPass] || '').trim(),
    status: (r[COL.status] || '').trim().toLowerCase(),
  }));
}

async function loadPendingRows() {
  return (await loadRows()).filter((r) => r.status === 'pending');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function unsafeIdentity(message) {
  const error = new Error(message);
  error.code = SHEET_IDENTITY_UNSAFE;
  return error;
}

async function resolveUniqueRowsByEmail(emails) {
  const identities = emails.map((email) => ({ email, normalizedEmail: normalizeEmail(email) }));
  if (identities.some(({ normalizedEmail }) => !normalizedEmail)) {
    throw unsafeIdentity('Sheet mutation requires non-empty email identities');
  }
  if (new Set(identities.map(({ normalizedEmail }) => normalizedEmail)).size !== identities.length) {
    throw unsafeIdentity('Sheet mutation received duplicate email identities');
  }
  const rows = await loadRows();
  return identities.map(({ email, normalizedEmail }) => {
    const matches = rows.filter((row) => normalizeEmail(row.email) === normalizedEmail);
    if (matches.length !== 1) {
      throw unsafeIdentity(
        `Sheet mutation for ${email} requires exactly one matching row; found ${matches.length}`,
      );
    }
    return matches[0];
  });
}

async function resolveUniqueRowByEmail(email) {
  return (await resolveUniqueRowsByEmail([email]))[0];
}

async function writeRange(range, values) {
  await client().spreadsheets.values.update({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!${range}`,
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

async function updatePasswordAndStatus(rowIndex, elevenPass, status) {
  await writeRange(`G${rowIndex}:H${rowIndex}`, [elevenPass, status]);
  console.log(`[sheet] Row ${rowIndex} → password stored, status: ${status}`);
}

// Success path only.
async function updateResult(rowIndex, apiKey, elevenPass, status) {
  await writeRange(`F${rowIndex}:H${rowIndex}`, [apiKey, elevenPass, status]);
  console.log(`[sheet] Row ${rowIndex} → status: ${status}`);
}

async function updateStatusByEmail(email, status) {
  const row = await resolveUniqueRowByEmail(email);
  await updateStatus(row.rowIndex, status);
  return row;
}

async function updatePasswordByEmail(email, elevenPass) {
  const row = await resolveUniqueRowByEmail(email);
  await updatePassword(row.rowIndex, elevenPass);
  return row;
}

async function updatePasswordAndStatusByEmail(email, elevenPass, status) {
  const row = await resolveUniqueRowByEmail(email);
  await updatePasswordAndStatus(row.rowIndex, elevenPass, status);
  return row;
}

async function updateResultByEmail(email, apiKey, elevenPass, status) {
  const row = await resolveUniqueRowByEmail(email);
  await updateResult(row.rowIndex, apiKey, elevenPass, status);
  return row;
}

// Clears F/G and returns status to 'pending' for the given rows, in one batched request.
async function resetRows(rowIndexes) {
  if (rowIndexes.length === 0) return;
  await client().spreadsheets.values.batchUpdate({
    spreadsheetId: activeSheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: rowIndexes.map((rowIndex) => ({
        range: `${activeSheetName}!F${rowIndex}:H${rowIndex}`,
        values: [['', '', 'pending']],
      })),
    },
  });
}

async function appendRows(values) {
  if (!values || values.length === 0) return;
  const res = await client().spreadsheets.values.append({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return res.data;
}

module.exports = {
  SHEET_ID, SHEET_NAME, COL, SHEET_IDENTITY_UNSAFE,
  configureSheets,
  initSheets, loadRows, loadPendingRows,
  updateStatus, updatePassword, updatePasswordAndStatus, updateResult, resetRows,
  resolveUniqueRowByEmail, resolveUniqueRowsByEmail,
  updateStatusByEmail, updatePasswordByEmail, updatePasswordAndStatusByEmail, updateResultByEmail,
  appendRows,
};
