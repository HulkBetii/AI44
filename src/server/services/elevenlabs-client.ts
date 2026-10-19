/**
 * elevenlabs-client.ts
 * Lightweight HTTP client for ElevenLabs REST API.
 * Communicates directly with official subscription & user endpoints without browser overhead.
 */

export interface ElevenLabsSubscriptionResult {
  valid: boolean;
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
  remainingCharacters?: number;
  status?: string;
  resetAt?: number | null;
  error?: string;
  message?: string;
}

export interface ElevenLabsClientOptions {
  timeoutMs?: number;
  endpoint?: string;
}

const PRIMARY_ENDPOINT = 'https://api.elevenlabs.io/v1/user/subscription';
const FALLBACK_ENDPOINT = 'https://api.us.elevenlabs.io/v1/user/subscription';

/**
 * Normalize and prepare request headers for both Bearer Tokens and xi-api-keys.
 */
function buildHeaders(tokenOrKey: string): Record<string, string> {
  const clean = String(tokenOrKey || '').trim();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };

  if (clean.startsWith('sk_') || clean.length < 60) {
    headers['xi-api-key'] = clean;
  } else {
    const bearer = clean.replace(/^Bearer\s+/i, '');
    headers['Authorization'] = `Bearer ${bearer}`;
  }

  return headers;
}

/**
 * Fetch subscription details and quota usage for a given token or API key.
 */
export async function fetchSubscription(
  tokenOrKey: string,
  options: ElevenLabsClientOptions = {}
): Promise<ElevenLabsSubscriptionResult> {
  const clean = String(tokenOrKey || '').trim();
  if (!clean) {
    return {
      valid: false,
      error: 'EMPTY_KEY',
      message: 'API key or Bearer token is empty',
    };
  }

  const timeoutMs = options.timeoutMs || 6000;
  const headers = buildHeaders(clean);
  const endpoints = options.endpoint ? [options.endpoint] : [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT];

  let lastError: Error | null = null;

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 200) {
        const data = (await response.json()) as any;
        const count = Number(data.character_count ?? 0);
        const limit = Number(data.character_limit ?? 10000);
        const remaining = Math.max(0, limit - count);

        return {
          valid: true,
          tier: String(data.tier || 'free'),
          characterCount: count,
          characterLimit: limit,
          remainingCharacters: remaining,
          status: String(data.status || 'active'),
          resetAt: data.next_character_count_reset_unix ?? null,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          valid: false,
          error: 'UNAUTHORIZED_OR_EXPIRED',
          message: 'Token is invalid, expired, or revoked by ElevenLabs',
        };
      }

      if (response.status === 429) {
        return {
          valid: false,
          error: 'RATE_LIMITED',
          message: 'ElevenLabs rate limit exceeded. Please back off.',
        };
      }

      if (response.status >= 500) {
        // Try fallback endpoint if primary has 5xx
        continue;
      }

      return {
        valid: false,
        error: `HTTP_${response.status}`,
        message: `ElevenLabs returned HTTP ${response.status}`,
      };
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      if (err.name === 'AbortError') {
        return {
          valid: false,
          error: 'TIMEOUT',
          message: `Request timed out after ${timeoutMs}ms`,
        };
      }
      // Transient connection error: try fallback
    }
  }

  return {
    valid: false,
    error: 'NETWORK_ERROR',
    message: lastError ? lastError.message : 'Unable to reach ElevenLabs subscription API',
  };
}

export interface ElevenLabsTtsTestResult {
  success: boolean;
  status?: number;
  audioSizeBytes?: number;
  detectedUnusualActivity?: boolean;
  error?: string;
  message?: string;
}

/**
 * Perform a test call to ElevenLabs Text-to-Speech endpoint.
 */
export async function testElevenLabsTts(
  tokenOrKey: string,
  options: { voiceId?: string; text?: string; timeoutMs?: number } = {}
): Promise<ElevenLabsTtsTestResult> {
  const clean = String(tokenOrKey || '').trim();
  if (!clean) {
    return { success: false, error: 'EMPTY_KEY', message: 'Token or API key is empty' };
  }

  const voiceId = options.voiceId || '21m00Tcm4TlvDq8ikWAM';
  const text = options.text || 'Hi';
  const timeoutMs = options.timeoutMs || 8000;
  const headers: Record<string, string> = {
    ...buildHeaders(clean),
    Accept: 'audio/mpeg',
    'Content-Type': 'application/json',
  };

  const endpoints = [
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    `https://api.us.elevenlabs.io/v1/text-to-speech/${voiceId}`,
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 200) {
        const buffer = await response.arrayBuffer();
        return {
          success: true,
          status: 200,
          audioSizeBytes: buffer.byteLength,
          message: 'TTS generation successful',
        };
      }

      const bodyText = await response.text();
      let parsedMessage = bodyText;
      let isUnusual = false;

      try {
        const json = JSON.parse(bodyText);
        if (
          json.detail?.status === 'detected_unusual_activity' ||
          (json.detail?.message && /unusual activity/i.test(json.detail.message))
        ) {
          isUnusual = true;
          parsedMessage = json.detail.message || 'detected_unusual_activity';
        } else if (json.detail?.message) {
          parsedMessage = json.detail.message;
        }
      } catch {}

      return {
        success: false,
        status: response.status,
        detectedUnusualActivity: isUnusual,
        error: isUnusual ? 'DETECTED_UNUSUAL_ACTIVITY' : `HTTP_${response.status}`,
        message: parsedMessage,
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return { success: false, error: 'TIMEOUT', message: `TTS request timed out after ${timeoutMs}ms` };
      }
    }
  }

  return { success: false, error: 'NETWORK_ERROR', message: 'All ElevenLabs TTS endpoints unreachable' };
}
