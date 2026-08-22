import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, z } from 'zod';
import { JobPreviewRequestSchema, JobRequestSchema, type JobEvent, type RuntimeSettings } from '../shared/contracts';
import type { AccountService } from './account-service';
import type { ConfigStore } from './config';
import type { JobManager } from './job-manager';
import type { JobStore } from './job-store';
import { WORKFLOWS } from './domain';
import { redactText } from './redactor';

interface AppDependencies {
  projectRoot: string;
  configStore: ConfigStore;
  accountService: AccountService;
  jobStore: JobStore;
  jobManager: JobManager;
  lockReader: () => { status: 'free' | 'busy' | 'stale' };
}

const SecretFieldSchema = z.enum(['hotmailPassword', 'elevenPassword', 'apiKey', 'proxyToken']);

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
  const { configStore, accountService, jobStore, jobManager } = dependencies;
  const app = express();
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
    const [gpmReady, sheetsReady] = await Promise.all([
      checkTcpEndpoint(settings.gpmApiBase),
      serviceAccountReady
        ? accountService.rows().then(() => true).catch(() => false)
        : Promise.resolve(false),
    ]);
    const cleanupReady = !jobManager.isCleanupBlocked();
    response.json({
      status: gpmReady && sheetsReady && cleanupReady ? 'ok' : 'degraded',
      sheets: sheetsReady ? 'ready' : 'unavailable',
      gpm: gpmReady ? 'ready' : 'unavailable',
      workerLock: cleanupReady ? dependencies.lockReader().status : 'busy',
      activeJobId: active?.id || null,
      queueLength: jobManager.queueLength(),
    });
  });

  app.get('/api/workflows', (_request, response) => response.json(WORKFLOWS));

  app.get('/api/accounts', async (request, response) => {
    const accounts = await accountService.summaries(
      jobStore.lastRunByRow(),
      jobStore.runtimesByRow(),
      request.query.refresh === '1',
    );
    response.json(accounts);
  });

  app.get('/api/accounts/:rowIndex', async (request, response) => {
    const rowIndex = z.coerce.number().int().min(2).parse(request.params.rowIndex);
    const recentJobs = jobStore.jobsForRow(rowIndex);
    const detail = await accountService.detail(
      rowIndex,
      recentJobs,
      jobStore.runtimesByRow().get(rowIndex) || null,
    );
    if (!detail) return response.status(404).json({ error: 'Không tìm thấy account' });
    for (const job of recentJobs) {
      const events = jobStore.readEvents(job.id);
      const failure = [...events].reverse().find((event) => event.type === 'account.failed' && event.rowIndex === rowIndex);
      if (!failure) continue;
      const artifact = [...events].reverse().find((event) => event.type === 'artifact.created'
        && event.rowIndex === rowIndex
        && typeof event.data?.artifactId === 'string');
      detail.lastFailure = {
        jobId: job.id,
        message: failure.message,
        step: typeof failure.data?.step === 'string' ? failure.data.step : job.currentStep,
        artifactId: typeof artifact?.data?.artifactId === 'string' ? artifact.data.artifactId : null,
      };
      break;
    }
    response.json(detail);
  });

  app.post('/api/accounts/:rowIndex/secrets/:field/reveal', async (request, response) => {
    const rowIndex = z.coerce.number().int().min(2).parse(request.params.rowIndex);
    const field = SecretFieldSchema.parse(request.params.field);
    const value = await accountService.reveal(rowIndex, field);
    if (value === null) return response.status(404).json({ error: 'Không tìm thấy account' });
    response.set('Cache-Control', 'no-store, max-age=0');
    response.set('Pragma', 'no-cache');
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

  app.get('/api/jobs', (_request, response) => response.json(jobStore.list()));

  app.get('/api/jobs/:jobId', (request, response) => {
    const job = jobStore.get(request.params.jobId);
    if (!job) return response.status(404).json({ error: 'Không tìm thấy lượt chạy' });
    response.json({ job, events: jobStore.readEvents(job.id), log: jobStore.readLog(job.id) });
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
      response.write(`id: ${event.id}\n`);
      response.write('event: job-event\n');
      response.write(`data: ${JSON.stringify(event)}\n\n`);
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
    response.json(configStore.response(jobManager.canEditSettings()));
  });

  app.put('/api/settings', (request, response) => {
    if (!jobManager.canEditSettings()) return response.status(409).json({ error: 'Không thể sửa cấu hình khi còn job active hoặc queued' });
    const values = configStore.validate(request.body) as RuntimeSettings;
    const updated = configStore.update(values);
    jobStore.setRuntimeDirectory(updated.runtimeDirectory);
    accountService.invalidate();
    response.json(updated);
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
    const override = typeof request.body?.options?.proxyTokenOverride === 'string'
      ? request.body.options.proxyTokenOverride
      : undefined;
    response.status(500).json({ error: redactText(message, override ? [override] : []) });
  });

  return app;
}
