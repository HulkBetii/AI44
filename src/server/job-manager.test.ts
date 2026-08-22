import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobRequest } from '../shared/contracts';
import { createLineBuffer, JobManager } from './job-manager';
import { JobStore } from './job-store';

const directories: string[] = [];

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
  directories.push(directory);
  const store = new JobStore(directory);
  store.initialize();
  const invalidateRows = vi.fn();
  const accountService = {
    rows: async () => [{
      rowIndex: 2,
      email: 'operator@example.com',
      password: 'hotmail-pass',
      msaToken: '',
      tenantGuid: '',
      recoveryEmail: '',
      apiKey: '',
      elevenPass: '',
      status: 'pending',
      proxyToken: '',
    }],
    invalidate: vi.fn(),
    invalidateRows,
  };
  const manager = new JobManager(
    process.cwd(),
    accountService as never,
    { get: () => ({}) } as never,
    store,
  );
  Object.defineProperty(manager, 'pump', { value: async () => undefined });
  return { manager, store, invalidateRows };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const request: JobRequest = {
  workflowId: 'signup',
  selection: { mode: 'rows', rowIndexes: [2] },
  options: { proxyMode: 'sheet', intervalMinutes: 1 },
};

describe('JobManager reservations', () => {
  it('publishes the queued event and immediately reserves accepted rows', async () => {
    const { manager, store } = setup();
    const events: JobEvent[] = [];
    manager.on('event', (event) => events.push(event));

    const job = await manager.create(request);

    expect(events.at(-1)).toMatchObject({ jobId: job.id, type: 'job.state', data: { status: 'queued' } });
    expect(store.runtimesByRow().get(2)).toMatchObject({ jobId: job.id, state: 'queued' });
    expect((await manager.preview(request)).accepted).toEqual([]);
  });

  it('invalidates the affected Sheet row after account result events', async () => {
    const { manager, invalidateRows } = setup();
    const job = await manager.create(request);
    const handleWorkerEvent = manager as unknown as {
      handleWorkerEvent(jobId: string, event: Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'>, secrets: string[]): void;
    };

    handleWorkerEvent.handleWorkerEvent(job.id, {
      type: 'account.succeeded',
      level: 'info',
      rowIndex: 2,
      message: 'done',
    }, []);

    expect(invalidateRows).toHaveBeenCalledWith([2]);
  });

  it('redacts known secrets before persisting job metadata', async () => {
    const { manager, store } = setup();
    const job = await manager.create(request);
    const handleWorkerEvent = manager as unknown as {
      handleWorkerEvent(jobId: string, event: Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'>, secrets: string[]): void;
    };

    handleWorkerEvent.handleWorkerEvent(job.id, {
      type: 'step.changed',
      level: 'info',
      message: 'using override-token-secret',
      data: { step: 'connect override-token-secret' },
    }, ['override-token-secret']);

    expect(store.get(job.id)?.lastMessage).not.toContain('override-token-secret');
    expect(store.get(job.id)?.currentStep).not.toContain('override-token-secret');

    const transition = manager as unknown as {
      transition(jobId: string, status: 'failed', message: string, secrets: string[]): void;
    };
    transition.transition(job.id, 'failed', 'fatal override-token-secret', ['override-token-secret']);
    expect(store.get(job.id)?.lastMessage).not.toContain('override-token-secret');
    expect(JSON.stringify(store.readEvents(job.id))).not.toContain('override-token-secret');
  });

  it('returns false when there is no active browser to focus', async () => {
    const { manager } = setup();
    await expect(manager.focus('missing')).resolves.toBe(false);
  });
});

describe('worker log buffering', () => {
  it('joins split chunks before a line is persisted and redacted', () => {
    const { store } = setup();
    const job = store.create({
      workflowId: 'signup',
      selection: { mode: 'rows', rowIndexes: [2] },
      options: { proxyMode: 'override', intervalMinutes: 1, hasProxyTokenOverride: true },
    }, [2], 0);
    const buffer = createLineBuffer((line) => store.appendLog(job.id, line, ['override-token-secret']));
    buffer.write('proxy=override-token-');
    expect(store.readLog(job.id)).toBe('');
    buffer.write('secret\nnext');
    buffer.flush();
    expect(store.readLog(job.id)).toContain('proxy=[REDACTED]');
    expect(store.readLog(job.id)).toContain('next');
    expect(store.readLog(job.id)).not.toContain('override-token-secret');
  });
});
