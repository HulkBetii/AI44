import path from 'node:path';
import type { AccountDetail, AccountRuntime, AccountSummary } from '../shared/contracts';
import { toAccountSummary, type AccountRow } from './domain';
import type { ConfigStore } from './config';

interface SheetsModule {
  configureSheets(config: { sheetId: string; sheetName: string; serviceAccountPath: string }): void;
  initSheets(): Promise<void>;
  loadRows(): Promise<AccountRow[]>;
  resetRows(rowIndexes: number[]): Promise<void>;
}

export class AccountService {
  private readonly sheets: SheetsModule;
  private cache: { at: number; rows: AccountRow[] } | null = null;

  constructor(projectRoot: string, private readonly configStore: ConfigStore) {
    this.sheets = require(path.join(projectRoot, 'sheets.js')) as SheetsModule;
  }

  private async connect(): Promise<void> {
    const config = this.configStore.get();
    this.sheets.configureSheets({
      sheetId: config.sheetId,
      sheetName: config.sheetName,
      serviceAccountPath: config.serviceAccountPath,
    });
    await this.sheets.initSheets();
  }

  async rows(force = false): Promise<AccountRow[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 10_000) return this.cache.rows;
    await this.connect();
    const rows = await this.sheets.loadRows();
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  async summaries(
    lastRuns: Map<number, string> = new Map(),
    runtimes: ReadonlyMap<number, AccountRuntime> = new Map(),
    force = false,
  ): Promise<AccountSummary[]> {
    return (await this.rows(force)).map((row) => toAccountSummary(
      row,
      lastRuns.get(row.rowIndex) || null,
      runtimes.get(row.rowIndex) || null,
    ));
  }

  async detail(
    rowIndex: number,
    recentJobs: AccountDetail['recentJobs'] = [],
    runtime: AccountRuntime | null = null,
  ): Promise<AccountDetail | null> {
    const account = (await this.rows()).find((row) => row.rowIndex === rowIndex);
    if (!account) return null;
    return {
      ...toAccountSummary(account, recentJobs[0]?.createdAt || null, runtime),
      recoveryEmail: account.recoveryEmail,
      msaTokenPresent: Boolean(account.msaToken),
      tenantGuidPresent: Boolean(account.tenantGuid),
      recentJobs,
      lastFailure: null,
    };
  }

  async reveal(rowIndex: number, field: 'hotmailPassword' | 'elevenPassword' | 'apiKey' | 'proxyToken'): Promise<string | null> {
    const account = (await this.rows(true)).find((row) => row.rowIndex === rowIndex);
    if (!account) return null;
    const values = {
      hotmailPassword: account.password,
      elevenPassword: account.elevenPass,
      apiKey: account.apiKey,
      proxyToken: account.proxyToken,
    };
    return values[field] || '';
  }

  async resetRows(rowIndexes: number[]): Promise<void> {
    await this.connect();
    await this.sheets.resetRows(rowIndexes);
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }

  invalidateRows(rowIndexes: number[]): void {
    if (!this.cache) return;
    const affected = new Set(rowIndexes);
    if (this.cache.rows.some((row) => affected.has(row.rowIndex))) this.cache = null;
  }
}
