import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobRequest } from '../shared/contracts';
import type { AccountRow } from './domain';
import { createLineBuffer, createWorkerEnvironment, JobManager } from './job-manager';
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const request: JobRequest = {
  workflowId: 'signup',
  selection: { mode: 'rows', rowIndexes: [2] },
  options: { intervalMinutes: 1 },
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

  it('fails and stops a worker that sends a malformed event', async () => {
    const { manager, store } = setup();
    const job = await manager.create(request);
    store.update(job.id, { status: 'running' });
    const worker = { kill: vi.fn() };
    Object.assign(manager as unknown as { activeJobId: string; worker: typeof worker }, {
      activeJobId: job.id,
      worker,
    });
    const internal = manager as unknown as {
      handleWorkerMessage(jobId: string, message: { kind: string; event: unknown }, secrets: string[]): void;
    };

    internal.handleWorkerMessage(job.id, {
      kind: 'event',
      event: { type: 'account.unknown', level: 'info', message: 'malformed', data: [] },
    }, []);

    expect(worker.kill).toHaveBeenCalledOnce();
    expect(store.get(job.id)?.status).toBe('failed');
    expect(manager.isCleanupBlocked()).toBe(true);
    expect(JSON.stringify(store.readEvents(job.id))).not.toContain('account.unknown');
  });

  it('returns false when there is no active browser to focus', async () => {
    const { manager } = setup();
    await expect(manager.focus('missing')).resolves.toBe(false);
  });

  it('keeps a preparing job queued and honours cancellation before worker start', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const rows: AccountRow[] = [{
      rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
      recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
    }];
    let resolveFreshPreview!: (rows: AccountRow[]) => void;
    let reads = 0;
    const accountService = {
      rows: async () => {
        reads++;
        if (reads === 1) return rows;
        return new Promise<AccountRow[]>((resolve) => {
          resolveFreshPreview = resolve;
        });
      },
      invalidate: vi.fn(),
      invalidateRows: vi.fn(),
    };
    const manager = new JobManager(process.cwd(), accountService as never, { get: () => ({}) } as never, store);

    const job = await manager.create(request);
    expect(manager.queueLength()).toBe(1);
    expect(manager.active()).toBeNull();
    expect(manager.canEditSettings()).toBe(false);

    await manager.cancel(job.id);
    resolveFreshPreview(rows);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.get(job.id)?.status).toBe('cancelled');
    expect(manager.active()).toBeNull();
    expect(manager.queueLength()).toBe(0);
  });

  it('serializes concurrent creates so the same row is reserved only once', async () => {
    const { manager, store } = setup();

    const results = await Promise.allSettled([manager.create(request), manager.create(request)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(store.runtimesByRow().get(2)?.state).toBe('queued');
  });

  it('does not create jobs for duplicate or blank Sheet identities', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const manager = new JobManager(
      process.cwd(),
      { rows: async () => [
        {
          rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
          recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
        },
        {
          rowIndex: 3, email: ' OPERATOR@example.com ', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
          recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
        },
        {
          rowIndex: 4, email: '   ', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
          recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
        },
      ], invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({}) } as never,
      store,
    );

    await expect(manager.create({
      workflowId: 'signup',
      selection: { mode: 'rows', rowIndexes: [2, 4] },
      options: { intervalMinutes: 1 },
    })).rejects.toThrow('Không có account hợp lệ');
    expect(store.list()).toEqual([]);
  });

  it('blocks create when recovery preparation fails', async () => {
    const { store } = setup();
    const accountService = { rows: vi.fn(), invalidate: vi.fn(), invalidateRows: vi.fn() };
    const manager = new JobManager(
      process.cwd(),
      accountService as never,
      { get: () => ({}) } as never,
      store,
      { prepareForJob: async () => { throw new Error('prepared recovery exists'); } } as never,
    );

    await expect(manager.create(request)).rejects.toThrow('prepared recovery exists');
    expect(accountService.rows).not.toHaveBeenCalled();
  });

  it.each(['busy', 'stale'] as const)('rejects create before recovery or metadata when the external lock is %s', async (status) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const rows = vi.fn();
    const prepareForJob = vi.fn();
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({ runtimeDirectory: directory }) } as never,
      store,
      { prepareForJob } as never,
      () => ({ status }),
    );

    await expect(manager.create(request)).rejects.toThrow(`Automation lock đang ${status}`);
    expect(prepareForJob).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it('rechecks the automation lock under the recovery maintenance guard', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const rows = vi.fn();
    const prepareForJob = vi.fn();
    const releaseGuard = vi.fn();
    const lockReader = vi.fn()
      .mockReturnValueOnce({ status: 'free' })
      .mockReturnValueOnce({ status: 'busy' });
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({ runtimeDirectory: directory }) } as never,
      store,
      { prepareForJob } as never,
      lockReader,
      () => undefined,
      () => releaseGuard,
    );

    await expect(manager.create(request)).rejects.toThrow('Automation lock đang busy');
    expect(prepareForJob).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    expect(releaseGuard).toHaveBeenCalledOnce();
  });

  it('releases the recovery maintenance guard before previewing or starting the worker', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    let guardHeld = false;
    const account = {
      rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
      recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
    };
    const rows = vi.fn(async () => {
      expect(guardHeld).toBe(false);
      return [account];
    });
    const prepareForJob = vi.fn(async () => {
      expect(guardHeld).toBe(true);
    });
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({ runtimeDirectory: directory }) } as never,
      store,
      { prepareForJob } as never,
      () => ({ status: 'free' }),
      () => undefined,
      () => {
        expect(guardHeld).toBe(false);
        guardHeld = true;
        return () => { guardHeld = false; };
      },
    );
    const startWorker = vi.fn(() => expect(guardHeld).toBe(false));
    Object.defineProperty(manager, 'startWorker', { value: startWorker });

    await manager.create(request);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(prepareForJob).toHaveBeenCalledTimes(2);
    expect(rows).toHaveBeenCalledTimes(2);
    expect(startWorker).toHaveBeenCalledOnce();
    expect(guardHeld).toBe(false);
  });

  it('rejects create before recovery or metadata when an uncertain GPM create is unresolved', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const rows = vi.fn();
    const prepareForJob = vi.fn();
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({ runtimeDirectory: directory }) } as never,
      store,
      { prepareForJob } as never,
      () => ({ status: 'free' }),
      () => { throw new Error('Unresolved uncertain GPM create marker'); },
    );

    await expect(manager.create(request)).rejects.toThrow(/uncertain GPM create marker/);
    expect(prepareForJob).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it('allows queue admission when the busy lock belongs to the active UI worker', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const active = store.create({
      workflowId: 'signup', selection: { mode: 'rows', rowIndexes: [3] }, options: { intervalMinutes: 1 },
    }, [3], 0, [{ rowIndex: 3, email: 'active@example.com' }]);
    store.update(active.id, { status: 'running' });
    const prepareForJob = vi.fn();
    const manager = new JobManager(
      process.cwd(),
      { rows: async () => [{
        rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
        recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
      }], invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({ runtimeDirectory: directory }) } as never,
      store,
      { prepareForJob } as never,
      () => ({ status: 'busy' }),
    );
    Object.assign(manager as unknown as { activeJobId: string }, { activeJobId: active.id });
    Object.defineProperty(manager, 'pump', { value: async () => undefined });

    await expect(manager.create(request)).resolves.toMatchObject({ acceptedRows: [2] });
    expect(prepareForJob).not.toHaveBeenCalled();
  });

  it('reserves a moved email at its current row without blocking the replacement row', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const queued = store.create({
      workflowId: 'resetPassword', selection: { mode: 'rows', rowIndexes: [2] }, options: { intervalMinutes: 1 },
    }, [2], 0, [{ rowIndex: 2, email: 'operator@example.com' }]);
    const accounts = [
      {
        rowIndex: 2, email: 'replacement@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
        recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
      },
      {
        rowIndex: 49, email: 'Operator@Example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
        recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
      },
    ];
    const manager = new JobManager(
      process.cwd(),
      { rows: async () => accounts, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({}) } as never,
      store,
    );
    const explicitReset = (rowIndex: number): JobRequest => ({
      workflowId: 'resetPassword', selection: { mode: 'rows', rowIndexes: [rowIndex] }, options: { intervalMinutes: 1 },
    });

    const moved = await manager.preview(explicitReset(49));
    const replacement = await manager.preview(explicitReset(2));

    expect(moved.accepted).toEqual([]);
    expect(moved.rejected[0]?.reason).toContain(queued.id.slice(0, 8));
    expect(replacement.accepted.map((account) => account.email)).toEqual(['replacement@example.com']);
  });

  it('revalidates a queued account by unique normalized email after Sheet rows move', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const original = {
      rowIndex: 2, email: 'Operator@Example.com ', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
      recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
    };
    const replacement = { ...original, rowIndex: 2, email: 'replacement@example.com' };
    const moved = { ...original, rowIndex: 3, email: ' operator@example.com' };
    const rows = vi.fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([replacement, moved]);
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({}) } as never,
      store,
    );
    const started: Array<{ acceptedRows: number[]; acceptedAccounts: Array<{ rowIndex: number; email: string }> }> = [];
    Object.defineProperty(manager, 'startWorker', {
      value: (_jobId: string, _request: JobRequest, acceptedRows: number[], acceptedAccounts: Array<{ rowIndex: number; email: string }>) => {
        started.push({ acceptedRows, acceptedAccounts });
      },
    });

    const job = await manager.create(request);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(started).toEqual([{
      acceptedRows: [3],
      acceptedAccounts: [{ rowIndex: 3, email: 'operator@example.com' }],
    }]);
    expect(store.get(job.id)?.acceptedRows).toEqual([3]);
  });

  it('fails a queued job instead of selecting a duplicate or replacement email', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const original = {
      rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
      recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
    };
    const rows = vi.fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([
        { ...original, rowIndex: 3 },
        { ...original, rowIndex: 4, email: 'OPERATOR@example.com' },
        { ...original, rowIndex: 2, email: 'replacement@example.com' },
      ]);
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({}) } as never,
      store,
    );
    const startWorker = vi.fn();
    Object.defineProperty(manager, 'startWorker', { value: startWorker });

    const job = await manager.create(request);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startWorker).not.toHaveBeenCalled();
    expect(store.get(job.id)?.status).toBe('failed');
    expect(store.get(job.id)?.acceptedRows).toEqual([2]);
  });

  it('checks recovery before each fresh queued preview', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const order: string[] = [];
    const account = {
      rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
      recoveryEmail: '', apiKey: '', elevenPass: '', status: 'pending',
    };
    const manager = new JobManager(
      process.cwd(),
      { rows: async () => { order.push('preview'); return [account]; }, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({}) } as never,
      store,
      { prepareForJob: async () => { order.push('recovery'); } } as never,
    );
    Object.defineProperty(manager, 'startWorker', { value: vi.fn() });

    await manager.create(request);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(order).toEqual(['recovery', 'preview', 'recovery', 'preview']);
  });

  it('preserves all-eligible reset policy when queued selection is rewritten to identities', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-manager-'));
    directories.push(directory);
    const store = new JobStore(directory);
    store.initialize();
    const resettable = {
      rowIndex: 2, email: 'operator@example.com', password: 'hotmail-pass', msaToken: '', tenantGuid: '',
      recoveryEmail: '', apiKey: '', elevenPass: 'Old1!', status: 'credentials-rejected',
    };
    const rows = vi.fn()
      .mockResolvedValueOnce([resettable])
      .mockResolvedValueOnce([{ ...resettable, status: 'pending' }]);
    const manager = new JobManager(
      process.cwd(),
      { rows, invalidate: vi.fn(), invalidateRows: vi.fn() } as never,
      { get: () => ({}) } as never,
      store,
    );
    const startWorker = vi.fn();
    Object.defineProperty(manager, 'startWorker', { value: startWorker });

    const job = await manager.create({
      workflowId: 'resetPassword', selection: { mode: 'allEligible' }, options: { intervalMinutes: 1 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startWorker).not.toHaveBeenCalled();
    expect(store.get(job.id)?.status).toBe('failed');
  });

  it('rejects creates once shutdown has started', async () => {
    const { manager, store } = setup();

    await manager.shutdown();

    await expect(manager.create(request)).rejects.toThrow(/Server đang dừng/);
    expect(store.list()).toEqual([]);
  });

  it('does not force-kill a worker after cleanup failure has been reported', async () => {
    vi.useFakeTimers();
    const { manager, store } = setup();
    const job = store.create({
      workflowId: 'signup', selection: { mode: 'rows', rowIndexes: [2] }, options: { intervalMinutes: 1 },
    }, [2], 0);
    store.update(job.id, { status: 'running' });
    const worker = { send: vi.fn(), kill: vi.fn() };
    Object.assign(manager as unknown as { activeJobId: string; worker: typeof worker }, {
      activeJobId: job.id,
      worker,
    });

    await manager.cancel(job.id);
    const internal = manager as unknown as {
      handleWorkerMessage(jobId: string, message: { kind: string; error?: string }, secrets: string[]): void;
    };
    internal.handleWorkerMessage(job.id, { kind: 'cleanup-failed', error: 'profile still open' }, []);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(worker.kill).not.toHaveBeenCalled();
    expect(store.get(job.id)?.status).toBe('failed');
    expect(manager.isCleanupBlocked()).toBe(true);
  });

  it('marks an unexpected zero-code worker close as failed', () => {
    const { manager, store } = setup();
    const job = store.create({
      workflowId: 'signup', selection: { mode: 'rows', rowIndexes: [2] }, options: { intervalMinutes: 1 },
    }, [2], 0);
    store.update(job.id, { status: 'running' });
    Object.assign(manager as unknown as { activeJobId: string; worker: object }, {
      activeJobId: job.id,
      worker: {},
    });
    const internal = manager as unknown as { handleWorkerClose(jobId: string, code: number | null): void };

    internal.handleWorkerClose(job.id, 0);

    expect(store.get(job.id)?.status).toBe('failed');
    expect(store.get(job.id)?.lastMessage).toContain('ngoài dự kiến');
  });
});

describe('worker log buffering', () => {
  it('does not pass ambient lock ownership markers into a new worker', () => {
    const environment = createWorkerEnvironment({
      sheetId: 'sheet',
      sheetName: 'hotmail',
      serviceAccountPath: path.join(process.cwd(), 'service-account.json'),
      gpmApiBase: 'http://127.0.0.1:19995',
      defaultIntervalMinutes: 1,
      runtimeDirectory: path.join(process.cwd(), '.runtime'),
      proxyProvider: 'none',
    }, {
      PATH: 'worker-path',
      MAIL_TEMP_LOCK_TOKEN: 'inherited-token',
      MAIL_TEMP_LOCK_HELD: '1',
    });

    expect(environment.PATH).toBe('worker-path');
    expect(environment.MAIL_TEMP_LOCK_TOKEN).toBeUndefined();
    expect(environment.MAIL_TEMP_LOCK_HELD).toBeUndefined();
  });

  it('joins split chunks before a line is persisted and redacted', () => {
    const { store } = setup();
    const job = store.create({
      workflowId: 'signup',
      selection: { mode: 'rows', rowIndexes: [2] },
      options: { intervalMinutes: 1 },
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
