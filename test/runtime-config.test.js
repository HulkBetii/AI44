const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadLocalConfig,
  resolveProxyConfig,
  resolveRuntimeConfig,
} = require('../runtime-config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
try {
  const file = path.join(directory, 'config.local.json');
  fs.writeFileSync(file, JSON.stringify({ proxyProvider: ' TinProxy ', proxyApiKey: 'local-key' }));
  assert.deepStrictEqual(loadLocalConfig({ projectRoot: directory }), {
    proxyProvider: ' TinProxy ',
    proxyApiKey: 'local-key',
  });

  const resolved = resolveRuntimeConfig({
    projectRoot: directory,
    local: loadLocalConfig({ projectRoot: directory }),
    env: { MAIL_TEMP_PROXY_PROVIDER: 'SP07', MAIL_TEMP_PROXY_API_KEY: 'env-key' },
  });
  assert.strictEqual(resolved.proxyProvider, 'sp07');
  assert.deepStrictEqual(resolveProxyConfig(resolved), { provider: 'sp07', apiKey: 'env-key' });
  assert.strictEqual(resolveRuntimeConfig({ projectRoot: directory, env: {}, local: {} }).proxyProvider, 'none');
  assert.throws(
    () => resolveProxyConfig({ proxyProvider: 'sp07', proxyApiKey: '' }),
    /requires proxyApiKey/,
  );
  console.log('✓ runtime config normalizes provider and gives environment values precedence');

  for (const invalid of ['null', '[]', '"text"']) {
    fs.writeFileSync(file, invalid);
    assert.throws(
      () => loadLocalConfig({ projectRoot: directory }),
      /plain JSON object/,
    );
  }
  assert.throws(
    () => resolveRuntimeConfig({ projectRoot: directory, env: {}, local: [] }),
    /plain JSON object/,
  );
  console.log('✓ non-object local JSON fails fast');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
