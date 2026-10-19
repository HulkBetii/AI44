/**
 * key-service.ts
 * Core domain service for ElevenLabs key management:
 * - Real-time quota checking
 * - Cached listing with multi-format export (JSON / Text)
 * - Automatic re-authentication and key provisioning
 */

import path from 'node:path';
import type {
  CheckQuotaRequest,
  CheckQuotaResponse,
  KeyItemSummary,
  ListKeysQuery,
  ListKeysResponse,
  RefreshKeyRequest,
  RefreshKeyResponse,
} from '../../shared/contracts';
import { fetchSubscription } from './elevenlabs-client';
import type { ConfigStore } from '../config';

export interface CatchAllAccountRow {
  rowIndex: number;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  status: string;
  apiKey: string;
  elevenPass: string;
  createdAt: string;
}

interface CatchAllSheetsModule {
  initSignupSheets(options?: Record<string, unknown>): Promise<unknown>;
  loadRows(): Promise<CatchAllAccountRow[]>;
  updateAccountResult(
    rowIndex: number,
    data: { apiKey?: string; elevenPass?: string; status?: string }
  ): Promise<void>;
  updateAccountStatus(rowIndex: number, status: string): Promise<void>;
}

export class KeyService {
  private readonly sheets: CatchAllSheetsModule;
  private cache: { loadedAt: number; rows: CatchAllAccountRow[] } | null = null;
  private readonly CACHE_TTL_MS = 30000; // 30s cache to protect Google Sheet API quota

  constructor(
    private readonly projectRoot: string,
    private readonly configStore?: ConfigStore
  ) {
    this.sheets = require(path.join(projectRoot, 'catch-all-signup', 'sheets.js'));
  }

