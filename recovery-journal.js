const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('./runtime-config');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['signup', 'resetPassword']);

function optionsWithDefaults(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || __dirname);
  const runtimeDirectory = options.runtimeDirectory
    ? path.resolve(options.runtimeDirectory)
    : loadRuntimeConfig({ projectRoot, env: options.env }).runtimeDirectory;
  return { runtimeDirectory };
}

function recoveryJournalDirectory(options = {}) {
  return path.join(optionsWithDefaults(options).runtimeDirectory, 'recovery');
}

function validateId(id) {
  if (!UUID_V4.test(String(id || ''))) throw new Error('Invalid recovery journal id');
  return id;
}

function entryPath(id, options = {}) {
  return path.join(recoveryJournalDirectory(options), `${validateId(id)}.json`);
}

function writeAtomic(file, value, { create = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (create && fs.existsSync(file)) throw new Error(`Recovery journal entry already exists: ${file}`);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd = null;
  let committed = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (create && fs.existsSync(file)) throw new Error(`Recovery journal entry already exists: ${file}`);
    fs.renameSync(temporary, file);
    committed = true;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (!committed) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

function prepareRecovery(entry, options = {}) {
  if (!entry || !OPERATIONS.has(entry.operation)) {
    throw new Error('Recovery entry operation must be signup or resetPassword');
  }
  if (!entry.email || !Number.isInteger(entry.originalRowIndex) || entry.originalRowIndex < 2) {
    throw new Error('Recovery entry needs email and originalRowIndex >= 2');
  }
  if (typeof entry.elevenPassword !== 'string' || entry.elevenPassword.length === 0) {
    throw new Error('Recovery entry needs a non-empty elevenPassword');
  }
  const now = new Date().toISOString();
  const record = {
    version: 1,
    id: crypto.randomUUID(),
    state: 'prepared',
    operation: entry.operation,
    email: entry.email,
    originalRowIndex: entry.originalRowIndex,
    elevenPassword: entry.elevenPassword,
    createdAt: now,
    updatedAt: now,
    remoteMutationAt: null,
  };
  writeAtomic(entryPath(record.id, options), record, { create: true });
  return record;
}

function getRecoveryEntry(id, options = {}) {
  const file = entryPath(id, options);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function updateEntry(id, transform, options = {}) {
  const current = getRecoveryEntry(id, options);
  if (!current) throw new Error(`Recovery journal entry not found: ${id}`);
  const next = transform(current);
  next.id = current.id;
  next.version = current.version;
  next.updatedAt = new Date().toISOString();
  writeAtomic(entryPath(id, options), next);
  return next;
}

function confirmRecovery(id, options = {}) {
  return updateEntry(id, (current) => ({
    ...current,
    state: 'confirmed',
    remoteMutationAt: current.remoteMutationAt || new Date().toISOString(),
  }), options);
}

function removeRecovery(id, options = {}) {
  const file = entryPath(id, options);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function toSummary(record) {
  return {
    id: record.id,
    state: record.state,
    operation: record.operation,
    email: record.email,
    originalRowIndex: record.originalRowIndex,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function listRecoveryEntries(options = {}) {
  const directory = recoveryJournalDirectory(options);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json') && UUID_V4.test(name.slice(0, -5)))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function listRecoverySummaries(options = {}) {
  return listRecoveryEntries(options).map(toSummary);
}

function assertNoPreparedRecoveries(options = {}) {
  const prepared = listRecoveryEntries(options).filter((entry) => entry.state === 'prepared');
  if (prepared.length === 0) return;
  const rows = prepared.map((entry) => `${entry.email} (row ${entry.originalRowIndex})`).join(', ');
  throw new Error(`Recovery journal has unresolved prepared mutation(s): ${rows}`);
}

async function syncConfirmedRecoveries(sheet, options = {}) {
  if (!sheet || typeof sheet.updatePasswordByEmail !== 'function') {
    throw new Error('syncConfirmedRecoveries needs updatePasswordByEmail');
  }
  const confirmed = listRecoveryEntries(options).filter((entry) => entry.state === 'confirmed');
  if (confirmed.length === 0) return [];
  const synced = [];
  for (const entry of confirmed) {
    try {
      await sheet.updatePasswordByEmail(entry.email, entry.elevenPassword);
    } catch {
      throw new Error(`Could not sync confirmed recovery for ${entry.email}`);
    }
    removeRecovery(entry.id, options);
    synced.push(toSummary(entry));
  }
  return synced;
}

module.exports = {
  assertNoPreparedRecoveries,
  confirmRecovery,
  getRecoveryEntry,
  listRecoverySummaries,
  prepareRecovery,
  recoveryJournalDirectory,
  removeRecovery,
  syncConfirmedRecoveries,
};
