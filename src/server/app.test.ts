import { EventEmitter } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '../shared/contracts';
import { AccountIdentityConflictError } from './account-service';
import { createApp } from './app';
import { AutomationLockConflictError } from './job-manager';

function testApp(
  events: JobEvent[] = [],
  focused = true,
  recoveryOverrides: Record<string, unknown> = {},
  managerOverrides: Record<string, unknown> = {},
  lockStatus: 'free' | 'busy' | 'stale' = 'free',
  lockGuardAcquirer: (runtimeDirectory: string) => () => void = () => () => undefined,
  configOverrides: Record<string, unknown> = {},
  jobStoreOverrides: Record<string, unknown> = {},
  accountServiceOverrides: Record<string, unknown> = {},
  automationAdmissionGuard: (runtimeDirectory: string) => void = () => undefined,
) {
  const manager = Object.assign(new EventEmitter(), {
    active: () => null,
    queueLength: () => 0,
    isCleanupBlocked: () => false,
    canEditSettings: () => true,
    canMutateRecovery: () => true,
    preview: async () => ({ workflowId: 'signup', accepted: [], rejected: [], phases: [] }),
    create: async () => ({}),
    cancel: async () => ({}),
    focus: async () => focused,
  }, managerOverrides);
  const settings = {
    sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
    gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: __dirname, proxyProvider: 'none' as const,
    capsolverApiKey: 'server-only-secret',
  };
  const publicSettings = {
    sheetId: settings.sheetId, sheetName: settings.sheetName, serviceAccountPath: settings.serviceAccountPath,
    gpmApiBase: settings.gpmApiBase, defaultIntervalMinutes: settings.defaultIntervalMinutes, runtimeDirectory: settings.runtimeDirectory,
    proxyProvider: settings.proxyProvider,
  };
  return createApp({
    projectRoot: process.cwd(),
    configStore: Object.assign({
      get: () => settings,
      response: (canEdit: boolean) => ({ values: publicSettings, configuredSecrets: ['capsolverApiKey'], envOverrides: [], canEdit }),
      validate: (value: unknown) => value,
      previewUpdate: () => settings,
      update: () => settings,
    }, configOverrides) as never,
    accountService: Object.assign({
      summaries: async () => [], rows: async () => [], detail: async () => null,
      reveal: async () => 'secret-value', invalidate: () => undefined, invalidateRows: () => undefined,
    }, accountServiceOverrides) as never,
    jobStore: Object.assign({
      list: () => events.length ? [{ id: 'job-1' }] : [], get: () => null, readEvents: () => events, readLog: () => '',
      lastRunByRow: () => new Map(), jobsForRow: () => [], artifactPath: () => null,
      setRuntimeDirectory: () => undefined, runtimesByRow: () => new Map(),
    }, jobStoreOverrides) as never,
    jobManager: manager as never,
    recoveryService: Object.assign({
      list: () => ({ entries: [] }), pendingCount: () => 0, reconcileConfirmed: async () => [],
      sync: async () => false, discard: async () => false,
    }, recoveryOverrides) as never,
    lockReader: () => ({ status: lockStatus }),
    lockGuardAcquirer,
    automationAdmissionGuard,
  });
}

