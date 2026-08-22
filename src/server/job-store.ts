import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AccountRuntime, JobEvent, JobRecord, JobStatus, PublicJobRequest } from '../shared/contracts';
import { redactText, redactValue } from './redactor';

const ACTIVE_STATUSES = new Set<JobStatus>(['running', 'needs_attention', 'cancelling']);
const RESERVED_STATUSES = new Set<JobStatus>(['queued', ...ACTIVE_STATUSES]);
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
    for (const entry of fs.readdirSync(this.jobsDirectory(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadataPath = path.join(this.jobsDirectory(), entry.name, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as JobRecord;
        this.jobs.set(job.id, job);
        this.sequences.set(job.id, this.readEvents(job.id).at(-1)?.sequence || 0);
      } catch {}
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

  create(request: PublicJobRequest, acceptedRows: number[], rejectedCount: number): JobRecord {
    const id = crypto.randomUUID();
    const job: JobRecord = {
      id,
      status: 'queued',
      request,
      acceptedRows,
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
    };
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
    const sequence = (this.sequences.get(jobId) || 0) + 1;
    this.sequences.set(jobId, sequence);
    const event: JobEvent = {
      ...partial,
      id: `${jobId}:${sequence}`,
      jobId,
      sequence,
      timestamp: new Date().toISOString(),
      message: redactText(partial.message, knownSecrets),
      data: redactValue(partial.data, knownSecrets) as Record<string, unknown> | undefined,
    };
    fs.mkdirSync(this.jobDirectory(jobId), { recursive: true });
    fs.appendFileSync(this.eventsPath(jobId), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
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
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JobEvent);
  }

  readLog(jobId: string): string {
    const file = path.join(this.jobDirectory(jobId), 'job.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  lastRunByRow(): Map<number, string> {
    const result = new Map<number, string>();
    for (const job of this.list().reverse()) {
      for (const rowIndex of job.acceptedRows) result.set(rowIndex, job.createdAt);
    }
    return result;
  }

  jobsForRow(rowIndex: number): JobRecord[] {
    return this.list().filter((job) => job.acceptedRows.includes(rowIndex));
  }

  runtimesByRow(excludeJobId?: string): Map<number, AccountRuntime> {
    const runtimes = new Map<number, AccountRuntime>();
    for (const job of this.jobs.values()) {
      if (job.id === excludeJobId || !RESERVED_STATUSES.has(job.status)) continue;
      const state = runtimeState(job.status);
      if (!state) continue;
      const runtime = { state, jobId: job.id, workflowId: job.request.workflowId };
      for (const rowIndex of job.acceptedRows || []) {
        const current = runtimes.get(rowIndex);
        if (!current || RUNTIME_PRIORITY[state] > RUNTIME_PRIORITY[current.state]) runtimes.set(rowIndex, runtime);
      }
    }
    return runtimes;
  }

  artifactPath(jobId: string, artifactId: string): string | null {
    const safeName = path.basename(artifactId);
    const file = path.join(this.jobDirectory(jobId), 'artifacts', safeName);
    return fs.existsSync(file) ? file : null;
  }

  importArtifact(jobId: string, sourcePath: string): string | null {
    if (!fs.existsSync(sourcePath)) return null;
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

  private persist(job: JobRecord): void {
    const directory = this.jobDirectory(job.id);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'metadata.json');
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  }
}
