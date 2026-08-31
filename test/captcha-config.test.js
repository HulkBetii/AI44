const assert = require('assert');
const fs = require('fs');
const path = require('path');

const previousNoneCap = process.env.NONECAP_API_KEY;
const previousCapSolver = process.env.CAPSOLVER_API_KEY;
process.env.NONECAP_API_KEY = 'nonecap-from-env';
process.env.CAPSOLVER_API_KEY = 'capsolver-from-env';

(async () => {
try {
  const { apiPost, loadConfig } = require('../captcha-solver');
  const config = loadConfig();
  assert.strictEqual(config.nonecapApiKey, 'nonecap-from-env');
  assert.strictEqual(config.capsolverApiKey, 'capsolver-from-env');

  const src = fs.readFileSync(path.join(__dirname, '..', 'captcha-solver.js'), 'utf8');
  assert.ok(src.includes("const { loadRuntimeConfig } = require('./runtime-config');"));
  assert.ok(src.includes('const SOLVER_DEADLINE_MS = 180000;'));
  assert.ok(src.includes('remainingTime(deadline)'));
  assert.ok(!src.includes("fs.readFileSync(configPath"));
  assert.ok(!src.includes('rqdata.substring'));
  assert.ok(!src.includes('outerHTML).substring'));

  const inspectSrc = fs.readFileSync(path.join(__dirname, '..', 'inspect2.js'), 'utf8');
  assert.ok(!inspectSrc.includes('parentElement.outerHTML'));
  assert.ok(!inspectSrc.includes('{ src: i.src'));
  console.log('✓ CAPTCHA providers use runtime config/env precedence and a bounded overall deadline');

  const originalFetch = global.fetch;
  const opaqueKey = 'Opaque/Captcha+Key?';
  const opaqueChallenge = 'OpaqueChallengePayload-1';
  const opaqueUrl = 'https://example.invalid/challenge?token=OpaqueQueryValue-2';
  global.fetch = async () => ({
    json: async () => ({
      errorId: 1,
      errorCode: 'PROVIDER_ERROR',
      errorDescription: `provider echo ${opaqueKey} ${encodeURIComponent(opaqueKey)} ${opaqueChallenge} ${opaqueUrl}`,
    }),
  });
  let providerError;
  try {
    await apiPost('https://captcha.invalid', '/createTask', {
      clientKey: opaqueKey,
      task: {
        websiteURL: opaqueUrl,
        websiteKey: 'OpaqueSiteKey-3',
        enterprisePayload: { rqdata: opaqueChallenge },
      },
    }, 1000);
  } catch (error) {
    providerError = error;
  } finally {
    global.fetch = originalFetch;
  }
  assert.ok(providerError);
  assert.ok(!providerError.message.includes(opaqueKey));
  assert.ok(!providerError.message.includes(encodeURIComponent(opaqueKey)));
  assert.ok(!providerError.message.includes(opaqueChallenge));
  assert.ok(!providerError.message.includes(opaqueUrl));
  console.log('✓ CAPTCHA provider echoes cannot expose raw or encoded client keys');
} finally {
  if (previousNoneCap === undefined) delete process.env.NONECAP_API_KEY;
  else process.env.NONECAP_API_KEY = previousNoneCap;
  if (previousCapSolver === undefined) delete process.env.CAPSOLVER_API_KEY;
  else process.env.CAPSOLVER_API_KEY = previousCapSolver;
}
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
