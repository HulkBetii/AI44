const assert = require('assert');
const { FULL_CYCLE_PHASES, isEligibleForWorkflow } = require('../automation-worker');

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
assert.strictEqual(isEligibleForWorkflow(pending, 'resume'), false);
assert.strictEqual(isEligibleForWorkflow(resumable, 'resume'), true);
assert.strictEqual(isEligibleForWorkflow(rejected, 'resetPassword'), true);
assert.strictEqual(isEligibleForWorkflow(rejected, 'resume'), false);
assert.strictEqual(isEligibleForWorkflow(completed, 'signup'), false);
assert.strictEqual(isEligibleForWorkflow(completed, 'resume'), false);
assert.strictEqual(isEligibleForWorkflow(completed, 'resetPassword'), false);

console.log('✓ full-cycle phases re-evaluate workflow eligibility inside the original scope');