describe('server API', () => {
  it('returns sanitized settings with no-store headers', async () => {
    const response = await request(testApp()).get('/api/settings');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.configuredSecrets).toContain('capsolverApiKey');
    expect(response.body.values).not.toHaveProperty('capsolverApiKey');
    expect(JSON.stringify(response.body)).not.toContain('server-only-secret');
  });

  it('returns a sanitized settings response after updates', async () => {
    const response = await request(testApp()).put('/api/settings').send({
      sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
      gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: __dirname, proxyProvider: 'none',
      secrets: { capsolverApiKey: 'replacement-secret' },
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.values).not.toHaveProperty('capsolverApiKey');
    expect(JSON.stringify(response.body)).not.toContain('replacement-secret');
  });

  it('keeps rejected settings updates out of caches', async () => {
    const response = await request(testApp([], true, {}, { canEditSettings: () => false }))
      .put('/api/settings').send({});

    expect(response.status).toBe(409);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('disables and rejects settings changes while the external automation lock is busy', async () => {
    const app = testApp([], true, {}, {}, 'busy');

    const settings = await request(app).get('/api/settings');
    const update = await request(app).put('/api/settings').send({});

    expect(settings.status).toBe(200);
    expect(settings.body.canEdit).toBe(false);
    expect(update.status).toBe(409);
  });

  it('returns 409 when automation acquires the lock after the settings read check', async () => {
    const acquire = () => { throw new Error('Automation is already running'); };

    const update = await request(testApp([], true, {}, {}, 'free', acquire))
      .put('/api/settings').send({});

    expect(update.status).toBe(409);
    expect(update.body.error).toMatch(/automation lock/);
  });

  it('rechecks job and recovery state after acquiring the settings lock', async () => {
    const canEditSettings = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const release = vi.fn();

    const update = await request(testApp([], true, {}, { canEditSettings }, 'free', () => release))
      .put('/api/settings').send({});

    expect(update.status).toBe(409);
    expect(release).toHaveBeenCalledOnce();
  });

  it('guards both current and target runtime directories before committing settings', async () => {
    const currentRuntime = path.join(__dirname, 'runtime-current');
    const targetRuntime = path.join(__dirname, 'runtime-target');
    const current = {
      sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
      gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: currentRuntime, proxyProvider: 'none',
    };
    const candidate = { ...current, runtimeDirectory: targetRuntime };
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const acquire = vi.fn((_runtimeDirectory: string) => {
      const release = vi.fn();
      releases.push(release);
      return release;
    });
    const update = vi.fn(() => candidate);

    const response = await request(testApp([], true, {}, {}, 'free', acquire, {
      get: () => current,
      previewUpdate: () => candidate,
      update,
    })).put('/api/settings').send(current);

    expect(response.status).toBe(200);
    expect(acquire.mock.calls.map(([directory]) => directory)).toEqual([
      path.resolve(currentRuntime),
      path.resolve(targetRuntime),
    ].sort());
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not commit settings when the target runtime lock is unavailable', async () => {
    const targetRuntime = path.join(__dirname, 'runtime-target');
    const update = vi.fn();
    const release = vi.fn();
    const acquire = vi.fn((directory: string) => {
      if (path.resolve(directory) === path.resolve(targetRuntime)) throw new Error('target busy');
      return release;
    });

    const response = await request(testApp([], true, {}, {}, 'free', acquire, {
      previewUpdate: () => ({
        sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
        gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: targetRuntime, proxyProvider: 'none',
      }),
      update,
    })).put('/api/settings').send({});

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not commit or initialize a target runtime with pending recovery', async () => {
    const targetRuntime = path.join(__dirname, 'runtime-target');
    const update = vi.fn();
    const setRuntimeDirectory = vi.fn();

    const response = await request(testApp([], true, {
      pendingCount: (runtimeDirectory?: string) => runtimeDirectory === targetRuntime ? 1 : 0,
    }, {}, 'free', undefined, {
      previewUpdate: () => ({
        sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
        gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: targetRuntime, proxyProvider: 'none',
      }),
      update,
    }, { setRuntimeDirectory })).put('/api/settings').send({});

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
    expect(setRuntimeDirectory).not.toHaveBeenCalled();
  });

  it('does not allow settings to escape an unresolved uncertain GPM marker', async () => {
    const targetRuntime = path.join(__dirname, 'runtime-target');
    const update = vi.fn();
    const admissionGuard = vi.fn((runtimeDirectory: string) => {
      if (runtimeDirectory === targetRuntime) throw new Error('uncertain marker');
    });

    const response = await request(testApp([], true, {}, {}, 'free', undefined, {
      previewUpdate: () => ({
        sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
        gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: targetRuntime, proxyProvider: 'none',
      }),
      update,
    }, {}, {}, admissionGuard)).put('/api/settings').send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/GPM create/);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports settings read-only while the current runtime has an uncertain GPM marker', async () => {
    const admissionGuard = () => { throw new Error('uncertain marker'); };

    const settings = await request(testApp(
      [], true, {}, {}, 'free', undefined, {}, {}, {}, admissionGuard,
    )).get('/api/settings');

    expect(settings.status).toBe(200);
    expect(settings.body.canEdit).toBe(false);
  });

  it('returns secret responses with no-store headers', async () => {
    const reveal = vi.fn(async () => 'secret-value');
    const response = await request(testApp([], true, {}, {}, 'free', undefined, {}, {}, { reveal }))
      .post('/api/accounts/2/secrets/apiKey/reveal')
      .send({ expectedEmail: 'Operator@Example.com' });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.value).toBe('secret-value');
    expect(reveal).toHaveBeenCalledWith(2, 'apiKey', 'Operator@Example.com');
  });

  it('requires the expected account identity before loading account details', async () => {
    const rows = vi.fn();
    const missingIdentity = await request(testApp([], true, {}, {}, 'free', undefined, {}, {}, {
      rows,
    })).get('/api/accounts/25');

    expect(missingIdentity.status).toBe(400);
    expect(rows).not.toHaveBeenCalled();
  });

  it('refreshes account identity and fails closed when the email moved or is duplicated', async () => {
    const rows = vi.fn()
      .mockResolvedValueOnce([
        { rowIndex: 25, email: 'replacement@example.com' },
        { rowIndex: 49, email: 'operator@example.com' },
      ])
      .mockResolvedValueOnce([
        { rowIndex: 25, email: 'operator@example.com' },
        { rowIndex: 49, email: ' OPERATOR@example.com ' },
      ]);
    const detail = vi.fn();
    const app = testApp([], true, {}, {}, 'free', undefined, {}, {}, { rows, detail });

    const moved = await request(app).get('/api/accounts/25').query({ expectedEmail: 'operator@example.com' });
    const duplicated = await request(app).get('/api/accounts/25').query({ expectedEmail: 'operator@example.com' });

    expect(moved.status).toBe(409);
    expect(duplicated.status).toBe(409);
    expect(rows).toHaveBeenNthCalledWith(1, true);
    expect(rows).toHaveBeenNthCalledWith(2, true);
    expect(detail).not.toHaveBeenCalled();
  });

  it('requires account identity and returns a no-store conflict when the row moved', async () => {
    const missingIdentity = await request(testApp()).post('/api/accounts/2/secrets/apiKey/reveal').send({});
    const movedIdentity = await request(testApp([], true, {}, {}, 'free', undefined, {}, {}, {
      reveal: async () => { throw new AccountIdentityConflictError('Account identity changed'); },
    })).post('/api/accounts/2/secrets/apiKey/reveal').send({ expectedEmail: 'operator@example.com' });

    expect(missingIdentity.status).toBe(400);
    expect(missingIdentity.headers['cache-control']).toContain('no-store');
    expect(movedIdentity.status).toBe(409);
    expect(movedIdentity.headers['cache-control']).toContain('no-store');
  });

  it('returns sanitized recovery entries and pending health count', async () => {
    const entry = {
      id: '11111111-1111-4111-8111-111111111111',
      state: 'prepared',
      email: 'operator@example.com',
      originalRowIndex: 2,
      operation: 'signup',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const app = testApp([], true, {
      list: () => ({ entries: [entry] }),
      pendingCount: () => 1,
    });

    const recovery = await request(app).get('/api/recovery');
    const health = await request(app).get('/api/health');

    expect(recovery.status).toBe(200);
    expect(recovery.headers['cache-control']).toContain('no-store');
    expect(recovery.body).toEqual({ entries: [entry] });
    expect(JSON.stringify(recovery.body)).not.toContain('server-only-secret');
    expect(health.body.recoveryPendingCount).toBe(1);
    expect(health.body.status).toBe('degraded');
  });

  it('syncs and discards recovery entries with no-store responses', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const sync = await request(testApp([], true, { sync: async () => true }))
      .post(`/api/recovery/${id}/sync`).send({});
    const discard = await request(testApp([], true, { discard: async () => true }))
      .delete(`/api/recovery/${id}`).send({ confirm: true });

    expect(sync.status).toBe(200);
    expect(sync.headers['cache-control']).toContain('no-store');
    expect(discard.status).toBe(200);
    expect(discard.headers['cache-control']).toContain('no-store');
  });

  it('rejects recovery mutations while a job or automation is active', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const sync = vi.fn(async () => true);
    const jobBusy = await request(testApp([], true, { sync }, { canMutateRecovery: () => false }))
      .post(`/api/recovery/${id}/sync`).send({});
    const automationBusy = await request(testApp([], true, { sync }, {}, 'busy'))
      .post(`/api/recovery/${id}/sync`).send({});

    expect(jobBusy.status).toBe(409);
    expect(automationBusy.status).toBe(409);
    expect(sync).not.toHaveBeenCalled();
  });

  it('rechecks job state after acquiring the recovery guard', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const canMutateRecovery = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const release = vi.fn();
    const sync = vi.fn(async () => true);

    const response = await request(testApp([], true, { sync }, { canMutateRecovery }, 'free', () => release))
      .post(`/api/recovery/${id}/sync`).send({});

    expect(response.status).toBe(409);
    expect(sync).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not reconcile recovery from health while jobs or automation locks are active', async () => {
    const reconcileConfirmed = vi.fn(async () => []);
    const lockGuardAcquirer = vi.fn(() => () => undefined);

    const jobBusy = await request(testApp([], true, {
      pendingCount: () => 1,
      reconcileConfirmed,
    }, { canMutateRecovery: () => false }, 'free', lockGuardAcquirer)).get('/api/health');
    const automationBusy = await request(testApp([], true, {
      pendingCount: () => 1,
      reconcileConfirmed,
    }, {}, 'busy', lockGuardAcquirer)).get('/api/health');

    expect(jobBusy.body.status).toBe('degraded');
    expect(automationBusy.body.status).toBe('degraded');
    expect(reconcileConfirmed).not.toHaveBeenCalled();
    expect(lockGuardAcquirer).not.toHaveBeenCalled();
  });

  it('requires discard confirmation and keeps recovery errors out of caches', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const missing = await request(testApp()).post(`/api/recovery/${id}/sync`).send({});
    const unconfirmed = await request(testApp()).delete(`/api/recovery/${id}`).send({ confirm: false });

    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toContain('no-store');
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.headers['cache-control']).toContain('no-store');
  });

  it('redacts configured opaque keys from server errors', async () => {
    const response = await request(testApp([], true, {}, {
      preview: async () => { throw new Error('provider rejected server-only-secret'); },
    })).post('/api/jobs/preview').send({
      workflowId: 'signup',
      selection: { mode: 'allEligible' },
      options: { intervalMinutes: 1 },
    });

    expect(response.status).toBe(500);
    expect(response.body.error).not.toContain('server-only-secret');
    expect(response.body.error).toContain('[REDACTED]');
  });

  it('returns a conflict when job admission detects an external automation owner', async () => {
    const response = await request(testApp([], true, {}, {
      create: async () => { throw new AutomationLockConflictError('Automation lock đang busy'); },
    })).post('/api/jobs').send({
      workflowId: 'signup', selection: { mode: 'allEligible' }, options: { intervalMinutes: 1 },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/lock đang busy/);
  });

  it('redacts encoded opaque keys from legacy job metadata, events and logs at read time', async () => {
    const secret = 'opaque /+? "quoted"\\tail';
    const uriEncoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams({ secret }).toString().slice('secret='.length);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const event: JobEvent = {
      id: 'job-1:1', jobId: 'job-1', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z',
      type: 'account.failed', level: 'error', message: `provider rejected ${uriEncoded}`,
      data: { detail: `form ${formEncoded}` },
    };
    const response = await request(testApp([event], true, {}, {}, 'free', undefined, {
      get: () => ({ capsolverApiKey: secret }),
    }, {
      get: () => ({ id: 'job-1', lastMessage: `failed ${jsonEscaped}` }),
      readLog: () => `legacy log ${secret}\nhttps://proxy.tinproxy.com/api/changeProxy.php?key=unconfigured-tinproxy-key`,
    })).get('/api/jobs/job-1');

    expect(response.status).toBe(200);
    expect(response.body.job.lastMessage).toBe('failed [REDACTED]');
    expect(response.body.events[0].message).toBe('provider rejected [REDACTED]');
    expect(response.body.events[0].data.detail).toBe('form [REDACTED]');
    expect(response.body.log).toBe([
      'legacy log [REDACTED]',
      'https://proxy.tinproxy.com/api/changeProxy.php?key=[REDACTED]',
    ].join('\n'));
  });

  it('attributes new-job failures by email when the event row moved after worker start', async () => {
    const currentAccount = { rowIndex: 49, email: 'operator@example.com' };
    const historicalJob = {
      id: 'job-identity',
      acceptedRows: [25],
      acceptedAccounts: [{ rowIndex: 25, email: 'Operator@Example.com' }],
      currentStep: 'login',
    };
    const events: JobEvent[] = [{
      id: 'job-identity:1', jobId: 'job-identity', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z',
      type: 'account.failed', level: 'error', rowIndex: 37, message: 'failed moved account',
      data: { email: ' OPERATOR@example.com ', step: 'submit' },
    }];
    const detail = { lastFailure: null };

    const response = await request(testApp([], true, {}, {}, 'free', undefined, {}, {
      jobsForRow: () => [historicalJob],
      rowIndexForAccount: () => 25,
      readEvents: () => events,
    }, {
      rows: async () => [currentAccount],
      detail: async () => detail,
    })).get('/api/accounts/49').query({ expectedEmail: 'operator@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.lastFailure).toMatchObject({
      jobId: 'job-identity', message: 'failed moved account', step: 'submit',
    });
  });

  it('rejects mutating requests from a non-local origin', async () => {
    const response = await request(testApp())
      .post('/api/jobs/preview')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(response.status).toBe(403);
  });

  it('rejects a localhost origin when it does not match the request host', async () => {
    const response = await request(testApp())
      .post('/api/jobs/preview')
      .set('Host', '127.0.0.1:4317')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({});
    expect(response.status).toBe(403);
  });

  it('accepts only secret-free preview requests', async () => {
    const response = await request(testApp()).post('/api/jobs/preview').send({
      workflowId: 'signup',
      selection: { mode: 'allEligible' },
      options: {
        proxyMode: 'override',
        intervalMinutes: 1,
        hasProxyTokenOverride: true,
        proxyTokenOverride: 'secret-must-not-enter-preview',
      },
    });
    expect(response.status).toBe(400);
  });

  it('returns the best-effort browser focus result', async () => {
    const response = await request(testApp([], false)).post('/api/jobs/job-1/focus-browser');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ focused: false });
  });

  it('streams named job events, excludes legacy logs and marks replay completion', async () => {
    const events: JobEvent[] = [
      {
        id: 'legacy-log', jobId: 'job-1', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z',
        level: 'info', type: 'log', message: 'old verbose log',
      },
      {
        id: 'structured-1', jobId: 'job-1', sequence: 2, timestamp: '2026-01-01T00:00:01.000Z',
        level: 'info', type: 'job.state', message: 'queued server-only-secret', data: { status: 'queued' },
      },
    ];
    const server = testApp(events).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let body = '';
      while (!body.includes('event: replay-end')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }

      expect(body).toContain('id: structured-1\nevent: job-event\n');
      expect(body).toContain('event: replay-end\ndata: {}\n\n');
      expect(body).not.toContain('legacy-log');
      expect(body).not.toContain('old verbose log');
      expect(body).not.toContain('server-only-secret');
      expect(body).toContain('[REDACTED]');
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
