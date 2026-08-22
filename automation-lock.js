const fs = require('fs');
const path = require('path');

function runtimeDirectory(override) {
  return path.resolve(override || process.env.MAIL_TEMP_RUNTIME_DIR || path.join(__dirname, '.runtime'));
}

function lockPath(override) {
  return path.join(runtimeDirectory(override), 'automation.lock');
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

function acquireAutomationLock(owner = 'cli') {
  if (process.env.MAIL_TEMP_LOCK_HELD === '1') return () => {};
  fs.mkdirSync(runtimeDirectory(), { recursive: true });

  const file = lockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (current.pid === process.pid) fs.unlinkSync(file);
        } catch {}
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readAutomationLock();
      if (current.status === 'stale') {
        fs.unlinkSync(file);
        continue;
      }
      throw new Error(`Automation is already running under PID ${current.owner?.pid || 'unknown'} (${current.owner?.owner || 'unknown'}).`);
    }
  }
  throw new Error('Could not acquire the automation lock.');
}

async function withAutomationLock(owner, callback) {
  const release = acquireAutomationLock(owner);
  try {
    return await callback();
  } finally {
    release();
  }
}

module.exports = { acquireAutomationLock, withAutomationLock, readAutomationLock, lockPath };
