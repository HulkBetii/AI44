/**
 * email-generator.js
 * Generates realistic synthetic user data and catch-all email aliases for ElevenLabs registration.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateSecurePassword } = require('../password-generator');
const { loadCatchAllConfig } = require('./config');

const FIRST_NAMES = [
  'James', 'Oliver', 'William', 'Henry', 'Arthur', 'Thomas', 'George', 'Alexander', 'Daniel', 'Edward',
  'Samuel', 'Joseph', 'Benjamin', 'Lucas', 'Matthew', 'David', 'Ethan', 'Charles', 'Adam', 'Nathan',
  'Emma', 'Olivia', 'Amelia', 'Isla', 'Ava', 'Mia', 'Sophia', 'Grace', 'Charlotte', 'Lily',
  'Emily', 'Ella', 'Jessica', 'Sophie', 'Lucy', 'Chloe', 'Ruby', 'Alice', 'Hannah', 'Eleanor',
  'Liam', 'Noah', 'Elijah', 'Mason', 'Logan', 'Jackson', 'Aiden', 'Sebastian', 'Owen', 'Caleb',
  'Harper', 'Evelyn', 'Abigail', 'Elizabeth', 'Avery', 'Sofia', 'Madison', 'Scarlett', 'Victoria', 'Zoe'
];

const LAST_NAMES = [
  'Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Robinson', 'Wright',
  'Thompson', 'Evans', 'Walker', 'White', 'Roberts', 'Green', 'Hall', 'Thomas', 'Clarke', 'Jackson',
  'Wood', 'Harris', 'Edwards', 'Turner', 'Cooper', 'Hill', 'Ward', 'Hughes', 'Moore', 'King',
  'Baker', 'Harrison', 'Morgan', 'Patel', 'Young', 'Allen', 'Anderson', 'Phillips', 'Lee', 'Bell',
  'Parker', 'Davis', 'Miller', 'Watson', 'Bennett', 'Cox', 'Richardson', 'Marshall', 'Price', 'Carter'
];

function getRandomElement(array) {
  return array[crypto.randomInt(array.length)];
}

function randomIntBetween(min, max) {
  return crypto.randomInt(min, max + 1);
}

/**
 * Generate a single account identity with a catch-all email alias
 */
function generateSingleAccount(options = {}) {
  const config = loadCatchAllConfig();
  const domain = options.domain || config.catchAllDomain || 'mrhulkstore.store';

  const firstName = options.firstName || getRandomElement(FIRST_NAMES);
  const lastName = options.lastName || getRandomElement(LAST_NAMES);

  // Email format: firstname + lastname + 3-5 random digits @ domain
  const suffixDigits = randomIntBetween(100, 99999);
  const cleanFirst = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const cleanLast = lastName.toLowerCase().replace(/[^a-z]/g, '');
  const email = `${cleanFirst}${cleanLast}${suffixDigits}@${domain}`;

  const password = options.password || generateSecurePassword();

  return {
    email,
    password,
    firstName,
    lastName,
    status: 'pending',
    apiKey: '',
    elevenPass: '',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate a batch of synthetic accounts (guaranteed unique emails)
 */
function generateBatch(count = 10, options = {}) {
  const accounts = [];
  const generatedEmails = new Set();

  while (accounts.length < count) {
    const acc = generateSingleAccount(options);
    if (!generatedEmails.has(acc.email)) {
      generatedEmails.add(acc.email);
      accounts.push(acc);
    }
  }
  return accounts;
}

/**
 * Convert accounts array to CSV format
 */
function toCsvString(accounts) {
  const header = ['Email', 'Password', 'FirstName', 'LastName', 'Status', 'APIKey', 'ElevenPass', 'Created_At'];
  const rows = accounts.map((a) => [
    a.email,
    a.password,
    a.firstName,
    a.lastName,
    a.status || 'pending',
    a.apiKey || '',
    a.elevenPass || '',
    a.createdAt || '',
  ]);
  return [header.join(','), ...rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
}

// CLI handler if executed directly
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let count = 10;
    let domain = null;
    let exportJsonPath = null;
    let exportCsvPath = null;
    let pushToSheet = false;

    for (const arg of args) {
      if (arg.startsWith('--count=')) count = parseInt(arg.split('=')[1], 10) || 10;
      if (arg.startsWith('--domain=')) domain = arg.split('=')[1].trim();
      if (arg.startsWith('--export-json=')) exportJsonPath = arg.split('=')[1].trim();
      if (arg.startsWith('--export-csv=')) exportCsvPath = arg.split('=')[1].trim();
      if (arg === '--to-sheet') pushToSheet = true;
    }

    const config = loadCatchAllConfig();
    const activeDomain = domain || config.catchAllDomain || 'mrhulkstore.store';
    console.log(`[email-generator] Generating ${count} catch-all accounts (@${activeDomain})...`);
    const accounts = generateBatch(count, { domain: activeDomain });

    if (exportJsonPath) {
      const fullPath = path.resolve(exportJsonPath);
      fs.writeFileSync(fullPath, JSON.stringify(accounts, null, 2), 'utf8');
      console.log(`[email-generator] Exported ${accounts.length} accounts to JSON: ${fullPath}`);
    }

    if (exportCsvPath) {
      const fullPath = path.resolve(exportCsvPath);
      fs.writeFileSync(fullPath, toCsvString(accounts), 'utf8');
      console.log(`[email-generator] Exported ${accounts.length} accounts to CSV: ${fullPath}`);
    }

    if (pushToSheet) {
      const { initSignupSheets, appendAccountsToSheet } = require('./sheets');
      await initSignupSheets();
      const appended = await appendAccountsToSheet(accounts);
      console.log(`[email-generator] Appended ${appended} accounts to Google Sheet (tab '${config.regSheetName}').`);
    }

    if (!exportJsonPath && !exportCsvPath && !pushToSheet) {
      console.log(JSON.stringify(accounts.slice(0, 3), null, 2));
      if (accounts.length > 3) {
        console.log(`... and ${accounts.length - 3} more accounts.`);
      }
    }
  })().catch((err) => {
    console.error('[email-generator] Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  FIRST_NAMES,
  LAST_NAMES,
  generateSingleAccount,
  generateBatch,
  toCsvString,
};
