const { SECRET_SETTING_KEYS } = require('./runtime-config');

const ACCOUNT_SECRET_KEYS = [
  'password',
  'elevenPass',
  'elevenPassword',
  'apiKey',
  'msaToken',
  'proxyToken',
];

function addVariants(target, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  target.add(value);
  try { target.add(encodeURIComponent(value)); } catch {}
  try { target.add(new URLSearchParams({ value }).toString().slice('value='.length)); } catch {}
  try { target.add(JSON.stringify(value).slice(1, -1)); } catch {}
  try { target.add(Buffer.from(value).toString('base64')); } catch {}
}

function addSecret(target, value) {
  addVariants(target, value);
  const proxyParts = typeof value === 'string' ? value.split(':') : [];
  if (proxyParts.length < 4) return;
  const username = proxyParts[2];
  const password = proxyParts.slice(3).join(':');
  addVariants(target, username);
  addVariants(target, password);
  addVariants(target, `${username}:${password}`);
}

function collectSecretValues({ account, runtimeConfig, extra = [] } = {}) {
  const secrets = new Set();
  for (const key of ACCOUNT_SECRET_KEYS) addSecret(secrets, account?.[key]);
  for (const key of SECRET_SETTING_KEYS) addSecret(secrets, runtimeConfig?.[key]);
  for (const value of extra) addSecret(secrets, value);
  return [...secrets].sort((left, right) => right.length - left.length);
}

function collectUrlSecrets(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const secrets = new Set([value]);
  try {
    const url = new URL(value);
    for (const parameter of url.searchParams.values()) {
      if (parameter) secrets.add(parameter);
    }
    const hash = url.hash.slice(1);
    if (hash) {
      for (const parameter of new URLSearchParams(hash).values()) {
        if (parameter) secrets.add(parameter);
      }
    }
  } catch {}
  return [...secrets];
}

function redactSecrets(value, secrets) {
  let text = String(value ?? '');
  const ordered = [...new Set(secrets || [])].sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

module.exports = { collectSecretValues, collectUrlSecrets, redactSecrets };
