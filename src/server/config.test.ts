import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, runtimeEnvironment, runtimeSecretValues } from './config';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MAIL_TEMP_SHEET_NAME;
  delete process.env.MAIL_TEMP_PROXY_PROVIDER;
  delete process.env.MAIL_TEMP_PROXY_API_KEY;
  delete process.env.CAPSOLVER_API_KEY;
  delete process.env.NONECAP_API_KEY;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('uses no proxy by default for existing configuration files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.local.json'), JSON.stringify({ sheetName: 'hotmail' }));

    expect(new ConfigStore(directory).get().proxyProvider).toBe('none');
  });

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

  it('rejects credentials and non-HTTP schemes in the public GPM endpoint', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    const store = new ConfigStore(directory);

    expect(() => store.validate({
      ...store.response(true).values,
      gpmApiBase: 'http://operator:secret@localhost:19995',
    })).toThrow(/unauthenticated localhost HTTP URL/);
    expect(() => store.validate({
      ...store.response(true).values,
      gpmApiBase: 'ftp://localhost:19995',
    })).toThrow(/unauthenticated localhost HTTP URL/);
    expect(() => store.validate({
      ...store.response(true).values,
      gpmApiBase: 'http://localhost:19995/untrusted-prefix',
    })).toThrow(/unauthenticated localhost HTTP URL/);
    expect(() => store.validate({
      ...store.response(true).values,
      gpmApiBase: 'not-a-url',
    })).toThrow(/unauthenticated localhost HTTP URL/);
  });

  it('reports configured secrets without returning their values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.local.json'), JSON.stringify({
      proxyApiKey: 'local-proxy-secret',
      capsolverApiKey: 'local-captcha-secret',
      nonecapApiKey: 'local-nonecap-secret',
    }));
    process.env.CAPSOLVER_API_KEY = 'environment-captcha-secret';

    const response = new ConfigStore(directory).response(true);

    expect(response.configuredSecrets).toEqual(expect.arrayContaining(['proxyApiKey', 'capsolverApiKey', 'nonecapApiKey']));
    expect(response.envOverrides).toContain('capsolverApiKey');
    expect(response.values).not.toHaveProperty('proxyApiKey');
    expect(response.values).not.toHaveProperty('capsolverApiKey');
    expect(JSON.stringify(response)).not.toContain('local-proxy-secret');
    expect(JSON.stringify(response)).not.toContain('environment-captcha-secret');
    expect(JSON.stringify(response)).not.toContain('local-nonecap-secret');
  });

  it('keeps, replaces and clears secrets through explicit patches', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.local.json'), JSON.stringify({
      proxyApiKey: 'keep-this-secret',
      capsolverApiKey: 'replace-this-secret',
    }));
    const store = new ConfigStore(directory);

    store.update({
      ...store.response(true).values,
      secrets: { capsolverApiKey: 'replacement-secret' },
    });
    expect(store.get().proxyApiKey).toBe('keep-this-secret');
    expect(store.get().capsolverApiKey).toBe('replacement-secret');

    store.update({
      ...store.response(true).values,
      secrets: { proxyApiKey: null },
    });
    expect(store.get().proxyApiKey).toBeUndefined();
    expect(store.response(true).configuredSecrets).not.toContain('proxyApiKey');
  });

  it('preserves local fallback values while environment overrides are active', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    const file = path.join(directory, 'config.local.json');
    fs.writeFileSync(file, JSON.stringify({
      sheetName: 'local-name',
      capsolverApiKey: 'local-fallback-secret',
    }));
    process.env.MAIL_TEMP_SHEET_NAME = 'environment-name';
    process.env.CAPSOLVER_API_KEY = 'environment-secret';
    const store = new ConfigStore(directory);

    store.update({
      ...store.response(true).values,
      sheetId: 'changed-sheet-id',
    });

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(persisted.sheetName).toBe('local-name');
    expect(persisted.capsolverApiKey).toBe('local-fallback-secret');
    delete process.env.MAIL_TEMP_SHEET_NAME;
    delete process.env.CAPSOLVER_API_KEY;
    const restarted = new ConfigStore(directory);
    expect(restarted.get().sheetName).toBe('local-name');
    expect(restarted.get().capsolverApiKey).toBe('local-fallback-secret');
  });

  it('validates the local proxy fallback even while the provider is overridden by the environment', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.local.json'), JSON.stringify({
      proxyProvider: 'sp07',
      proxyApiKey: 'local-proxy-secret',
    }));
    process.env.MAIL_TEMP_PROXY_PROVIDER = 'none';
    const store = new ConfigStore(directory);

    expect(() => store.update({
      ...store.response(true).values,
      secrets: { proxyApiKey: null },
    })).toThrow(/requires proxyApiKey/);
    expect(store.get().proxyApiKey).toBe('local-proxy-secret');
  });

  it('removes temporary secret files and keeps the original config when persistence fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    const file = path.join(directory, 'config.local.json');
    fs.writeFileSync(file, `${JSON.stringify({ capsolverApiKey: 'original-secret' }, null, 2)}\n`);
    const original = fs.readFileSync(file, 'utf8');
    const store = new ConfigStore(directory);
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk sync failed'); });

    expect(() => store.update({
      ...store.response(true).values,
      secrets: { capsolverApiKey: 'replacement-secret' },
    })).toThrow(/disk sync failed/);

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(store.get().capsolverApiKey).toBe('original-secret');
  });

  it('requires an API key for an enabled proxy provider', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    const store = new ConfigStore(directory);

    expect(() => store.update({
      ...store.response(true).values,
      proxyProvider: 'sp07',
    })).toThrow(/requires proxyApiKey/);

    const updated = store.update({
      ...store.response(true).values,
      proxyProvider: 'sp07',
      secrets: { proxyApiKey: 'proxy-secret' },
    });
    expect(updated.proxyProvider).toBe('sp07');
    expect(updated.proxyApiKey).toBe('proxy-secret');
  });

  it('passes effective global settings to workers and redacts every configured key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-config-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.local.json'), JSON.stringify({
      proxyProvider: 'sp07',
      proxyApiKey: 'proxy-secret',
      nonecapApiKey: 'nonecap-secret',
    }));
    const settings = new ConfigStore(directory).get();

    expect(runtimeEnvironment(settings)).toMatchObject({
      MAIL_TEMP_PROXY_PROVIDER: 'sp07',
      MAIL_TEMP_PROXY_API_KEY: 'proxy-secret',
      NONECAP_API_KEY: 'nonecap-secret',
    });
    expect(runtimeSecretValues(settings)).toEqual(expect.arrayContaining(['proxy-secret', 'nonecap-secret']));
  });
});
