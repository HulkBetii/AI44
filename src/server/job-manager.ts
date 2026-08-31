import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import {
  type JobEvent,
  type JobPreviewRequest,
  type JobRecord,
  type JobRequest,
  type JobStatus,
  type PublicJobRequest,
  type RuntimeSettings,
} from '../shared/contracts';
import { previewJob } from './domain';
import type { AccountService } from './account-service';
import { runtimeEnvironment, runtimeSecretValues, type ConfigStore } from './config';
import type { JobStore } from './job-store';
import { redactText } from './redactor';
import type { RecoveryService } from './recovery';

interface WorkerEventMessage {
  kind: 'event';
  event: Omit<JobEvent, 'id' | 'jobId' | 'sequence' | 'timestamp'>;
}

export class AutomationLockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationLockConflictError';
  }
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

export function createWorkerEnvironment(
  settings: RuntimeSettings,
  ambientEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = {
    ...ambientEnvironment,
    ...runtimeEnvironment(settings),
  };
  delete environment.MAIL_TEMP_LOCK_TOKEN;
  delete environment.MAIL_TEMP_LOCK_HELD;
  return environment;
}

export class JobManager extends EventEmitter {
  private queue: string[] = [];
  private createChain = Promise.resolve();
  private createOperations = 0;
  private preparingJobId: string | null = null;
  private pumping = false;
  private activeJobId: string | null = null;
  private worker: ChildProcess | null = null;
  private privateRequests = new Map<string, JobRequest>();
  private expectedExit = new Set<string>();
  private forcedTermination = new Set<string>();
  private seenRows = new Map<string, Set<number>>();
  private focusWaiters = new Map<string, Set<(focused: boolean) => void>>();
  private cancelTimers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;
  private cleanupBlocked = false;

  constructor(
    private readonly projectRoot: string,
    private readonly accountService: AccountService,
    private readonly configStore: ConfigStore,
    private readonly store: JobStore,
    private readonly recoveryService?: RecoveryService,
    private readonly lockReader: (runtimeDirectory: string) => { status: 'free' | 'busy' | 'stale' } = () => ({ status: 'free' }),
    private readonly automationAdmissionGuard: (runtimeDirectory: string) => void = () => undefined,
    private readonly recoveryGuardAcquirer: (runtimeDirectory: string) => () => void = () => () => undefined,
  ) {
    super();
  }

  async preview(
    request: JobPreviewRequest | JobRequest,
    excludeJobId?: string,
    eligibilityOptions: { explicitReset?: boolean } = {},
  ) {
    const accounts = await this.accountService.rows(true);
    return previewJob(
      accounts,
      request,
      this.store.runtimesByRow(excludeJobId, accounts),
      eligibilityOptions,
    );
  }

