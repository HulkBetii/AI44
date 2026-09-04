/**
 * config.js (catch-all-signup)
 * Configuration loader for Catch-All domain and Gmail IMAP client.
 */

const { loadRuntimeConfig } = require('../runtime-config');

const CATCH_ALL_DEFAULTS = {
  catchAllDomain: 'mrhulkstore.store',
  gmailUser: 'hadijamuale@gmail.com',
  gmailAppPassword: '',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapTls: true,
  imapTimeoutMs: 120000,
  imapPollIntervalMs: 3000,
  regSheetId: '1nNAzzC34zSvX2S_AJ4jB6njhKnKRWs8KeZ0mJ5oSkTU',
  regSheetName: 'catch-all-signup',
};

function loadCatchAllConfig(options = {}) {
  const baseConfig = loadRuntimeConfig(options);
  const config = {
    ...CATCH_ALL_DEFAULTS,
    ...baseConfig,
  };

  if (process.env.CATCH_ALL_DOMAIN) config.catchAllDomain = process.env.CATCH_ALL_DOMAIN;
  if (process.env.GMAIL_USER) config.gmailUser = process.env.GMAIL_USER;
  if (process.env.GMAIL_APP_PASSWORD) config.gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (process.env.IMAP_HOST) config.imapHost = process.env.IMAP_HOST;
  if (process.env.IMAP_PORT) config.imapPort = parseInt(process.env.IMAP_PORT, 10);
  if (process.env.REG_SHEET_ID) config.regSheetId = process.env.REG_SHEET_ID;
  if (process.env.REG_SHEET_NAME) config.regSheetName = process.env.REG_SHEET_NAME;

  // Normalize app password (remove spaces if any)
  if (config.gmailAppPassword) {
    config.gmailAppPassword = config.gmailAppPassword.replace(/\s+/g, '');
  }

  return config;
}

module.exports = {
  CATCH_ALL_DEFAULTS,
  loadCatchAllConfig,
};
