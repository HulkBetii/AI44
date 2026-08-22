import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { JobEvent, JobPreviewRequest, JobRecord, JobRequest, JobStatus, PublicJobRequest } from '../shared/contracts';
import { previewJob } from './domain';
import type { AccountService } from './account-service';
import type { ConfigStore } from './config';
import type { JobStore } from './job-store';
import { redactText } from './redactor';

interface WorkerEventMessage {
  kind: 'event';
  event: Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'>;
}

export function createLineBuffer(onLine: (line: string) => void) {
  let pending = '';
  return {
    write(chunk: Buffer | string): void {
      const lines = `${pending}${chunk.toString()}`.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line) onLine(line);
    },
    flush(): void {
      if (pending) onLine(pending);
      pending = '';
    },
  };
}

export class JobManager extends EventEmitter {
  private queue: string[] = [];
  private activeJobId: string | null = null;
  private worker: ChildProcess | null = null;
  private privateRequests = new Map<string, JobRequest>();
  private expectedExit = new Set<string>();
  private forcedTermination = new Set<string>();
  private seenRows = new Map<string, Set<number>>();
  private focusWaiters = new Map<string, Set<(focused: boolean) => void>>();
  private shuttingDown = false;
  private cleanupBlocked = false;

  constructor(
    private readonly projectRoot: string,
    private readonly accountService: AccountService,
    private readonly configStore: ConfigStore,
    private readonly store: JobStore,
  ) {
    super();
  }

  async preview(request: JobPreviewRequest | JobRequest, excludeJobId?: string) {
    return previewJob(
      await this.accountService.rows(true),
      request,
      this.store.runtimesByRow(excludeJobId),
    );
  }

  async create(request: JobRequest): Promise<JobRecord> {
    if (this.cleanupBlocked) {
      throw new Error('Queue đang khóa vì GPM cleanup thất bại; kiểm tra profile còn sót và restart server trước khi chạy tiếp');
    }
    const preview = await this.preview(request);
    if (request.workflowId !== 'proxyCheck' && preview.accepted.length === 0) {
      throw new Error('Không có account hợp lệ cho workflow đã chọn');
    }
    const publicRequest = this.toPublicRequest(request);
    const job = this.store.create(publicRequest, preview.accepted.map((account) => account.rowIndex), preview.rejected.length);
    this.privateRequests.set(job.id, request);
    this.queue.push(job.id);
    const queuedEvent = this.store.readEvents(job.id).at(-1);
    if (queuedEvent) this.publish(queuedEvent);
    this.emit('changed', job);
    void this.pump();
    return job;
  }

  active(): JobRecord | null {
    return this.activeJobId ? this.store.get(this.activeJobId) : null;
  }

  queueLength(): number {
    return this.queue.length;
  }

  isCleanupBlocked(): boolean {
    return this.cleanupBlocked;
  }

