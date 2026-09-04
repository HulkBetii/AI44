/**
 * sheets.js (catch-all-signup)
 * Dedicated Google Sheet integration for Catch-All ElevenLabs registration workflow.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { loadCatchAllConfig } = require('./config');

const REG_HEADERS = [
  'Email',
  'Password',
  'FirstName',
  'LastName',
  'Status',
  'APIKey',
  'ElevenPass',
  'Created_At',
];

const COL = {
  email: 0,
  password: 1,
  firstName: 2,
  lastName: 3,
  status: 4,
  apiKey: 5,
  elevenPass: 6,
  createdAt: 7,
};

let sheetsClient = null;
let activeSheetId = null;
let activeSheetName = null;

function loadCredentials(customPath) {
  const config = loadCatchAllConfig();
  const credentialsPath = customPath
    ? path.resolve(customPath)
    : config.serviceAccountPath
      ? path.resolve(config.serviceAccountPath)
      : path.join(__dirname, '..', 'service-account.json');

  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Google service account credentials could not be read at ${credentialsPath}: ${err.message}`
    );
  }
}

async function initSignupSheets(options = {}) {
  const config = loadCatchAllConfig();
  activeSheetId = options.sheetId || config.regSheetId || config.sheetId;
  activeSheetName = options.sheetName || config.regSheetName || 'catch-all-signup';

  if (!activeSheetId) {
    throw new Error('Google Spreadsheet ID is required. Please configure regSheetId or sheetId in config.local.json.');
  }

  const credentials = options.credentials || loadCredentials(options.serviceAccountPath);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function client() {
  if (!sheetsClient) {
    throw new Error('initSignupSheets() must be called before interacting with Google Sheets.');
  }
  return sheetsClient;
}

/**
 * Ensure the sheet tab exists and the header row is properly written
 */
async function ensureHeaderRow() {
  try {
    const res = await client().spreadsheets.values.get({
      spreadsheetId: activeSheetId,
      range: `${activeSheetName}!A1:H1`,
    });

    const existingHeader = res.data.values?.[0] || [];
    if (existingHeader.length === 0 || existingHeader[0] !== REG_HEADERS[0]) {
      await client().spreadsheets.values.update({
        spreadsheetId: activeSheetId,
        range: `${activeSheetName}!A1:H1`,
        valueInputOption: 'RAW',
        requestBody: { values: [REG_HEADERS] },
      });
      console.log(`[sheet] Initialized header row in '${activeSheetName}'.`);
    }
  } catch (err) {
    // If tab doesn't exist, create tab and initialize header
    if (err.message && (err.message.includes('Unable to parse range') || err.message.includes('not found'))) {
      try {
        await client().spreadsheets.batchUpdate({
          spreadsheetId: activeSheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: { title: activeSheetName },
                },
              },
            ],
          },
        });
      } catch (createErr) {
        // Ignore if already created concurrently
      }

      await client().spreadsheets.values.update({
        spreadsheetId: activeSheetId,
        range: `${activeSheetName}!A1:H1`,
        valueInputOption: 'RAW',
        requestBody: { values: [REG_HEADERS] },
      });
      console.log(`[sheet] Created tab '${activeSheetName}' and initialized header row.`);
    } else {
      throw err;
    }
  }
}

/**
 * Load all account rows from sheet
 */
async function loadRows() {
  await ensureHeaderRow();
  const res = await client().spreadsheets.values.get({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!A:H`,
  });

  const rawRows = res.data.values || [];
  if (rawRows.length <= 1) return [];

  return rawRows.slice(1).map((r, i) => ({
    rowIndex: i + 2, // 1-based index (header is row 1)
    email: (r[COL.email] || '').trim(),
    password: (r[COL.password] || '').trim(),
    firstName: (r[COL.firstName] || '').trim(),
    lastName: (r[COL.lastName] || '').trim(),
    status: (r[COL.status] || '').trim().toLowerCase(),
    apiKey: (r[COL.apiKey] || '').trim(),
    elevenPass: (r[COL.elevenPass] || '').trim(),
    createdAt: (r[COL.createdAt] || '').trim(),
  }));
}

/**
 * Load pending accounts
 */
async function loadPendingAccounts() {
  const all = await loadRows();
  return all.filter((row) => row.status === 'pending');
}

/**
 * Append generated accounts to sheet
 */
async function appendAccountsToSheet(accounts) {
  if (!accounts || accounts.length === 0) return 0;
  await ensureHeaderRow();

  const values = accounts.map((a) => [
    a.email,
    a.password,
    a.firstName,
    a.lastName,
    a.status || 'pending',
    a.apiKey || '',
    a.elevenPass || '',
    a.createdAt || new Date().toISOString(),
  ]);

  await client().spreadsheets.values.append({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!A:H`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return accounts.length;
}

/**
 * Update account status in sheet
 */
async function updateAccountStatus(rowIndex, status) {
  await client().spreadsheets.values.update({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!E${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[status]],
    },
  });
  console.log(`[sheet] Row ${rowIndex} → status: ${status}`);
}

/**
 * Update account success result (status, apiKey, elevenPass, createdAt)
 */
async function updateAccountResult(rowIndex, { apiKey, elevenPass, status = 'complete' } = {}) {
  const updates = [
    {
      range: `${activeSheetName}!E${rowIndex}:G${rowIndex}`,
      values: [[status, apiKey || '', elevenPass || '']],
    },
  ];

  await client().spreadsheets.values.batchUpdate({
    spreadsheetId: activeSheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
  console.log(`[sheet] Row ${rowIndex} → success result stored (API key: ${apiKey ? 'captured' : 'none'})`);
}

/**
 * Update result by email address
 */
async function updateResultByEmail(email, result = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  const rows = await loadRows();
  const match = rows.find((r) => r.email.toLowerCase() === normalized);
  if (!match) {
    throw new Error(`Cannot update sheet: no row found with email ${email}`);
  }
  await updateAccountResult(match.rowIndex, result);
  return match;
}

/**
 * Reset specific rows back to 'pending'
 */
async function resetRows(rowIndexes) {
  if (!rowIndexes || rowIndexes.length === 0) return;
  const updates = rowIndexes.map((rowIndex) => ({
    range: `${activeSheetName}!E${rowIndex}:G${rowIndex}`,
    values: [['pending', '', '']],
  }));

  await client().spreadsheets.values.batchUpdate({
    spreadsheetId: activeSheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
  console.log(`[sheet] Reset ${rowIndexes.length} rows to 'pending'.`);
}

module.exports = {
  REG_HEADERS,
  COL,
  initSignupSheets,
  ensureHeaderRow,
  loadRows,
  loadPendingAccounts,
  appendAccountsToSheet,
  updateAccountStatus,
  updateAccountResult,
  updateResultByEmail,
  resetRows,
};
