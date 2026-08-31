import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  AccountIdentitySchema,
  AccountSelectionSchema,
  JobEventTypeSchema,
  JobPreviewRequestSchema,
  JobStatusSchema,
  WorkflowIdSchema,
  type AccountRuntime,
  type AccountIdentity,
  type JobEvent,
  type JobRecord,
  type JobStatus,
  type PublicJobRequest,
} from '../shared/contracts';
import { redactText, redactValue } from './redactor';

const ACTIVE_STATUSES = new Set<JobStatus>(['running', 'needs_attention', 'cancelling']);
const RESERVED_STATUSES = new Set<JobStatus>(['queued', ...ACTIVE_STATUSES]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]{1,10})?$/i;
const StoredPublicJobRequestSchema = z.object({
  workflowId: WorkflowIdSchema,
  selection: AccountSelectionSchema,
  // Legacy proxy fields are accepted as unknown keys and stripped from loaded API state.
  options: z.object({ intervalMinutes: z.number().positive().max(180) }),
}).pipe(JobPreviewRequestSchema);
const StoredAccountIdentitiesSchema = z.array(AccountIdentitySchema).superRefine((accounts, context) => {
  const rowIndexes = new Set<number>();
  const emails = new Set<string>();
  for (const [index, account] of accounts.entries()) {
    const email = normalizeEmail(account.email);
    if (rowIndexes.has(account.rowIndex)) {
      context.addIssue({ code: 'custom', path: [index, 'rowIndex'], message: 'Duplicate account row identity' });
    }
    if (emails.has(email)) {
      context.addIssue({ code: 'custom', path: [index, 'email'], message: 'Duplicate account email identity' });
    }
    rowIndexes.add(account.rowIndex);
    emails.add(email);
  }
});
const StoredJobSchema = z.object({
  id: z.string().regex(UUID_V4),
  status: JobStatusSchema,
  request: StoredPublicJobRequestSchema,
  acceptedRows: z.array(z.number().int().min(2)),
  acceptedAccounts: StoredAccountIdentitiesSchema.default([]),
  rejectedCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  currentRowIndex: z.number().int().min(2).nullable(),
  currentAccount: z.number().int().nonnegative(),
  totalAccounts: z.number().int().nonnegative(),
  currentStep: z.string().nullable(),
  errorCount: z.number().int().nonnegative(),
  lastMessage: z.string(),
});
const StoredJobEventSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  level: z.enum(['info', 'warning', 'error']),
  type: JobEventTypeSchema,
  rowIndex: z.number().int().min(2).optional(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();
const StoredJobEventPartialSchema = StoredJobEventSchema.omit({
  id: true,
  jobId: true,
  sequence: true,
  timestamp: true,
});
const RUNTIME_PRIORITY: Record<AccountRuntime['state'], number> = {
  queued: 0,
  running: 1,
  waiting_captcha: 2,
  cancelling: 3,
};

function runtimeState(status: JobStatus): AccountRuntime['state'] | null {
  if (status === 'needs_attention') return 'waiting_captcha';
  if (status === 'queued' || status === 'running' || status === 'cancelling') return status;
  return null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class JobStore {
  private jobs = new Map<string, JobRecord>();
  private sequences = new Map<string, number>();

  constructor(private runtimeDirectory: string) {}

  setRuntimeDirectory(runtimeDirectory: string): void {
    if (this.runtimeDirectory === runtimeDirectory) return;
    this.runtimeDirectory = runtimeDirectory;
    this.jobs.clear();
    this.sequences.clear();
    this.initialize();
  }

  initialize(): void {
    fs.mkdirSync(this.jobsDirectory(), { recursive: true });
    const jobsDirectory = path.resolve(this.jobsDirectory());
    for (const entry of fs.readdirSync(this.jobsDirectory(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobDirectory = path.resolve(jobsDirectory, entry.name);
      const metadataPath = path.join(jobDirectory, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue;
      if (!UUID_V4.test(entry.name) || path.dirname(jobDirectory) !== jobsDirectory || !fs.lstatSync(metadataPath).isFile()) {
        this.quarantineMetadata(metadataPath);
        continue;
      }
      let job: JobRecord;
      try {
        job = StoredJobSchema.parse(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))) as JobRecord;
        if (job.id !== entry.name) throw new Error('Job metadata id does not match its directory');
      } catch {
        this.quarantineMetadata(metadataPath);
        continue;
      }
      try {
        const sequence = this.readEvents(job.id).reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
        this.jobs.set(job.id, job);
        this.sequences.set(job.id, sequence);
      } catch (error) {
        this.jobs.delete(job.id);
        this.sequences.delete(job.id);
        console.warn(`Could not load events for job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const job of this.jobs.values()) {
      if (!ACTIVE_STATUSES.has(job.status) && job.status !== 'queued') continue;
      this.update(job.id, {
        status: 'interrupted',
        completedAt: new Date().toISOString(),
        lastMessage: 'Server đã restart trước khi lượt chạy kết thúc',
      });
      this.appendEvent(job.id, {
        type: 'job.state',
        level: 'warning',
        message: 'Lượt chạy bị gián đoạn do server restart',
        data: { status: 'interrupted' },
      });
    }
  }

  create(
    request: PublicJobRequest,
    acceptedRows: number[],
    rejectedCount: number,
    acceptedAccounts: AccountIdentity[] = [],
  ): JobRecord {
    const id = crypto.randomUUID();
    const job = StoredJobSchema.parse({
      id,
      status: 'queued',
      request,
      acceptedRows,
      acceptedAccounts,
      rejectedCount,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      currentRowIndex: null,
      currentAccount: 0,
      totalAccounts: acceptedRows.length,
      currentStep: null,
      errorCount: 0,
      lastMessage: 'Đang chờ trong hàng đợi',
    }) as JobRecord;
    this.jobs.set(id, job);
    this.sequences.set(id, 0);
    this.persist(job);
    this.appendEvent(id, {
      type: 'job.state',
      level: 'info',
      message: 'Đã thêm lượt chạy vào hàng đợi',
      data: { status: 'queued' },
    });
    return { ...job };
  }

  update(id: string, changes: Partial<JobRecord>): JobRecord {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    const updated = { ...current, ...changes };
    this.jobs.set(id, updated);
    this.persist(updated);
    return { ...updated };
  }

  get(id: string): JobRecord | null {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => ({ ...job }));
  }

  appendEvent(jobId: string, partial: Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'>, knownSecrets: string[] = []): JobEvent {
    const validatedPartial = this.validateEventPartial(partial);
    const sequence = (this.sequences.get(jobId) || 0) + 1;
    const event = StoredJobEventSchema.parse({
      ...validatedPartial,
      id: `${jobId}:${sequence}`,
      jobId,
      sequence,
      timestamp: new Date().toISOString(),
      message: redactText(validatedPartial.message, knownSecrets),
      data: redactValue(validatedPartial.data, knownSecrets),
    }) as JobEvent;
    fs.mkdirSync(this.jobDirectory(jobId), { recursive: true });
    this.appendJsonLine(this.eventsPath(jobId), JSON.stringify(event));
    this.sequences.set(jobId, sequence);
    return event;
  }

  validateEventPartial(partial: unknown): Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'> {
    return StoredJobEventPartialSchema.parse(partial) as Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'>;
  }

  appendLog(jobId: string, line: string, knownSecrets: string[] = []): string {
    const redacted = redactText(line, knownSecrets);
    fs.mkdirSync(this.jobDirectory(jobId), { recursive: true });
    fs.appendFileSync(path.join(this.jobDirectory(jobId), 'job.log'), `${redacted}\n`, 'utf8');
    return redacted;
  }

  readEvents(jobId: string): JobEvent[] {
    const file = this.eventsPath(jobId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const events: JobEvent[] = [];
    let repaired = false;
    const seenSequences = new Set<number>();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      try {
        const event = StoredJobEventSchema.parse(JSON.parse(line)) as JobEvent;
        if (event.jobId !== jobId || event.id !== `${jobId}:${event.sequence}` || seenSequences.has(event.sequence)) {
          repaired = true;
          continue;
        }
        if (event.sequence !== events.length + 1) repaired = true;
        seenSequences.add(event.sequence);
        events.push(event);
      } catch {
        repaired = true;
      }
    }
    if (repaired) {
      const backup = `${file}.corrupt.${Date.now()}.${crypto.randomUUID()}.bak`;
      fs.copyFileSync(file, backup);
      const repairedEvents = events.map((event, index) => ({
        ...event,
        id: `${jobId}:${index + 1}`,
        jobId,
        sequence: index + 1,
      }));
      this.writeTextAtomic(
        file,
        repairedEvents.map((event) => JSON.stringify(event)).join('\n') + (repairedEvents.length ? '\n' : ''),
      );
      this.sequences.set(jobId, repairedEvents.length);
      return repairedEvents;
    }
    return events;
  }

  readLog(jobId: string): string {
    const file = path.join(this.jobDirectory(jobId), 'job.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  lastRunByRow(currentAccounts: AccountIdentity[] = []): Map<number, string> {
    const result = new Map<number, string>();
    const rowsByEmail = new Map<string, number[]>();
    for (const account of currentAccounts) {
      const email = normalizeEmail(account.email);
      const rows = rowsByEmail.get(email) || [];
      rows.push(account.rowIndex);
      rowsByEmail.set(email, rows);
    }
    for (const job of this.list().reverse()) {
      if (job.acceptedAccounts?.length && currentAccounts.length) {
        for (const account of job.acceptedAccounts) {
          const currentRows = rowsByEmail.get(normalizeEmail(account.email)) || [];
          if (currentRows.length === 1) result.set(currentRows[0], job.createdAt);
        }
      } else {
        for (const rowIndex of job.acceptedRows) result.set(rowIndex, job.createdAt);
      }
    }
    return result;
  }

  jobsForRow(rowIndex: number, email?: string): JobRecord[] {
    const normalizedEmail = email ? normalizeEmail(email) : '';
    return this.list().filter((job) => job.acceptedAccounts?.length && normalizedEmail
      ? job.acceptedAccounts.some((account) => normalizeEmail(account.email) === normalizedEmail)
      : job.acceptedRows.includes(rowIndex));
  }

  rowIndexForAccount(job: JobRecord, rowIndex: number, email: string): number | null {
    if (!job.acceptedAccounts?.length) return job.acceptedRows.includes(rowIndex) ? rowIndex : null;
    const matches = job.acceptedAccounts.filter((account) => normalizeEmail(account.email) === normalizeEmail(email));
    return matches.length === 1 ? matches[0].rowIndex : null;
  }

  runtimesByRow(excludeJobId?: string, currentAccounts: AccountIdentity[] = []): Map<number, AccountRuntime> {
    const runtimes = new Map<number, AccountRuntime>();
    const rowsByEmail = new Map<string, number[]>();
    for (const account of currentAccounts) {
      const email = normalizeEmail(account.email);
      const rowIndexes = rowsByEmail.get(email) || [];
      rowIndexes.push(account.rowIndex);
      rowsByEmail.set(email, rowIndexes);
    }
    for (const job of this.jobs.values()) {
      if (job.id === excludeJobId || !RESERVED_STATUSES.has(job.status)) continue;
      const state = runtimeState(job.status);
      if (!state) continue;
      const runtime = {
        state,
        jobId: job.id,
        workflowId: job.request.workflowId,
        currentStep: job.currentStep,
      };
      const reservedRows = job.acceptedAccounts?.length && currentAccounts.length
        ? job.acceptedAccounts.flatMap((account) => rowsByEmail.get(normalizeEmail(account.email)) || [])
        : job.acceptedRows;
      for (const rowIndex of reservedRows) {
        const current = runtimes.get(rowIndex);
        if (!current || RUNTIME_PRIORITY[state] > RUNTIME_PRIORITY[current.state]) runtimes.set(rowIndex, runtime);
      }
    }
    return runtimes;
  }

  artifactPath(jobId: string, artifactId: string): string | null {
    if (!UUID_V4.test(jobId) || !this.jobs.has(jobId) || !ARTIFACT_ID.test(artifactId)) return null;
    const directory = path.resolve(this.jobDirectory(jobId), 'artifacts');
    const file = path.resolve(directory, artifactId);
    if (path.dirname(file) !== directory) return null;
    return fs.existsSync(file) ? file : null;
  }

  importArtifact(jobId: string, sourcePath: string): string | null {
    if (!UUID_V4.test(jobId) || !this.jobs.has(jobId) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return null;
    const extension = path.extname(sourcePath).toLowerCase();
    const artifactId = `${crypto.randomUUID()}${extension}`;
    const directory = path.join(this.jobDirectory(jobId), 'artifacts');
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(directory, artifactId));
    return artifactId;
  }

  private jobsDirectory(): string {
    return path.join(this.runtimeDirectory, 'jobs');
  }

  private jobDirectory(jobId: string): string {
    return path.join(this.jobsDirectory(), jobId);
  }

  private eventsPath(jobId: string): string {
    return path.join(this.jobDirectory(jobId), 'events.jsonl');
  }

  private appendJsonLine(file: string, line: string): void {
    let prefix = '';
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 0) {
        const descriptor = fs.openSync(file, 'r');
        const last = Buffer.alloc(1);
        try {
          fs.readSync(descriptor, last, 0, 1, size - 1);
        } finally {
          fs.closeSync(descriptor);
        }
        if (last[0] !== 0x0a) prefix = '\n';
      }
    }
    fs.appendFileSync(file, `${prefix}${line}\n`, 'utf8');
  }

  private writeTextAtomic(file: string, content: string): void {
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let completed = false;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
      completed = true;
    } finally {
      if (!completed) {
        try { fs.unlinkSync(temporary); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }

  private quarantineMetadata(file: string): void {
    const quarantine = `${file}.invalid.${Date.now()}.${crypto.randomUUID()}.bak`;
    try {
      fs.renameSync(file, quarantine);
    } catch (error) {
      console.warn(`Could not quarantine invalid job metadata at ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(job: JobRecord): void {
    const directory = this.jobDirectory(job.id);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'metadata.json');
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  }
}
