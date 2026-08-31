const { withAutomationLock } = require('./automation-lock');
const sheets = require('./sheets');
const { runFullCycle } = require('./automation-worker');
const { parseArgs: parseSignupArgs } = require('./signup-hotmail');
const { isEligibleForWorkflow } = require('./workflow-policy');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function parseBatchArgs(argv) {
  const parsed = parseSignupArgs(argv);
  if (parsed.resume || parsed.resetPassword || parsed.regenerateKey || parsed.auditWeakPasswords
    || parsed.rows || parsed.expectedEmail) {
    throw new Error('batch.js accepts only --row, --limit, --interval, and --no-proxy');
  }
  return {
    row: parsed.row,
    limit: parsed.limit,
    intervalMinutes: parsed.interval,
    noProxy: parsed.noProxy,
  };
}

function selectBatchAccounts(rows, { row, limit }) {
  const emailCounts = new Map();
  for (const account of rows) {
    const email = normalizeEmail(account.email);
    emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
  }

  const selected = rows
    .filter((account) => row === null || account.rowIndex === row)
    .filter((account) => isEligibleForWorkflow(account, 'fullCycle'));
  const limited = Number.isFinite(limit) ? selected.slice(0, limit) : selected;
  return limited.map((account) => {
    const email = normalizeEmail(account.email);
    if (!email || emailCounts.get(email) !== 1) {
      throw new Error(`Batch scope requires one unique Sheet row for ${account.email || '(blank email)'}`);
    }
    return { rowIndex: account.rowIndex, email: account.email };
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseBatchArgs(argv);
  await sheets.initSheets();
  const accounts = selectBatchAccounts(await sheets.loadRows(), options);
  if (accounts.length === 0) {
    throw new Error('Batch scope contains no full-cycle eligible accounts');
  }
  console.log(`Running full cycle for ${accounts.length} scoped account(s).`);
  await runFullCycle(accounts, {
    options: {
      intervalMinutes: options.intervalMinutes,
      noProxy: options.noProxy,
    },
  });
}

if (require.main === module) {
  withAutomationLock('batch-cli', () => main()).catch((error) => {
    console.error(`[batch] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseBatchArgs, selectBatchAccounts };
