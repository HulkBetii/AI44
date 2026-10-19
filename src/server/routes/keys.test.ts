import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createKeysRouter } from './keys';
import type { KeyService } from '../services/key-service';

function createMockApp(keyServiceOverrides: Partial<KeyService> = {}) {
  const app = express();
  app.use(express.json());

  const mockKeyService = {
    checkQuota: vi.fn().mockResolvedValue({
      success: true,
      valid: true,
      tier: 'free',
      characterCount: 0,
      characterLimit: 10000,
      remainingCharacters: 10000,
      status: 'active',
      checkedAt: new Date().toISOString(),
    }),
    listKeys: vi.fn().mockImplementation((query) => {
      if (query.format === 'text') {
        return 'token_123_abc ,\ntoken_456_def ,\n';
      }
      return {
        success: true,
        total: 2,
        count: 2,
        offset: 0,
        limit: 50,
        data: [
          {
            rowIndex: 2,
            email: 'user1@mrhulkstore.store',
            apiKey: 'token_123_abc',
            status: 'complete',
            createdAt: '2026-09-04T10:00:00.000Z',
          },
        ],
      };
    }),
    refreshKey: vi.fn().mockResolvedValue({
      success: true,
      action: 'provision_pool',
      email: 'user2@mrhulkstore.store',
      apiKey: 'new_token_789',
      status: 'complete',
      remainingCharacters: 10000,
    }),
    ...keyServiceOverrides,
  } as unknown as KeyService;

  app.use('/api/keys', createKeysRouter(mockKeyService));
  return { app, mockKeyService };
}

describe('Keys Router (/api/keys)', () => {
  describe('POST /api/keys/check-quota', () => {
    it('returns 400 when neither key nor email is provided', async () => {
      const { app } = createMockApp();
      const res = await request(app).post('/api/keys/check-quota').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 200 with quota details when key is provided', async () => {
      const { app } = createMockApp();
      const res = await request(app)
        .post('/api/keys/check-quota')
        .send({ key: 'eyJhbGciOiJSUzI1NiIs...' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.valid).toBe(true);
      expect(res.body.remainingCharacters).toBe(10000);
    });
  });

  describe('GET /api/keys', () => {
    it('returns JSON format by default', async () => {
      const { app } = createMockApp();
      const res = await request(app).get('/api/keys?limit=5');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(2);
      expect(res.body.data[0].email).toBe('user1@mrhulkstore.store');
    });

    it('returns text/plain when format=text', async () => {
      const { app } = createMockApp();
      const res = await request(app).get('/api/keys?format=text');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('token_123_abc ,');
    });
  });

  describe('POST /api/keys/refresh', () => {
    it('returns refreshed or provisioned key', async () => {
      const { app } = createMockApp();
      const res = await request(app)
        .post('/api/keys/refresh')
        .send({ mode: 'provision' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('provision_pool');
      expect(res.body.apiKey).toBe('new_token_789');
    });
  });
});
