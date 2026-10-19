/**
 * config.js (reg-museai)
 * Configuration loader for Muse AI automation with GPM and US Proxy.
 */

const { loadRuntimeConfig } = require('../runtime-config');

const MUSE_DEFAULTS = {
  referralCode: 'AR8YUP',
  proxyList: [
    '69.12.25.5:17540:qVtbdItJ:YyZcJyNWqE4A',
    '23.95.45.67:15920:muse:muse',
    '23.95.45.238:31276:muse:muse',
    '200.229.24.106:19448:muse:muse',
  ],
  proxyString: '69.12.25.5:17540:qVtbdItJ:YyZcJyNWqE4A',
  gpmApiBase: 'http://127.0.0.1:19995',
  sheetName: 'hotmail',
  cooldownSec: 60,
  otpTimeoutMs: 120000,
  maxRetries: 2,
};

function loadMuseConfig(options = {}) {
  const baseConfig = loadRuntimeConfig();

  const config = {
    ...MUSE_DEFAULTS,
    sheetId: baseConfig.sheetId,
    serviceAccountPath: baseConfig.serviceAccountPath,
    runtimeDirectory: baseConfig.runtimeDirectory,
    catchAllDomain: baseConfig.catchAllDomain || 'mrhulkstore.store',
    gmailUser: baseConfig.gmailUser || 'hadijamuale@gmail.com',
    gmailAppPassword: (baseConfig.gmailAppPassword || '').replace(/\s+/g, ''),
    imapHost: baseConfig.imapHost || 'imap.gmail.com',
    imapPort: baseConfig.imapPort || 993,
    useCatchAll: options.useCatchAll !== undefined ? Boolean(options.useCatchAll) : true,
  };

  if (options.referralCode) config.referralCode = options.referralCode.trim();
  if (options.catchAllDomain) config.catchAllDomain = options.catchAllDomain.trim();
  if (options.proxyList && Array.isArray(options.proxyList)) config.proxyList = options.proxyList;
  if (options.proxyString !== undefined) {
    config.proxyString = options.proxyString.trim();
  } else if (config.proxyList && config.proxyList.length > 0) {
    config.proxyString = config.proxyList[0];
  }
  if (options.gpmApiBase) config.gpmApiBase = options.gpmApiBase.trim();

  if (process.env.MUSE_REF_CODE) config.referralCode = process.env.MUSE_REF_CODE.trim();
  if (process.env.MUSE_PROXY) config.proxyString = process.env.MUSE_PROXY.trim();
  if (process.env.GPM_API_BASE) config.gpmApiBase = process.env.GPM_API_BASE.trim();
  if (process.env.CATCH_ALL_DOMAIN) config.catchAllDomain = process.env.CATCH_ALL_DOMAIN.trim();
  if (process.env.GMAIL_USER) config.gmailUser = process.env.GMAIL_USER.trim();
  if (process.env.GMAIL_APP_PASSWORD) config.gmailAppPassword = process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '');

  return config;
}

module.exports = {
  MUSE_DEFAULTS,
  loadMuseConfig,
};
