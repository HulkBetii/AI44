import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryService } from './recovery';

const directories: string[] = [];
const journal = require('../../recovery-journal.js') as {
  prepareRecovery(entry: Record<string, unknown>, options: Record<string, unknown>): { id: string };
  confirmRecovery(id: string, options: Record<string, unknown>): void;
};

function setup(
  rows = [{ rowIndex: 2, email: 'operator@example.com' }],
  updatePasswordImplementation: (rowIndex: number, password: string) => Promise<void> = async () => undefined,
) {
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-recovery-'));
  directories.push(runtimeDirectory);
  const updatePassword = vi.fn(updatePasswordImplementation);
  const updatePasswordByEmail = vi.fn(async (email: string, password: string) => {
    const normalizedEmail = email.trim().toLowerCase();
    const matches = rows.filter((candidate) => candidate.email.trim().toLowerCase() === normalizedEmail);
    if (matches.length !== 1) throw new Error(`unsafe identity: found ${matches.length}`);
    await updatePassword(matches[0].rowIndex, password);
    return matches[0];
  });
  const accountService = {
    rows: async () => rows,
    updatePassword,
    updatePasswordByEmail,
  };
  const service = new RecoveryService(
    process.cwd(),
    { get: () => ({ runtimeDirectory }) } as never,
    accountService as never,
  );
  const options = { projectRoot: process.cwd(), runtimeDirectory };
  return { service, updatePassword, options };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('RecoveryService', () => {
  it('lists prepared recovery entries without exposing the password', () => {
    const { service, options } = setup();
    journal.prepareRecovery({
      operation: 'signup',
      email: 'operator@example.com',
      originalRowIndex: 2,
      elevenPassword: 'opaque-password',
    }, options);

    const response = service.list();

    expect(response.entries).toHaveLength(1);
    expect(response.entries[0]).toMatchObject({ state: 'prepared', operation: 'signup', originalRowIndex: 2 });
    expect(JSON.stringify(response)).not.toContain('opaque-password');
  });

  it('allows an operator to sync a prepared entry by unique email', async () => {
    const { service, updatePassword, options } = setup();
    const entry = journal.prepareRecovery({
      operation: 'resetPassword',
      email: 'operator@example.com',
      originalRowIndex: 49,
      elevenPassword: 'new-password',
    }, options);

    await expect(service.sync(entry.id)).resolves.toBe(true);
    expect(updatePassword).toHaveBeenCalledWith(2, 'new-password');
    expect(service.pendingCount()).toBe(0);
  });

  it('refuses manual sync when an email is duplicated in the Sheet', async () => {
    const { service, updatePassword, options } = setup([
      { rowIndex: 2, email: 'operator@example.com' },
      { rowIndex: 3, email: 'OPERATOR@example.com' },
    ]);
    const entry = journal.prepareRecovery({
      operation: 'signup', email: 'operator@example.com', originalRowIndex: 2, elevenPassword: 'new-password',
    }, options);

    await expect(service.sync(entry.id)).rejects.toThrow(/xuất hiện nhiều lần/);
    expect(updatePassword).not.toHaveBeenCalled();
    expect(service.pendingCount()).toBe(1);
  });

  it('auto-syncs only confirmed entries before a job starts', async () => {
    const { service, updatePassword, options } = setup();
    const confirmed = journal.prepareRecovery({
      operation: 'signup', email: 'operator@example.com', originalRowIndex: 2, elevenPassword: 'confirmed-password',
    }, options);
    journal.confirmRecovery(confirmed.id, options);

    await service.prepareForJob();

    expect(updatePassword).toHaveBeenCalledWith(2, 'confirmed-password');
    expect(service.pendingCount()).toBe(0);
  });

  it('blocks jobs while a prepared mutation remains unresolved', async () => {
    const { service, options } = setup();
    journal.prepareRecovery({
      operation: 'signup', email: 'operator@example.com', originalRowIndex: 2, elevenPassword: 'pending-password',
    }, options);

    await expect(service.prepareForJob()).rejects.toThrow(/prepared mutation/);
  });

  it('redacts opaque passwords echoed by manual Sheet update failures', async () => {
    const password = 'opaque-manual-password';
    const { service, options } = setup(undefined, async () => {
      throw new Error(`provider rejected ${password}`);
    });
    const entry = journal.prepareRecovery({
      operation: 'resetPassword', email: 'operator@example.com', originalRowIndex: 2, elevenPassword: password,
    }, options);

    await expect(service.sync(entry.id)).rejects.toThrow('provider rejected [REDACTED]');
    expect(service.pendingCount()).toBe(1);
  });

  it('redacts opaque passwords echoed while reconciling confirmed entries', async () => {
    const password = 'opaque-confirmed-password';
    const { service, options } = setup(undefined, async () => {
      throw new Error(`provider rejected ${password}`);
    });
    const entry = journal.prepareRecovery({
      operation: 'signup', email: 'operator@example.com', originalRowIndex: 2, elevenPassword: password,
    }, options);
    journal.confirmRecovery(entry.id, options);

    let caught: unknown;
    try {
      await service.reconcileConfirmed();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('Could not sync confirmed recovery');
    expect(message).not.toContain(password);
    expect(service.pendingCount()).toBe(1);
  });
});
