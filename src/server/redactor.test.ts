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
    expect(redactValue({ apiKey: 'sk_x', hasApiKey: true, nested: { password: 'p' }, message: 'ok' })).toEqual({
      apiKey: '[REDACTED]',
      hasApiKey: true,
      nested: { password: '[REDACTED]' },
      message: 'ok',
    });
  });

  it('redacts longer overlapping known secrets before their suffixes', () => {
    expect(redactText('provider rejected prefix-secret', ['secret', 'prefix-secret']))
      .toBe('provider rejected [REDACTED]');
  });

  it('redacts URL, form and JSON encodings of opaque known secrets', () => {
    const secret = 'opaque /+? "quoted"\\tail';
    const uriEncoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams({ secret }).toString().slice('secret='.length);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const slashEscaped = jsonEscaped.replace(/\//g, '\\/');
    const redacted = redactText([
      secret,
      uriEncoded,
      formEncoded,
      jsonEscaped,
      slashEscaped,
    ].join('\n'), [secret]);

    expect(redacted.split('\n')).toEqual(Array(5).fill('[REDACTED]'));
  });

  it('redacts generic sensitive query parameters including TinProxy keys', () => {
    const redacted = redactText([
      'https://proxy.tinproxy.com/api/changeProxy.php?key=tin-secret&location=0',
      'https://provider.test/path?client_secret=client-secret&access_token=access-secret',
    ].join('\n'));

    expect(redacted).not.toContain('tin-secret');
    expect(redacted).not.toContain('client-secret');
    expect(redacted).not.toContain('access-secret');
    expect(redacted).toContain('?key=[REDACTED]&location=0');
  });
});
