/**
 * sheets.js (reg-hotmail)
 * Dedicated Google Sheet integration for Hotmail / Outlook registration workflow.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { loadRegConfig } = require('./config');

const REG_HEADERS = [
  'Email',
  'Password',
  'FirstName',
  'LastName',
  'DOB',
  'Country',
  'Status',
  'Phone',
  'SMS_OrderID',
  'Created_At',
];

const COL = {
  email: 0,
  password: 1,
  firstName: 2,
  lastName: 3,
  dob: 4,
  country: 5,
  status: 6,
  phone: 7,
  smsOrderId: 8,
  createdAt: 9,
};

let sheetsClient = null;
let activeSheetId = null;
let activeSheetName = null;

function loadCredentials(customPath) {
  const config = loadRegConfig();
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

async function initRegSheets(options = {}) {
  const config = loadRegConfig();
  activeSheetId = options.sheetId || config.regSheetId || config.sheetId;
  activeSheetName = options.sheetName || config.regSheetName || 'reg-hotmail';

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
    throw new Error('initRegSheets() must be called before interacting with Google Sheets.');
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
      range: `${activeSheetName}!A1:J1`,
    });

    const existingHeader = res.data.values?.[0] || [];
    if (existingHeader.length === 0 || existingHeader[0] !== REG_HEADERS[0]) {
      await client().spreadsheets.values.update({
        spreadsheetId: activeSheetId,
        range: `${activeSheetName}!A1:J1`,
        valueInputOption: 'RAW',
        requestBody: { values: [REG_HEADERS] },
      });
      console.log(`[sheet] Initialized header row in '${activeSheetName}'.`);
    }
  } catch (err) {
    // If tab doesn't exist, try creating the tab/sheet
    if (err.message && err.message.includes('Unable to parse range')) {
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
      await client().spreadsheets.values.update({
        spreadsheetId: activeSheetId,
        range: `${activeSheetName}!A1:J1`,
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
  const res = await client().spreadsheets.values.get({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!A:J`,
  });

  const rawRows = res.data.values || [];
  if (rawRows.length <= 1) return [];

  return rawRows.slice(1).map((r, i) => {
    const dobRaw = r[COL.dob] || '';
    const [year, month, day] = dobRaw.split('-').map(Number);
    return {
      rowIndex: i + 2, // 1-based index (header is row 1)
      email: (r[COL.email] || '').trim(),
      password: (r[COL.password] || '').trim(),
      firstName: (r[COL.firstName] || '').trim(),
      lastName: (r[COL.lastName] || '').trim(),
      dob: {
        formatted: dobRaw,
        year: year || 2000,
        month: month || 1,
        day: day || 1,
      },
      country: (r[COL.country] || 'GB').trim(),
      status: (r[COL.status] || '').trim().toLowerCase(),
      phone: (r[COL.phone] || '').trim(),
      smsOrderId: (r[COL.smsOrderId] || '').trim(),
      createdAt: (r[COL.createdAt] || '').trim(),
    };
  });
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
    a.dob?.formatted || (typeof a.dob === 'string' ? a.dob : ''),
    a.country || 'GB',
    a.status || 'pending',
    a.phone || '',
    a.smsOrderId || '',
    a.createdAt || new Date().toISOString(),
  ]);

  await client().spreadsheets.values.append({
    spreadsheetId: activeSheetId,
    range: `${activeSheetName}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return accounts.length;
}

/**
 * Update status and auxiliary fields for a row
 */
async function updateAccountStatus(rowIndex, status, extraFields = {}) {
  const updates = [
    {
      range: `${activeSheetName}!G${rowIndex}`,
      values: [[status]],
    },
  ];

  if (extraFields.phone) {
    updates.push({
      range: `${activeSheetName}!H${rowIndex}`,
      values: [[extraFields.phone]],
    });
  }

  if (extraFields.smsOrderId) {
    updates.push({
      range: `${activeSheetName}!I${rowIndex}`,
      values: [[String(extraFields.smsOrderId)]],
    });
  }

  if (extraFields.createdAt) {
    updates.push({
      range: `${activeSheetName}!J${rowIndex}`,
      values: [[extraFields.createdAt]],
    });
  }

  await client().spreadsheets.values.batchUpdate({
    spreadsheetId: activeSheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });

  console.log(`[sheet] Row ${rowIndex} (${status}) updated.`);
}

/**
 * Update account status by email
 */
async function updateAccountStatusByEmail(email, status, extraFields = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  const rows = await loadRows();
  const match = rows.find((r) => r.email.toLowerCase() === normalized);
  if (!match) {
    throw new Error(`Cannot update sheet: no row found with email ${email}`);
  }
  await updateAccountStatus(match.rowIndex, status, extraFields);
  return match;
}

/**
 * Reset specific rows back to 'pending'
 */
async function resetRows(rowIndexes) {
  if (!rowIndexes || rowIndexes.length === 0) return;
  const updates = rowIndexes.map((rowIndex) => ({
    range: `${activeSheetName}!G${rowIndex}:I${rowIndex}`,
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
  initRegSheets,
  ensureHeaderRow,
  loadRows,
  loadPendingAccounts,
  appendAccountsToSheet,
  updateAccountStatus,
  updateAccountStatusByEmail,
  resetRows,
};