  canEditSettings(): boolean {
    return !this.cleanupBlocked && !this.activeJobId && this.queue.length === 0;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = this.store.get(jobId);
    if (!job) throw new Error('Không tìm thấy lượt chạy');
    if (job.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== jobId);
      this.privateRequests.delete(jobId);
      return this.transition(jobId, 'cancelled', 'Đã hủy lượt chạy trong hàng đợi');
    }
    if (jobId !== this.activeJobId || !this.worker) throw new Error('Lượt chạy này không thể hủy');
    const updated = this.transition(jobId, 'cancelling', 'Đang đóng browser và giải phóng GPM profile');
    this.worker.send?.({ kind: 'cancel' });
    setTimeout(() => {
      if (this.activeJobId === jobId && this.worker) {
        this.forcedTermination.add(jobId);
        this.worker.kill();
      }
    }, 45_000).unref();
    return updated;
  }

  async focus(jobId: string): Promise<boolean> {
    if (jobId !== this.activeJobId || !this.worker?.connected) return false;
    return new Promise<boolean>((resolve) => {
      const waiters = this.focusWaiters.get(jobId) || new Set<(focused: boolean) => void>();
      const finish = (focused: boolean) => {
        clearTimeout(timeout);
        waiters.delete(finish);
        if (waiters.size === 0) this.focusWaiters.delete(jobId);
        resolve(focused);
      };
      const timeout = setTimeout(() => finish(false), 3_000);
      timeout.unref();
      waiters.add(finish);
      this.focusWaiters.set(jobId, waiters);
      this.worker?.send?.({ kind: 'focus' });
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.worker || !this.activeJobId) return;
    const jobId = this.activeJobId;
    const worker = this.worker;
    this.expectedExit.add(jobId);
    this.transition(jobId, 'interrupted', 'Server đang dừng; job cần được retry thủ công');
    worker.send?.({ kind: 'cancel' });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        worker.kill();
        resolve();
      }, 45_000);
      worker.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown || this.cleanupBlocked || this.activeJobId || this.queue.length === 0) return;
    const jobId = this.queue.shift()!;
    const job = this.store.get(jobId);
    const request = this.privateRequests.get(jobId);
    if (!job || !request) {
      void this.pump();
      return;
    }

    let freshPreview;
    try {
      freshPreview = await this.preview(request, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể kiểm tra Google Sheet';
      this.transition(jobId, 'failed', `Không thể kiểm tra eligibility: ${message}`);
      this.privateRequests.delete(jobId);
      void this.pump();
      return;
    }
    const acceptedRows = freshPreview.accepted.map((account) => account.rowIndex);
    if (request.workflowId !== 'proxyCheck' && acceptedRows.length === 0) {
      this.transition(jobId, 'failed', 'Eligibility đã thay đổi; không còn account hợp lệ');
      this.privateRequests.delete(jobId);
      void this.pump();
      return;
    }

    this.activeJobId = jobId;
    this.seenRows.set(jobId, new Set());
    this.store.update(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      acceptedRows,
      totalAccounts: acceptedRows.length,
      lastMessage: 'Worker đã bắt đầu',
    });
    this.publish(this.store.appendEvent(jobId, {
      type: 'job.state', level: 'info', message: 'Worker đã bắt đầu', data: { status: 'running' },
    }));

    const settings = this.configStore.get();
    const workerPath = path.join(this.projectRoot, 'automation-worker.js');
    const secrets = request.options.proxyTokenOverride ? [request.options.proxyTokenOverride] : [];
    const child = fork(workerPath, [], {
      cwd: this.projectRoot,
      silent: true,
      env: {
        ...process.env,
        MAIL_TEMP_SHEET_ID: settings.sheetId,
        MAIL_TEMP_SHEET_NAME: settings.sheetName,
        GOOGLE_SERVICE_ACCOUNT_PATH: settings.serviceAccountPath,
        GPM_API_BASE: settings.gpmApiBase,
        MAIL_TEMP_RUNTIME_DIR: settings.runtimeDirectory,
      },
    });
    this.worker = child;

    const attachLog = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      const buffer = createLineBuffer((line) => this.store.appendLog(jobId, line, secrets));
      let flushed = false;
      const flush = () => {
        if (flushed) return;
        flushed = true;
        buffer.flush();
      };
      stream.on('data', (chunk: Buffer | string) => buffer.write(chunk));
      stream.once('end', flush);
      stream.once('close', flush);
    };
    attachLog(child.stdout);
    attachLog(child.stderr);
    child.on('message', (message: WorkerEventMessage | { kind: string; errorCount?: number; error?: string; focused?: boolean }) => {
      if (message.kind === 'event') this.handleWorkerEvent(jobId, (message as WorkerEventMessage).event, secrets);
      if (message.kind === 'focus-result') this.resolveFocusWaiters(jobId, Boolean(message.focused));
      if (message.kind === 'completed') {
        const state: JobStatus = this.shuttingDown
          ? 'interrupted'
          : message.errorCount ? 'completed_with_errors' : 'succeeded';
        this.expectedExit.add(jobId);
        this.transition(jobId, state, this.shuttingDown
          ? 'Server đã dừng; job cần được retry thủ công'
          : message.errorCount ? 'Hoàn thành với lỗi account' : 'Hoàn thành thành công', secrets);
      }
      if (message.kind === 'fatal') {
        this.expectedExit.add(jobId);
        this.transition(jobId, this.shuttingDown ? 'interrupted' : 'failed', this.shuttingDown
          ? 'Server đã dừng; job cần được retry thủ công'
          : message.error || 'Worker gặp lỗi nghiêm trọng', secrets);
      }
      if (message.kind === 'cancelled') {
        this.expectedExit.add(jobId);
        this.transition(jobId, this.shuttingDown ? 'interrupted' : 'cancelled', this.shuttingDown
          ? 'Server đã dừng sau khi giải phóng tài nguyên; job cần được retry thủ công'
          : 'Đã hủy và giải phóng tài nguyên', secrets);
      }
      if (message.kind === 'cleanup-failed') {
        this.cleanupBlocked = true;
        this.expectedExit.add(jobId);
        this.transition(jobId, 'failed', `${message.error || 'Cleanup GPM thất bại'}; queue đã khóa để tránh chạy job kế tiếp`, secrets);
      }
    });
    child.once('error', (error) => {
      this.expectedExit.add(jobId);
      this.transition(jobId, 'failed', `Không thể khởi động worker: ${error.message}`, secrets);
    });
    child.once('close', (code) => {
      if (!this.expectedExit.has(jobId)) {
        const forced = this.forcedTermination.has(jobId);
        const current = this.store.get(jobId);
        if (forced) {
          this.cleanupBlocked = true;
          this.transition(jobId, 'failed', 'Worker bị buộc dừng vì cleanup quá hạn; cần kiểm tra GPM profile');
        } else if (current?.status === 'cancelling') {
          this.transition(jobId, 'cancelled', 'Đã hủy và giải phóng tài nguyên');
        } else {
          this.transition(jobId, code === 0 ? 'succeeded' : 'failed', `Worker kết thúc với code ${code}`);
        }
      }
      this.expectedExit.delete(jobId);
      this.forcedTermination.delete(jobId);
      this.privateRequests.delete(jobId);
      this.seenRows.delete(jobId);
      this.resolveFocusWaiters(jobId, false);
      this.activeJobId = null;
      this.worker = null;
      this.accountService.invalidate();
      void this.pump();
    });
    child.send({ kind: 'start', jobId, request, acceptedRows });
  }

  private handleWorkerEvent(jobId: string, partial: WorkerEventMessage['event'], secrets: string[]): void {
    const current = this.store.get(jobId);
    if (!current) return;
    const changes: Partial<JobRecord> = { lastMessage: redactText(partial.message, secrets) };
    if (partial.type === 'account.started') {
      changes.currentRowIndex = partial.rowIndex || null;
      const seen = this.seenRows.get(jobId) || new Set<number>();
      if (partial.rowIndex && !seen.has(partial.rowIndex)) {
        seen.add(partial.rowIndex);
        this.seenRows.set(jobId, seen);
        changes.currentAccount = Math.min(seen.size, current.totalAccounts);
      }
    }
    if (partial.type === 'step.changed') changes.currentStep = redactText(String(partial.data?.step || partial.message), secrets);
    if (partial.type === 'phase.started') changes.currentStep = redactText(`phase:${String(partial.data?.phaseId || partial.message)}`, secrets);
    if (partial.type === 'account.failed') changes.errorCount = current.errorCount + 1;
    if (partial.type === 'attention.required') changes.status = 'needs_attention';
    if (partial.type === 'attention.cleared' && current.status === 'needs_attention') changes.status = 'running';
    if (partial.rowIndex && ['account.started', 'attention.required', 'account.succeeded', 'account.failed'].includes(partial.type)) {
      this.accountService.invalidateRows([partial.rowIndex]);
    }
    this.store.update(jobId, changes);
    let eventData = partial.data;
    if (partial.type === 'artifact.created' && typeof partial.data?.path === 'string') {
      const artifactId = this.store.importArtifact(jobId, partial.data.path);
      eventData = artifactId ? { kind: partial.data.kind, artifactId } : { kind: partial.data.kind };
    }
    this.publish(this.store.appendEvent(jobId, { ...partial, data: eventData }, secrets));
  }

  private transition(jobId: string, status: JobStatus, message: string, knownSecrets: string[] = []): JobRecord {
    const terminal = ['cancelled', 'succeeded', 'completed_with_errors', 'failed', 'interrupted'].includes(status);
    const redactedMessage = redactText(message, knownSecrets);
    const job = this.store.update(jobId, {
      status,
      lastMessage: redactedMessage,
      completedAt: terminal ? new Date().toISOString() : null,
    });
    this.publish(this.store.appendEvent(jobId, {
      type: 'job.state',
      level: status === 'failed' ? 'error' : status === 'needs_attention' || status === 'cancelling' ? 'warning' : 'info',
      message: redactedMessage,
      data: { status },
    }, knownSecrets));
    this.emit('changed', job);
    return job;
  }

  private publish(event: JobEvent): void {
    this.emit('event', event);
  }

  private resolveFocusWaiters(jobId: string, focused: boolean): void {
    const waiters = this.focusWaiters.get(jobId);
    if (!waiters) return;
    for (const finish of [...waiters]) finish(focused);
  }

  private toPublicRequest(request: JobRequest): PublicJobRequest {
    return {
      workflowId: request.workflowId,
      selection: request.selection,
      options: {
        proxyMode: request.options.proxyMode,
        intervalMinutes: request.options.intervalMinutes,
        hasProxyTokenOverride: Boolean(request.options.proxyTokenOverride),
      },
    };
  }
}
