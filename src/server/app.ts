import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';
import { JobPreviewRequestSchema, JobRequestSchema, type JobEvent, type SettingsUpdateRequest } from '../shared/contracts';
import { AccountIdentityConflictError, type AccountService } from './account-service';
import { runtimeSecretValues, type ConfigStore } from './config';
import { AutomationLockConflictError, type JobManager } from './job-manager';
import type { JobStore } from './job-store';
import type { RecoveryService } from './recovery';
import { WORKFLOWS } from './domain';
import { redactText, redactValue } from './redactor';

interface AppDependencies {
  projectRoot: string;
  configStore: ConfigStore;
  accountService: AccountService;
  jobStore: JobStore;
  jobManager: JobManager;
  recoveryService: RecoveryService;
  lockReader: (runtimeDirectory?: string) => { status: 'free' | 'busy' | 'stale' };
  lockGuardAcquirer: (runtimeDirectory: string) => () => void;
  automationAdmissionGuard: (runtimeDirectory: string) => void;
}

const SecretFieldSchema = z.enum(['hotmailPassword', 'elevenPassword', 'apiKey']);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isSameHostOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function replayEvents(jobStore: JobStore, lastEventId: string | undefined): JobEvent[] {
  const events = jobStore.list()
    .flatMap((job) => jobStore.readEvents(job.id))
    .filter((event) => event.type !== 'log')
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  if (!lastEventId) return events.slice(-300);
  const cursor = events.findIndex((event) => event.id === lastEventId);
  return cursor >= 0 ? events.slice(cursor + 1) : events.slice(-300);
}

