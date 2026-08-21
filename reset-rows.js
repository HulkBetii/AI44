// Returns rows burned by a failed run back to 'pending' so they can be retried.
// Dry run by default; pass --apply to actually write.
//
// Kept separate from signup-hotmail.js on purpose: resetting automatically on every startup
// would retry genuinely dead accounts forever.
//
//   node reset-rows.js                          # show every resettable row
//   node reset-rows.js --status=failed:proxy_api
//   node reset-rows.js --rows=25,30 --apply
//
// The filters exist because the sheet mixes two very different kinds of failure. A row that
// died at 'failed:proxy_api' never touched the account and is a clean retry; a row marked
// 'need to recover password' is a dead Hotmail login that will fail the same way forever.
// Without a way to name rows, rescuing the first meant re-queueing the second as well.

const { initSheets, loadRows, resetRows } = require('./sheets');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');

  let rows = null;
  const rowsArg = argv.find((a) => a.startsWith('--rows='));
  if (rowsArg) {
    const raw = rowsArg.slice('--rows='.length);
    rows = raw.split(',').map((n) => Number(n.trim()));
    if (raw.trim() === '' || rows.some((n) => !Number.isInteger(n) || n < 2)) {
      throw new Error(`--rows must be sheet rows >= 2 (row 1 is the header), got: ${raw}`);
    }
  }

  let statuses = null;
  const statusArg = argv.find((a) => a.startsWith('--status='));
  if (statusArg) {
    const raw = statusArg.slice('--status='.length);
    statuses = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (statuses.length === 0) throw new Error('--status needs at least one status value');
  }

  // A typo like `--status failed:x` (space instead of =) would otherwise be ignored, and the
  // run would silently reset every stale row instead of the one that was named.
  const unknown = argv.filter((a) => a.startsWith('--')
    && !['--apply', '--force'].includes(a)
    && !a.startsWith('--rows=') && !a.startsWith('--status='));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);

  return { apply, force, rows, statuses };
}

// Pure: decides what would be written, so the guards can be tested without a spreadsheet.
// Returns the rows to reset plus whatever was withheld and why, for main() to report.
function selectRows(all, { rows = null, statuses = null, force = false } = {}) {
  const stale = all.filter((r) => r.status !== 'complete' && r.status !== 'pending');
  const present = [...new Set(stale.map((r) => r.status || '(blank)'))].sort();

  let pool = stale;

  if (rows) {
    const missing = rows.filter((n) => !all.some((r) => r.rowIndex === n));
    if (missing.length) throw new Error(`No such row(s) in the sheet: ${missing.join(', ')}`);

    // Named rows are matched against every row, not just the stale ones, so that naming a
    // finished row is refused outright rather than quietly resolving to nothing.
    const named = all.filter((r) => rows.includes(r.rowIndex));
    const done = named.filter((r) => r.status === 'complete');
    if (done.length && !force) {
      throw new Error(
        `Row(s) ${done.map((r) => r.rowIndex).join(', ')} are already 'complete'. `
        + 'Resetting clears columns F and G, destroying the stored key and password. '
        + 'Pass --force if that is really what you want.',
      );
    }
    pool = named;
  }

  if (statuses) pool = pool.filter((r) => statuses.includes(r.status));

  if (pool.length === 0) {
    return { candidates: [], withheld: [], present, stale, reason: statuses ? 'no-match' : 'nothing' };
  }

  // A non-complete row holding an API key means the key was created but the status write
  // failed. Resetting clears column F, and a live key cannot be recovered once overwritten -
  // so this now withholds the row instead of warning and wiping it anyway.
  const withheld = force ? [] : pool.filter((r) => r.apiKey);
  const candidates = force ? pool : pool.filter((r) => !r.apiKey);

  return {
    candidates, withheld, present, stale,
    reason: candidates.length === 0 ? 'all-withheld' : null,
  };
}

async function main() {
  const { apply, force, rows, statuses } = parseArgs(process.argv.slice(2));

  await initSheets();
  const all = await loadRows();
  const { candidates, withheld, present, stale, reason } = selectRows(all, { rows, statuses, force });

  console.log(`Total rows: ${all.length}`);
  console.log(`  complete: ${all.filter((r) => r.status === 'complete').length}`);
  console.log(`  pending:  ${all.filter((r) => r.status === 'pending').length}`);
  console.log(`  stale:    ${stale.length}`);

  if (reason === 'no-match') {
    // Naming a status that matches nothing is almost always a typo, so show what is actually
    // there rather than reporting an empty result as success.
    console.log(`\nNothing matches ${statuses.map((s) => `'${s}'`).join(' or ')}${rows ? ` on row(s) ${rows.join(', ')}` : ''}.`);
    console.log(`Statuses actually present: ${present.length ? present.join(', ') : '(none)'}`);
    return;
  }

  if (withheld.length > 0) {
    console.log(`\n⚠️  ${withheld.length} row(s) already hold an API key: ${withheld.map((r) => r.rowIndex).join(', ')}`);
    console.log('   Reset clears columns F and G. Save those keys first, or re-run with --force.');
  }

  if (reason === 'all-withheld' || candidates.length === 0) {
    console.log('\nNothing to reset.');
    return;
  }

  console.log('');
  for (const r of candidates) {
    const hadKey = r.apiKey ? ' [HAS API KEY]' : '';
    console.log(`  row ${String(r.rowIndex).padStart(3)}  ${r.email.padEnd(34)} ${r.status || '(blank)'}${hadKey}`);
  }

  if (!apply) {
    console.log(`\nDry run — nothing written. Re-run with --apply to reset ${candidates.length} row(s).`);
    return;
  }

  await resetRows(candidates.map((r) => r.rowIndex));
  console.log(`\n✅ Reset ${candidates.length} row(s) to 'pending': ${candidates.map((r) => r.rowIndex).join(', ')}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Failed:', err.stack || err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, selectRows };
