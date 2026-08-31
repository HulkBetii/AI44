const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertNoPreparedRecoveries,
  confirmRecovery,
  getRecoveryEntry,
  listRecoverySummaries,
  prepareRecovery,
  recoveryJournalDirectory,
  removeRecovery,
  syncConfirmedRecoveries,
} = require('../recovery-journal');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-recovery-'));
const options = { runtimeDirectory: directory };

(async () => {
  try {
    const prepared = prepareRecovery({
      operation: 'resetPassword',
      email: 'User@Example.com',
      originalRowIndex: 49,
      elevenPassword: 'SecretPassword1!',
    }, options);
    assert.throws(() => assertNoPreparedRecoveries(options), /unresolved prepared mutation/);
    const [summary] = listRecoverySummaries(options);
    assert.strictEqual(summary.state, 'prepared');
    assert.strictEqual(Object.hasOwn(summary, 'elevenPassword'), false);
    console.log('✓ prepared recovery blocks automation and public summaries omit passwords');

    confirmRecovery(prepared.id, options);
    const writes = [];
    await syncConfirmedRecoveries({
      updatePasswordByEmail: async (email, password) => writes.push({ email, password }),
    }, options);
    assert.deepStrictEqual(writes, [{ email: 'User@Example.com', password: 'SecretPassword1!' }]);
    assert.strictEqual(getRecoveryEntry(prepared.id, options), null);
    console.log('✓ confirmed recovery uses email identity and deletes only after a successful write');

    const duplicate = prepareRecovery({
      operation: 'signup',
      email: 'duplicate@example.com',
      originalRowIndex: 5,
      elevenPassword: 'AnotherSecret1!',
    }, options);
    confirmRecovery(duplicate.id, options);
    await assert.rejects(
      () => syncConfirmedRecoveries({
        updatePasswordByEmail: async () => {
          throw new Error('found 2 matching sheet rows');
        },
      }, options),
      /Could not sync confirmed recovery/,
    );
    assert.ok(getRecoveryEntry(duplicate.id, options), 'ambiguous recovery must remain journaled');
    removeRecovery(duplicate.id, options);
    console.log('✓ duplicate email rows fail safely without deleting recovery evidence');

    const syncFailure = prepareRecovery({
      operation: 'resetPassword',
      email: 'sync-failure@example.com',
      originalRowIndex: 9,
      elevenPassword: 'OpaqueRecoveryValue-1!',
    }, options);
    confirmRecovery(syncFailure.id, options);
    let syncError;
    try {
      await syncConfirmedRecoveries({
        updatePasswordByEmail: async (email, password) => {
          throw new Error(`Sheet provider echoed ${password}`);
        },
      }, options);
    } catch (error) {
      syncError = error;
    }
    assert.match(syncError?.message || '', /Could not sync confirmed recovery/);
    assert.ok(!syncError.message.includes(syncFailure.elevenPassword));
    assert.ok(getRecoveryEntry(syncFailure.id, options), 'failed sync must remain journaled');
    removeRecovery(syncFailure.id, options);
    console.log('✓ recovery sync wraps provider errors without echoing the stored password');

    const atomic = prepareRecovery({
      operation: 'signup',
      email: 'atomic@example.com',
      originalRowIndex: 10,
      elevenPassword: 'OpaqueAtomicValue-2!',
    }, options);
    const originalFsync = fs.fsyncSync;
    let failNextFsync = true;
    fs.fsyncSync = (fd) => {
      if (failNextFsync) {
        failNextFsync = false;
        throw new Error('injected fsync failure');
      }
      return originalFsync(fd);
    };
    try {
      assert.throws(() => confirmRecovery(atomic.id, options), /injected fsync failure/);
    } finally {
      fs.fsyncSync = originalFsync;
    }
    assert.strictEqual(getRecoveryEntry(atomic.id, options).state, 'prepared');
    const recoveryFiles = fs.readdirSync(recoveryJournalDirectory(options));
    assert.strictEqual(recoveryFiles.some((name) => name.endsWith('.tmp')), false);
    removeRecovery(atomic.id, options);
    console.log('✓ failed atomic writes preserve the original journal and remove secret temp files');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAILED:', error.stack || error.message);
  process.exit(1);
});
