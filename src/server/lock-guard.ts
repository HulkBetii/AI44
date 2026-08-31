import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface AutomationLockAccess {
  maintenanceLockPath(runtimeDirectory: string): string;
  readAutomationLock(runtimeDirectory: string): { status: 'free' | 'busy' | 'stale' };
}

function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

function removeOwnedGuard(file: string, token: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string };
    if (current.token === token) fs.unlinkSync(file);
  } catch {}
}

export function acquireAutomationMaintenanceGuard(
  lockAccess: AutomationLockAccess,
  runtimeDirectory: string,
  owner: string,
): () => void {
  const directory = path.resolve(runtimeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const file = lockAccess.maintenanceLockPath(directory);
  const token = crypto.randomUUID();
  let descriptor: number | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; token?: string };
        if (attempt === 0 && !isProcessAlive(existing.pid) && typeof existing.token === 'string') {
          removeOwnedGuard(file, existing.token);
          continue;
        }
      } catch {}
      throw new Error(`Automation lock maintenance is already in progress at ${file}`);
    }
  }
  if (descriptor === null) throw new Error(`Could not acquire automation maintenance guard at ${file}`);

  try {
    try {
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        token,
        owner,
        createdAt: new Date().toISOString(),
      }));
      fs.fsyncSync(descriptor);
    } finally {
      const openDescriptor = descriptor;
      descriptor = null;
      fs.closeSync(openDescriptor);
    }
  } catch (error) {
    try { fs.unlinkSync(file); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    removeOwnedGuard(file, token);
  };
  process.once('exit', release);

  try {
    const lock = lockAccess.readAutomationLock(directory);
    if (lock.status === 'free') return release;
    release();
    throw new Error(`Automation lock is ${lock.status} in ${directory}`);
  } catch (error) {
    release();
    throw error;
  }
}
