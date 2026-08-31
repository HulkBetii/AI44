const assert = require('assert');
const { missingTabMessage, parseArgs, safePageLocation } = require('../screenshot');

assert.deepStrictEqual(parseArgs(['--debug-address=127.0.0.1:9222']), {
  endpoint: 'http://127.0.0.1:9222',
  urlContains: '',
});
assert.deepStrictEqual(parseArgs([
  '--debug-address=localhost:9333',
  '--url-contains=elevenlabs.io',
]), {
  endpoint: 'http://localhost:9333',
  urlContains: 'elevenlabs.io',
});
assert.throws(() => parseArgs([]), /Missing --debug-address/);
assert.throws(() => parseArgs(['--debug-address=example.com:9222']), /localhost host:port/);
assert.throws(() => parseArgs(['--debug-address=127.0.0.1']), /localhost host:port/);
assert.throws(() => parseArgs(['--debug-address=127.0.0.1:9222\/path']), /localhost host:port/);
assert.throws(() => parseArgs(['--debug-address=127.0.0.1:9222', '--profile=1']), /Unknown option/);
assert.throws(
  () => parseArgs(['--debug-address=127.0.0.1:9222', '--debug-address=localhost:9333']),
  /Duplicate option: --debug-address/,
);
assert.throws(
  () => parseArgs([
    '--debug-address=127.0.0.1:9222',
    '--url-contains=first',
    '--url-contains=secret-token',
  ]),
  /Duplicate option: --url-contains/,
);
assert.strictEqual(
  safePageLocation('https://elevenlabs.io/app/action?token=opaque-secret#fragment'),
  'https://elevenlabs.io/app/action',
);
assert.strictEqual(missingTabMessage(true), 'No browser tab matched --url-contains');
assert.ok(!missingTabMessage(true).includes('opaque-secret'));

console.log('✓ screenshot helper accepts only localhost endpoints and never prints URL secrets');
