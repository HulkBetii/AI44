import { describe, expect, it } from 'vitest';
import { JobPreviewRequestSchema, JobRequestSchema } from './contracts';

const base = {
  workflowId: 'signup' as const,
  selection: { mode: 'allEligible' as const },
  options: { intervalMinutes: 1 },
};

describe('job request contracts', () => {
  it('rejects proxyCheck with row selection', () => {
    expect(JobPreviewRequestSchema.safeParse({
      workflowId: 'proxyCheck',
      selection: { mode: 'rows', rowIndexes: [2] },
      options: { intervalMinutes: 1 },
    }).success).toBe(false);
  });
});
