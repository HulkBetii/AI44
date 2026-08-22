import type {
  AccountRuntime,
  AccountSummary,
  JobPreview,
  JobPreviewRequest,
  JobRequest,
  StatusGroup,
  WorkflowDefinition,
  WorkflowId,
} from '../shared/contracts';

export interface AccountRow {
  rowIndex: number;
  email: string;
  password: string;
  msaToken: string;
  tenantGuid: string;
  recoveryEmail: string;
  apiKey: string;
  elevenPass: string;
  status: string;
  proxyToken: string;
}

const RESETTABLE_STATUSES = new Set(['credentials-rejected', 'already-registered']);
const MANUAL_STATUSES = new Set(['inactive', 'need to recover password']);

export const WORKFLOWS: WorkflowDefinition[] = [
  { id: 'signup', label: 'Chạy pending', description: 'Đăng ký, xác minh và tạo API key.', risk: 'normal', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'resume', label: 'Tiếp tục', description: 'Tiếp tục account đã có mật khẩu nhưng chưa có key.', risk: 'normal', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'resetPassword', label: 'Reset mật khẩu', description: 'Khôi phục quyền truy cập qua Outlook.', risk: 'attention', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'regenerateKey', label: 'Tạo key mới', description: 'Đăng nhập và tạo thêm API key.', risk: 'attention', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'retryPending', label: 'Đưa về pending', description: 'Reset lỗi an toàn rồi chạy signup lại.', risk: 'attention', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'fullCycle', label: 'Chạy full cycle', description: 'Signup, resume, reset password và resume lại.', risk: 'attention', supportsAccountSelection: true, allowedProxyModes: ['sheet', 'none', 'override'], usesInterval: true },
  { id: 'proxyCheck', label: 'Kiểm tra proxy', description: 'Rotate proxy và kiểm tra các host bắt buộc.', risk: 'normal', supportsAccountSelection: false, allowedProxyModes: ['sheet', 'override'], usesInterval: false },
];

const FULL_CYCLE_PHASES = [
  { phaseId: 'signup', workflowId: 'signup', dynamic: false },
  { phaseId: 'resume-1', workflowId: 'resume', dynamic: true },
  { phaseId: 'reset-password', workflowId: 'resetPassword', dynamic: true },
  { phaseId: 'resume-2', workflowId: 'resume', dynamic: true },
] as const;

export function getEligibleWorkflows(account: AccountRow): WorkflowId[] {
  const status = account.status.trim().toLowerCase();
  const hasPassword = Boolean(account.elevenPass);
  const hasKey = Boolean(account.apiKey);
  const eligible: WorkflowId[] = [];

  if (MANUAL_STATUSES.has(status)) return [];
  if (hasPassword) eligible.push('regenerateKey');
  if (hasKey) return eligible;

  if (status === 'pending' && !hasPassword) eligible.push('signup');
  if (RESETTABLE_STATUSES.has(status)) eligible.push('resetPassword');
  if (status !== 'complete' && hasPassword && !RESETTABLE_STATUSES.has(status)) eligible.push('resume');
  if (
    status !== 'pending'
    && status !== 'complete'
    && !MANUAL_STATUSES.has(status)
    && !RESETTABLE_STATUSES.has(status)
    && !hasPassword
    && !hasKey
  ) {
    eligible.push('retryPending');
  }
  if (eligible.some((workflow) => ['signup', 'resume', 'resetPassword'].includes(workflow))) {
    eligible.push('fullCycle');
  }

  return [...new Set(eligible)];
}

export function getRecommendedAction(account: AccountRow): WorkflowId | null {
  const eligible = getEligibleWorkflows(account);
  return ['signup', 'resume', 'resetPassword', 'retryPending', 'regenerateKey']
    .find((workflow) => eligible.includes(workflow as WorkflowId)) as WorkflowId | undefined || null;
}