  async create(request: JobRequest): Promise<JobRecord> {
    this.createOperations++;
    const previous = this.createChain;
    let release!: () => void;
    this.createChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.shuttingDown) throw new Error('Server đang dừng; không thể tạo job mới');
      if (this.cleanupBlocked) {
        throw new Error('Queue đang khóa vì GPM cleanup thất bại; kiểm tra profile còn sót và restart server trước khi chạy tiếp');
      }
      const hasOwnedActiveWorker = Boolean(this.activeJobId);
      if (!hasOwnedActiveWorker) {
        this.assertAutomationAvailable();
        await this.prepareRecoveryForJob();
      }
      const preview = await this.preview(request);
      if (this.shuttingDown) throw new Error('Server đang dừng; không thể tạo job mới');
      if (request.workflowId !== 'proxyCheck' && preview.accepted.length === 0) {
        throw new Error('Không có account hợp lệ cho workflow đã chọn');
      }
      const publicRequest = this.toPublicRequest(request);
      const acceptedAccounts = preview.accepted.map((account) => ({
        rowIndex: account.rowIndex,
        email: account.email.trim(),
      }));
      const job = this.store.create(
        publicRequest,
        acceptedAccounts.map((account) => account.rowIndex),
        preview.rejected.length,
        acceptedAccounts,
      );
      this.privateRequests.set(job.id, request);
      this.queue.push(job.id);
      const queuedEvent = this.store.readEvents(job.id).at(-1);
      if (queuedEvent) this.publish(queuedEvent);
      this.emit('changed', job);
      void this.pump();
      return job;
    } finally {
      this.createOperations--;
      release();
    }
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
    return this.canMutateRecovery()
      && (this.recoveryService?.canEditSettings() ?? true);
  }

  canMutateRecovery(): boolean {
    return !this.cleanupBlocked
      && !this.shuttingDown
      && !this.activeJobId
      && !this.preparingJobId
      && this.createOperations === 0
      && this.queue.length === 0;
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
    this.clearCancelTimer(jobId);
    const timeout = setTimeout(() => {
      this.cancelTimers.delete(jobId);
      if (this.activeJobId === jobId && this.worker) {
        this.forcedTermination.add(jobId);
        this.worker.kill();
      }
    }, 45_000);
    timeout.unref();
    this.cancelTimers.set(jobId, timeout);
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
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.shuttingDown && !this.cleanupBlocked && !this.activeJobId && this.queue.length > 0) {
        const jobId = this.queue[0];
        this.preparingJobId = jobId;
        const job = this.store.get(jobId);
        const request = this.privateRequests.get(jobId);
        if (!job || !request || job.status !== 'queued') {
          this.queue.shift();
          this.privateRequests.delete(jobId);
          continue;
        }

        let freshPreview;
        try {
          this.assertAutomationAvailable();
          await this.prepareRecoveryForJob();
          freshPreview = await this.previewQueuedJob(jobId, request);
        } catch (error) {
          const current = this.store.get(jobId);
          if (this.queue[0] === jobId && current?.status === 'queued') {
            this.queue.shift();
            const message = error instanceof Error ? error.message : 'Không thể kiểm tra Google Sheet';
            this.transition(jobId, 'failed', `Không thể kiểm tra eligibility: ${message}`);
          }
          this.privateRequests.delete(jobId);
          continue;
        }

        const current = this.store.get(jobId);
        if (
          this.shuttingDown
          || this.cleanupBlocked
          || this.queue[0] !== jobId
          || current?.status !== 'queued'
          || this.privateRequests.get(jobId) !== request
        ) {
          continue;
        }

        const acceptedRows = freshPreview.accepted.map((account) => account.rowIndex);
        const acceptedAccounts = freshPreview.accepted.map((account) => ({
          rowIndex: account.rowIndex,
          email: account.email.trim(),
        }));
        if (request.workflowId !== 'proxyCheck' && acceptedRows.length === 0) {
          this.queue.shift();
          this.transition(jobId, 'failed', 'Eligibility đã thay đổi; không còn account hợp lệ');
          this.privateRequests.delete(jobId);
          continue;
        }

        this.queue.shift();
        this.preparingJobId = null;
        this.activeJobId = jobId;
        this.seenRows.set(jobId, new Set());
        this.store.update(jobId, {
          status: 'running',
          startedAt: new Date().toISOString(),
          acceptedRows,
          acceptedAccounts,
          totalAccounts: acceptedRows.length,
          lastMessage: 'Worker đã bắt đầu',
        });
        this.publish(this.store.appendEvent(jobId, {
          type: 'job.state', level: 'info', message: 'Worker đã bắt đầu', data: { status: 'running' },
        }));
        try {
          this.startWorker(jobId, request, acceptedRows, acceptedAccounts);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Không thể khởi động worker';
          this.transition(jobId, 'failed', `Không thể khởi động worker: ${message}`);
          this.privateRequests.delete(jobId);
          this.seenRows.delete(jobId);
          this.activeJobId = null;
          this.worker = null;
          continue;
        }
        return;
      }
    } finally {
      this.preparingJobId = null;
      this.pumping = false;
      if (!this.shuttingDown && !this.cleanupBlocked && !this.activeJobId && this.queue.length > 0) {
        void this.pump();
      }
    }
  }

  private async previewQueuedJob(jobId: string, request: JobRequest) {
    if (request.workflowId === 'proxyCheck') return this.preview(request, jobId);
    const identities = this.store.get(jobId)?.acceptedAccounts || [];
    return this.preview({
      ...request,
      selection: { mode: 'identities', accounts: identities },
    }, jobId, {
      explicitReset: request.workflowId === 'resetPassword' && request.selection.mode !== 'allEligible',
    });
  }

  private startWorker(
    jobId: string,
    request: JobRequest,
    acceptedRows: number[],
    acceptedAccounts: Array<{ rowIndex: number; email: string }>,
  ): void {
    const settings = this.configStore.get();
    const workerPath = path.join(this.projectRoot, 'automation-worker.js');
    const secrets = runtimeSecretValues(settings);
    const child = fork(workerPath, [], {
      cwd: this.projectRoot,
      silent: true,
      env: createWorkerEnvironment(settings),
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
      this.handleWorkerMessage(jobId, message, secrets);
    });
    child.once('error', (error) => {
      this.expectedExit.add(jobId);
      this.transition(jobId, 'failed', `Không thể khởi động worker: ${error.message}`, secrets);
    });
    child.once('close', (code) => this.handleWorkerClose(jobId, code));
    child.send({ kind: 'start', jobId, request, acceptedRows, acceptedAccounts });
  }

  private handleWorkerEvent(jobId: string, partial: WorkerEventMessage['event'], secrets: string[]): void {
    this.store.validateEventPartial(partial);
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

  private handleWorkerMessage(
    jobId: string,
    message: WorkerEventMessage | { kind: string; errorCount?: number; error?: string; focused?: boolean },
    secrets: string[],
  ): void {
    if (message.kind === 'event') {
      try {
        this.handleWorkerEvent(jobId, (message as WorkerEventMessage).event, secrets);
      } catch (error) {
        this.cleanupBlocked = true;
        this.expectedExit.add(jobId);
        const detail = error instanceof Error ? error.message : 'invalid event payload';
        this.transition(jobId, 'failed', `Worker gửi event không hợp lệ: ${detail}; queue đã khóa để kiểm tra cleanup`, secrets);
        this.worker?.kill();
        return;
      }
    }
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
      this.clearCancelTimer(jobId);
      this.cleanupBlocked = true;
      this.expectedExit.add(jobId);
      this.transition(jobId, 'failed', `${message.error || 'Cleanup GPM thất bại'}; queue đã khóa để tránh chạy job kế tiếp`, secrets);
    }
  }

  private handleWorkerClose(jobId: string, code: number | null): void {
    this.clearCancelTimer(jobId);
    if (!this.expectedExit.has(jobId)) {
      const forced = this.forcedTermination.has(jobId);
      const current = this.store.get(jobId);
      if (forced) {
        this.cleanupBlocked = true;
        this.transition(jobId, 'failed', 'Worker bị buộc dừng vì cleanup quá hạn; cần kiểm tra GPM profile');
      } else if (current?.status === 'cancelling') {
        this.transition(jobId, 'cancelled', 'Đã hủy và giải phóng tài nguyên');
      } else {
        this.transition(jobId, 'failed', `Worker kết thúc ngoài dự kiến với code ${code}`);
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
  }

  private clearCancelTimer(jobId: string): void {
    const timeout = this.cancelTimers.get(jobId);
    if (!timeout) return;
    clearTimeout(timeout);
    this.cancelTimers.delete(jobId);
  }

  private assertAutomationAvailable(): void {
    const runtimeDirectory = this.configStore.get().runtimeDirectory;
    let status: 'free' | 'busy' | 'stale';
    try {
      status = this.lockReader(runtimeDirectory).status;
    } catch {
      throw new AutomationLockConflictError('Không thể kiểm tra automation lock; chưa tạo job');
    }
    if (status !== 'free') {
      throw new AutomationLockConflictError(`Automation lock đang ${status}; chưa tạo job`);
    }
    try {
      this.automationAdmissionGuard(runtimeDirectory);
    } catch (error) {
      throw new AutomationLockConflictError(error instanceof Error ? error.message : 'Automation state chưa an toàn; chưa tạo job');
    }
  }

  private async prepareRecoveryForJob(): Promise<void> {
    if (!this.recoveryService) return;
    const runtimeDirectory = this.configStore.get().runtimeDirectory;
    let releaseGuard: () => void;
    try {
      releaseGuard = this.recoveryGuardAcquirer(runtimeDirectory);
    } catch (error) {
      throw new AutomationLockConflictError(error instanceof Error
        ? error.message
        : 'Không thể khóa recovery maintenance; chưa tạo job');
    }
    try {
      this.assertAutomationAvailable();
      await this.recoveryService.prepareForJob();
    } finally {
      releaseGuard();
    }
  }

  private toPublicRequest(request: JobRequest): PublicJobRequest {
    return {
      workflowId: request.workflowId,
      selection: request.selection,
      options: {
        intervalMinutes: request.options.intervalMinutes,
      },
    };
  }
}
