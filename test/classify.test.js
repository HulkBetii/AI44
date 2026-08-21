const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

// A genuine credential failure during MS login must still be flagged as inactive - that
// classification is the whole point of distinguishing dead mailboxes from other failures.
assert.strictEqual(classify({
  err: 'MS login: neither the passkey link nor the password field appeared',
  currentStep: 'MS login — switch to password',
}), 'inactive');
console.log('✓ a real MS login failure is still classified as inactive');

// Recovery modes never touch Microsoft, so nothing they hit can mean "dead mailbox".
for (const mode of ['resume', 'resetPassword', 'regenerateKey']) {
  assert.strictEqual(classify({
    err: 'something broke',
    currentStep: 'MS login — fill password',
    [mode]: true,
  }), 'failed:MS login — fill password', `${mode} must not produce 'inactive'`);
}
console.log('✓ resume / reset-password / regenerate-key never produce "inactive"');

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

// --reset-password is the only mode that can reach these rows, so the status it selects on
// has to include the new one. If this drifts, every refused address strands silently.
const resettable = src.match(/const RESETTABLE = \[([^\]]*)\]/);
assert.ok(resettable, 'RESETTABLE list not found in signup-hotmail.js');
for (const status of ['credentials-rejected', 'already-registered']) {
  assert.ok(resettable[1].includes(`'${status}'`), `--reset-password must select '${status}'`);
}
console.log('✓ --reset-password selects both recoverable statuses');

console.log('\nAll assertions passed.');
