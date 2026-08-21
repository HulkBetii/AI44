const assert = require('assert');
const { parseArgs, selectRows } = require('../reset-rows.js');

// reset-rows.js is the only way a burned row gets back into the queue, and it writes to the
// live sheet. It used to be all-or-nothing: every non-complete, non-pending row went back to
// 'pending' together. On the real sheet that meant rescuing row 30 ('failed:proxy_api' - the
// proxy API died before the account was touched, a clean retry) also re-queued four rows
// marked 'need to recover password', whose Hotmail logins are dead and will burn a CAPTCHA
// solve failing the same way every time.
//
// It also cleared column F on rows that already held an API key after only printing a
// warning. A live key cannot be recovered once overwritten.

// A miniature of the real sheet's shape: complete rows, queued rows, and the two very
// different kinds of failure that used to be indistinguishable to this tool.
const SHEET = [
  { rowIndex: 2,  email: 'done@x.com',    status: 'complete',                  apiKey: 'sk_aaa', elevenPass: 'p' },
  { rowIndex: 5,  email: 'badpass@x.com', status: 'credentials-rejected',      apiKey: '',       elevenPass: 'p' },
  { rowIndex: 6,  email: 'taken@x.com',   status: 'already-registered',        apiKey: '',       elevenPass: '' },
  { rowIndex: 19, email: 'dead1@x.com',   status: 'need to recover password',  apiKey: '',       elevenPass: '' },
  { rowIndex: 20, email: 'dead2@x.com',   status: 'need to recover password',  apiKey: '',       elevenPass: '' },
  { rowIndex: 25, email: 'signup@x.com',  status: 'failed:sign-up elevenlabs', apiKey: '',       elevenPass: '' },
  { rowIndex: 30, email: 'proxy@x.com',   status: 'failed:proxy_api',          apiKey: '',       elevenPass: '' },
  { rowIndex: 31, email: 'stranded@x.com', status: 'failed:sheet write',       apiKey: 'sk_bbb', elevenPass: 'p' },
  { rowIndex: 37, email: 'queued@x.com',  status: 'pending',                   apiKey: '',       elevenPass: '' },
];
const idx = (r) => r.rowIndex;

// ── parseArgs ────────────────────────────────────────────────────────────────

assert.deepStrictEqual(parseArgs([]), { apply: false, force: false, rows: null, statuses: null });
console.log('✓ no flags → dry run over everything stale');

assert.deepStrictEqual(parseArgs(['--rows=25,30']).rows, [25, 30]);
assert.deepStrictEqual(parseArgs(['--rows= 25 , 30 ']).rows, [25, 30]);
console.log('✓ --rows parsed, spaces tolerated');

for (const bad of ['--rows=1', '--rows=0', '--rows=', '--rows=2,abc', '--rows=2.5']) {
  assert.throws(() => parseArgs([bad]), /--rows must be/, `should reject ${bad}`);
}
console.log('✓ invalid --rows rejected (header row, zero, empty, non-numeric, fractional)');

assert.deepStrictEqual(parseArgs(['--status=failed:proxy_api']).statuses, ['failed:proxy_api']);
assert.deepStrictEqual(parseArgs(['--status=Failed:Proxy_API']).statuses, ['failed:proxy_api'],
  'statuses are compared lowercase, as loadRows stores them');
assert.deepStrictEqual(parseArgs(['--status=a,b']).statuses, ['a', 'b']);
console.log('✓ --status parsed, lowercased, comma-separated');

// `--status failed:x` with a space leaves the filter unset. Silently resetting every stale
// row is the worst possible response to a typo in this particular tool.
assert.throws(() => parseArgs(['--status', 'failed:x', '--apply']), /Unknown option/);
assert.throws(() => parseArgs(['--dry-run']), /Unknown option/);
console.log('✓ a mistyped flag is rejected instead of widening the reset');

assert.strictEqual(parseArgs(['--apply']).apply, true);
assert.strictEqual(parseArgs(['--force']).force, true);
console.log('✓ --apply and --force parsed');

// ── selectRows ───────────────────────────────────────────────────────────────

// Default behaviour: every stale row, minus any that would lose a key and minus those with a
// dedicated recovery.
{
  const { candidates, withheld } = selectRows(SHEET, {});
  assert.deepStrictEqual(candidates.map(idx), [19, 20, 25, 30]);
  assert.deepStrictEqual(withheld.map(idx), [31]);
  assert.ok(!candidates.some((r) => r.status === 'complete'), 'a complete row is never reset');
  assert.ok(!candidates.some((r) => r.status === 'pending'), 'an already-queued row is not touched');
  console.log('✓ default selects every stale row and withholds the one holding a key');
}

