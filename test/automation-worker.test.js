const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const {
  FULL_CYCLE_PHASES,
  assertAccountProcessed,
  assertFullCycleProcessed,
  assertWorkflowEligible,
  findAccountByEmail,
  isEligibleForWorkflow,
  isExplicitResetRequest,
  runFullCycle,
  runRows,
  validateAcceptedAccounts,
  terminateChild,
} = require('../automation-worker');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'automation-worker.js'), 'utf8');
assert.ok(workerSource.includes("await sheets.updateStatusByEmail(current.email, 'pending')"));
assert.ok(workerSource.includes('if (error?.preserveAutomationLock) preserveLockOnCleanupFailure(releaseLock);'));
console.log('✓ retryPending mutates the uniquely resolved email identity, not a stale row index');

assert.deepStrictEqual(FULL_CYCLE_PHASES.map((phase) => phase.phaseId), [
  'signup',
  'resume-1',
  'reset-password',
  'resume-2',
]);

const pending = { status: 'pending', elevenPass: '', apiKey: '' };
const resumable = { status: 'failed:onboarding', elevenPass: 'Eleven1!', apiKey: '' };
const rejected = { status: 'already-registered', elevenPass: '', apiKey: '' };
const completed = { status: 'complete', elevenPass: 'Eleven1!', apiKey: 'sk_done' };

assert.strictEqual(isEligibleForWorkflow(pending, 'signup'), true);
assert.strictEqual(isEligibleForWorkflow(pending, 'retryPending'), true);
assert.strictEqual(isEligibleForWorkflow(pending, 'resume'), false);
assert.strictEqual(isEligibleForWorkflow(resumable, 'resume'), true);
assert.strictEqual(isEligibleForWorkflow(rejected, 'resetPassword'), true);
assert.strictEqual(isEligibleForWorkflow(rejected, 'resume'), false);
assert.strictEqual(isEligibleForWorkflow(completed, 'signup'), false);
assert.strictEqual(isEligibleForWorkflow(completed, 'resume'), false);
assert.strictEqual(isEligibleForWorkflow(completed, 'resetPassword'), false);

console.log('✓ full-cycle phases re-evaluate workflow eligibility inside the original scope');

assert.strictEqual(
  findAccountByEmail(
    [{ rowIndex: 8, email: 'moved@example.com' }],
    { rowIndex: 3, email: 'MOVED@example.com' },
  ).rowIndex,
  8,
);
assert.throws(
  () => findAccountByEmail([
    { rowIndex: 8, email: 'duplicate@example.com' },
    { rowIndex: 9, email: 'DUPLICATE@example.com' },
  ], { rowIndex: 3, email: 'duplicate@example.com' }),
  /found 2 matching Sheet rows/,
);
console.log('✓ worker follows stable email identity and rejects duplicates');

assert.throws(
  () => assertWorkflowEligible(
    { email: 'done@example.com', status: 'complete', elevenPass: 'p', apiKey: 'sk_done' },
    'retryPending',
  ),
  /no longer eligible/,
);
assert.doesNotThrow(() => assertWorkflowEligible(
  { email: 'done@example.com', status: 'complete', elevenPass: 'p', apiKey: 'sk_done' },
  'resetPassword',
  { explicitReset: true },
));
assert.throws(() => assertWorkflowEligible(
  { email: 'done@example.com', status: 'complete', elevenPass: 'p', apiKey: 'sk_done' },
  'resetPassword',
));
console.log('✓ worker revalidates state before retry mutation while explicit reset remains available');
assert.strictEqual(isExplicitResetRequest({ selection: { mode: 'allEligible' } }), false);
assert.strictEqual(isExplicitResetRequest({ selection: { mode: 'rows' } }), true);
assert.strictEqual(isExplicitResetRequest({ selection: { mode: 'identities' } }), true);
console.log('✓ only explicit reset selections can override account state');

assert.throws(() => validateAcceptedAccounts(undefined, 'signup'), /stable row and email identity/);
assert.throws(() => validateAcceptedAccounts([
  { rowIndex: 2, email: 'duplicate@example.com' },
  { rowIndex: 3, email: 'DUPLICATE@example.com' },
], 'signup'), /duplicate accepted account identity/);
assert.deepStrictEqual(validateAcceptedAccounts([], 'proxyCheck'), []);
console.log('✓ automation workflows require acceptedAccounts identity snapshots');

assert.throws(() => assertFullCycleProcessed(0), /without processing any account/);
assert.doesNotThrow(() => assertFullCycleProcessed(1));
assert.throws(() => assertAccountProcessed({ processedAccounts: 0 }, 'zero@example.com'), /without processing/);
console.log('✓ full-cycle cannot report success after every phase processes zero rows');

