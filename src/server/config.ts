import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RuntimeSettings, SettingsResponse } from '../shared/contracts';

const SettingsSchema = z.object({
  sheetId: z.string().trim().min(1),
  sheetName: z.string().trim().min(1),
  serviceAccountPath: z.string().trim().min(1).refine(path.isAbsolute, 'Service account path must be absolute'),
  gpmApiBase: z.string().url().refine((value) => {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  }, 'GPM API must point to localhost'),
  defaultIntervalMinutes: z.number().positive().max(180),
  runtimeDirectory: z.string().trim().min(1).refine(path.isAbsolute, 'Runtime directory must be absolute'),
});

const ENV_MAP: Record<keyof RuntimeSettings, string> = {
  sheetId: 'MAIL_TEMP_SHEET_ID',
  sheetName: 'MAIL_TEMP_SHEET_NAME',
  serviceAccountPath: 'GOOGLE_SERVICE_ACCOUNT_PATH',
  gpmApiBase: 'GPM_API_BASE',
  defaultIntervalMinutes: 'MAIL_TEMP_DEFAULT_INTERVAL',
  runtimeDirectory: 'MAIL_TEMP_RUNTIME_DIR',
};

export class ConfigStore {
  private readonly filePath: string;
  private values: RuntimeSettings;

  constructor(private readonly projectRoot: string) {
    this.filePath = path.join(projectRoot, 'config.local.json');
    this.values = this.load();
  }

  private defaults(): RuntimeSettings {
    return {
      sheetId: '1nNAzzC34zSvX2S_AJ4jB6njhKnKRWs8KeZ0mJ5oSkTU',
      sheetName: 'hotmail',
      serviceAccountPath: path.join(this.projectRoot, 'service-account.json'),
      gpmApiBase: 'http://127.0.0.1:19995',
      defaultIntervalMinutes: 1,
      runtimeDirectory: path.join(this.projectRoot, '.runtime'),
    };
  }

  private load(): RuntimeSettings {
    let local: Partial<RuntimeSettings> = {};
    if (fs.existsSync(this.filePath)) {
      local = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<RuntimeSettings>;
    }

    const merged = { ...this.defaults(), ...local } as Record<keyof RuntimeSettings, string | number>;
    for (const [key, envName] of Object.entries(ENV_MAP) as Array<[keyof RuntimeSettings, string]>) {
      const envValue = process.env[envName];
      if (envValue === undefined) continue;
      merged[key] = key === 'defaultIntervalMinutes' ? Number(envValue) : envValue;
    }
    return SettingsSchema.parse(merged);
  }

  get(): RuntimeSettings {
    return { ...this.values };
  }

  response(canEdit: boolean): SettingsResponse {
    return {
      values: this.get(),
      envOverrides: (Object.entries(ENV_MAP) as Array<[keyof RuntimeSettings, string]>)
        .filter(([, envName]) => process.env[envName] !== undefined)
        .map(([key]) => key),
      canEdit,
    };
  }

  update(candidate: RuntimeSettings): RuntimeSettings {
    const parsed = SettingsSchema.parse(candidate);
    const persisted = { ...parsed } as Partial<RuntimeSettings>;
    for (const [key, envName] of Object.entries(ENV_MAP) as Array<[keyof RuntimeSettings, string]>) {
      if (process.env[envName] !== undefined) delete persisted[key];
    }
    fs.writeFileSync(this.filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    this.values = this.load();
    return this.get();
  }

  validate(candidate: unknown): RuntimeSettings {
    return SettingsSchema.parse(candidate);
  }
}
