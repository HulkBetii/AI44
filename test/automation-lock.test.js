const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireAutomationLock,
  clearStaleAutomationLock,
  lockPath,
  maintenanceLockPath,
  readAutomationLock,
} = require('../automation-lock');
const { prepareRecovery, removeRecovery } = require('../recovery-journal');
const { recordUncertainCreate, removeUncertainCreate } = require('../gpm-api');

const lockSource = fs.readFileSync(path.join(__dirname, '..', 'automation-lock.js'), 'utf8');
assert.ok(!lockSource.includes("process.once('exit', release)"));
assert.ok(lockSource.includes('if (error?.preserveAutomationLock) release.preserve();'));
console.log('✓ process exit cannot silently erase a lock before remote cleanup is confirmed');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-lock-'));
const previousRuntime = process.env.MAIL_TEMP_RUNTIME_DIR;
const previousInheritedToken = process.env.MAIL_TEMP_LOCK_TOKEN;
const previousHeldFlag = process.env.MAIL_TEMP_LOCK_HELD;
delete process.env.MAIL_TEMP_LOCK_HELD;
delete process.env.MAIL_TEMP_LOCK_TOKEN;
process.env.MAIL_TEMP_RUNTIME_DIR = directory;

try {
  const release = acquireAutomationLock('test-owner');
  assert.strictEqual(readAutomationLock(directory).status, 'busy');
  process.env.MAIL_TEMP_LOCK_HELD = '1';
  assert.throws(() => acquireAutomationLock('fake-boolean-bypass'), /already running/);
  delete process.env.MAIL_TEMP_LOCK_HELD;
  process.env.MAIL_TEMP_LOCK_TOKEN = crypto.randomUUID();
  assert.throws(() => acquireAutomationLock('fake-token-bypass'), /already running/);
  process.env.MAIL_TEMP_LOCK_TOKEN = release.token;
  assert.throws(() => acquireAutomationLock('same-process-token-bypass'), /already running/);
  delete process.env.MAIL_TEMP_LOCK_TOKEN;
  console.log('✓ ambient flags and matching tokens cannot bypass a non-parent lock');
  const replacement = {
    pid: process.pid,
    token: crypto.randomUUID(),
    owner: 'replacement',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath(directory), JSON.stringify(replacement));
  release();
  assert.strictEqual(readAutomationLock(directory).owner.token, replacement.token);
  fs.unlinkSync(lockPath(directory));
  console.log('✓ release cannot delete a lock owned by another token');

  const parentToken = crypto.randomUUID();
  fs.writeFileSync(lockPath(directory), JSON.stringify({
    pid: process.ppid,
    token: parentToken,
    owner: 'verified-parent',
    createdAt: new Date().toISOString(),
  }));
  process.env.MAIL_TEMP_LOCK_TOKEN = parentToken;
  const inheritedRelease = acquireAutomationLock('verified-child');
  assert.strictEqual(inheritedRelease.inherited, true);
  inheritedRelease();
  assert.strictEqual(readAutomationLock(directory).status, 'busy');
  delete process.env.MAIL_TEMP_LOCK_TOKEN;
  fs.unlinkSync(lockPath(directory));
  console.log('✓ a direct child can inherit only its live parent lock token');

  fs.writeFileSync(lockPath(directory), JSON.stringify({
    pid: 2147483647,
    token: crypto.randomUUID(),
    owner: 'dead-owner',
    createdAt: new Date().toISOString(),
  }));
  assert.throws(() => acquireAutomationLock('new-owner'), /stale automation lock/);
  assert.strictEqual(clearStaleAutomationLock(directory), true);
  assert.strictEqual(readAutomationLock(directory).status, 'free');
  assert.strictEqual(fs.existsSync(maintenanceLockPath(directory)), false);
  console.log('✓ stale locks require explicit maintenance and the guard is cleaned up');

  const recovery = prepareRecovery({
    operation: 'signup',
    email: 'blocked@example.com',
    originalRowIndex: 2,
    elevenPassword: 'SecretPassword1!',
  }, { runtimeDirectory: directory });
  assert.throws(() => acquireAutomationLock('blocked-owner'), /unresolved prepared mutation/);
  removeRecovery(recovery.id, { runtimeDirectory: directory });
  console.log('✓ prepared remote mutations block new automation');

  const uncertain = recordUncertainCreate('uncertain@example.com', new Set(), {
    runtimeDirectory: directory,
  });
  assert.throws(() => acquireAutomationLock('uncertain-gpm-owner'), /Unresolved uncertain GPM create/);
  removeUncertainCreate(uncertain.id, { runtimeDirectory: directory });
  console.log('✓ unresolved GPM create evidence blocks new automation');

  const preserveRelease = acquireAutomationLock('unresolved-child');
  preserveRelease.preserve();
  preserveRelease();
  assert.strictEqual(readAutomationLock(directory).status, 'busy');
  fs.unlinkSync(lockPath(directory));
  console.log('✓ unresolved child ownership can preserve the lock across cleanup');

  fs.writeFileSync(maintenanceLockPath(directory), JSON.stringify({
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }));
  assert.throws(() => acquireAutomationLock('maintenance-race'), /maintenance is in progress/);
  fs.unlinkSync(maintenanceLockPath(directory));
  console.log('✓ maintenance guard blocks concurrent acquisition');

  fs.writeFileSync(maintenanceLockPath(directory), '');
  assert.throws(() => clearStaleAutomationLock(directory), /guard is incomplete/);
  assert.strictEqual(fs.existsSync(maintenanceLockPath(directory)), true);
  fs.unlinkSync(maintenanceLockPath(directory));
  console.log('✓ an in-flight empty maintenance guard cannot be unlinked by a racing maintainer');

  fs.writeFileSync(maintenanceLockPath(directory), JSON.stringify({
    pid: 2147483647,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }));
  assert.strictEqual(clearStaleAutomationLock(directory), false);
  assert.strictEqual(fs.existsSync(maintenanceLockPath(directory)), false);
  console.log('✓ clear-stale recovers a maintenance guard left by a crashed process');
} finally {
  if (previousRuntime === undefined) delete process.env.MAIL_TEMP_RUNTIME_DIR;
  else process.env.MAIL_TEMP_RUNTIME_DIR = previousRuntime;
  if (previousInheritedToken === undefined) delete process.env.MAIL_TEMP_LOCK_TOKEN;
  else process.env.MAIL_TEMP_LOCK_TOKEN = previousInheritedToken;
  if (previousHeldFlag === undefined) delete process.env.MAIL_TEMP_LOCK_HELD;
  else process.env.MAIL_TEMP_LOCK_HELD = previousHeldFlag;
  fs.rmSync(directory, { recursive: true, force: true });
}
