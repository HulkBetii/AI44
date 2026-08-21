const assert = require('assert');

// Mirror of the failure classification in signup-hotmail.js's run() loop. It has been wrong
// twice in this project's history, and both times the cost was real: a row wrongly marked
// 'inactive' drops out of 'pending' and looks like a dead mailbox to the operator.
function classify({ err, currentStep, resume = false, resetPassword = false, regenerateKey = false }) {
  const isNetworkError = /net::ERR_/.test(err || '');
  const isInactive = !resume && !resetPassword && !regenerateKey
    && currentStep.startsWith('MS login') && !isNetworkError;
  return isNetworkError ? 'failed:network' : isInactive ? 'inactive' : `failed:${currentStep}`;
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

console.log('\nAll assertions passed.');
