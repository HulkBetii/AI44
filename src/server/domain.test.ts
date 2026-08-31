import { describe, expect, it } from 'vitest';
import { getEligibleWorkflows, getRecommendedAction, getStatusGroup, previewJob, toAccountSummary, WORKFLOWS, type AccountRow } from './domain';

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  const rowIndex = overrides.rowIndex ?? 2;
  return {
    rowIndex,
    email: rowIndex === 2 ? 'operator@example.com' : `operator-${rowIndex}@example.com`,
    password: 'hotmail-pass',
    msaToken: '',
    tenantGuid: '',
    recoveryEmail: '',
    apiKey: '',
    elevenPass: '',
    status: 'pending',
    ...overrides,
  };
}

describe('account workflow classification', () => {
  it('routes pending rows to signup', () => {
    expect(getEligibleWorkflows(row())).toContain('signup');
    expect(getRecommendedAction(row())).toBe('signup');
    expect(getStatusGroup(row())).toBe('pending');
  });

  it('routes stranded accounts to resume without allowing retry pending', () => {
    const account = row({ status: 'failed:onboarding', elevenPass: 'Eleven1!' });
    expect(getEligibleWorkflows(account)).toEqual(expect.arrayContaining(['resume', 'regenerateKey', 'fullCycle']));
    expect(getEligibleWorkflows(account)).not.toContain('retryPending');
    expect(getRecommendedAction(account)).toBe('resume');
  });

  it('resumes a pending row that already has an ElevenLabs password', () => {
    const account = row({ status: 'pending', elevenPass: 'Eleven1!' });
    expect(getRecommendedAction(account)).toBe('resume');
    expect(getEligibleWorkflows(account)).not.toContain('signup');
    expect(getStatusGroup(account)).toBe('recoverable');
  });

  it('routes rejected credentials to password reset first', () => {
    const account = row({ status: 'credentials-rejected', elevenPass: 'Old1!' });
    expect(getRecommendedAction(account)).toBe('resetPassword');
    expect(getStatusGroup(account)).toBe('recoverable');
  });

  it('protects rows that already contain a key', () => {
    const account = row({ status: 'failed:create API key', apiKey: 'sk_live', elevenPass: 'Eleven1!' });
    expect(getEligibleWorkflows(account)).not.toContain('retryPending');
    expect(getEligibleWorkflows(account)).toContain('resetPassword');
    expect(getEligibleWorkflows(account)).not.toContain('fullCycle');
    expect(getRecommendedAction(account)).toBe('regenerateKey');
    expect(getStatusGroup(account)).toBe('manual');
  });

  it('keeps inactive accounts manual except for explicit password reset', () => {
    const account = row({ status: 'inactive', elevenPass: '' });
    expect(getEligibleWorkflows(account)).toEqual(['resetPassword']);
    expect(getRecommendedAction(account)).toBeNull();
    expect(getStatusGroup(account)).toBe('manual');
  });

  it('does not retry Hotmail rows that need manual password recovery', () => {
    const account = row({ status: 'need to recover password' });
    expect(getEligibleWorkflows(account)).toEqual(['resetPassword']);
    expect(getRecommendedAction(account)).toBeNull();
    expect(getStatusGroup(account)).toBe('manual');
  });

  it('adds runtime reservation data without changing Sheet classification', () => {
    const summary = toAccountSummary(row(), null, {
      state: 'running',
      jobId: 'job-1',
      workflowId: 'signup',
      currentStep: null,
    });
    expect(summary.runtime).toEqual({ state: 'running', jobId: 'job-1', workflowId: 'signup', currentStep: null });
    expect(summary.recommendedAction).toBe('signup');
  });

  it('declares workflow-specific interval capabilities', () => {
    expect(WORKFLOWS.find((workflow) => workflow.id === 'signup')).toMatchObject({
      usesInterval: true,
    });
    expect(WORKFLOWS.find((workflow) => workflow.id === 'proxyCheck')).toMatchObject({
      usesInterval: false,
    });
  });
});

