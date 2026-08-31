import { z } from 'zod';

export const WorkflowIdSchema = z.enum([
  'signup',
  'resume',
  'resetPassword',
  'regenerateKey',
  'retryPending',
  'fullCycle',
  'proxyCheck',
]);

export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const AccountIdentitySchema = z.object({
  rowIndex: z.number().int().min(2),
  email: z.string().trim().min(1),
}).strict();

export type AccountIdentity = z.infer<typeof AccountIdentitySchema>;

export const AccountSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('rows'), rowIndexes: z.array(z.number().int().min(2)).min(1) }),
  z.object({ mode: z.literal('identities'), accounts: z.array(AccountIdentitySchema).min(1) }),
  z.object({ mode: z.literal('allEligible') }),
]);

const JobSelectionSchema = z.object({
  workflowId: WorkflowIdSchema,
  selection: AccountSelectionSchema,
});

const JobOptionsSchema = z.object({
  intervalMinutes: z.number().positive().max(180),
}).strict();

const JobPreviewOptionsSchema = z.object({
  intervalMinutes: z.number().positive().max(180),
}).strict();

function validateWorkflowRequest(
  request: {
    workflowId: WorkflowId;
    selection: z.infer<typeof AccountSelectionSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (request.workflowId === 'proxyCheck' && request.selection.mode !== 'allEligible') {
    context.addIssue({
      code: 'custom',
      path: ['selection'],
      message: 'proxyCheck does not accept an account selection',
    });
  }
}

export const JobRequestSchema = JobSelectionSchema.extend({
  options: JobOptionsSchema,
}).superRefine((request, context) => validateWorkflowRequest(request, context));

export const JobPreviewRequestSchema = JobSelectionSchema.extend({
  options: JobPreviewOptionsSchema,
}).superRefine((request, context) => validateWorkflowRequest(request, context));

export type JobPreviewRequest = z.infer<typeof JobPreviewRequestSchema>;

export type JobRequest = z.infer<typeof JobRequestSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'needs_attention',
  'cancelling',
  'cancelled',
  'succeeded',
  'completed_with_errors',
  'failed',
  'interrupted',
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobEventTypeSchema = z.enum([
  'job.state',
  'account.started',
  'step.changed',
  'attention.required',
  'attention.cleared',
  'account.succeeded',
  'account.failed',
  'cleanup.started',
  'cleanup.completed',
  'artifact.created',
  'phase.started',
  'phase.completed',
  'log',
]);

export type JobEventType = z.infer<typeof JobEventTypeSchema>;

export interface JobEvent {
  id: string;
  jobId: string;
  sequence: number;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  type: JobEventType;
  rowIndex?: number;
  message: string;
  data?: Record<string, unknown>;
}

export type StatusGroup = 'pending' | 'recoverable' | 'complete' | 'manual' | 'failed';

export interface AccountRuntime {
  state: 'queued' | 'running' | 'waiting_captcha' | 'cancelling';
  jobId: string;
  workflowId: WorkflowId;
  currentStep: string | null;
}

export interface AccountSummary {
  rowIndex: number;
  email: string;
  status: string;
  statusGroup: StatusGroup;
  recommendedAction: WorkflowId | null;
  eligibleWorkflows: WorkflowId[];
  hasElevenPassword: boolean;
  hasApiKey: boolean;
  lastRunAt: string | null;
  runtime: AccountRuntime | null;
}

export interface AccountDetail extends AccountSummary {
  recoveryEmail: string;
  msaTokenPresent: boolean;
  tenantGuidPresent: boolean;
  recentJobs: JobRecord[];
  lastFailure: {
    jobId: string;
    message: string;
    step: string | null;
    artifactId: string | null;
  } | null;
}

export interface WorkflowDefinition {
  id: WorkflowId;
  label: string;
  description: string;
  risk: 'normal' | 'attention' | 'danger';
  supportsAccountSelection: boolean;
  usesInterval: boolean;
}

export interface PreviewRejectedAccount {
  rowIndex: number;
  email: string;
  reason: string;
}

export interface JobPreview {
  workflowId: WorkflowId;
  accepted: AccountSummary[];
  rejected: PreviewRejectedAccount[];
  phases: Array<{
    phaseId: string;
    workflowId: WorkflowId;
    currentEligible: number;
    maxAccounts: number;
    dynamic: boolean;
  }>;
}

export type PublicJobRequest = JobPreviewRequest;

export interface JobRecord {
  id: string;
  status: JobStatus;
  request: PublicJobRequest;
  acceptedRows: number[];
  acceptedAccounts?: AccountIdentity[];
  rejectedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  currentRowIndex: number | null;
  currentAccount: number;
  totalAccounts: number;
  currentStep: string | null;
  errorCount: number;
  lastMessage: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  sheets: 'ready' | 'unavailable' | 'unchecked';
  gpm: 'ready' | 'unavailable' | 'unchecked';
  workerLock: 'free' | 'busy' | 'stale';
  activeJobId: string | null;
  queueLength: number;
  recoveryPendingCount: number;
}

export interface RuntimeSettings {
  sheetId: string;
  sheetName: string;
  serviceAccountPath: string;
  gpmApiBase: string;
  defaultIntervalMinutes: number;
  runtimeDirectory: string;
  proxyProvider: 'tinproxy' | 'sp07' | 'none';
  proxyApiKey?: string;
  capsolverApiKey?: string;
  capbypassApiKey?: string;
  twoCaptchaApiKey?: string;
  nonecapApiKey?: string;
}

export const SECRET_SETTING_KEYS = [
  'proxyApiKey',
  'capsolverApiKey',
  'capbypassApiKey',
  'twoCaptchaApiKey',
  'nonecapApiKey',
] as const;

export type SecretSettingKey = typeof SECRET_SETTING_KEYS[number];
export type PublicRuntimeSettings = Omit<RuntimeSettings, SecretSettingKey>;

export interface SettingsUpdateRequest extends PublicRuntimeSettings {
  secrets?: Partial<Record<SecretSettingKey, string | null>>;
}

export interface SettingsResponse {
  values: PublicRuntimeSettings;
  configuredSecrets: SecretSettingKey[];
  envOverrides: Array<keyof RuntimeSettings>;
  canEdit: boolean;
}

export interface RecoveryEntrySummary {
  id: string;
  state: 'prepared' | 'confirmed';
  email: string;
  originalRowIndex: number | null;
  operation: 'signup' | 'resetPassword';
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryResponse {
  entries: RecoveryEntrySummary[];
}
