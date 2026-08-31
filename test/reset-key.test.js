const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const reset = src.match(/async function resetPasswordAndCreateKey\(ctx, cred\) \{[\s\S]*?\n\}/)[0];

const preserveAt = reset.indexOf('if (cred.apiKey)');
const createAt = reset.lastIndexOf('await finishOnboardingAndKey(page, cred, newPassword)');
assert.ok(preserveAt >= 0 && createAt > preserveAt, 'existing-key branch must precede key creation');
assert.ok(reset.includes("await updatePasswordAndStatusByEmail(email, newPassword, 'complete')"));
assert.ok(reset.includes('return cred.apiKey;'));
assert.ok(src.includes('cred.apiKey = resetPassword ? existingApiKey : null;'));
assert.ok(src.includes('persistCapturedCredentials(cred, proxyString)'));
assert.ok(src.includes('if (cred.apiKeyMayBeVisible) {'));

const signInAt = reset.indexOf('const outcome = await attemptSignIn(page, email, newPassword)');
const confirmAt = reset.indexOf('confirmRecovery(recoveryEntry.id)');
assert.ok(signInAt >= 0 && confirmAt > signInAt,
  'a reset action redirect must not confirm the password before a successful sign-in');

const signup = src.match(/async function processAccount\(ctx, cred, proxyString = ''\) \{[\s\S]*?\n\}/)[0];
assert.ok(
  signup.indexOf('confirmRecovery(recoveryEntry.id)')
    > signup.indexOf('const verifyUrl = await pollOutlookInbox('),
  'signup must wait for fresh verification-email evidence before confirming recovery',
);
console.log('✓ reset preserves an existing API key and skips creating/exporting a replacement');
console.log('✓ failure capture is skipped after a new API key enters the page');
console.log('✓ error redirects cannot confirm signup/reset credentials without positive evidence');
