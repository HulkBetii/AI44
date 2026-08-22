import { describe, expect, it } from 'vitest';
import { JobPreviewRequestSchema, JobRequestSchema } from './contracts';

const base = {
  workflowId: 'signup' as const,
  selection: { mode: 'allEligible' as const },
  options: { proxyMode: 'sheet' as const, intervalMinutes: 1 },
};

describe('job request contracts', () => {
  it('keeps proxy secrets out of preview requests', () => {
    expect(JobPreviewRequestSchema.safeParse({
      ...base,
      options: {
        ...base.options,
        proxyMode: 'override',
        hasProxyTokenOverride: true,
        proxyTokenOverride: 'must-not-enter-preview-cache',
      },
    }).success).toBe(false);
  });

  it('requires the real override token only when creating a job', () => {
    expect(JobRequestSchema.safeParse({
      ...base,
      options: { ...base.options, proxyMode: 'override' },
    }).success).toBe(false);
    expect(JobRequestSchema.safeParse({
      ...base,
      options: { ...base.options, proxyMode: 'override', proxyTokenOverride: 'token' },
    }).success).toBe(true);
  });

  it('rejects proxyCheck without a proxy and with row selection', () => {
    expect(JobPreviewRequestSchema.safeParse({
      workflowId: 'proxyCheck',
      selection: { mode: 'rows', rowIndexes: [2] },
      options: { proxyMode: 'none', hasProxyTokenOverride: false, intervalMinutes: 1 },
    }).success).toBe(false);
  });

  it('rejects an override flag when proxyMode is not override', () => {
    expect(JobPreviewRequestSchema.safeParse({
      ...base,
      options: { ...base.options, hasProxyTokenOverride: true },
    }).success).toBe(false);
  });
});
