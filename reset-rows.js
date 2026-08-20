// Returns rows burned by a failed run back to 'pending' so they can be retried.
// Dry run by default; pass --apply to actually write.
//
// Kept separate from signup-hotmail.js on purpose: resetting automatically on every startup
// would retry genuinely dead accounts forever.

const { initSheets, loadRows, resetRows } = require('./sheets');

const APPLY = process.argv.includes('--apply');

async function main() {
  await initSheets();
  const rows = await loadRows();

  // Anything that is not finished and not already queued is a candidate: 'inactive',
  // 'failed:<step>', or a blank status left behind by an interrupted run.
  const stale = rows.filter((r) => r.status !== 'complete' && r.status !== 'pending');

  console.log(`Total rows: ${rows.length}`);
  console.log(`  complete: ${rows.filter((r) => r.status === 'complete').length}`);
  console.log(`  pending:  ${rows.filter((r) => r.status === 'pending').length}`);
  console.log(`  to reset: ${stale.length}`);

  if (stale.length === 0) {
    console.log('\nNothing to reset.');
    return;
  }

  console.log('');
  for (const r of stale) {
    const hadKey = r.apiKey ? ' [HAS API KEY]' : '';
    console.log(`  row ${String(r.rowIndex).padStart(3)}  ${r.email.padEnd(34)} ${r.status}${hadKey}`);
  }

  // A non-complete row holding an API key means the key was created but the status write
  // failed. Resetting would clear the key, so surface it rather than destroying it.
  const withKeys = stale.filter((r) => r.apiKey);
  if (withKeys.length > 0) {
    console.log(`\n⚠️  ${withKeys.length} row(s) above already hold an API key.`);
    console.log('   Reset clears columns F and G. Save those keys first, or fix the status by hand.');
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to perform the reset.');
    return;
  }

  await resetRows(stale.map((r) => r.rowIndex));
  console.log(`\n✅ Reset ${stale.length} row(s) to 'pending'.`);
}

main().catch((err) => {
  console.error('❌ Failed:', err.stack || err.message);
  process.exitCode = 1;
});
