const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isEligibleForWorkflow } = require('../workflow-policy');

// The failure classification in signup-hotmail.js's run() loop. It has been wrong twice in
// this project's history, and both times the cost was real: a row wrongly marked 'inactive'
// drops out of 'pending' and looks like a dead mailbox to the operator.
//
// Lifted from the source rather than copied. This file used to hold a hand-written mirror of
// the expression, which is a standing invitation for the two to drift - the tests would keep
// passing while the shipped classifier changed underneath them.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const block = src.match(/const isNetworkError = [\s\S]*?`failed:\$\{currentStep\}`;/);
assert.ok(block, 'failure classification not found in signup-hotmail.js');

const build = new Function('err', 'currentStep', 'resume', 'resetPassword', 'regenerateKey',
  `${block[0]} return failStatus;`);

function classify({ err, code, currentStep, resume = false, resetPassword = false, regenerateKey = false }) {
  const error = new Error(err || '');
  if (code) error.code = code;
  return build(error, currentStep, resume, resetPassword, regenerateKey);
}

// The regression: a proxy that could not reach login.live.com produced ERR_CONNECTION_CLOSED
// during an "MS login" step, and the row was written off as 'inactive' even though the
// credentials were never submitted.
assert.strictEqual(classify({
  err: 'page.goto: net::ERR_CONNECTION_CLOSED at https://login.live.com/',
  currentStep: 'MS login — open login page',
}), 'failed:network');
console.log('✓ a transport failure during MS login is not called "inactive"');

for (const netErr of ['net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_TIMED_OUT']) {
  assert.strictEqual(classify({ err: `page.goto: ${netErr}`, currentStep: 'MS login — fill email' }), 'failed:network');
}
console.log('✓ proxy/DNS/timeout transport errors all classify as network, not inactive');

for (const netErr of ['read ECONNRESET', 'connect ECONNREFUSED', 'getaddrinfo ENOTFOUND', 'socket hang up', 'fetch failed']) {
  assert.strictEqual(classify({ err: netErr, currentStep: 'MS login — open login page' }), 'failed:network');
}
console.log('✓ Node and fetch transport errors classify as network');

// Only a typed Microsoft credential rejection is evidence that the mailbox is inactive.
assert.strictEqual(classify({
  err: 'Your account or password is incorrect',
  code: 'MS_BAD_CREDENTIALS',
  currentStep: 'MS login — submit password',
}), 'inactive');
console.log('✓ an explicit Microsoft bad-credential response is inactive');

assert.strictEqual(classify({
  err: 'MS login: neither the password choice nor the password field appeared',
  code: 'MS_UI_CHANGED',
  currentStep: 'MS login — switch to password',
}), 'failed:MS login — switch to password');
console.log('✓ an unknown Microsoft layout is not guessed to be inactive');

assert.strictEqual(classify({
  err: 'Microsoft requested manual account recovery',
  code: 'MS_RECOVERY_REQUIRED',
  currentStep: 'MS login — switch to password',
}), 'need to recover password');
console.log('✓ a Microsoft recovery challenge gets its manual status');

// A typed rejection remains authoritative in every workflow that signs into Hotmail.
for (const mode of ['resume', 'resetPassword', 'regenerateKey']) {
  assert.strictEqual(classify({
    err: 'Your account or password is incorrect',
    code: 'MS_BAD_CREDENTIALS',
    currentStep: 'MS login — fill password',
    [mode]: true,
  }), 'inactive', `${mode} must preserve a typed bad-credential classification`);
}
console.log('✓ typed bad credentials stay inactive across workflows');

// Failures outside MS login keep naming their step, which is what makes --resume able to
// tell a half-created account from one that never started.
assert.strictEqual(classify({
  err: 'API key not captured',
  currentStep: 'create API key',
}), 'failed:create API key');
console.log('✓ non-MS-login failures keep their step name');

// A refused address and an unsolved CAPTCHA both fail on the sign-up step but need opposite
// recoveries: the first means an ElevenLabs account already exists whose password was never
// recorded, reachable only through --reset-password. One shared 'failed:<step>' label would
// bury that, the same way network failures once hid behind 'inactive'.
const SIGNUP_STEP = 'wait for signup (CAPTCHA may need manual solve)';
assert.strictEqual(classify({
  err: 'ElevenLabs refused the address: This email is already in use',
  code: 'ALREADY_REGISTERED',
  currentStep: SIGNUP_STEP,
}), 'already-registered');
console.log('✓ a refused address gets its own status, not the sign-up step name');

assert.strictEqual(classify({
  err: `Signup timed out after 900s (still at https://elevenlabs.io/app/sign-up)`,
  currentStep: SIGNUP_STEP,
}), `failed:${SIGNUP_STEP}`);
console.log('✓ an unsolved CAPTCHA on the same step stays a plain retry');

// Classified on the tag, never on the wording - the message quotes whatever ElevenLabs said,
// which is outside this project's control.
assert.strictEqual(classify({
  err: 'ElevenLabs refused the address: some wording we never anticipated',
  code: 'ALREADY_REGISTERED',
  currentStep: SIGNUP_STEP,
}), 'already-registered');
assert.strictEqual(classify({
  err: 'this email is already in use',
  currentStep: SIGNUP_STEP,
}), `failed:${SIGNUP_STEP}`, 'the message text alone must not trigger the classification');
console.log('✓ classification follows the error tag, not the message text');

for (const status of ['credentials-rejected', 'already-registered']) {
  assert.strictEqual(isEligibleForWorkflow({ status, elevenPass: '', apiKey: '' }, 'resetPassword'), true);
}
assert.strictEqual(isEligibleForWorkflow({
  status: 'inactive', elevenPass: '', apiKey: '',
}, 'resetPassword'), false);
assert.strictEqual(isEligibleForWorkflow({
  status: 'complete', elevenPass: 'p', apiKey: 'sk_done',
}, 'resetPassword', { explicitReset: true }), true);
console.log('✓ --reset-password selects both recoverable statuses');

console.log('\nAll assertions passed.');
