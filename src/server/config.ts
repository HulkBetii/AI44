import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  SECRET_SETTING_KEYS,
  type PublicRuntimeSettings,
  type RuntimeSettings,
  type SettingsResponse,
  type SettingsUpdateRequest,
} from '../shared/contracts';

interface RuntimeConfigModule {
  ENV_MAP: Record<keyof RuntimeSettings, string>;
  getEnvOverrides(env?: NodeJS.ProcessEnv): Array<keyof RuntimeSettings>;
  loadLocalConfig(options: { projectRoot: string; filePath?: string }): Record<string, unknown>;
  resolveRuntimeConfig(options: {
    projectRoot: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    local?: Record<string, unknown>;
  }): unknown;
  resolveProxyConfig(config: RuntimeSettings, options?: { required?: boolean }): unknown;
}

const runtimeConfig = require(path.join(__dirname, '..', '..', 'runtime-config.js')) as RuntimeConfigModule;

const PublicSettingsShape = {
  sheetId: z.string().trim().min(1),
  sheetName: z.string().trim().min(1),
  serviceAccountPath: z.string().trim().min(1).refine(path.isAbsolute, 'Service account path must be absolute'),
  gpmApiBase: z.string().trim().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:'
        && !url.username
        && !url.password
        && url.pathname === '/'
        && !url.search
        && !url.hash
        && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  }, 'GPM API must be an unauthenticated localhost HTTP URL'),
  defaultIntervalMinutes: z.number().positive().max(180),
  runtimeDirectory: z.string().trim().min(1).refine(path.isAbsolute, 'Runtime directory must be absolute'),
  proxyProvider: z.enum(['tinproxy', 'sp07', 'none']),
};

const SecretSettingsShape = {
  proxyApiKey: z.string().trim().optional(),
  capsolverApiKey: z.string().trim().optional(),
  capbypassApiKey: z.string().trim().optional(),
  twoCaptchaApiKey: z.string().trim().optional(),
  nonecapApiKey: z.string().trim().optional(),
};

const SecretPatchSchema = z.object({
  proxyApiKey: z.string().trim().min(1).nullable().optional(),
  capsolverApiKey: z.string().trim().min(1).nullable().optional(),
  capbypassApiKey: z.string().trim().min(1).nullable().optional(),
  twoCaptchaApiKey: z.string().trim().min(1).nullable().optional(),
  nonecapApiKey: z.string().trim().min(1).nullable().optional(),
}).strict();

const SettingsSchema = z.object({ ...PublicSettingsShape, ...SecretSettingsShape });
const SettingsUpdateSchema = z.object({
  ...PublicSettingsShape,
  secrets: SecretPatchSchema.optional(),
}).strict();

export const SETTINGS_ENV_MAP = runtimeConfig.ENV_MAP;

function isEnvironmentOverride(key: keyof RuntimeSettings): boolean {
  return process.env[SETTINGS_ENV_MAP[key]] !== undefined;
}

export function runtimeEnvironment(settings: RuntimeSettings): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, envName] of Object.entries(SETTINGS_ENV_MAP) as Array<[keyof RuntimeSettings, string]>) {
    const value = settings[key];
    if (value !== undefined) environment[envName] = String(value);
  }
  return environment;
}

export function runtimeSecretValues(settings: RuntimeSettings): string[] {
  return SECRET_SETTING_KEYS
    .map((key) => settings[key])
    .filter((value): value is string => Boolean(value));
}

export class ConfigStore {
  private readonly filePath: string;
  private rawValues: Record<string, unknown>;
  private values: RuntimeSettings;

  constructor(private readonly projectRoot: string) {
    this.filePath = path.join(projectRoot, 'config.local.json');
    this.rawValues = runtimeConfig.loadLocalConfig({ projectRoot, filePath: this.filePath });
    this.values = this.resolve(this.rawValues, process.env);
  }

  private resolve(
    local: Record<string, unknown>,
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
    validateProxy = true,
  ): RuntimeSettings {
    const settings = SettingsSchema.parse(runtimeConfig.resolveRuntimeConfig({
      projectRoot: this.projectRoot,
      env,
      local,
    }));
    if (validateProxy && settings.proxyProvider !== 'none') {
      runtimeConfig.resolveProxyConfig(settings, { required: true });
    }
    return settings;
  }

  private persist(rawValues: Record<string, unknown>): void {
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let completed = false;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(rawValues, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.filePath);
      completed = true;
    } finally {
      if (!completed) {
        try { fs.unlinkSync(temporary); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }

  get(): RuntimeSettings {
    return { ...this.values };
  }

  response(canEdit: boolean): SettingsResponse {
    const publicValues = Object.fromEntries(
      Object.entries(this.values).filter(([key]) => !SECRET_SETTING_KEYS.includes(key as typeof SECRET_SETTING_KEYS[number])),
    ) as PublicRuntimeSettings;

    return {
      values: publicValues,
      configuredSecrets: SECRET_SETTING_KEYS.filter((key) => Boolean(this.values[key])),
      envOverrides: runtimeConfig.getEnvOverrides(process.env),
      canEdit,
    };
  }

  private prepareUpdate(candidate: SettingsUpdateRequest): {
    nextRaw: Record<string, unknown>;
    effective: RuntimeSettings;
  } {
    const { secrets, ...publicValues } = SettingsUpdateSchema.parse(candidate);
    const nextRaw = { ...this.rawValues };

    for (const [key, value] of Object.entries(publicValues) as Array<[keyof PublicRuntimeSettings, unknown]>) {
      if (!isEnvironmentOverride(key)) nextRaw[key] = value;
    }
    for (const key of SECRET_SETTING_KEYS) {
      if (!secrets || !(key in secrets) || isEnvironmentOverride(key)) continue;
      const value = secrets[key];
      if (value === null) delete nextRaw[key];
      else if (value !== undefined) nextRaw[key] = value;
    }

    // Environment removal must always leave a complete, runnable local fallback.
    this.resolve(nextRaw, {});
    const effective = this.resolve(nextRaw, process.env);
    return { nextRaw, effective };
  }

  previewUpdate(candidate: SettingsUpdateRequest): RuntimeSettings {
    return { ...this.prepareUpdate(candidate).effective };
  }

  update(candidate: SettingsUpdateRequest): RuntimeSettings {
    const { nextRaw, effective } = this.prepareUpdate(candidate);
    this.persist(nextRaw);
    this.rawValues = nextRaw;
    this.values = effective;
    return this.get();
  }

  validate(candidate: unknown): SettingsUpdateRequest {
    return SettingsUpdateSchema.parse(candidate);
  }
}
