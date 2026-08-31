import path from 'node:path';
import type { RecoveryEntrySummary, RecoveryResponse } from '../shared/contracts';
import type { AccountService } from './account-service';
import type { ConfigStore } from './config';
import { redactText } from './redactor';

interface RecoveryRecord extends RecoveryEntrySummary {
  elevenPassword: string;
}

interface RecoveryJournalModule {
  assertNoPreparedRecoveries(options?: { runtimeDirectory: string; projectRoot: string }): void;
  getRecoveryEntry(id: string, options?: { runtimeDirectory: string; projectRoot: string }): RecoveryRecord | null;
  listRecoverySummaries(options?: { runtimeDirectory: string; projectRoot: string }): RecoveryEntrySummary[];
  removeRecovery(id: string, options?: { runtimeDirectory: string; projectRoot: string }): boolean;
  syncConfirmedRecoveries(
    sheet: {
      updatePasswordByEmail(email: string, password: string): Promise<void>;
    },
    options?: { runtimeDirectory: string; projectRoot: string },
  ): Promise<RecoveryEntrySummary[]>;
}

export class RecoveryService {
  private readonly journal: RecoveryJournalModule;
  private operationChain = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly configStore: ConfigStore,
    private readonly accountService: AccountService,
  ) {
    this.journal = require(path.join(projectRoot, 'recovery-journal.js')) as RecoveryJournalModule;
  }

  private options(runtimeDirectory = this.configStore.get().runtimeDirectory): { runtimeDirectory: string; projectRoot: string } {
    return {
      projectRoot: this.projectRoot,
      runtimeDirectory,
    };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChain;
    let release!: () => void;
    this.operationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async updatePasswordByEmail(email: string, password: string): Promise<void> {
    try {
      await this.accountService.updatePasswordByEmail(email, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactText(message, [password]));
    }
  }

  list(runtimeDirectory?: string): RecoveryResponse {
    return {
      entries: this.journal.listRecoverySummaries(this.options(runtimeDirectory)).map((entry) => ({
        id: entry.id,
        state: entry.state,
        email: entry.email,
        originalRowIndex: entry.originalRowIndex,
        operation: entry.operation,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    };
  }

  pendingCount(runtimeDirectory?: string): number {
    return this.list(runtimeDirectory).entries.length;
  }

  canEditSettings(): boolean {
    try {
      return this.pendingCount() === 0;
    } catch {
      return false;
    }
  }

  async prepareForJob(): Promise<void> {
    await this.reconcileConfirmed();
    this.journal.assertNoPreparedRecoveries(this.options());
  }

  async reconcileConfirmed(): Promise<RecoveryEntrySummary[]> {
    return this.exclusive(() => this.journal.syncConfirmedRecoveries({
      updatePasswordByEmail: (email, password) => this.updatePasswordByEmail(email, password),
    }, this.options()));
  }

  async sync(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const entry = this.journal.getRecoveryEntry(id, this.options());
      if (!entry) return false;
      const email = entry.email.trim().toLowerCase();
      const matches = (await this.accountService.rows(true))
        .filter((candidate) => candidate.email.trim().toLowerCase() === email);
      if (matches.length === 0) throw new Error(`Không thể đồng bộ recovery: ${entry.email} không còn trong Sheet`);
      if (matches.length > 1) throw new Error(`Không thể đồng bộ recovery: ${entry.email} xuất hiện nhiều lần trong Sheet`);
      await this.updatePasswordByEmail(entry.email, entry.elevenPassword);
      this.journal.removeRecovery(id, this.options());
      return true;
    });
  }

  async discard(id: string): Promise<boolean> {
    return this.exclusive(async () => this.journal.removeRecovery(id, this.options()));
  }
}
