const fs = require('fs');
const path = require('path');
const { initSheets, loadRows, appendRows, SHEET_ID, SHEET_NAME } = require('./sheets');

async function importAccounts(filePath = 'C:\\Users\\HulkBeoti\\Documents\\hotmail2.txt') {
  console.log(`[import] Reading file: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  console.log(`[import] Total non-empty lines found: ${lines.length}`);

  await initSheets();
  const existingRows = await loadRows();
  const existingEmails = new Set(existingRows.map((r) => r.email.toLowerCase().trim()));
  console.log(`[import] Existing accounts in sheet (${SHEET_NAME}): ${existingEmails.size}`);

  const rowsToAppend = [];
  let skippedDuplicates = 0;

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 2) continue;

    const email = (parts[0] || '').trim();
    const password = (parts[1] || '').trim();
    const msaToken = (parts[2] || '').trim();
    const tenantGuid = (parts[3] || '').trim();
    const recoveryEmail = (parts[4] || '').trim();
    const elevenLabsApiKey = '';
    const elevenLabsPassword = '';
    const status = 'pending';
    const proxyToken = '';

    if (!email) continue;

    if (existingEmails.has(email.toLowerCase())) {
      skippedDuplicates++;
      continue;
    }

    rowsToAppend.push([
      email,
      password,
      msaToken,
      tenantGuid,
      recoveryEmail,
      elevenLabsApiKey,
      elevenLabsPassword,
      status,
      proxyToken,
    ]);
  }

  console.log(`[import] Skipped duplicates: ${skippedDuplicates}`);
  console.log(`[import] New accounts to append: ${rowsToAppend.length}`);

  if (rowsToAppend.length > 0) {
    await appendRows(rowsToAppend);
    console.log(`[import] Successfully appended ${rowsToAppend.length} accounts to Google Sheet (${SHEET_NAME})!`);
  } else {
    console.log('[import] No new accounts to append.');
  }

  const updatedRows = await loadRows();
  console.log(`[import] Total rows now in sheet: ${updatedRows.length}`);
}

if (require.main === module) {
  const targetFile = process.argv[2] || 'C:\\Users\\HulkBeoti\\Documents\\hotmail2.txt';
  importAccounts(targetFile).catch((err) => {
    console.error('[import] Error:', err);
    process.exit(1);
  });
}

module.exports = { importAccounts };
