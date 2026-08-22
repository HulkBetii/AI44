import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Eye, EyeOff, LoaderCircle, X } from 'lucide-react';
import type { JobPreview, JobPreviewRequest, JobRequest, ProxyMode, WorkflowDefinition, WorkflowId } from '../shared/contracts';
import { api } from './api';
import { Overlay } from './Overlay';

export function StatusPill({ status }: { status: string }) {
  const normalized = status.replaceAll('_', '-');
  return <span className={`status-pill status-${normalized}`}>{status.replaceAll('_', ' ')}</span>;
}

export function PresenceMark({ present, label }: { present: boolean; label: string }) {
  return (
    <span className={`presence ${present ? 'presence-yes' : 'presence-no'}`} aria-label={`${label}: ${present ? 'có' : 'không'}`}>
      {present ? <Check size={14} aria-hidden="true" /> : '—'}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <span>{error instanceof Error ? error.message : 'Không thể tải dữ liệu'}</span>
    </div>
  );
}

export function LoadingLine({ label = 'Đang tải dữ liệu' }: { label?: string }) {
  return <div className="loading-line"><LoaderCircle className="spin" size={18} aria-hidden="true" />{label}</div>;
}

export interface ComposerState {
  workflowId: WorkflowId;
  rowIndexes?: number[];
}

