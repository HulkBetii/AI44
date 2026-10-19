/**
 * tts-tester.js
 * Quick test call to ElevenLabs Text-to-Speech endpoint immediately after obtaining key/token.
 */

/**
 * Call ElevenLabs Text-to-Speech API to test if the account has active voice generation.
 * @param {string} apiKey - Bearer token or xi-api-key
 * @param {object} [options]
 * @param {string} [options.voiceId='21m00Tcm4TlvDq8ikWAM'] - Voice ID (default: Rachel)
 * @param {string} [options.text='Hi'] - Text to synthesize (keep short to conserve quota)
 * @param {number} [options.timeoutMs=10000] - Request timeout
 * @returns {Promise<{ success: boolean, status?: number, audioSizeBytes?: number, detectedUnusualActivity?: boolean, error?: string, message?: string }>}
 */
async function testElevenLabsTts(apiKey, options = {}) {
  const voiceId = options.voiceId || '21m00Tcm4TlvDq8ikWAM';
  const text = options.text || 'Hi';
  const timeoutMs = options.timeoutMs || 10000;

  const clean = String(apiKey || '').trim();
  if (!clean) {
    return { success: false, error: 'EMPTY_KEY', message: 'API key or token is empty' };
  }

  const headers = {
    Accept: 'audio/mpeg',
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };

  if (clean.startsWith('sk_') || clean.length < 60) {
    headers['xi-api-key'] = clean;
  } else {
    headers['Authorization'] = `Bearer ${clean.replace(/^Bearer\s+/i, '')}`;
  }

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
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          success: true,
          status: 200,
          audioSizeBytes: buffer.length,
          audioBuffer: buffer,
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
        message: parsedMessage,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return { success: false, error: 'TIMEOUT', message: `TTS request timed out after ${timeoutMs}ms` };
      }
    }
  }

  return { success: false, error: 'NETWORK_ERROR', message: 'All TTS endpoints unreachable' };
}

module.exports = {
  testElevenLabsTts,
};
