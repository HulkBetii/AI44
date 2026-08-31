import path from 'node:path';
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
}

interface WorkflowPolicyModule {
  FULL_CYCLE_PHASES: Array<{
    phaseId: string;
    workflowId: WorkflowId;
    dynamic: boolean;
  }>;
  MANUAL_STATUSES: Set<string>;
  getEligibleWorkflows(account: AccountRow): WorkflowId[];
  getRecommendedAction(account: AccountRow): WorkflowId | null;
  getStateEligibleWorkflows(account: AccountRow): WorkflowId[];
  isEligibleForWorkflow(account: AccountRow, workflowId: WorkflowId, options?: { explicitReset?: boolean }): boolean;
}

const workflowPolicy = require(path.join(__dirname, '..', '..', 'workflow-policy.js')) as WorkflowPolicyModule;

export const WORKFLOWS: WorkflowDefinition[] = [
  { id: 'signup', label: 'Chạy pending', description: 'Đăng ký, xác minh và tạo API key.', risk: 'normal', supportsAccountSelection: true, usesInterval: true },
  { id: 'resume', label: 'Tiếp tục', description: 'Tiếp tục account đã có mật khẩu nhưng chưa có key.', risk: 'normal', supportsAccountSelection: true, usesInterval: true },
  { id: 'resetPassword', label: 'Reset mật khẩu', description: 'Khôi phục quyền truy cập qua Outlook.', risk: 'attention', supportsAccountSelection: true, usesInterval: true },
  { id: 'regenerateKey', label: 'Tạo key mới', description: 'Đăng nhập và tạo thêm API key.', risk: 'attention', supportsAccountSelection: true, usesInterval: true },
  { id: 'retryPending', label: 'Đưa về pending', description: 'Reset lỗi an toàn rồi chạy signup lại.', risk: 'attention', supportsAccountSelection: true, usesInterval: true },
  { id: 'fullCycle', label: 'Chạy full cycle', description: 'Signup, resume, reset password và resume lại.', risk: 'attention', supportsAccountSelection: true, usesInterval: true },
  { id: 'proxyCheck', label: 'Kiểm tra proxy', description: 'Rotate proxy và kiểm tra các host bắt buộc.', risk: 'normal', supportsAccountSelection: false, usesInterval: false },
];

export function getEligibleWorkflows(account: AccountRow): WorkflowId[] {
  return workflowPolicy.getEligibleWorkflows(account);
}

export function getRecommendedAction(account: AccountRow): WorkflowId | null {
  return workflowPolicy.getRecommendedAction(account);
}

export function getStatusGroup(account: AccountRow): StatusGroup {
  const status = account.status.trim().toLowerCase();
  if (workflowPolicy.MANUAL_STATUSES.has(status) || (account.apiKey && status !== 'complete')) return 'manual';
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
    lastRunAt,
    runtime,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailCounts(accounts: AccountRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    const email = normalizeEmail(account.email);
    if (email) counts.set(email, (counts.get(email) || 0) + 1);
  }
  return counts;
}

function identityRejectionReason(account: AccountRow, counts: ReadonlyMap<string, number>): string | null {
  const email = normalizeEmail(account.email);
  if (!email) return 'Email trống; không thể xác định account ổn định';
  if (counts.get(email) !== 1) return 'Email trùng trong Sheet; cần giữ duy nhất một dòng';
  return null;
}

function selectedAccounts(accounts: AccountRow[], request: JobPreviewRequest | JobRequest): AccountRow[] {
  if (request.selection.mode === 'allEligible') return accounts;
  if (request.selection.mode === 'rows') {
    return accounts.filter((account) => request.selection.mode === 'rows'
      && request.selection.rowIndexes.includes(account.rowIndex));
  }

  const requestedCounts = new Map<string, number>();
  for (const identity of request.selection.accounts) {
    const email = normalizeEmail(identity.email);
    requestedCounts.set(email, (requestedCounts.get(email) || 0) + 1);
  }
  const sheetCounts = new Map<string, number>();
  for (const account of accounts) {
    const email = normalizeEmail(account.email);
    sheetCounts.set(email, (sheetCounts.get(email) || 0) + 1);
  }
  return accounts.filter((account) => {
    const email = normalizeEmail(account.email);
    return requestedCounts.get(email) === 1 && sheetCounts.get(email) === 1;
  });
}

function rejectionReason(account: AccountRow, workflowId: WorkflowId, runtime: AccountRuntime | null): string {
  if (runtime) return `Đang được giữ bởi job #${runtime.jobId.slice(0, 8)} (${runtime.state})`;
  const status = account.status.trim().toLowerCase();
  if (workflowPolicy.MANUAL_STATUSES.has(status) && workflowId !== 'resetPassword') return 'Hotmail cần kiểm tra thủ công';
  if (account.apiKey && ['signup', 'resume', 'retryPending', 'fullCycle'].includes(workflowId)) {
    return 'Account đang giữ API key';
  }
  if (!account.elevenPass && workflowId === 'regenerateKey') return 'Chưa có mật khẩu ElevenLabs';
  return `Không hợp lệ cho workflow ${workflowId}`;
}

export function previewJob(
  accounts: AccountRow[],
  request: JobPreviewRequest | JobRequest,
  runtimes: ReadonlyMap<number, AccountRuntime> = new Map(),
  options: { explicitReset?: boolean } = {},
): JobPreview {
  if (request.workflowId === 'proxyCheck') {
    return { workflowId: request.workflowId, accepted: [], rejected: [], phases: [] };
  }

  const selected = selectedAccounts(accounts, request);
  const identityCounts = emailCounts(accounts);
  const explicitReset = options.explicitReset
    ?? (request.workflowId === 'resetPassword' && request.selection.mode !== 'allEligible');
  const accepts = (account: AccountRow, workflowId: WorkflowId) => {
    if (identityRejectionReason(account, identityCounts)) return false;
    if (runtimes.has(account.rowIndex)) return false;
    return workflowPolicy.isEligibleForWorkflow(account, workflowId, { explicitReset });
  };
  const acceptedRows = selected.filter((account) => accepts(account, request.workflowId));
  const rejectedRows = selected.filter((account) => !accepts(account, request.workflowId));
  const phases = request.workflowId === 'fullCycle'
    ? workflowPolicy.FULL_CYCLE_PHASES.map(({ phaseId, workflowId, dynamic }) => ({
        phaseId,
        workflowId,
        currentEligible: acceptedRows.filter((account) => workflowPolicy.getStateEligibleWorkflows(account).includes(workflowId)).length,
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
      reason: identityRejectionReason(account, identityCounts)
        || rejectionReason(account, request.workflowId, runtimes.get(account.rowIndex) || null),
    })),
    phases,
  };
}
