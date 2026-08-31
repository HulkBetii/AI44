const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadRuntimeConfig } = require('./runtime-config');
const { assertNoPreparedRecoveries } = require('./recovery-journal');

function runtimeDirectory(override) {
  return path.resolve(override || loadRuntimeConfig().runtimeDirectory);
}

function lockPath(override) {
  return path.join(runtimeDirectory(override), 'automation.lock');
}

function maintenanceLockPath(override) {
  return path.join(runtimeDirectory(override), 'automation.maintenance.lock');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readAutomationLock(runtimeDirectoryOverride) {
  const file = lockPath(runtimeDirectoryOverride);
  if (!fs.existsSync(file)) return { status: 'free', file };
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { status: isProcessAlive(owner.pid) ? 'busy' : 'stale', file, owner };
  } catch {
    return { status: 'stale', file };
  }
}

function createMaintenanceGuard(directory, guardToken) {
  const guardFile = maintenanceLockPath(directory);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(guardFile, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          token: guardToken,
          createdAt: new Date().toISOString(),
        }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return guardFile;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const firstRaw = fs.readFileSync(guardFile, 'utf8');
      let owner = null;
      try { owner = JSON.parse(firstRaw); } catch {}
      const validOwner = Number.isInteger(owner?.pid) && owner.pid > 0
        && typeof owner.token === 'string' && owner.token.length > 0
        && typeof owner.createdAt === 'string' && !Number.isNaN(Date.parse(owner.createdAt));
      if (!validOwner) {
        throw new Error('Automation maintenance guard is incomplete; retry shortly.');
      }
      if (isProcessAlive(owner?.pid)) {
        throw new Error(`Automation lock maintenance is already running under PID ${owner.pid}.`);
      }
      const secondRaw = fs.readFileSync(guardFile, 'utf8');
      if (secondRaw !== firstRaw) {
        throw new Error('Automation maintenance guard changed while recovering; retry shortly.');
      }
      fs.unlinkSync(guardFile);
    }
  }
  throw new Error('Could not acquire the automation maintenance guard.');
}

function inheritedLockRelease(directory) {
  const inheritedToken = process.env.MAIL_TEMP_LOCK_TOKEN;
  if (!inheritedToken) return null;
  const current = readAutomationLock(directory);
  if (current.status !== 'busy'
    || current.owner?.token !== inheritedToken
    || current.owner?.pid !== process.ppid) return null;
  const release = () => {};
  release.token = inheritedToken;
  release.inherited = true;
  release.preserve = () => {};
  return release;
}

function acquireAutomationLock(owner = 'cli') {
  const directory = runtimeDirectory();
  const inheritedRelease = inheritedLockRelease(directory);
  if (inheritedRelease) return inheritedRelease;
  assertNoPreparedRecoveries({ runtimeDirectory: directory });
  require('./gpm-api').assertNoUncertainCreates({ runtimeDirectory: directory });
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(maintenanceLockPath(directory))) {
    throw new Error('Automation lock maintenance is in progress; retry shortly.');
  }

  const file = lockPath();
  const token = crypto.randomUUID();
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        token,
        owner,
        createdAt: new Date().toISOString(),
      }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(maintenanceLockPath(directory))) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.token === token) fs.unlinkSync(file);
      throw new Error('Automation lock maintenance is in progress; retry shortly.');
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = readAutomationLock();
    if (current.status === 'stale') {
      throw new Error(`A stale automation lock exists at ${file}. Run "node automation-lock.js --clear-stale" before retrying.`);
    }
    throw new Error(`Automation is already running under PID ${current.owner?.pid || 'unknown'} (${current.owner?.owner || 'unknown'}).`);
  }

  let released = false;
  let preserved = false;
  const release = () => {
    if (released || preserved) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.token === token) fs.unlinkSync(file);
    } catch {}
  };
  release.token = token;
  release.inherited = false;
  release.preserve = () => { preserved = true; };
  return release;
}

function clearStaleAutomationLock(runtimeDirectoryOverride) {
  const directory = runtimeDirectory(runtimeDirectoryOverride);
  fs.mkdirSync(directory, { recursive: true });
  const guardToken = crypto.randomUUID();
  let guardCreated = false;
  let guardFile;
  try {
    guardFile = createMaintenanceGuard(directory, guardToken);
    guardCreated = true;

    const first = readAutomationLock(directory);
    if (first.status === 'free') return false;
    if (first.status === 'busy') {
      throw new Error(`Automation is still running under PID ${first.owner?.pid || 'unknown'}.`);
    }
    const expectedToken = first.owner?.token;
    const expectedPid = first.owner?.pid;
    const current = readAutomationLock(directory);
    if (current.status !== 'stale'
      || current.owner?.token !== expectedToken
      || current.owner?.pid !== expectedPid) {
      throw new Error('Automation lock changed while clearing; retry after checking the current owner.');
    }
    fs.unlinkSync(first.file);
    return true;
  } finally {
    if (guardCreated) {
      try {
        const current = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
        if (current.token === guardToken) fs.unlinkSync(guardFile);
      } catch {}
    }
  }
}

async function withAutomationLock(owner, callback) {
  const release = acquireAutomationLock(owner);
  try {
    return await callback(release.token);
  } catch (error) {
    if (error?.preserveAutomationLock) release.preserve();
    throw error;
  } finally {
    release();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--clear-stale') {
    console.error('Usage: node automation-lock.js --clear-stale');
    process.exitCode = 1;
  } else {
    try {
      console.log(clearStaleAutomationLock() ? 'Cleared stale automation lock.' : 'No automation lock exists.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  acquireAutomationLock,
  clearStaleAutomationLock,
  createMaintenanceGuard,
  maintenanceLockPath,
  withAutomationLock,
  readAutomationLock,
  lockPath,
};
