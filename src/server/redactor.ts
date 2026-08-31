const SECRET_PATTERNS: Array<{ pattern: RegExp; preservePrefix?: boolean }> = [
  { pattern: /\bsk_[A-Za-z0-9_-]+\b/g },
  {
    pattern: /([?&](?:api[_-]?key|key|token|access[_-]?token|proxy[_-]?token|password|secret|client[_-]?secret|authorization)=)[^&#\s]*/gi,
    preservePrefix: true,
  },
  { pattern: /(proxy(?:Token| token)?\s*[:=]\s*)\S+/gi, preservePrefix: true },
  { pattern: /(password\s*[:=]\s*)\S+/gi, preservePrefix: true },
  { pattern: /(api\s*key\s*[:=]\s*)\S+/gi, preservePrefix: true },
  { pattern: /(https?:\/\/[^:\s/@]+:)[^@\s]+@/gi, preservePrefix: true },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}:[^:\s]+:[^\s]+\b/g },
];

function secretVariants(secret: string): string[] {
  const variants = new Set([secret]);
  try {
    variants.add(encodeURIComponent(secret));
  } catch {}
  try {
    const formValue = new URLSearchParams({ secret }).toString().slice('secret='.length);
    variants.add(formValue);
  } catch {}
  const jsonValue = JSON.stringify(secret);
  if (jsonValue) {
    const escaped = jsonValue.slice(1, -1);
    variants.add(escaped);
    variants.add(escaped.replace(/\//g, '\\/'));
  }
  return [...variants].filter(Boolean);
}

export function redactText(value: string, knownSecrets: string[] = []): string {
  let redacted = value;
  const orderedSecrets = [...new Set(knownSecrets.filter(Boolean).flatMap(secretVariants))]
    .sort((left, right) => right.length - left.length);
  for (const secret of orderedSecrets) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  for (const { pattern, preservePrefix } of SECRET_PATTERNS) {
    redacted = preservePrefix
      ? redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`)
      : redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

export function redactValue(value: unknown, knownSecrets: string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/password|apiKey|proxyToken|secret/i.test(key) && typeof item === 'string') return [key, '[REDACTED]'];
      return [key, redactValue(item, knownSecrets)];
    }));
  }
  return value;
}
