/**
 * sheets.js (trial-gpt)
 * Google Sheets integration for reading Hotmail accounts and tracking Trial GPT results.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { loadTrialConfig } = require('./config');

const TARGET_HEADERS = [
  'Row_Source',
  'Email',
  'Password',
  'Status',
  'Trial_Detected',
  'MoMo_Link',
  'Plan_Name',
  'Account_Age',
  'OTP_Method',
  'Retry_Count',
  'Error_Detail',
  'Worker_ID',
  'Started_At',
  'Updated_At',
];

let sheetsClient = null;
let activeSpreadsheetId = null;

function loadCredentials(customPath) {
  const config = loadTrialConfig();
  const credentialsPath = customPath
    ? path.resolve(customPath)
    : config.serviceAccountPath;

  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Google service account credentials could not be read at ${credentialsPath}: ${err.message}`
    );
  }
}

async function initSheets(options = {}) {
  const config = loadTrialConfig();
  activeSpreadsheetId = options.sheetId || config.sheetId;

  if (!activeSpreadsheetId) {
    throw new Error('Google Spreadsheet ID is missing in config.');
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
    throw new Error('initSheets() must be called before interacting with Google Sheets.');
  }
  return sheetsClient;
}

/**
 * Ensure the target result tab (trial-gpt) exists with headers
 */
async function ensureTargetTab(tabName) {
  const config = loadTrialConfig();
  const targetTab = tabName || config.targetSheetName || 'trial-gpt';

  try {
    const res = await client().spreadsheets.values.get({
      spreadsheetId: activeSpreadsheetId,
      range: `${targetTab}!A1:N1`,
    });

    const existing = res.data.values?.[0] || [];
    if (existing.length === 0 || existing[0] !== TARGET_HEADERS[0]) {
      await client().spreadsheets.values.update({
        spreadsheetId: activeSpreadsheetId,
        range: `${targetTab}!A1:N1`,
        valueInputOption: 'RAW',
        requestBody: { values: [TARGET_HEADERS] },
      });
      console.log(`[sheet] Initialized header in tab '${targetTab}'.`);
    }
  } catch (err) {
    if (err.message && (err.message.includes('Unable to parse range') || err.message.includes('not found'))) {
      try {
        await client().spreadsheets.batchUpdate({
          spreadsheetId: activeSpreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: { title: targetTab },
                },
              },
            ],
          },
        });
      } catch {}

      await client().spreadsheets.values.update({
        spreadsheetId: activeSpreadsheetId,
        range: `${targetTab}!A1:N1`,
        valueInputOption: 'RAW',
        requestBody: { values: [TARGET_HEADERS] },
      });
      console.log(`[sheet] Created target tab '${targetTab}' and set headers.`);
    } else {
      throw err;
    }
  }
}

/**
 * Load accounts from source sheet ('hotmail') starting from startRow (1-based index)
 */
async function loadSourceAccounts({ startRow, limit = Infinity, sourceTab } = {}) {
  const config = loadTrialConfig();
  const source = sourceTab || config.sourceSheetName || 'hotmail';
  const fromRow = startRow || config.startRow || 152;

  const res = await client().spreadsheets.values.get({
    spreadsheetId: activeSpreadsheetId,
    range: `${source}!A${fromRow}:B`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  // Fetch existing statuses from target tab to skip finished or wrong_password accounts
  const existingStatuses = new Map();
  try {
    const targetRes = await client().spreadsheets.values.get({
      spreadsheetId: activeSpreadsheetId,
      range: `${config.targetSheetName || 'trial-gpt'}!B2:D`,
    });
    const targetRows = targetRes.data.values || [];
    for (const r of targetRows) {
      const targetEmail = (r[0] || '').trim().toLowerCase();
      const targetStatus = (r[2] || '').trim().toLowerCase();
      if (targetEmail && targetStatus) {
        existingStatuses.set(targetEmail, targetStatus);
      }
    }
  } catch {}

  const accounts = [];
  for (let i = 0; i < rows.length; i++) {
    if (accounts.length >= limit) break;

    const row = rows[i];
    const email = (row[0] || '').trim();
    const password = (row[1] || '').trim();

    if (!email) continue;

    // Check if previously marked as wrong_password, trial_found, or no_trial
    const existingStatus = existingStatuses.get(email.toLowerCase());
    if (existingStatus === 'wrong_password') {
      console.log(`[sheet] ⏭️ Skipping ${email} (already marked wrong_password)`);
      continue;
    }
    if (existingStatus === 'trial_found' || existingStatus === 'no_trial') {
      console.log(`[sheet] ⏭️ Skipping ${email} (already processed: ${existingStatus})`);
      continue;
    }

    accounts.push({
      rowIndex: fromRow + i,
      email,
      password,
    });
  }

  return accounts;
}

/**
 * Append or update account result in the target tab ('trial-gpt')
 */
async function recordTrialResult({
  sourceRowIndex,
  email,
  password,
  status,
  trialDetected,
  momoLink = '',
  planName = '',
  accountAge = '',
  otpMethod = '',
  retryCount = 0,
  errorDetail = '',
  workerId = '',
  startedAt = '',
  targetTab,
}) {
  const config = loadTrialConfig();
  const target = targetTab || config.targetSheetName || 'trial-gpt';
  await ensureTargetTab(target);

  const timestamp = new Date().toISOString();
  const values = [
    [
      sourceRowIndex,
      email,
      password,
      status,
      trialDetected ? 'YES' : (trialDetected === false ? 'NO' : 'UNKNOWN'),
      momoLink,
      planName,
      accountAge,
      otpMethod,
      retryCount,
      errorDetail,
      workerId,
      startedAt || timestamp,
      timestamp,
    ],
  ];

  await client().spreadsheets.values.append({
    spreadsheetId: activeSpreadsheetId,
    range: `${target}!A:N`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  console.log(`[sheet] Recorded result for ${email} (Row ${sourceRowIndex}) -> Status: ${status}, Trial: ${trialDetected ? 'YES' : 'NO'}`);
}

module.exports = {
  TARGET_HEADERS,
  initSheets,
  ensureTargetTab,
  loadSourceAccounts,
  recordTrialResult,
};
