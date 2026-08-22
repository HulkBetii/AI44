import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from './job-store';

const directories: string[] = [];

function createStore(): { store: JobStore; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-store-'));
  directories.push(directory);
  const store = new JobStore(directory);
  store.initialize();
  return { store, directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const request = {
  workflowId: 'signup' as const,
  selection: { mode: 'rows' as const, rowIndexes: [2] },
  options: { proxyMode: 'sheet' as const, intervalMinutes: 1, hasProxyTokenOverride: false },
};

describe('JobStore', () => {
  it('redacts persisted events and logs', () => {
    const { store } = createStore();
    const job = store.create(request, [2], 0);
    store.appendEvent(job.id, { type: 'log', level: 'info', message: 'API Key: sk_secret password: Pass1!' });
    store.appendLog(job.id, 'proxyToken=token-secret', ['token-secret']);
    expect(JSON.stringify(store.readEvents(job.id))).not.toContain('sk_secret');
    expect(store.readLog(job.id)).not.toContain('token-secret');
  });

  it('marks unfinished jobs interrupted after restart', () => {
    const { store, directory } = createStore();
    const job = store.create(request, [2], 0);
    store.update(job.id, { status: 'running', startedAt: new Date().toISOString() });
    const restarted = new JobStore(directory);
    restarted.initialize();
    expect(restarted.get(job.id)?.status).toBe('interrupted');
  });

  it('exposes only non-terminal row reservations and maps CAPTCHA state', () => {
    const { store } = createStore();
    const queued = store.create(request, [2], 0);
    const active = store.create(request, [2, 3], 0);
    store.update(active.id, { status: 'needs_attention' });

    expect(store.runtimesByRow().get(2)).toMatchObject({
      jobId: active.id,
      state: 'waiting_captcha',
      workflowId: 'signup',
    });
    expect(store.runtimesByRow(active.id).get(2)?.jobId).toBe(queued.id);

    store.update(active.id, { status: 'succeeded' });
    store.update(queued.id, { status: 'cancelled' });
    expect(store.runtimesByRow()).toEqual(new Map());
  });
});
