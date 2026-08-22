import { describe, expect, it } from 'vitest';
import { redactText, redactValue } from './redactor';

describe('redactor', () => {
  it('removes API keys, passwords and known secrets', () => {
    const text = redactText('API Key: sk_live_123 password: Secret1! token-value https://host.test/?token=query-secret 10.0.0.1:8080:user:proxy-pass', ['token-value']);
    expect(text).not.toContain('sk_live_123');
    expect(text).not.toContain('Secret1!');
    expect(text).not.toContain('token-value');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain('proxy-pass');
  });

  it('redacts secret-shaped object properties recursively', () => {
    expect(redactValue({ apiKey: 'sk_x', nested: { password: 'p' }, message: 'ok' })).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]' },
      message: 'ok',
    });
  });
});