  /**
   * Load accounts from Sheet with in-memory TTL cache.
   */
  async getAccounts(forceRefresh = false): Promise<CatchAllAccountRow[]> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.cache.loadedAt < this.CACHE_TTL_MS) {
      return this.cache.rows;
    }

    await this.sheets.initSignupSheets();
    const rows = await this.sheets.loadRows();
    this.cache = { loadedAt: now, rows };
    return rows;
  }

  /**
   * Invalidate cached rows
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Check quota and status of a key or email.
   */
  async checkQuota(request: CheckQuotaRequest): Promise<CheckQuotaResponse> {
    const checkedAt = new Date().toISOString();
    let targetKey = (request.key || '').trim();
    let matchedEmail = (request.email || '').trim().toLowerCase();
    let matchedRow: CatchAllAccountRow | null = null;

    if (!targetKey && matchedEmail) {
      const accounts = await this.getAccounts();
      matchedRow = accounts.find((a) => a.email.toLowerCase() === matchedEmail) || null;
      if (!matchedRow || !matchedRow.apiKey) {
        return {
          success: false,
          valid: false,
          error: 'ACCOUNT_NOT_FOUND',
          message: `No active API key found for account '${matchedEmail}'`,
          checkedAt,
        };
      }
      targetKey = matchedRow.apiKey;
    }

    const sub = await fetchSubscription(targetKey);

    if (!sub.valid) {
      return {
        success: true,
        valid: false,
        error: sub.error || 'UNAUTHORIZED_OR_EXPIRED',
        message: sub.message || 'Token is invalid, expired, or revoked by ElevenLabs',
        checkedAt,
      };
    }

    return {
      success: true,
      valid: true,
      tier: sub.tier,
      characterCount: sub.characterCount,
      characterLimit: sub.characterLimit,
      remainingCharacters: sub.remainingCharacters,
      status: sub.status,
      resetAt: sub.resetAt,
      checkedAt,
    };
  }

  /**
   * List keys with filtering, pagination, and multi-format output.
   */
  async listKeys(query: ListKeysQuery): Promise<ListKeysResponse | string> {
    const accounts = await this.getAccounts();

    let filtered = accounts.filter((a) => (a.apiKey || '').trim().length > 20);

    if (query.status !== 'all') {
      filtered = filtered.filter((a) => a.status.toLowerCase() === query.status.toLowerCase());
    }

    // Text format: key [space] , [newline] key tiếp theo...
    if (query.format === 'text') {
      const slice = filtered.slice(query.offset, query.offset + query.limit);
      return slice.map((a) => `${a.apiKey.trim()} ,`).join('\n') + (slice.length > 0 ? '\n' : '');
    }

    const total = filtered.length;
    const sliced = filtered.slice(query.offset, query.offset + query.limit);

    let data: KeyItemSummary[] = sliced.map((a) => ({
      rowIndex: a.rowIndex,
      email: a.email,
      apiKey: a.apiKey,
      status: a.status,
      createdAt: a.createdAt,
    }));

    if (query.with_quota) {
      // Concurrently query quota for sliced items (limit concurrency to 5)
      data = await Promise.all(
        data.map(async (item) => {
          try {
            const sub = await fetchSubscription(item.apiKey, { timeoutMs: 3000 });
            return {
              ...item,
              quota: {
                valid: sub.valid,
                remainingCharacters: sub.remainingCharacters,
                characterLimit: sub.characterLimit,
                tier: sub.tier,
              },
            };
          } catch {
            return item;
          }
        })
      );
    }

    return {
      success: true,
      total,
      count: data.length,
      offset: query.offset,
      limit: query.limit,
      data,
    };
  }

  /**
   * Refresh a key (via Re-authentication or Pool Provisioning).
   */
  async refreshKey(request: RefreshKeyRequest): Promise<RefreshKeyResponse> {
    const accounts = await this.getAccounts();
    const targetEmail = (request.email || '').trim().toLowerCase();
    const targetKey = (request.key || '').trim();

    let targetAccount = accounts.find((a) =>
      (targetEmail && a.email.toLowerCase() === targetEmail) ||
      (targetKey && a.apiKey === targetKey)
    ) || null;

    let effectiveMode = request.mode;

    if (effectiveMode === 'auto') {
      if (targetAccount?.apiKey) {
        const sub = await fetchSubscription(targetAccount.apiKey, { timeoutMs: 4000 });
        if (sub.valid && (sub.remainingCharacters ?? 0) > 0) {
          return {
            success: true,
            action: 'reauth',
            email: targetAccount.email,
            apiKey: targetAccount.apiKey,
            status: 'complete',
            remainingCharacters: sub.remainingCharacters,
            message: 'Key is still valid with remaining quota',
          };
        }
        if (sub.valid && (sub.remainingCharacters ?? 0) === 0) {
          effectiveMode = 'provision';
        } else {
          effectiveMode = 'reauth';
        }
      } else {
        effectiveMode = targetAccount ? 'reauth' : 'provision';
      }
    }

    if (effectiveMode === 'provision') {
      // Find an existing account in pool that has a valid key and is different from the exhausted one
      const available = accounts.find((a) =>
        a.status.toLowerCase() === 'complete' &&
        a.apiKey &&
        a.apiKey.length > 20 &&
        (!targetAccount || a.email.toLowerCase() !== targetAccount.email.toLowerCase())
      );

      if (available) {
        return {
          success: true,
          action: 'provision_pool',
          email: available.email,
          apiKey: available.apiKey,
          status: 'complete',
          message: 'Allocated unexhausted key from standby pool',
        };
      }

      throw new Error('Key pool exhausted. No available standby keys in sheet.');
    }

    // Re-auth mode
    if (!targetAccount) {
      throw new Error(`Cannot re-authenticate: account '${request.email || request.key}' not found in sheet.`);
    }

    const { attemptSignIn, createTokenSniffer } = require(
      path.join(this.projectRoot, 'catch-all-signup', 'elevenlabs-signup.js')
    );
    const { chromium } = require('playwright');

    let browser = null;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const sniffer = createTokenSniffer(context);
      const page = await context.newPage();

      const outcome = await attemptSignIn(page, targetAccount.email, targetAccount.password);
      if (outcome !== 'ok') {
        throw new Error(`Re-authentication failed with outcome: ${outcome}`);
      }

      const newKey = await sniffer.waitForToken(30000);
      sniffer.cleanup();

      // Update sheet with new token
      await this.sheets.updateAccountResult(targetAccount.rowIndex, {
        apiKey: newKey,
        elevenPass: targetAccount.password,
        status: 'complete',
      });
      this.invalidateCache();

      return {
        success: true,
        action: 'reauth',
        email: targetAccount.email,
        apiKey: newKey,
        status: 'complete',
        message: 'Successfully re-authenticated and captured fresh Bearer token',
      };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}
