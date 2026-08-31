import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const request = {
  workflowId: 'signup' as const,
  selection: { mode: 'rows' as const, rowIndexes: [2] },
  options: { intervalMinutes: 1 },
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

  it.each([
    ['blank email', [{ rowIndex: 2, email: '   ' }]],
    ['duplicate email', [
      { rowIndex: 2, email: 'operator@example.com' },
      { rowIndex: 3, email: ' OPERATOR@example.com ' },
    ]],
  ])('rejects %s identities before persisting job metadata', (_case, acceptedAccounts) => {
    const { store, directory } = createStore();

    expect(() => store.create(
      request,
      acceptedAccounts.map((account) => account.rowIndex),
      0,
      acceptedAccounts,
    )).toThrow();
    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(path.join(directory, 'jobs'))).toEqual([]);
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
    store.update(active.id, { status: 'needs_attention', currentStep: 'rotate proxy (TinProxy)' });

    expect(store.runtimesByRow().get(2)).toMatchObject({
      jobId: active.id,
      state: 'waiting_captcha',
      workflowId: 'signup',
      currentStep: 'rotate proxy (TinProxy)',
    });
    expect(store.runtimesByRow(active.id).get(2)?.jobId).toBe(queued.id);

    store.update(active.id, { status: 'succeeded' });
    store.update(queued.id, { status: 'cancelled' });
    expect(store.runtimesByRow()).toEqual(new Map());
  });

  it('moves identity reservations with unique current emails and does not block replacements', () => {
    const { store } = createStore();
    const queued = store.create(request, [2], 0, [{ rowIndex: 2, email: 'Operator@Example.com' }]);
    const currentAccounts = [
      { rowIndex: 2, email: 'replacement@example.com' },
      { rowIndex: 49, email: ' operator@example.com ' },
    ];

    const runtimes = store.runtimesByRow(undefined, currentAccounts);

    expect(runtimes.get(49)).toMatchObject({ jobId: queued.id, state: 'queued' });
    expect(runtimes.has(2)).toBe(false);
  });

  it('reserves every current row when a queued identity is duplicated', () => {
    const { store } = createStore();
    const queued = store.create(request, [2], 0, [{ rowIndex: 2, email: 'operator@example.com' }]);
    const runtimes = store.runtimesByRow(undefined, [
      { rowIndex: 12, email: 'operator@example.com' },
      { rowIndex: 13, email: 'OPERATOR@example.com' },
    ]);

    expect(runtimes.get(12)?.jobId).toBe(queued.id);
    expect(runtimes.get(13)?.jobId).toBe(queued.id);
    expect(runtimes.has(2)).toBe(false);
  });

  it('backs up and repairs trailing event corruption before appending the next sequence', () => {
    const { store, directory } = createStore();
    const job = store.create(request, [2], 0);
    const jobDirectory = path.join(directory, 'jobs', job.id);
    const eventsFile = path.join(jobDirectory, 'events.jsonl');
    fs.appendFileSync(eventsFile, '{partial-event', 'utf8');

    const repaired = store.readEvents(job.id);
    expect(repaired.map((event) => event.sequence)).toEqual([1]);
    expect(fs.readdirSync(jobDirectory).some((name) => name.startsWith('events.jsonl.corrupt.') && name.endsWith('.bak'))).toBe(true);

    const next = store.appendEvent(job.id, { type: 'log', level: 'info', message: 'after repair' });
    expect(next.sequence).toBe(2);
    expect(store.readEvents(job.id).map((event) => event.id)).toEqual([`${job.id}:1`, `${job.id}:2`]);
  });

  it('drops events with invalid identity and sequence while repairing middle corruption', () => {
    const { store, directory } = createStore();
    const job = store.create(request, [2], 0);
    store.appendEvent(job.id, { type: 'log', level: 'info', message: 'second valid event' });
    const eventsFile = path.join(directory, 'jobs', job.id, 'events.jsonl');
    const [firstLine, secondLine] = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    fs.writeFileSync(eventsFile, `${firstLine}\n{broken}\n${JSON.stringify({ ...JSON.parse(secondLine), id: 'wrong', sequence: 99 })}\n`, 'utf8');

    const repaired = store.readEvents(job.id);
    expect(repaired.map((event) => event.message)).toEqual(['Đã thêm lượt chạy vào hàng đợi']);
    expect(repaired.map((event) => event.sequence)).toEqual([1]);
    expect(repaired.map((event) => event.id)).toEqual([`${job.id}:1`]);
    expect(fs.readdirSync(path.dirname(eventsFile)).some((name) => name.startsWith('events.jsonl.corrupt.') && name.endsWith('.bak'))).toBe(true);
    expect(store.appendEvent(job.id, { type: 'log', level: 'info', message: 'third' }).sequence).toBe(2);
  });

  it('drops parseable invalid event shapes and keeps later valid events contiguous', () => {
    const { store, directory } = createStore();
    const job = store.create(request, [2], 0);
    const validSecond = store.appendEvent(job.id, { type: 'log', level: 'info', message: 'valid second' });
    const eventsFile = path.join(directory, 'jobs', job.id, 'events.jsonl');
    const [firstLine, secondLine] = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    const secondEvent = JSON.parse(secondLine);
    fs.writeFileSync(eventsFile, [
      firstLine,
      JSON.stringify({}),
      JSON.stringify({ ...secondEvent, jobId: '11111111-1111-4111-8111-111111111111' }),
      JSON.stringify({ ...secondEvent, id: `${job.id}:0`, sequence: 0 }),
      JSON.stringify({ ...secondEvent, type: 'account.unknown' }),
      secondLine,
      '',
    ].join('\n'), 'utf8');

    const repaired = store.readEvents(job.id);

    expect(repaired.map((event) => event.message)).toEqual(['Đã thêm lượt chạy vào hàng đợi', validSecond.message]);
    expect(repaired.map((event) => event.id)).toEqual([`${job.id}:1`, `${job.id}:2`]);
    expect(repaired.map((event) => event.sequence)).toEqual([1, 2]);
    expect(fs.readdirSync(path.dirname(eventsFile)).some((name) => name.startsWith('events.jsonl.corrupt.'))).toBe(true);
  });

  it.each([
    { type: 'account.unknown', level: 'info', message: 'unknown type' },
    { type: 'log', level: 'info', message: 'invalid data', data: [] },
  ])('rejects malformed runtime events before consuming a sequence', (partial) => {
    const { store } = createStore();
    const job = store.create(request, [2], 0);

    expect(() => store.appendEvent(job.id, partial as never)).toThrow();

    const valid = store.appendEvent(job.id, { type: 'log', level: 'info', message: 'valid event' });
    expect(valid.sequence).toBe(2);
    expect(JSON.stringify(store.readEvents(job.id))).not.toContain(partial.message);
  });

  it('removes repair temp files and preserves the original journal when fsync fails', () => {
    const { store, directory } = createStore();
    const job = store.create(request, [2], 0);
    const jobDirectory = path.join(directory, 'jobs', job.id);
    const eventsFile = path.join(jobDirectory, 'events.jsonl');
    fs.appendFileSync(eventsFile, '{broken}', 'utf8');
    const original = fs.readFileSync(eventsFile, 'utf8');
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk sync failed'); });

    expect(() => store.readEvents(job.id)).toThrow(/disk sync failed/);

    expect(fs.readFileSync(eventsFile, 'utf8')).toBe(original);
    expect(fs.readdirSync(jobDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects traversal and malformed artifact identifiers', () => {
    const { store, directory } = createStore();
    const job = store.create(request, [2], 0);
    const source = path.join(directory, 'source.png');
    fs.writeFileSync(source, 'image');
    const artifactId = store.importArtifact(job.id, source);
    expect(artifactId).not.toBeNull();
    expect(store.artifactPath(job.id, artifactId!)).not.toBeNull();
    expect(store.artifactPath('..\\..\\target', artifactId!)).toBeNull();
    expect(store.artifactPath(job.id, '..%2Fsecret.txt')).toBeNull();
    expect(store.artifactPath(job.id, `${artifactId!}.html`)).toBeNull();
  });

  it('quarantines metadata whose id does not match its safe job directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-store-'));
    directories.push(directory);
    const directoryId = '11111111-1111-4111-8111-111111111111';
    const jobDirectory = path.join(directory, 'jobs', directoryId);
    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.writeFileSync(path.join(jobDirectory, 'metadata.json'), JSON.stringify({
      id: '..\\..\\outside',
      status: 'queued',
      request,
      acceptedRows: [2],
      rejectedCount: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      currentRowIndex: null,
      currentAccount: 0,
      totalAccounts: 1,
      currentStep: null,
      errorCount: 0,
      lastMessage: 'queued',
    }));

    const store = new JobStore(directory);
    store.initialize();

    expect(store.list()).toEqual([]);
    expect(fs.existsSync(path.join(jobDirectory, 'metadata.json'))).toBe(false);
    expect(fs.readdirSync(jobDirectory).some((name) => name.startsWith('metadata.json.invalid.') && name.endsWith('.bak'))).toBe(true);
  });

  it('quarantines metadata stored under a non-UUID directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-store-'));
    directories.push(directory);
    const jobDirectory = path.join(directory, 'jobs', 'not-a-job-id');
    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.writeFileSync(path.join(jobDirectory, 'metadata.json'), '{}');

    const store = new JobStore(directory);
    store.initialize();

    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(jobDirectory).some((name) => name.startsWith('metadata.json.invalid.') && name.endsWith('.bak'))).toBe(true);
  });

  it('loads legacy public requests while stripping obsolete proxy fields and injected metadata', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-job-store-'));
    directories.push(directory);
    const id = '11111111-1111-4111-8111-111111111111';
    const jobDirectory = path.join(directory, 'jobs', id);
    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.writeFileSync(path.join(jobDirectory, 'metadata.json'), JSON.stringify({
      id,
      status: 'succeeded',
      request: {
        ...request,
        options: {
          intervalMinutes: 1,
          proxyMode: 'override',
          hasProxyTokenOverride: true,
          proxyTokenOverride: 'legacy-secret',
        },
      },
      acceptedRows: [2],
      rejectedCount: 0,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      currentRowIndex: 2,
      currentAccount: 1,
      totalAccounts: 1,
      currentStep: 'done',
      errorCount: 0,
      lastMessage: 'done',
      injectedSecret: 'must-not-be-returned',
    }));

    const store = new JobStore(directory);
    store.initialize();

    const loaded = store.get(id);
    expect(loaded?.request.options).toEqual({ intervalMinutes: 1 });
    expect(JSON.stringify(loaded)).not.toContain('legacy-secret');
    expect(JSON.stringify(loaded)).not.toContain('must-not-be-returned');
    expect(fs.existsSync(path.join(jobDirectory, 'metadata.json'))).toBe(true);
  });
});