(async () => {
  const sheets = require('../sheets');
  const originalLoadRows = sheets.loadRows;
  let snapshots = 0;
  sheets.loadRows = async () => {
    snapshots++;
    return snapshots === 1
      ? [{ rowIndex: 2, email: 'race@example.com', status: 'pending', elevenPass: '', apiKey: '' }]
      : [{ rowIndex: 2, email: 'race@example.com', status: 'complete', elevenPass: 'p', apiKey: 'sk_done' }];
  };
  try {
    await assert.rejects(
      () => runFullCycle(
        [{ rowIndex: 2, email: 'race@example.com' }],
        { options: { intervalMinutes: 1 } },
      ),
      /without processing any account/,
    );
    assert.strictEqual(snapshots, 5, 'initial eligibility plus four phase snapshots expected');
  } finally {
    sheets.loadRows = originalLoadRows;
  }
  console.log('✓ full-cycle fails when eligibility disappears before every phase');

  snapshots = 0;
  sheets.loadRows = async () => {
    snapshots++;
    return snapshots === 1
      ? [{ rowIndex: 2, email: 'duplicate-race@example.com', status: 'pending', elevenPass: '', apiKey: '' }]
      : [
        { rowIndex: 2, email: 'duplicate-race@example.com', status: 'pending', elevenPass: '', apiKey: '' },
        { rowIndex: 7, email: 'DUPLICATE-RACE@example.com', status: 'pending', elevenPass: '', apiKey: '' },
      ];
  };
  try {
    await assert.rejects(
      () => runFullCycle(
        [{ rowIndex: 2, email: 'duplicate-race@example.com' }],
        { options: { intervalMinutes: 1 } },
      ),
      /found 2 matching Sheet rows/,
    );
  } finally {
    sheets.loadRows = originalLoadRows;
  }
  console.log('✓ full-cycle fails if a duplicate email appears inside the reserved scope');

  snapshots = 0;
  sheets.loadRows = async () => {
    snapshots++;
    const resettable = {
      rowIndex: 2,
      email: 'reset-race@example.com',
      status: 'credentials-rejected',
      elevenPass: '',
      apiKey: '',
    };
    return snapshots < 5 ? [resettable] : [{ ...resettable, status: 'inactive' }];
  };
  try {
    await assert.rejects(
      () => runFullCycle(
        [{ rowIndex: 2, email: 'reset-race@example.com' }],
        { options: { intervalMinutes: 1 } },
      ),
      /no longer eligible for resetPassword/,
    );
  } finally {
    sheets.loadRows = originalLoadRows;
  }
  console.log('✓ full-cycle reset cannot become an explicit override after phase selection');

  const signup = require('../signup-hotmail');
  const originalSignupRun = signup.run;
  sheets.loadRows = async () => [{
    rowIndex: 2,
    email: 'zero-work@example.com',
    status: 'pending',
    elevenPass: '',
    apiKey: '',
  }];
  signup.run = async () => ({ processedAccounts: 0 });
  try {
    await assert.rejects(
      () => runRows(
        [{ rowIndex: 2, email: 'zero-work@example.com' }],
        [],
        { options: { intervalMinutes: 1 } },
        { workflowId: 'signup' },
      ),
      /without processing zero-work@example.com/,
    );
  } finally {
    signup.run = originalSignupRun;
    sheets.loadRows = originalLoadRows;
  }
  console.log('✓ ordinary workflows fail when the CLI reports zero processed accounts');

  assert.strictEqual(isEligibleForWorkflow({
    status: 'pending', elevenPass: '', apiKey: '',
  }, 'retryPending'), true);
  console.log('✓ retryPending remains eligible after cancellation leaves the row pending');

  class FakeChild extends EventEmitter {
    constructor({ closeOnKill = true } = {}) {
      super();
      this.signals = [];
      this.closeOnKill = closeOnKill;
    }

    kill(signal = 'SIGTERM') {
      this.signals.push(signal);
      if (signal === 'SIGKILL' && this.closeOnKill) setTimeout(() => this.emit('close'), 5);
      return true;
    }
  }

  const child = new FakeChild();
  let settled = false;
  const terminating = terminateChild(child, { forceAfterMs: 10, failAfterMs: 100 })
    .then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual(settled, false, 'termination must not settle before close');
  await terminating;
  assert.deepStrictEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  console.log('✓ proxy cancellation escalates and waits for child close');

  const delayedClose = new FakeChild({ closeOnKill: false });
  let unresolvedReports = 0;
  settled = false;
  const delayedTermination = terminateChild(delayedClose, {
    forceAfterMs: 5,
    failAfterMs: 20,
    onUnresolved: () => { unresolvedReports++; },
  }).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.strictEqual(unresolvedReports, 1);
  assert.strictEqual(settled, false, 'worker must stay alive until the child actually closes');
  delayedClose.emit('close');
  await delayedTermination;
  assert.strictEqual(settled, true);
  console.log('✓ unresolved proxy cleanup reports once but keeps the worker alive until close');
})().catch((error) => {
  console.error('FAILED:', error.stack || error.message);
  process.exit(1);
});