describe('job preview', () => {
  it('accepts password reset for every selected account state', () => {
    const request = {
      workflowId: 'resetPassword' as const,
      selection: { mode: 'rows' as const, rowIndexes: [2, 3, 4] },
      options: { intervalMinutes: 1 },
    };
    const preview = previewJob([
      row(),
      row({ rowIndex: 3, status: 'complete', apiKey: 'sk_done', elevenPass: 'Eleven1!' }),
      row({ rowIndex: 4, status: 'need to recover password' }),
    ], request);

    expect(preview.accepted.map((account) => account.rowIndex)).toEqual([2, 3, 4]);
    expect(preview.rejected).toEqual([]);
  });

  it('limits all-eligible password reset to resettable states', () => {
    const preview = previewJob([
      row(),
      row({ rowIndex: 3, status: 'credentials-rejected', elevenPass: 'Old1!' }),
      row({ rowIndex: 4, status: 'already-registered' }),
      row({ rowIndex: 5, status: 'complete', apiKey: 'sk_done', elevenPass: 'Eleven1!' }),
    ], {
      workflowId: 'resetPassword',
      selection: { mode: 'allEligible' },
      options: { intervalMinutes: 1 },
    });

    expect(preview.accepted.map((account) => account.rowIndex)).toEqual([3, 4]);
    expect(preview.rejected.map((account) => account.rowIndex)).toEqual([2, 5]);
  });

  it('does not reactivate inactive accounts through retry or full cycle', () => {
    const account = row({ status: 'inactive' });
    for (const workflowId of ['retryPending', 'fullCycle'] as const) {
      const preview = previewJob([account], {
        workflowId,
        selection: { mode: 'rows', rowIndexes: [2] },
        options: { intervalMinutes: 1 },
      });
      expect(preview.accepted).toEqual([]);
      expect(preview.rejected[0]?.reason).toContain('thủ công');
    }
  });

  it('returns accepted and rejected selected rows', () => {
    const request = {
      workflowId: 'signup' as const,
      selection: { mode: 'rows' as const, rowIndexes: [2, 3] },
      options: { intervalMinutes: 1 },
    };
    const preview = previewJob([row(), row({ rowIndex: 3, status: 'complete', apiKey: 'sk_done' })], request);
    expect(preview.accepted.map((account) => account.rowIndex)).toEqual([2]);
    expect(preview.rejected.map((account) => account.rowIndex)).toEqual([3]);
  });

  it('shows current eligibility and the reserved scope for every full-cycle pass', () => {
    const request = {
      workflowId: 'fullCycle' as const,
      selection: { mode: 'rows' as const, rowIndexes: [2, 3] },
      options: { intervalMinutes: 1 },
    };
    const preview = previewJob([
      row(),
      row({ rowIndex: 3, status: 'failed:onboarding', elevenPass: 'Eleven1!' }),
    ], request);
    expect(preview.phases).toEqual([
      { phaseId: 'signup', workflowId: 'signup', currentEligible: 1, maxAccounts: 2, dynamic: false },
      { phaseId: 'resume-1', workflowId: 'resume', currentEligible: 1, maxAccounts: 2, dynamic: true },
      { phaseId: 'reset-password', workflowId: 'resetPassword', currentEligible: 0, maxAccounts: 2, dynamic: true },
      { phaseId: 'resume-2', workflowId: 'resume', currentEligible: 1, maxAccounts: 2, dynamic: true },
    ]);
  });

  it('rejects rows already reserved by a non-terminal job', () => {
    const request = {
      workflowId: 'signup' as const,
      selection: { mode: 'rows' as const, rowIndexes: [2] },
      options: { intervalMinutes: 1 },
    };
    const preview = previewJob([row()], request, new Map([[2, {
      state: 'waiting_captcha' as const,
      jobId: 'job-reserved',
      workflowId: 'signup' as const,
      currentStep: 'solve CAPTCHA',
    }]]));
    expect(preview.accepted).toEqual([]);
    expect(preview.rejected[0]?.reason).toContain('job-rese');
  });

  it('rejects duplicate and blank Sheet identities for all-eligible and row previews', () => {
    const accounts = [
      row({ rowIndex: 2, email: 'operator@example.com' }),
      row({ rowIndex: 3, email: ' OPERATOR@example.com ' }),
      row({ rowIndex: 4, email: '   ' }),
    ];
    const selections = [
      { mode: 'allEligible' as const },
      { mode: 'rows' as const, rowIndexes: [2, 4] },
    ];

    for (const selection of selections) {
      const preview = previewJob(accounts, {
        workflowId: 'signup',
        selection,
        options: { intervalMinutes: 1 },
      });
      expect(preview.accepted).toEqual([]);
      expect(preview.rejected.find((account) => account.rowIndex === 2)?.reason).toContain('Email trùng');
      expect(preview.rejected.find((account) => account.rowIndex === 4)?.reason).toContain('Email trống');
    }
  });
});
