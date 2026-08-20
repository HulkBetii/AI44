const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Regression guard for the bug that broke --regenerate-key: Promise.race settles on the
// first promise to *settle*, and a rejection settles too. With every branch wrapped in
// .catch(() => null), a branch that failed fast beat a slower success and the caller saw
// "no recognised outcome" even though sign-in had worked.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const firstOutcome = new Function(
  `return ${src.match(/function firstOutcome\(candidates, timeoutMs\) \{[\s\S]*?\n\}/)[0]}`)();

const after = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));
const failAfter = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), ms));

(async () => {
  // The exact shape of the bug: two branches reject almost immediately, one succeeds later.
  const got = await firstOutcome([
    { value: 'ok', promise: after(300, 'nav') },
    { value: 'unverified', promise: failAfter(5) },
    { value: 'rejected', promise: failAfter(5) },
  ], 5000);
  assert.strictEqual(got, 'ok', 'a fast rejection must not beat a slower success');
  console.log('✓ fast rejections lose to a slower success');

  // Whichever positive outcome lands first still wins.
  assert.strictEqual(await firstOutcome([
    { value: 'ok', promise: after(400, 1) },
    { value: 'rejected', promise: after(50, 1) },
  ], 5000), 'rejected');
  console.log('✓ the first positive outcome wins');

  // All branches failing must fall through to the timeout, not hang.
  const started = Date.now();
  assert.strictEqual(await firstOutcome([
    { value: 'ok', promise: failAfter(5) },
    { value: 'unverified', promise: failAfter(5) },
  ], 300), null);
  const waited = Date.now() - started;
  assert.ok(waited >= 250 && waited < 2000, `expected ~300ms, waited ${waited}ms`);
  console.log(`✓ all-failing branches fall through to the timeout (${waited}ms)`);

  assert.strictEqual(await firstOutcome([], 200), null);
  console.log('✓ no candidates resolves null at the timeout');

  // The timeout timer must be cleared, or a resolved race would hold the event loop open.
  const t0 = Date.now();
  await firstOutcome([{ value: 'ok', promise: after(10, 1) }], 60000);
  console.log(`✓ resolving early does not wait out the timeout (${Date.now() - t0}ms)`);

  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
