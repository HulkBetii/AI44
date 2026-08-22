import { EventEmitter } from 'node:events';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { JobEvent } from '../shared/contracts';
import { createApp } from './app';

function testApp(events: JobEvent[] = [], focused = true) {
  const manager = Object.assign(new EventEmitter(), {
    active: () => null,
    queueLength: () => 0,
    isCleanupBlocked: () => false,
    canEditSettings: () => true,
    preview: async () => ({ workflowId: 'signup', accepted: [], rejected: [], phases: [] }),
    create: async () => ({}),
    cancel: async () => ({}),
    focus: async () => focused,
  });
  const settings = {
    sheetId: 'sheet', sheetName: 'hotmail', serviceAccountPath: __filename,
    gpmApiBase: 'http://127.0.0.1:1', defaultIntervalMinutes: 1, runtimeDirectory: __dirname,
  };
  return createApp({
    projectRoot: process.cwd(),
    configStore: {
      get: () => settings,
      response: () => ({ values: settings, envOverrides: [], canEdit: true }),
      validate: (value: unknown) => value,
      update: (value: unknown) => value,
    } as never,
    accountService: {
      summaries: async () => [], rows: async () => [], detail: async () => null,
      reveal: async () => 'secret-value', invalidate: () => undefined, invalidateRows: () => undefined,
    } as never,
    jobStore: {
      list: () => events.length ? [{ id: 'job-1' }] : [], get: () => null, readEvents: () => events, readLog: () => '',
      lastRunByRow: () => new Map(), jobsForRow: () => [], artifactPath: () => null,
      setRuntimeDirectory: () => undefined, runtimesByRow: () => new Map(),
    } as never,
    jobManager: manager as never,
    lockReader: () => ({ status: 'free' }),
  });
}

describe('server API', () => {
  it('returns secret responses with no-store headers', async () => {
    const response = await request(testApp()).post('/api/accounts/2/secrets/apiKey/reveal');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.value).toBe('secret-value');
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
        level: 'info', type: 'job.state', message: 'queued', data: { status: 'queued' },
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
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
