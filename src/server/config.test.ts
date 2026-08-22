import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from './config';

const directories: string[] = [];

afterEach(() => {
  delete process.env.MAIL_TEMP_SHEET_NAME;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('applies environment values after local configuration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.local.json'), JSON.stringify({ sheetName: 'local-name' }));
    process.env.MAIL_TEMP_SHEET_NAME = 'env-name';
    const store = new ConfigStore(directory);
    expect(store.get().sheetName).toBe('env-name');
    expect(store.response(true).envOverrides).toContain('sheetName');
  });

  it('rejects relative filesystem paths', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    const store = new ConfigStore(directory);
    expect(() => store.validate({
      ...store.get(),
      runtimeDirectory: '.runtime',
    })).toThrow(/Runtime directory must be absolute/);
  });
});
