import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(() => {
  delete process.env.MAIL_TEMP_RUNTIME_DIR;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('automation lock', () => {
  it('prevents a second owner while the first process holds the lock', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-lock-'));
    directories.push(directory);
    process.env.MAIL_TEMP_RUNTIME_DIR = directory;
    const lock = require('../../automation-lock.js') as {
      acquireAutomationLock(owner: string): () => void;
      readAutomationLock(directory?: string): { status: string };
    };
    const release = lock.acquireAutomationLock('test-owner');
    expect(lock.readAutomationLock(directory).status).toBe('busy');
    expect(() => lock.acquireAutomationLock('second-owner')).toThrow(/already running/);
    release();
    expect(lock.readAutomationLock(directory).status).toBe('free');
  });
});
