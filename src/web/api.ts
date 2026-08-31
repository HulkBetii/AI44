import type {
  AccountDetail,
  AccountSummary,
  HealthResponse,
  JobEvent,
  JobPreview,
  JobPreviewRequest,
  JobRecord,
  JobRequest,
  RecoveryResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  WorkflowDefinition,
} from '../shared/contracts';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `Request failed with status ${response.status}`);
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  workflows: () => request<WorkflowDefinition[]>('/api/workflows'),
  accounts: (refresh = false) => request<AccountSummary[]>(`/api/accounts${refresh ? '?refresh=1' : ''}`),
  account: (rowIndex: number, expectedEmail: string) => {
    const query = new URLSearchParams({ expectedEmail });
    return request<AccountDetail>(`/api/accounts/${rowIndex}?${query}`);
  },
  revealSecret: (rowIndex: number, field: string, expectedEmail: string) => request<{ value: string }>(
    `/api/accounts/${rowIndex}/secrets/${field}/reveal`, {
      method: 'POST', body: JSON.stringify({ expectedEmail }),
    },
  ),
  previewJob: (job: JobPreviewRequest) => request<JobPreview>('/api/jobs/preview', {
    method: 'POST', body: JSON.stringify(job),
  }),
  createJob: (job: JobRequest, signal?: AbortSignal) => request<JobRecord>('/api/jobs', {
    method: 'POST', body: JSON.stringify(job), signal,
  }),
  jobs: () => request<JobRecord[]>('/api/jobs'),
  job: (jobId: string) => request<{ job: JobRecord; events: JobEvent[]; log: string }>(`/api/jobs/${jobId}`),
  cancelJob: (jobId: string) => request<JobRecord>(`/api/jobs/${jobId}/cancel`, { method: 'POST' }),
  focusJob: (jobId: string) => request<{ focused: boolean }>(`/api/jobs/${jobId}/focus-browser`, { method: 'POST' }),
  settings: () => request<SettingsResponse>('/api/settings'),
  saveSettings: (settings: SettingsUpdateRequest) => request<SettingsResponse>('/api/settings', {
    method: 'PUT', body: JSON.stringify(settings),
  }),
  recovery: () => request<RecoveryResponse>('/api/recovery'),
  syncRecovery: (id: string) => request<RecoveryResponse>(`/api/recovery/${id}/sync`, { method: 'POST' }),
  discardRecovery: (id: string) => request<RecoveryResponse>(`/api/recovery/${id}`, {
    method: 'DELETE', body: JSON.stringify({ confirm: true }),
  }),
  diagnoseSheets: () => request<{ ok: boolean; rowCount: number }>('/api/diagnostics/sheets', { method: 'POST' }),
  diagnoseGpm: () => request<{ ok: boolean }>('/api/diagnostics/gpm', { method: 'POST' }),
};
