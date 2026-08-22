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

export const ProxyModeSchema = z.enum(['sheet', 'none', 'override']);
export type ProxyMode = z.infer<typeof ProxyModeSchema>;

export const AccountSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('rows'), rowIndexes: z.array(z.number().int().min(2)).min(1) }),
  z.object({ mode: z.literal('allEligible') }),
]);

const JobSelectionSchema = z.object({
  workflowId: WorkflowIdSchema,
  selection: AccountSelectionSchema,
});

const JobOptionsSchema = z.object({
  proxyMode: ProxyModeSchema,
  proxyTokenOverride: z.string().trim().min(1).optional(),
  intervalMinutes: z.number().positive().max(180),
}).strict();

const JobPreviewOptionsSchema = z.object({
  proxyMode: ProxyModeSchema,
  hasProxyTokenOverride: z.boolean(),
  intervalMinutes: z.number().positive().max(180),
}).strict();

function validateWorkflowRequest(
  request: {
    workflowId: WorkflowId;
    selection: z.infer<typeof AccountSelectionSchema>;
    options: { proxyMode: ProxyMode; hasProxyTokenOverride: boolean };
  },
  context: z.RefinementCtx,
  overridePath: 'proxyTokenOverride' | 'hasProxyTokenOverride',
): void {
  if (request.options.proxyMode === 'override' && !request.options.hasProxyTokenOverride) {
    context.addIssue({
      code: 'custom',
      path: ['options', overridePath],
      message: 'A proxy token is required when proxyMode is override',
    });
  }
  if (request.options.proxyMode !== 'override' && request.options.hasProxyTokenOverride) {
    context.addIssue({
      code: 'custom',
      path: ['options', overridePath],
      message: 'A proxy token override is only allowed when proxyMode is override',
    });
  }
  if (request.workflowId === 'proxyCheck' && request.options.proxyMode === 'none') {
    context.addIssue({
      code: 'custom',
      path: ['options', 'proxyMode'],
      message: 'proxyCheck requires a Sheet or override proxy token',
    });
  }
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
}).superRefine((request, context) => {
  validateWorkflowRequest({
    ...request,
    options: {
      proxyMode: request.options.proxyMode,
      hasProxyTokenOverride: Boolean(request.options.proxyTokenOverride),
    },
  }, context, 'proxyTokenOverride');
});

export const JobPreviewRequestSchema = JobSelectionSchema.extend({
  options: JobPreviewOptionsSchema,
}).superRefine((request, context) => validateWorkflowRequest(request, context, 'hasProxyTokenOverride'));

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
  hasProxyToken: boolean;
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
  allowedProxyModes: ProxyMode[];
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
}

export interface RuntimeSettings {
  sheetId: string;
  sheetName: string;
  serviceAccountPath: string;
  gpmApiBase: string;
  defaultIntervalMinutes: number;
  runtimeDirectory: string;
}

export interface SettingsResponse {
  values: RuntimeSettings;
  envOverrides: Array<keyof RuntimeSettings>;
  canEdit: boolean;
}
