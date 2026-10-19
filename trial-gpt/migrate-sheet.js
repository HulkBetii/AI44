/**
 * migrate-sheet.js
 * Copy accounts từ sheet 'hotmail' (row 152+) sang sheet 'trial-gpt' mới
 * với các trường tracking phù hợp cho dự án Trial GPT Plus Automation.
 *
 * Usage: node trial-gpt/migrate-sheet.js [--start-row=152] [--limit=500]
 */

const { initSheets } = require('./sheets');
const { google } = require('googleapis');
const { loadTrialConfig } = require('./config');
const fs = require('fs');
const path = require('path');

const TARGET_TAB = 'trial-gpt';
const TARGET_HEADERS = [
  'Row_Source',       // Row gốc trong sheet hotmail
  'Email',            // Hotmail email
  'Password',         // Password
  'Status',           // pending | processing | success | error | skipped
  'Trial_Detected',   // YES | NO | UNKNOWN
  'MoMo_Link',        // URL thanh toán MoMo (nếu có)
  'Plan_Name',        // Tên gói: Free | Plus Trial | Plus | Pro
  'Account_Age',      // Ngày tạo tài khoản (nếu detect được)
  'OTP_Method',       // otp | link | none
  'Retry_Count',      // Số lần retry
  'Error_Detail',     // Chi tiết lỗi
  'Worker_ID',        // Worker nào xử lý
  'Started_At',       // Thời điểm bắt đầu xử lý
  'Updated_At',       // Thời điểm cập nhật cuối
];

async function main() {
  const args = process.argv.slice(2);
  const startRow = parseInt(args.find(a => a.startsWith('--start-row='))?.split('=')[1] || '152', 10);
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999', 10);

  const config = loadTrialConfig();
  const sheetsClient = await initSheets();
  const spreadsheetId = config.sheetId;

  // 1. Read all accounts from hotmail sheet
  console.log(`[migrate] Reading accounts from 'hotmail' starting at row ${startRow}...`);
  const sourceRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `hotmail!A${startRow}:B`,
  });

  const sourceRows = sourceRes.data.values || [];
  if (sourceRows.length === 0) {
    console.log('[migrate] No accounts found in source sheet.');
    return;
  }

  const accounts = [];
  for (let i = 0; i < Math.min(sourceRows.length, limit); i++) {
    const email = (sourceRows[i][0] || '').trim();
    const password = (sourceRows[i][1] || '').trim();
    if (!email) continue;
    accounts.push({ rowIndex: startRow + i, email, password });
  }

  console.log(`[migrate] Found ${accounts.length} account(s) to migrate.`);

  // 2. Create or clear the target tab
  try {
    // Check if tab exists
    await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${TARGET_TAB}!A1:A1`,
    });
    // Tab exists - check existing data
    const existingRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${TARGET_TAB}!A:A`,
    });
    const existingCount = (existingRes.data.values || []).length - 1; // minus header
    if (existingCount > 0) {
      console.log(`[migrate] Target tab '${TARGET_TAB}' already has ${existingCount} row(s). Clearing data...`);
      await sheetsClient.spreadsheets.values.clear({
        spreadsheetId,
        range: `${TARGET_TAB}!A2:N`,
      });
    }
  } catch (err) {
    if (err.message && (err.message.includes('Unable to parse range') || err.message.includes('not found'))) {
      console.log(`[migrate] Creating new tab '${TARGET_TAB}'...`);
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: TARGET_TAB } } }],
        },
      });
    } else {
      throw err;
    }
  }

  // 3. Write headers
  console.log(`[migrate] Writing ${TARGET_HEADERS.length} column headers...`);
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${TARGET_TAB}!A1:N1`,
    valueInputOption: 'RAW',
    requestBody: { values: [TARGET_HEADERS] },
  });

  // 4. Write account rows with default values
  const dataRows = accounts.map(acc => [
    acc.rowIndex,       // Row_Source
    acc.email,          // Email
    acc.password,       // Password
    'pending',          // Status
    '',                 // Trial_Detected
    '',                 // MoMo_Link
    '',                 // Plan_Name
    '',                 // Account_Age
    '',                 // OTP_Method
    0,                  // Retry_Count
    '',                 // Error_Detail
    '',                 // Worker_ID
    '',                 // Started_At
    '',                 // Updated_At
  ]);

  // Write in batches of 100 to avoid API limits
  const BATCH_SIZE = 100;
  let written = 0;

  for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
    const batch = dataRows.slice(i, i + BATCH_SIZE);
    const startCell = i + 2; // row 2 (after header)
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${TARGET_TAB}!A${startCell}:N${startCell + batch.length - 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: batch },
    });
    written += batch.length;
    console.log(`[migrate] Written ${written}/${accounts.length} rows...`);
  }

  console.log(`\n✅ Migration complete!`);
  console.log(`   Tab: '${TARGET_TAB}'`);
  console.log(`   Headers: ${TARGET_HEADERS.length} columns`);
  console.log(`   Accounts: ${accounts.length} rows`);
  console.log(`   Source range: hotmail!A${startRow}:B${startRow + sourceRows.length - 1}`);
}

main().catch(err => {
  console.error('[migrate] Fatal error:', err.message);
  process.exit(1);
});