async function checkTcpEndpoint(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
  const url = new URL(endpoint);
  const port = Number(url.port) || 80;
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createApp(dependencies: AppDependencies) {
  const { configStore, accountService, jobStore, jobManager, recoveryService } = dependencies;
  const app = express();
  const canEditSettings = () => {
    if (!jobManager.canEditSettings()) return false;
    try {
      const runtimeDirectory = configStore.get().runtimeDirectory;
      if (dependencies.lockReader(runtimeDirectory).status !== 'free') return false;
      dependencies.automationAdmissionGuard(runtimeDirectory);
      return true;
    } catch {
      return false;
    }
  };
  const canMutateRecovery = () => {
    if (!jobManager.canMutateRecovery()) return false;
    try {
      return dependencies.lockReader().status === 'free';
    } catch {
      return false;
    }
  };
  const acquireRuntimeGuards = (runtimeDirectories: string[]): (() => void) => {
    const releases: Array<() => void> = [];
    try {
      const uniqueDirectories = [...new Set(runtimeDirectories.map((directory) => path.resolve(directory)))].sort();
      for (const directory of uniqueDirectories) releases.push(dependencies.lockGuardAcquirer(directory));
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  };
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', (request, response, next) => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(request.hostname)) {
      response.status(403).json({ error: 'API is available only on localhost.' });
      return;
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const origin = request.get('origin');
    const host = request.get('host');
    if (origin && (!host || !isSameHostOrigin(origin, host))) {
      response.status(403).json({ error: 'Mutating requests require a same-origin localhost request.' });
      return;
    }
    next();
  });

  app.get('/api/health', async (_request, response) => {
    const active = jobManager.active();
    const settings = configStore.get();
    const serviceAccountReady = fs.existsSync(settings.serviceAccountPath);
    let recoveryPendingCount = 0;
    try {
      recoveryPendingCount = recoveryService.pendingCount();
    } catch {
      recoveryPendingCount = 1;
    }
    const reconcileRecovery = async (): Promise<boolean> => {
      if (recoveryPendingCount === 0) return true;
      if (!jobManager.canMutateRecovery()) return false;
      try {
        if (dependencies.lockReader(settings.runtimeDirectory).status !== 'free') return false;
      } catch {
        return false;
      }
      let releaseGuard: () => void;
      try {
        releaseGuard = acquireRuntimeGuards([settings.runtimeDirectory]);
      } catch {
        return false;
      }
      try {
        if (!jobManager.canMutateRecovery()) return false;
        await recoveryService.reconcileConfirmed();
        recoveryPendingCount = recoveryService.pendingCount();
        return true;
      } catch {
        return false;
      } finally {
        releaseGuard();
      }
    };
    const [gpmReady, sheetsReady, recoveryReady] = await Promise.all([
      checkTcpEndpoint(settings.gpmApiBase),
      serviceAccountReady
        ? accountService.rows().then(() => true).catch(() => false)
        : Promise.resolve(false),
      reconcileRecovery(),
    ]);
    const cleanupReady = !jobManager.isCleanupBlocked();
    response.json({
      status: gpmReady && sheetsReady && cleanupReady && recoveryReady && recoveryPendingCount === 0 ? 'ok' : 'degraded',
      sheets: sheetsReady ? 'ready' : 'unavailable',
      gpm: gpmReady ? 'ready' : 'unavailable',
      workerLock: cleanupReady ? dependencies.lockReader().status : 'busy',
      activeJobId: active?.id || null,
      queueLength: jobManager.queueLength(),
      recoveryPendingCount,
    });
  });

  app.get('/api/workflows', (_request, response) => response.json(WORKFLOWS));

  app.get('/api/accounts', async (request, response) => {
    const refresh = request.query.refresh === '1';
    const currentAccounts = await accountService.rows(refresh);
    const accounts = await accountService.summaries(
      jobStore.lastRunByRow(currentAccounts),
      jobStore.runtimesByRow(undefined, currentAccounts),
      false,
    );
    response.json(accounts);
  });

  app.get('/api/accounts/:rowIndex', async (request, response) => {
    const rowIndex = z.coerce.number().int().min(2).parse(request.params.rowIndex);
    const { expectedEmail } = z.object({
      expectedEmail: z.string().trim().min(1),
    }).strict().parse(request.query);
    const currentAccounts = await accountService.rows(true);
    const identityMatches = currentAccounts.filter(
      (account) => normalizeEmail(account.email) === normalizeEmail(expectedEmail),
    );
    if (identityMatches.length !== 1 || identityMatches[0].rowIndex !== rowIndex) {
      throw new AccountIdentityConflictError('Account identity changed; refresh the account before opening details');
    }
    const currentAccount = identityMatches[0];
    const recentJobs = jobStore.jobsForRow(rowIndex, currentAccount.email);
    const detail = await accountService.detail(
      rowIndex,
      recentJobs,
      jobStore.runtimesByRow(undefined, currentAccounts).get(rowIndex) || null,
      currentAccounts,
    );
    if (!detail) return response.status(404).json({ error: 'Không tìm thấy account' });
    const knownSecrets = runtimeSecretValues(configStore.get());
    detail.recentJobs = redactValue(detail.recentJobs, knownSecrets) as typeof detail.recentJobs;
    for (const job of recentJobs) {
      const events = jobStore.readEvents(job.id);
      const historicalRowIndex = jobStore.rowIndexForAccount(job, rowIndex, currentAccount.email);
      if (historicalRowIndex === null) continue;
      const failure = [...events].reverse().find((event) => event.type === 'account.failed' && (
        job.acceptedAccounts?.length
          ? typeof event.data?.email === 'string' && normalizeEmail(event.data.email) === normalizeEmail(currentAccount.email)
          : event.rowIndex === historicalRowIndex
      ));
      if (!failure) continue;
      const artifact = [...events].reverse().find((event) => event.type === 'artifact.created'
        && event.rowIndex === failure.rowIndex
        && typeof event.data?.artifactId === 'string');
      detail.lastFailure = {
        jobId: job.id,
        message: redactText(failure.message, knownSecrets),
        step: redactText(String(typeof failure.data?.step === 'string' ? failure.data.step : job.currentStep || ''), knownSecrets),
        artifactId: typeof artifact?.data?.artifactId === 'string' ? artifact.data.artifactId : null,
      };
      break;
    }
    response.json(detail);
  });

  app.post('/api/accounts/:rowIndex/secrets/:field/reveal', async (request, response) => {
    response.set('Cache-Control', 'no-store, max-age=0');
    response.set('Pragma', 'no-cache');
    const rowIndex = z.coerce.number().int().min(2).parse(request.params.rowIndex);
    const field = SecretFieldSchema.parse(request.params.field);
    const { expectedEmail } = z.object({ expectedEmail: z.string().trim().min(1) }).strict().parse(request.body);
    const value = await accountService.reveal(rowIndex, field, expectedEmail);
    response.json({ value });
  });

  app.post('/api/jobs/preview', async (request, response) => {
    const jobRequest = JobPreviewRequestSchema.parse(request.body);
    response.json(await jobManager.preview(jobRequest));
  });

  app.post('/api/jobs', async (request, response) => {
    const jobRequest = JobRequestSchema.parse(request.body);
    response.status(201).json(await jobManager.create(jobRequest));
  });

  app.get('/api/jobs', (_request, response) => {
    response.json(redactValue(jobStore.list(), runtimeSecretValues(configStore.get())));
  });

  app.get('/api/jobs/:jobId', (request, response) => {
    const job = jobStore.get(request.params.jobId);
    if (!job) return response.status(404).json({ error: 'Không tìm thấy lượt chạy' });
    response.json(redactValue({
      job,
      events: jobStore.readEvents(job.id),
      log: jobStore.readLog(job.id),
    }, runtimeSecretValues(configStore.get())));
  });

  app.post('/api/jobs/:jobId/cancel', async (request, response) => {
    response.json(await jobManager.cancel(request.params.jobId));
  });

  app.post('/api/jobs/:jobId/focus-browser', async (request, response) => {
    response.json({ focused: await jobManager.focus(request.params.jobId) });
  });

  app.get('/api/jobs/:jobId/artifacts/:artifactId', (request, response) => {
    const artifact = jobStore.artifactPath(request.params.jobId, request.params.artifactId);
    if (!artifact) return response.status(404).json({ error: 'Không tìm thấy artifact' });
    response.set('Cache-Control', 'private, no-store');
    response.sendFile(artifact);
  });

  app.get('/api/events', (request, response) => {
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    const send = (event: JobEvent) => {
      const sanitized = redactValue(event, runtimeSecretValues(configStore.get())) as JobEvent;
      response.write(`id: ${sanitized.id}\n`);
      response.write('event: job-event\n');
      response.write(`data: ${JSON.stringify(sanitized)}\n\n`);
    };
    let replaying = true;
    const pending: JobEvent[] = [];
    const forward = (event: JobEvent) => replaying ? pending.push(event) : send(event);
    jobManager.on('event', forward);
    const replay = replayEvents(jobStore, request.get('last-event-id'));
    const replayIds = new Set(replay.map((event) => event.id));
    for (const event of replay) send(event);
    response.write('event: replay-end\ndata: {}\n\n');
    replaying = false;
    for (const event of pending) if (!replayIds.has(event.id)) send(event);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      jobManager.off('event', forward);
    });
  });

  app.get('/api/settings', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(configStore.response(canEditSettings()));
  });

  app.get('/api/recovery', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(recoveryService.list());
  });

  app.post('/api/recovery/:id/sync', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const id = z.string().uuid().parse(request.params.id);
    if (!canMutateRecovery()) return response.status(409).json({ error: 'Không thể xử lý recovery khi job hoặc automation đang chạy' });
    let releaseGuard: () => void;
    try {
      releaseGuard = acquireRuntimeGuards([configStore.get().runtimeDirectory]);
    } catch {
      return response.status(409).json({ error: 'Không thể xử lý recovery khi automation lock đang bận' });
    }
    try {
      if (!jobManager.canMutateRecovery()) {
        return response.status(409).json({ error: 'Không thể xử lý recovery khi job đang chạy' });
      }
      if (!await recoveryService.sync(id)) return response.status(404).json({ error: 'Không tìm thấy recovery entry' });
    } finally {
      releaseGuard();
    }
    response.json(recoveryService.list());
  });

  app.delete('/api/recovery/:id', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const id = z.string().uuid().parse(request.params.id);
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    if (!canMutateRecovery()) return response.status(409).json({ error: 'Không thể xử lý recovery khi job hoặc automation đang chạy' });
    let releaseGuard: () => void;
    try {
      releaseGuard = acquireRuntimeGuards([configStore.get().runtimeDirectory]);
    } catch {
      return response.status(409).json({ error: 'Không thể xử lý recovery khi automation lock đang bận' });
    }
    try {
      if (!jobManager.canMutateRecovery()) {
        return response.status(409).json({ error: 'Không thể xử lý recovery khi job đang chạy' });
      }
      if (!await recoveryService.discard(id)) return response.status(404).json({ error: 'Không tìm thấy recovery entry' });
    } finally {
      releaseGuard();
    }
    response.json(recoveryService.list());
  });

  app.put('/api/settings', (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!canEditSettings()) {
      return response.status(409).json({ error: 'Không thể sửa cấu hình khi job, recovery hoặc automation lock đang bận' });
    }
    const values = configStore.validate(request.body) as SettingsUpdateRequest;
    const current = configStore.get();
    const candidate = configStore.previewUpdate(values);
    let releaseGuards: () => void;
    try {
      releaseGuards = acquireRuntimeGuards([current.runtimeDirectory, candidate.runtimeDirectory]);
    } catch {
      return response.status(409).json({ error: 'Không thể sửa cấu hình khi automation lock đang bận' });
    }
    try {
      if (!jobManager.canEditSettings()) {
        return response.status(409).json({ error: 'Không thể sửa cấu hình khi còn job hoặc recovery đang chờ xử lý' });
      }
      try {
        dependencies.automationAdmissionGuard(current.runtimeDirectory);
        dependencies.automationAdmissionGuard(candidate.runtimeDirectory);
      } catch {
        return response.status(409).json({ error: 'Runtime directory có GPM create chưa xác định; xử lý marker trước khi đổi cấu hình' });
      }
      if (recoveryService.pendingCount(candidate.runtimeDirectory) > 0) {
        return response.status(409).json({ error: 'Runtime directory đích có recovery đang chờ xử lý' });
      }
      const updated = configStore.update(values);
      jobStore.setRuntimeDirectory(updated.runtimeDirectory);
      accountService.invalidate();
    } finally {
      releaseGuards();
    }
    response.json(configStore.response(canEditSettings()));
  });

  app.post('/api/diagnostics/sheets', async (_request, response) => {
    const rows = await accountService.rows(true);
    response.json({ ok: true, rowCount: rows.length });
  });

  app.post('/api/diagnostics/gpm', async (_request, response) => {
    const ok = await checkTcpEndpoint(configStore.get().gpmApiBase, 2_000);
    response.status(ok ? 200 : 503).json({ ok });
  });

  app.post('/api/diagnostics/proxy', async (request, response) => {
    const jobRequest = JobRequestSchema.parse({
      workflowId: 'proxyCheck',
      selection: { mode: 'allEligible' },
      options: request.body,
    });
    response.status(201).json(await jobManager.create(jobRequest));
  });

  const webDirectory = path.join(dependencies.projectRoot, 'dist', 'web');
  if (fs.existsSync(webDirectory)) {
    app.use(express.static(webDirectory, { index: false }));
    app.get('*path', (_request, response) => response.sendFile(path.join(webDirectory, 'index.html')));
  }

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Dữ liệu không hợp lệ', details: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : 'Lỗi không xác định';
    const knownSecrets = runtimeSecretValues(configStore.get());
    response.status(error instanceof AutomationLockConflictError || error instanceof AccountIdentityConflictError ? 409 : 500)
      .json({ error: redactText(message, knownSecrets) });
  });

  return app;
}