// Sweeping these back to 'pending' is wrong twice: it clears the password in column G, and it
// re-runs a sign-up ElevenLabs refuses because the account exists - so the row returns here
// next run. --reset-password is the route that actually works on them.
{
  const { candidates, deferred } = selectRows(SHEET, {});
  assert.deepStrictEqual(deferred.map(idx), [5, 6]);
  for (const n of [5, 6]) {
    assert.ok(!candidates.map(idx).includes(n), `row ${n} must not be swept back to pending`);
  }
  console.log('✓ statuses with their own recovery are left out of the blind sweep');
}

// Held back from the sweep, not made unreachable. Naming one by row used to work while naming
// it by status silently found nothing - the two routes have to agree.
{
  assert.deepStrictEqual(selectRows(SHEET, { rows: [6] }).candidates.map(idx), [6]);
  assert.deepStrictEqual(
    selectRows(SHEET, { statuses: ['already-registered'] }).candidates.map(idx), [6],
    '--status must reach a deferred row exactly as --rows does',
  );
  assert.deepStrictEqual(
    selectRows(SHEET, { statuses: ['credentials-rejected'] }).candidates.map(idx), [5]);
  console.log('✓ naming a deferred row reaches it, by row or by status alike');
}

// The case the filters were added for: rescue the clean retry without re-queueing the four
// dead logins alongside it.
{
  const { candidates } = selectRows(SHEET, { statuses: ['failed:proxy_api'] });
  assert.deepStrictEqual(candidates.map(idx), [30]);
  console.log('✓ --status isolates one kind of failure');
}
{
  const { candidates } = selectRows(SHEET, { rows: [25, 30] });
  assert.deepStrictEqual(candidates.map(idx), [25, 30]);
  console.log('✓ --rows resets exactly the rows named');
}
{
  const { candidates } = selectRows(SHEET, { rows: [25, 30], statuses: ['failed:proxy_api'] });
  assert.deepStrictEqual(candidates.map(idx), [30], 'both filters apply, not just the last one');
  console.log('✓ --rows and --status combine');
}

// Resetting clears columns F and G. On a complete row that destroys a working key, so naming
// one has to fail loudly rather than being quietly dropped from the selection.
assert.throws(
  () => selectRows(SHEET, { rows: [2] }),
  /already 'complete'/,
  'naming a complete row must be refused, not silently ignored',
);
console.log('✓ naming a complete row is refused');

// ...but --force is a real escape hatch, or the refusal just becomes a wall.
{
  const { candidates } = selectRows(SHEET, { rows: [2], force: true });
  assert.deepStrictEqual(candidates.map(idx), [2]);
  console.log('✓ --force overrides the complete-row refusal');
}

// Row 31 created its key and then failed writing the status. Clearing column F loses it for
// good, so the old advisory warning is now a withhold.
{
  const { candidates, withheld } = selectRows(SHEET, { rows: [31] });
  assert.deepStrictEqual(candidates.map(idx), []);
  assert.deepStrictEqual(withheld.map(idx), [31]);
  console.log('✓ a stale row holding an API key is withheld, not wiped');
}
{
  const { candidates, withheld } = selectRows(SHEET, { rows: [31], force: true });
  assert.deepStrictEqual(candidates.map(idx), [31]);
  assert.deepStrictEqual(withheld.map(idx), []);
  console.log('✓ --force overrides the API-key withhold');
}

// A row number that is not on the sheet is a mistake worth stopping for: the operator meant
// some row, and resetting the others while ignoring the typo is the wrong recovery.
assert.throws(() => selectRows(SHEET, { rows: [99] }), /No such row/);
console.log('✓ an unknown row number is rejected');

// A status that matches nothing reports what is actually present, so a typo is visible.
{
  const { candidates, reason, present } = selectRows(SHEET, { statuses: ['failed:proxy'] });
  assert.deepStrictEqual(candidates, []);
  assert.strictEqual(reason, 'no-match');
  assert.ok(present.includes('failed:proxy_api'),
    'the near-miss the operator meant must appear in the reported statuses');
  console.log('✓ an unmatched --status reports the statuses actually present');
}

// Nothing stale at all must not be an error.
{
  const clean = SHEET.filter((r) => r.status === 'complete' || r.status === 'pending');
  const { candidates, reason } = selectRows(clean, {});
  assert.deepStrictEqual(candidates, []);
  assert.strictEqual(reason, 'nothing');
  console.log('✓ a sheet with nothing stale is a no-op');
}

// selectRows decides; nothing here may mutate the caller's rows.
{
  const snapshot = JSON.stringify(SHEET);
  selectRows(SHEET, { rows: [25, 30], force: true });
  assert.strictEqual(JSON.stringify(SHEET), snapshot, 'selectRows must not mutate its input');
  console.log('✓ selectRows leaves the input untouched');
}

console.log('\nAll assertions passed.');
