const fs = require('fs');
const path = require('path');

const SECRET_SETTING_KEYS = [
  'proxyApiKey',
  'capsolverApiKey',
  'capbypassApiKey',
  'twoCaptchaApiKey',
  'nonecapApiKey',
];

const ENV_MAP = {
  sheetId: 'MAIL_TEMP_SHEET_ID',
  sheetName: 'MAIL_TEMP_SHEET_NAME',
  serviceAccountPath: 'GOOGLE_SERVICE_ACCOUNT_PATH',
  gpmApiBase: 'GPM_API_BASE',
  defaultIntervalMinutes: 'MAIL_TEMP_DEFAULT_INTERVAL',
  runtimeDirectory: 'MAIL_TEMP_RUNTIME_DIR',
  proxyProvider: 'MAIL_TEMP_PROXY_PROVIDER',
  proxyApiKey: 'MAIL_TEMP_PROXY_API_KEY',
  capsolverApiKey: 'CAPSOLVER_API_KEY',
  capbypassApiKey: 'CAPBYPASS_API_KEY',
  twoCaptchaApiKey: 'TWO_CAPTCHA_API_KEY',
  nonecapApiKey: 'NONECAP_API_KEY',
};

function defaults(projectRoot = __dirname) {
  return {
    sheetId: '1nNAzzC34zSvX2S_AJ4jB6njhKnKRWs8KeZ0mJ5oSkTU',
    sheetName: 'hotmail',
    serviceAccountPath: path.join(projectRoot, 'service-account.json'),
    gpmApiBase: 'http://127.0.0.1:19995',
    defaultIntervalMinutes: 1,
    runtimeDirectory: path.join(projectRoot, '.runtime'),
    proxyProvider: 'none',
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolveRuntimeConfig({ projectRoot = __dirname, env = process.env, local = {} } = {}) {
  if (!isPlainObject(local)) throw new Error('Runtime config must be a plain JSON object');
  const resolvedRoot = path.resolve(projectRoot);
  const merged = { ...defaults(resolvedRoot), ...local };
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    if (env[envName] === undefined) continue;
    merged[key] = key === 'defaultIntervalMinutes' ? Number(env[envName]) : env[envName];
  }

  if (!Number.isFinite(merged.defaultIntervalMinutes) || merged.defaultIntervalMinutes <= 0) {
    throw new Error('defaultIntervalMinutes must be a positive number');
  }
  merged.proxyProvider = String(merged.proxyProvider || 'none').trim().toLowerCase() || 'none';
  if (!['none', 'sp07', 'tinproxy'].includes(merged.proxyProvider)) {
    throw new Error(`Unsupported proxyProvider: ${merged.proxyProvider}`);
  }
  return merged;
}

function loadLocalConfig({ projectRoot = __dirname, filePath } = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedFile = path.resolve(filePath || path.join(resolvedRoot, 'config.local.json'));
  if (!fs.existsSync(resolvedFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('expected a plain JSON object');
    return parsed;
  } catch (error) {
    throw new Error(`Runtime config could not be read at ${resolvedFile}: ${error.message}`);
  }
}

function getEnvOverrides(env = process.env) {
  return Object.entries(ENV_MAP)
    .filter(([, envName]) => env[envName] !== undefined)
    .map(([key]) => key);
}

function loadRuntimeConfig({ projectRoot = __dirname, env = process.env, filePath } = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const local = loadLocalConfig({ projectRoot: resolvedRoot, filePath });
  return resolveRuntimeConfig({ projectRoot: resolvedRoot, env, local });
}

function resolveProxyConfig(config, { required = false } = {}) {
  const provider = config.proxyProvider || 'none';
  if (provider === 'none') {
    if (required) throw new Error('No proxy provider configured in Settings');
    return { provider, apiKey: null };
  }
  const apiKey = String(config.proxyApiKey || '').trim();
  if (!apiKey) throw new Error(`Proxy provider ${provider} requires proxyApiKey in Settings`);
  return { provider, apiKey };
}

module.exports = {
  ENV_MAP,
  SECRET_SETTING_KEYS,
  defaults,
  getEnvOverrides,
  loadLocalConfig,
  loadRuntimeConfig,
  resolveRuntimeConfig,
  resolveProxyConfig,
};
