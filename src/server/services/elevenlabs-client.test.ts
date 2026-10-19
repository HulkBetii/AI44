import { describe, it, expect, vi } from 'vitest';
import { fetchSubscription } from './elevenlabs-client';

describe('elevenlabs-client', () => {
  it('returns EMPTY_KEY when token is empty', async () => {
    const res = await fetchSubscription('');
    expect(res.valid).toBe(false);
    expect(res.error).toBe('EMPTY_KEY');
  });

  it('handles 200 response correctly', async () => {
    const mockData = {
      tier: 'free',
      character_count: 500,
      character_limit: 10000,
      status: 'active',
      next_character_count_reset_unix: 1791152233,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => mockData,
    } as any);

    try {
      const res = await fetchSubscription('eyJhbGciOiJSUzI1NiIs...');
      expect(res.valid).toBe(true);
      expect(res.tier).toBe('free');
      expect(res.characterCount).toBe(500);
      expect(res.characterLimit).toBe(10000);
      expect(res.remainingCharacters).toBe(9500);
      expect(res.status).toBe('active');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles 401 unauthorized response correctly', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 401,
      json: async () => ({ detail: 'invalid' }),
    } as any);

    try {
      const res = await fetchSubscription('bad_token');
      expect(res.valid).toBe(false);
      expect(res.error).toBe('UNAUTHORIZED_OR_EXPIRED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('testElevenLabsTts returns EMPTY_KEY when token is empty', async () => {
    const { testElevenLabsTts } = await import('./elevenlabs-client');
    const res = await testElevenLabsTts('');
    expect(res.success).toBe(false);
    expect(res.error).toBe('EMPTY_KEY');
  });

  it('testElevenLabsTts handles 200 success response', async () => {
    const { testElevenLabsTts } = await import('./elevenlabs-client');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4096),
    } as any);

    try {
      const res = await testElevenLabsTts('mock_key');
      expect(res.success).toBe(true);
      expect(res.status).toBe(200);
      expect(res.audioSizeBytes).toBe(4096);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('testElevenLabsTts detects detected_unusual_activity', async () => {
    const { testElevenLabsTts } = await import('./elevenlabs-client');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 401,
      text: async () =>
        JSON.stringify({
          detail: {
            status: 'detected_unusual_activity',
            message: 'Unusual activity has been detected',
          },
        }),
    } as any);

    try {
      const res = await testElevenLabsTts('mock_key');
      expect(res.success).toBe(false);
      expect(res.status).toBe(401);
      expect(res.detectedUnusualActivity).toBe(true);
      expect(res.error).toBe('DETECTED_UNUSUAL_ACTIVITY');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

