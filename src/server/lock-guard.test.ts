import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireAutomationMaintenanceGuard } from './lock-guard';

const directories: string[] = [];

function setup(status: 'free' | 'busy' | 'stale' = 'free') {
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-lock-guard-'));
  directories.push(runtimeDirectory);
  const guardFile = path.join(runtimeDirectory, 'automation.maintenance.lock');
  const lockAccess = {
    maintenanceLockPath: () => guardFile,
    readAutomationLock: vi.fn(() => ({ status })),
  };
  return { runtimeDirectory, guardFile, lockAccess };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('acquireAutomationMaintenanceGuard', () => {
  it('owns the guard until an idempotent release', () => {
    const { runtimeDirectory, guardFile, lockAccess } = setup();

    const release = acquireAutomationMaintenanceGuard(lockAccess, runtimeDirectory, 'test');
    expect(fs.existsSync(guardFile)).toBe(true);

    release();
    release();
    expect(fs.existsSync(guardFile)).toBe(false);
  });

  it.each(['busy', 'stale'] as const)('removes its guard when the automation lock is %s', (status) => {
    const { runtimeDirectory, guardFile, lockAccess } = setup(status);

    expect(() => acquireAutomationMaintenanceGuard(lockAccess, runtimeDirectory, 'test'))
      .toThrow(`Automation lock is ${status}`);
    expect(fs.existsSync(guardFile)).toBe(false);
  });

  it('recovers a stale maintenance guard without overwriting a live owner', () => {
    const { runtimeDirectory, guardFile, lockAccess } = setup();
    fs.writeFileSync(guardFile, JSON.stringify({ pid: 2_147_483_647, token: 'stale-token' }));

    const release = acquireAutomationMaintenanceGuard(lockAccess, runtimeDirectory, 'test');
    const current = JSON.parse(fs.readFileSync(guardFile, 'utf8')) as { token: string };
    expect(current.token).not.toBe('stale-token');

    expect(() => acquireAutomationMaintenanceGuard(lockAccess, runtimeDirectory, 'competitor'))
      .toThrow(/already in progress/);
    expect(JSON.parse(fs.readFileSync(guardFile, 'utf8'))).toMatchObject({ token: current.token });
    release();
  });

  it('removes a partially initialized guard when persistence fails', () => {
    const { runtimeDirectory, guardFile, lockAccess } = setup();
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk sync failed'); });

    expect(() => acquireAutomationMaintenanceGuard(lockAccess, runtimeDirectory, 'test'))
      .toThrow(/disk sync failed/);
    expect(fs.existsSync(guardFile)).toBe(false);
  });

  it('removes the guard when the final automation lock read fails', () => {
    const { runtimeDirectory, guardFile, lockAccess } = setup();
    lockAccess.readAutomationLock.mockImplementationOnce(() => { throw new Error('lock read failed'); });

    expect(() => acquireAutomationMaintenanceGuard(lockAccess, runtimeDirectory, 'test'))
      .toThrow(/lock read failed/);
    expect(fs.existsSync(guardFile)).toBe(false);
  });
});