export function getStatusGroup(account: AccountRow): StatusGroup {
  const status = account.status.trim().toLowerCase();
  if (MANUAL_STATUSES.has(status) || (account.apiKey && status !== 'complete')) return 'manual';
  if (status === 'complete') return 'complete';
  const eligible = getEligibleWorkflows(account);
  if (status === 'pending' && eligible.includes('signup')) return 'pending';
  if (eligible.some((workflow) => ['resume', 'resetPassword', 'retryPending'].includes(workflow))) {
    return 'recoverable';
  }
  return 'failed';
}

export function toAccountSummary(
  account: AccountRow,
  lastRunAt: string | null = null,
  runtime: AccountRuntime | null = null,
): AccountSummary {
  return {
    rowIndex: account.rowIndex,
    email: account.email,
    status: account.status || '(blank)',
    statusGroup: getStatusGroup(account),
    recommendedAction: getRecommendedAction(account),
    eligibleWorkflows: getEligibleWorkflows(account),
    hasElevenPassword: Boolean(account.elevenPass),
    hasApiKey: Boolean(account.apiKey),
    hasProxyToken: Boolean(account.proxyToken),
    lastRunAt,
    runtime,
  };
}

function inRequestedSelection(account: AccountRow, request: JobPreviewRequest | JobRequest): boolean {
  return request.selection.mode === 'allEligible' || request.selection.rowIndexes.includes(account.rowIndex);
}

function rejectionReason(account: AccountRow, workflowId: WorkflowId, runtime: AccountRuntime | null): string {
  if (runtime) return `Đang được giữ bởi job #${runtime.jobId.slice(0, 8)} (${runtime.state})`;
  const status = account.status.trim().toLowerCase();
  if (MANUAL_STATUSES.has(status)) return 'Hotmail cần kiểm tra thủ công';
  if (account.apiKey && ['signup', 'resume', 'resetPassword', 'retryPending', 'fullCycle'].includes(workflowId)) {
    return 'Account đang giữ API key';
  }
  if (!account.elevenPass && workflowId === 'regenerateKey') return 'Chưa có mật khẩu ElevenLabs';
  return `Không hợp lệ cho workflow ${workflowId}`;
}

export function previewJob(
  accounts: AccountRow[],
  request: JobPreviewRequest | JobRequest,
  runtimes: ReadonlyMap<number, AccountRuntime> = new Map(),
): JobPreview {
  if (request.workflowId === 'proxyCheck') {
    if (request.options.proxyMode === 'sheet' && !accounts.some((account) => account.proxyToken)) {
      throw new Error('Không tìm thấy proxy token trong Sheet');
    }
    return { workflowId: request.workflowId, accepted: [], rejected: [], phases: [] };
  }

  const selected = accounts.filter((account) => inRequestedSelection(account, request));
  const accepts = (account: AccountRow, workflowId: WorkflowId) => {
    if (runtimes.has(account.rowIndex)) return false;
    const eligible = getEligibleWorkflows(account);
    return workflowId === 'fullCycle'
      ? eligible.includes('fullCycle')
      : eligible.includes(workflowId);
  };
  const acceptedRows = selected.filter((account) => accepts(account, request.workflowId));
  const rejectedRows = selected.filter((account) => !accepts(account, request.workflowId));
  const phases = request.workflowId === 'fullCycle'
    ? FULL_CYCLE_PHASES.map(({ phaseId, workflowId, dynamic }) => ({
        phaseId,
        workflowId,
        currentEligible: acceptedRows.filter((account) => getEligibleWorkflows(account).includes(workflowId)).length,
        maxAccounts: acceptedRows.length,
        dynamic,
      }))
    : [{
        phaseId: request.workflowId,
        workflowId: request.workflowId,
        currentEligible: acceptedRows.length,
        maxAccounts: acceptedRows.length,
        dynamic: false,
      }];

  return {
    workflowId: request.workflowId,
    accepted: acceptedRows.map((account) => toAccountSummary(account, null, runtimes.get(account.rowIndex) || null)),
    rejected: rejectedRows.map((account) => ({
      rowIndex: account.rowIndex,
      email: account.email,
      reason: rejectionReason(account, request.workflowId, runtimes.get(account.rowIndex) || null),
    })),
    phases,
  };
}
