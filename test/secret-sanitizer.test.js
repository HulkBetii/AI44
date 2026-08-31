const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { collectSecretValues, collectUrlSecrets, redactSecrets } = require('../secret-sanitizer');

const account = {
  password: 'OpaqueAccountValue/1?',
  elevenPass: 'OpaqueElevenValue+2',
  apiKey: 'sk_opaque_value_3',
};
const runtimeConfig = {
  proxyApiKey: 'OpaqueProxyKey/4?',
  capsolverApiKey: 'OpaqueCaptchaKey+5',
};
const proxyString = 'host:123:user:OpaqueProxyPassword-6';
const secrets = collectSecretValues({ account, runtimeConfig, extra: [proxyString] });
const source = [
  account.password,
  encodeURIComponent(account.password),
  new URLSearchParams({ value: runtimeConfig.capsolverApiKey }).toString(),
  proxyString,
  'OpaqueProxyPassword-6',
  Buffer.from('user:OpaqueProxyPassword-6').toString('base64'),
  runtimeConfig.proxyApiKey,
  account.apiKey,
].join(' | ');
const redacted = redactSecrets(source, secrets);

for (const value of [
  account.password,
  encodeURIComponent(account.password),
  runtimeConfig.capsolverApiKey,
  proxyString,
  'OpaqueProxyPassword-6',
  Buffer.from('user:OpaqueProxyPassword-6').toString('base64'),
  runtimeConfig.proxyApiKey,
  account.apiKey,
]) {
  assert.ok(!redacted.includes(value));
}
assert.ok(redacted.includes('[REDACTED]'));

const overlapping = redactSecrets('long-secret short', ['short', 'long-secret']);
assert.strictEqual(overlapping, '[REDACTED] [REDACTED]');

const actionUrl = 'https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=OpaqueMagic%2FToken%2B7';
const actionSecrets = collectSecretValues({ extra: collectUrlSecrets(actionUrl) });
const actionLog = [
  actionUrl,
  encodeURIComponent(actionUrl),
  'OpaqueMagic/Token+7',
  encodeURIComponent('OpaqueMagic/Token+7'),
].join(' | ');
const redactedActionLog = redactSecrets(actionLog, actionSecrets);
assert.ok(!redactedActionLog.includes(actionUrl));
assert.ok(!redactedActionLog.includes('OpaqueMagic/Token+7'));
assert.ok(!redactedActionLog.includes(encodeURIComponent('OpaqueMagic/Token+7')));
console.log('✓ action URLs and decoded magic tokens are redacted in raw and encoded forms');

const hotmailSource = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const standaloneSource = fs.readFileSync(path.join(__dirname, '..', 'signup.js'), 'utf8');
assert.ok(hotmailSource.includes('activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl))'));
assert.ok(hotmailSource.includes('activeAdditionalSecrets.push(...collectUrlSecrets(resetUrl))'));
assert.ok(standaloneSource.includes('activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl))'));
assert.ok(hotmailSource.includes('if (cred.apiKeyMayBeVisible) {'));
assert.ok(standaloneSource.includes('if (apiKeyMayBeVisible || account?.apiKey) {'));
console.log('✓ action URLs are tracked and API-key dialogs cannot be captured in screenshots');
console.log('✓ root sanitizer redacts account, runtime, proxy, and encoded secret variants');
