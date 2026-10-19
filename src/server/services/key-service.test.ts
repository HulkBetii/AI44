import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyService } from './key-service';
import * as elevenlabsClient from './elevenlabs-client';

describe('KeyService', () => {
  let keyService: KeyService;
  const mockAccounts = [
    {
      rowIndex: 2,
      email: 'test1@mrhulkstore.store',
      password: 'pass1',
      firstName: 'Test',
      lastName: 'One',
      status: 'complete',
      apiKey: 'eyJhbGciOiJSUzI1NiIsKey1ValidLongStringHere1234567890',
      elevenPass: 'pass1',
      createdAt: '2026-09-04T10:00:00.000Z',
    },
    {
      rowIndex: 3,
      email: 'test2@mrhulkstore.store',
      password: 'pass2',
      firstName: 'Test',
      lastName: 'Two',
      status: 'complete',
      apiKey: 'eyJhbGciOiJSUzI1NiIsKey2ValidLongStringHere1234567890',
      elevenPass: 'pass2',
      createdAt: '2026-09-04T10:01:00.000Z',
    },
  ];

  beforeEach(() => {
    keyService = new KeyService(process.cwd());
    (keyService as any).sheets = {
      initSignupSheets: vi.fn().mockResolvedValue(true),
      loadRows: vi.fn().mockResolvedValue(mockAccounts),
      updateAccountResult: vi.fn().mockResolvedValue(true),
      updateAccountStatus: vi.fn().mockResolvedValue(true),
    };
  });

  describe('checkQuota', () => {
    it('checks quota by key directly', async () => {
      vi.spyOn(elevenlabsClient, 'fetchSubscription').mockResolvedValueOnce({
        valid: true,
        tier: 'free',
        characterCount: 100,
        characterLimit: 10000,
        remainingCharacters: 9900,
        status: 'active',
        resetAt: null,
      });

      const res = await keyService.checkQuota({ key: 'test_token' });
      expect(res.success).toBe(true);
      expect(res.valid).toBe(true);
      expect(res.remainingCharacters).toBe(9900);
    });

    it('checks quota by email lookup in sheet', async () => {
      vi.spyOn(elevenlabsClient, 'fetchSubscription').mockResolvedValueOnce({
        valid: true,
        tier: 'free',
        characterCount: 0,
        characterLimit: 10000,
        remainingCharacters: 10000,
        status: 'active',
        resetAt: null,
      });

      const res = await keyService.checkQuota({ email: 'test1@mrhulkstore.store' });
      expect(res.success).toBe(true);
      expect(res.valid).toBe(true);
      expect(res.remainingCharacters).toBe(10000);
    });
  });

  describe('listKeys', () => {
    it('lists keys in JSON format', async () => {
      const res = await keyService.listKeys({
        limit: 10,
        offset: 0,
        status: 'complete',
        format: 'json',
        with_quota: false,
      });

      expect(typeof res).toBe('object');
      if (typeof res === 'object') {
        expect(res.success).toBe(true);
        expect(res.total).toBe(2);
        expect(res.data[0].email).toBe('test1@mrhulkstore.store');
      }
    });

    it('lists keys in text format with `key [space] , [newline]`', async () => {
      const res = await keyService.listKeys({
        limit: 10,
        offset: 0,
        status: 'complete',
        format: 'text',
        with_quota: false,
      });

      expect(typeof res).toBe('string');
      if (typeof res === 'string') {
        const lines = res.split('\n').filter(Boolean);
        expect(lines.length).toBe(2);
        expect(lines[0].endsWith(' ,')).toBe(true);
        expect(lines[1].endsWith(' ,')).toBe(true);
      }
    });
  });

  describe('refreshKey', () => {
    it('provisions available key from standby pool', async () => {
      const res = await keyService.refreshKey({
        email: 'test1@mrhulkstore.store',
        mode: 'provision',
      });

      expect(res.success).toBe(true);
      expect(res.action).toBe('provision_pool');
      expect(res.email).toBe('test2@mrhulkstore.store');
    });
  });
});