export function JobComposer({
  state,
  workflows,
  workflowError,
  settingsError,
  settingsLoading,
  defaultInterval,
  onClose,
  onCreated,
}: {
  state: ComposerState;
  workflows: WorkflowDefinition[];
  workflowError?: unknown;
  settingsError?: unknown;
  settingsLoading: boolean;
  defaultInterval: number;
  onClose(): void;
  onCreated(): void;
}) {
  const queryClient = useQueryClient();
  const [proxyMode, setProxyMode] = useState<JobRequest['options']['proxyMode']>('sheet');
  const [proxyToken, setProxyToken] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(defaultInterval);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const creatingRef = useRef(false);
  const intervalEditedRef = useRef(false);
  const definition = workflows.find((workflow) => workflow.id === state.workflowId);
  const allowedProxyModes = definition?.allowedProxyModes || ['sheet', 'none', 'override'];
  const validProxyMode = allowedProxyModes.includes(proxyMode);
  const intervalSettingsReady = !definition?.usesInterval || (!settingsLoading && !settingsError);
  const selection = useMemo<JobRequest['selection']>(() => state.rowIndexes?.length
    ? { mode: 'rows', rowIndexes: state.rowIndexes }
    : { mode: 'allEligible' }, [state.rowIndexes]);
  const previewRequest = useMemo<JobPreviewRequest>(() => ({
    workflowId: state.workflowId,
    selection,
    options: {
      proxyMode,
      hasProxyTokenOverride: proxyMode === 'override' && Boolean(proxyToken.trim()),
      intervalMinutes,
    },
  }), [state.workflowId, selection, proxyMode, proxyToken, intervalMinutes]);

  const preview = useQuery({
    queryKey: ['job-preview', previewRequest],
    queryFn: () => api.previewJob(previewRequest),
    enabled: Boolean(definition) && intervalSettingsReady && validProxyMode && (proxyMode !== 'override' || Boolean(proxyToken.trim())),
    retry: false,
  });
  const createJob = async () => {
    if (creatingRef.current || !definition || !intervalSettingsReady || !validProxyMode) return;
    const request: JobRequest = {
      workflowId: state.workflowId,
      selection,
      options: {
        proxyMode,
        ...(proxyMode === 'override' ? { proxyTokenOverride: proxyToken.trim() } : {}),
        intervalMinutes,
      },
    };

    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createJob(request);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      onCreated();
      onClose();
    } catch (error) {
      setCreateError(error);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const isDiagnostic = state.workflowId === 'proxyCheck';
  const acceptedCount = preview.data?.accepted.length || 0;
  const validOverride = proxyMode !== 'override' || Boolean(proxyToken.trim());
  const canCreate = Boolean(
    definition
    && intervalSettingsReady
    && validProxyMode
    && validOverride
    && preview.data
    && !preview.error
    && !preview.isFetching
    && !creating
    && (isDiagnostic || acceptedCount > 0),
  );
  const close = () => { if (!creating) onClose(); };
  const changeProxyMode = (mode: ProxyMode) => {
    setProxyMode(mode);
    if (mode !== 'override') setProxyToken('');
  };

  useEffect(() => {
    if (!intervalEditedRef.current) setIntervalMinutes(defaultInterval);
  }, [defaultInterval]);

  return (
    <Overlay backdropClassName="modal-backdrop" panelClassName="modal" labelledBy="composer-title" onClose={close}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">Tạo lượt chạy</span>
            <h2 id="composer-title">{definition?.label || state.workflowId}</h2>
            <p>{definition?.description}</p>
          </div>
          <button className="icon-button" disabled={creating} onClick={close} aria-label="Đóng"><X size={18} /></button>
        </header>

        <div className="modal-body">
          {workflowError ? <ErrorState error={workflowError} /> : !definition ? <LoadingLine label="Đang tải workflow registry" /> : definition.usesInterval && settingsError ? <ErrorState error={settingsError} /> : definition.usesInterval && settingsLoading ? <LoadingLine label="Đang tải interval mặc định" /> : <>
          <div className="form-grid">
            <label>
              <span>Chế độ proxy</span>
              <select value={proxyMode} onChange={(event) => changeProxyMode(event.target.value as ProxyMode)}>
                {allowedProxyModes.includes('sheet') && <option value="sheet">Token từ Google Sheet</option>}
                {allowedProxyModes.includes('none') && <option value="none">Không dùng proxy</option>}
                {allowedProxyModes.includes('override') && <option value="override">Override tạm thời</option>}
              </select>
            </label>
            {definition?.usesInterval && <label>
              <span>Interval trung bình (phút)</span>
              <input type="number" min="0.1" max="180" step="0.1" value={intervalMinutes} onChange={(event) => { intervalEditedRef.current = true; setIntervalMinutes(Number(event.target.value)); }} />
            </label>}
          </div>
          {proxyMode === 'override' && (
            <label className="field-block">
              <span>Proxy token override</span>
              <input type="password" autoComplete="off" value={proxyToken} onChange={(event) => setProxyToken(event.target.value)} placeholder="Không lưu vào log hoặc lịch sử" />
            </label>
          )}

          <PreviewPanel preview={preview.data} loading={preview.isFetching} error={preview.error} workflowId={state.workflowId} />
          {definition?.risk !== 'normal' && (
            <div className="warning-box"><AlertTriangle size={17} />Workflow này thay đổi credential hoặc trạng thái account. Backend sẽ kiểm tra eligibility lại trước khi chạy.</div>
          )}
          </>}
          {createError && <ErrorState error={createError} />}
        </div>

        <footer className="modal-footer">
          <button className="button button-ghost" disabled={creating} onClick={close}>Hủy</button>
          <button className="button button-primary" disabled={!canCreate} onClick={() => void createJob()}>
            {creating ? 'Đang thêm...' : `Thêm vào hàng đợi${acceptedCount ? ` · ${acceptedCount}` : ''}`}
          </button>
        </footer>
    </Overlay>
  );
}

function PreviewPanel({ preview, loading, error, workflowId }: { preview?: JobPreview; loading: boolean; error: unknown; workflowId: WorkflowId }) {
  if (loading) return <LoadingLine label="Đang kiểm tra eligibility" />;
  if (error) return <ErrorState error={error} />;
  if (workflowId === 'proxyCheck') return <div className="preview-summary"><strong>Proxy diagnostic</strong><span>Sẽ rotate một proxy và kiểm tra ba host bắt buộc.</span></div>;
  if (!preview) return null;
  return (
    <div className="preview-summary">
      <div><strong>{preview.accepted.length}</strong><span>account được nhận</span></div>
      <div><strong>{preview.rejected.length}</strong><span>account bị loại</span></div>
      {preview.phases.length > 1 && <div className="phase-list">{preview.phases.map((phase) => (
        <span key={phase.phaseId}>
          {phaseLabel(phase.phaseId, phase.workflowId)}: {phase.currentEligible}/{phase.maxAccounts}
          {phase.dynamic ? ' · tính lại khi bắt đầu pass' : ''}
        </span>
      ))}</div>}
      <div style={{ width: '100%', maxHeight: 'min(280px, 40vh)', overflowY: 'auto' }}>
        {preview.accepted.length > 0 && <details><summary>Xem chính xác {preview.accepted.length} account được nhận</summary>{preview.accepted.map((item) => <p key={item.rowIndex}>#{item.rowIndex} {item.email}</p>)}</details>}
        {preview.rejected.length > 0 && <details><summary>Xem đầy đủ {preview.rejected.length} account bị loại</summary>{preview.rejected.map((item) => <p key={item.rowIndex}>#{item.rowIndex} {item.email} — {item.reason}</p>)}</details>}
      </div>
    </div>
  );
}

function phaseLabel(phaseId: string, workflowId: WorkflowId): string {
  return ({
    signup: 'Signup',
    'resume-1': 'Resume pass 1',
    'reset-password': 'Reset password',
    'resume-2': 'Resume pass 2',
  } as Record<string, string>)[phaseId] || workflowId;
}

export function SecretValue({ rowIndex, field, label, present }: { rowIndex: number; field: string; label: string; present: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), 30_000);
    return () => clearTimeout(timer);
  }, [value]);

  const copy = async () => {
    if (value !== null) await navigator.clipboard.writeText(value);
  };
  const toggleReveal = async () => {
    if (value !== null) {
      setValue(null);
      return;
    }
    setRevealing(true);
    setRevealError(null);
    try {
      const response = await api.revealSecret(rowIndex, field);
      setValue(response.value);
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : 'Không thể reveal secret');
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div className="secret-row">
      <span>{label}</span>
      <code>{value !== null ? value : present ? '••••••••••••' : 'Chưa có'}</code>
      <div>
        <button className="icon-button" disabled={revealing || (!present && value === null)} onClick={() => void toggleReveal()} aria-label={`${value !== null ? 'Ẩn' : 'Hiện'} ${label}`}>
          {value !== null ? <EyeOff size={16} /> : revealing ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />}
        </button>
        <button className="icon-button" disabled={value === null} onClick={copy} aria-label={`Copy ${label}`}><Copy size={16} /></button>
      </div>
      {revealError && <small className="secret-error" role="alert">{revealError}</small>}
    </div>
  );
}
