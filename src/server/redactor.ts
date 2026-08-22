const SECRET_PATTERNS = [
  /\bsk_[A-Za-z0-9_-]+\b/g,
  /([?&](?:token|proxyToken|password|apiKey)=)[^&\s]+/gi,
  /(proxy(?:Token| token)?\s*[:=]\s*)\S+/gi,
  /(password\s*[:=]\s*)\S+/gi,
  /(api\s*key\s*[:=]\s*)\S+/gi,
  /(https?:\/\/[^:\s/@]+:)[^@\s]+@/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}:[^:\s]+:[^\s]+\b/g,
];

export function redactText(value: string, knownSecrets: string[] = []): string {
  let redacted = value;
  for (const secret of knownSecrets.filter(Boolean)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix: string | undefined) => prefix ? `${prefix}[REDACTED]` : '[REDACTED]');
  }
  return redacted;
}

export function redactValue(value: unknown, knownSecrets: string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/password|apiKey|proxyToken|secret/i.test(key)) return [key, '[REDACTED]'];
      return [key, redactValue(item, knownSecrets)];
    }));
  }
  return value;
}
