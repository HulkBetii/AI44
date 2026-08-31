import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Eye, EyeOff, LoaderCircle, X } from 'lucide-react';
import type { JobPreview, JobPreviewRequest, JobRequest, WorkflowDefinition, WorkflowId } from '../shared/contracts';
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
  selection?: JobRequest['selection'];
}

export function JobComposer({
  state,
  workflows,
  workflowError,
  settingsError,
  settingsLoading,
  defaultInterval,
  creationDisabledReason,
  onClose,
  onCreated,
}: {
  state: ComposerState;
  workflows: WorkflowDefinition[];
  workflowError?: unknown;
  settingsError?: unknown;
  settingsLoading: boolean;
  defaultInterval: number;
  creationDisabledReason?: string;
  onClose(): void;
  onCreated(): void;
}) {
  const queryClient = useQueryClient();
  const [intervalMinutes, setIntervalMinutes] = useState(defaultInterval);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const creatingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const intervalEditedRef = useRef(false);
  const definition = workflows.find((workflow) => workflow.id === state.workflowId);
  const intervalSettingsReady = !definition?.usesInterval || (!settingsLoading && !settingsError);
  const selection = useMemo<JobRequest['selection']>(
    () => state.selection || { mode: 'allEligible' },
    [state.selection],
  );
  const previewRequest = useMemo<JobPreviewRequest>(() => ({
    workflowId: state.workflowId,
    selection,
    options: {
      intervalMinutes,
    },
  }), [state.workflowId, selection, intervalMinutes]);

  const preview = useQuery({
    queryKey: ['job-preview', previewRequest],
    queryFn: () => api.previewJob(previewRequest),
    enabled: Boolean(definition) && intervalSettingsReady,
    retry: false,
  });
  const invalidateOperationalData = () => {
    for (const queryKey of [['jobs'], ['health'], ['accounts'], ['settings']] as const) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const createJob = async () => {
    if (creatingRef.current || !definition || !intervalSettingsReady || creationDisabledReason) return;
    const request: JobRequest = {
      workflowId: state.workflowId,
      selection,
      options: {
        intervalMinutes,
      },
    };

    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      await api.createJob(request, controller.signal);
      if (controller.signal.aborted) return;
      onCreated();
      onClose();
    } catch (error) {
      if (!isAbortError(error) && mountedRef.current) setCreateError(error);
    } finally {
      invalidateOperationalData();
      creatingRef.current = false;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      if (mountedRef.current) setCreating(false);
    }
  };

  const isDiagnostic = state.workflowId === 'proxyCheck';
  const acceptedCount = preview.data?.accepted.length || 0;
  const canCreate = Boolean(
    definition
    && intervalSettingsReady
    && preview.data
    && !preview.error
    && !preview.isFetching
    && !creating
    && !creationDisabledReason
    && (isDiagnostic || acceptedCount > 0),
  );
  const close = () => {
    if (creatingRef.current) {
      abortControllerRef.current?.abort();
      invalidateOperationalData();
    }
    onClose();
  };

  useEffect(() => {
    if (!intervalEditedRef.current) setIntervalMinutes(defaultInterval);
  }, [defaultInterval]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  return (
    <Overlay backdropClassName="modal-backdrop" panelClassName="modal" labelledBy="composer-title" onClose={close}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">Tạo lượt chạy</span>
            <h2 id="composer-title">{definition?.label || state.workflowId}</h2>
            <p>{definition?.description}</p>
          </div>
          <button className="icon-button" onClick={close} aria-label={creating ? 'Dừng chờ và đóng' : 'Đóng'}><X size={18} /></button>
        </header>

        <div className="modal-body">
          {workflowError ? <ErrorState error={workflowError} /> : !definition ? <LoadingLine label="Đang tải workflow registry" /> : definition.usesInterval && settingsError ? <ErrorState error={settingsError} /> : definition.usesInterval && settingsLoading ? <LoadingLine label="Đang tải interval mặc định" /> : <>
          <div className="form-grid">
            {definition?.usesInterval && <label>
              <span>Interval trung bình (phút)</span>
              <input type="number" min="0.1" max="180" step="0.1" value={intervalMinutes} onChange={(event) => { intervalEditedRef.current = true; setIntervalMinutes(Number(event.target.value)); }} />
            </label>}
          </div>

          <PreviewPanel preview={preview.data} loading={preview.isFetching} error={preview.error} workflowId={state.workflowId} />
          {definition?.risk !== 'normal' && (
            <div className="warning-box"><AlertTriangle size={17} />Workflow này thay đổi credential hoặc trạng thái account. Backend sẽ kiểm tra eligibility lại trước khi chạy.</div>
          )}
          </>}
          {creationDisabledReason ? <div className="warning-box" role="status">{creationDisabledReason}</div> : null}
          {creating ? <div className="warning-box" role="status">Có thể đóng cửa sổ để dừng chờ. Việc này không hủy request trên server; hãy kiểm tra trang Lượt chạy trước khi thử lại.</div> : null}
          {createError ? <ErrorState error={createError} /> : null}
        </div>

        <footer className="modal-footer">
          <button className="button button-ghost" onClick={close}>{creating ? 'Dừng chờ và đóng' : 'Hủy'}</button>
          <button className="button button-primary" disabled={!canCreate} onClick={() => void createJob()}>
            {creating ? 'Đang thêm...' : `Thêm vào hàng đợi${acceptedCount ? ` · ${acceptedCount}` : ''}`}
          </button>
        </footer>
    </Overlay>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

export function SecretValue({ rowIndex, expectedEmail, field, label, present }: { rowIndex: number; expectedEmail: string; field: string; label: string; present: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const identity = `${rowIndex}\0${expectedEmail.trim().toLowerCase()}\0${field}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    setValue(null);
    setRevealError(null);
    setRevealing(false);
    setCopyState('idle');
    setCopyError(null);
  }, [identity]);

  useEffect(() => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    setCopyState('idle');
    setCopyError(null);
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), 30_000);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copy = async () => {
    if (value === null || copyState === 'copying') return;
    const requestedIdentity = identity;
    setCopyState('copying');
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(value);
      if (identityRef.current !== requestedIdentity) return;
      setCopyState('copied');
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        if (identityRef.current === requestedIdentity) setCopyState('idle');
      }, 2_000);
    } catch (error) {
      if (identityRef.current !== requestedIdentity) return;
      setCopyState('idle');
      setCopyError(error instanceof Error ? error.message : 'Không thể copy credential');
    }
  };
  const toggleReveal = async () => {
    if (value !== null) {
      setValue(null);
      return;
    }
    setRevealing(true);
    setRevealError(null);
    const requestedIdentity = identity;
    try {
      const response = await api.revealSecret(rowIndex, field, expectedEmail);
      if (identityRef.current !== requestedIdentity) return;
      setValue(response.value);
    } catch (error) {
      if (identityRef.current !== requestedIdentity) return;
      setRevealError(error instanceof Error ? error.message : 'Không thể reveal secret');
    } finally {
      if (identityRef.current === requestedIdentity) setRevealing(false);
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
        <button className="icon-button" disabled={value === null || copyState === 'copying'} onClick={() => void copy()} aria-label={`${copyState === 'copying' ? 'Đang copy' : copyState === 'copied' ? 'Đã copy' : 'Copy'} ${label}`}>{copyState === 'copying' ? <LoaderCircle className="spin" size={16} /> : copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}</button>
      </div>
      {copyState === 'copied' && <small className="secret-feedback" role="status">Đã copy</small>}
      {copyError && <small className="secret-error" role="alert">{copyError}</small>}
      {revealError && <small className="secret-error" role="alert">{revealError}</small>}
    </div>
  );
}
