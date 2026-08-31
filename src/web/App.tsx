import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, AlertTriangle, Database, Gauge, ListChecks, PanelLeft, Settings, Users, X } from 'lucide-react';
import type { JobRequest, RecoveryEntrySummary, RecoveryResponse, WorkflowId } from '../shared/contracts';
import { api } from './api';
import { type ComposerState, ErrorState, JobComposer, StatusPill } from './components';
import { useJobEvents } from './hooks';
import { AccountsPage } from './pages/AccountsPage';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';

const NAVIGATION = [
  { to: '/dashboard', label: 'Tổng quan', icon: Gauge },
  { to: '/accounts', label: 'Tài khoản', icon: Users },
  { to: '/jobs', label: 'Lượt chạy', icon: ListChecks },
  { to: '/settings', label: 'Cấu hình', icon: Settings },
];

const MOBILE_NAV_QUERY = '(max-width: 768px)';
const JOB_DRAWER_QUERY = '(max-width: 1100px)';

export function App() {
  useJobEvents();
  const queryClient = useQueryClient();
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(() => matchesMedia(MOBILE_NAV_QUERY));
  const [useJobDrawer, setUseJobDrawer] = useState(() => matchesMedia(JOB_DRAWER_QUERY));
  const firstMobileNavLinkRef = useRef<HTMLAnchorElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavWasOpen = useRef(false);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 10_000 });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: api.workflows });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 10_000 });
  const recovery = useQuery({ queryKey: ['recovery'], queryFn: api.recovery, refetchInterval: 10_000 });
  const activeJob = useMemo(() => jobs.data?.find((job) => ['running', 'needs_attention', 'cancelling'].includes(job.status)) || null, [jobs.data]);
  const preparedRecoveries = recovery.data?.entries.filter((entry) => entry.state === 'prepared') || [];
  const blockingJobs = jobs.data?.filter((job) => ['queued', 'running', 'needs_attention', 'cancelling'].includes(job.status)) || [];
  const ownsBusyWorkerLock = health.data?.workerLock === 'busy'
    && Boolean(activeJob)
    && health.data.activeJobId === activeJob?.id;
  const jobCreationDisabledReason = jobs.isLoading
    ? 'Đang kiểm tra trạng thái worker trước khi cho phép tạo job.'
    : jobs.error
      ? 'Không thể xác minh trạng thái worker; tạm khóa việc tạo job.'
      : health.isLoading
        ? 'Đang kiểm tra automation lock trước khi cho phép tạo job.'
        : health.error
          ? 'Không thể xác minh automation lock; tạm khóa việc tạo job.'
          : health.data?.workerLock !== 'free' && !ownsBusyWorkerLock
            ? `Automation lock đang ${health.data?.workerLock || 'không xác định'}; chưa thể tạo job.`
            : recovery.isLoading
              ? 'Đang kiểm tra recovery journal trước khi cho phép tạo job.'
              : recovery.error
                ? 'Không thể xác minh recovery journal; tạm khóa việc tạo job.'
                : preparedRecoveries.length > 0
                  ? `Có ${preparedRecoveries.length} recovery chưa xác nhận; xử lý hoặc loại bỏ trước khi tạo job mới.`
                  : undefined;
  const recoveryActionDisabledReason = jobs.isLoading
    ? 'Đang kiểm tra trạng thái job trước khi cho phép xử lý recovery.'
    : jobs.error
      ? 'Không thể xác minh trạng thái job; tạm khóa thao tác recovery.'
      : blockingJobs.length > 0
        ? 'Chờ job active hoặc queued kết thúc trước khi xử lý recovery.'
        : health.isLoading
          ? 'Đang kiểm tra automation lock trước khi cho phép xử lý recovery.'
          : health.error
            ? 'Không thể xác minh automation lock; tạm khóa thao tác recovery.'
            : health.data?.workerLock !== 'free'
              ? `Automation lock đang ${health.data?.workerLock || 'không xác định'}; chưa thể xử lý recovery.`
              : undefined;
  const focus = useMutation({
    mutationFn: (jobId: string) => api.focusJob(jobId),
    onMutate: () => setFocusMessage(null),
    onSuccess: (result) => setFocusMessage(result.focused ? null : 'Browser không còn hoạt động để đưa ra trước.'),
    onError: (error) => setFocusMessage(error instanceof Error ? error.message : 'Không thể mở cửa sổ CAPTCHA.'),
  });
  const refreshRecoveryData = (response: RecoveryResponse) => {
    queryClient.setQueryData(['recovery'], response);
    for (const queryKey of [['recovery'], ['health'], ['accounts'], ['account'], ['settings']] as const) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const syncRecovery = useMutation({ mutationFn: api.syncRecovery, onSuccess: refreshRecoveryData });
  const discardRecovery = useMutation({ mutationFn: api.discardRecovery, onSuccess: refreshRecoveryData });
  const activeRecoveryAction = syncRecovery.isPending && syncRecovery.variables
    ? { entryId: syncRecovery.variables, action: 'sync' as const }
    : discardRecovery.isPending && discardRecovery.variables
      ? { entryId: discardRecovery.variables, action: 'discard' as const }
      : null;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mobileQuery = window.matchMedia(MOBILE_NAV_QUERY);
    const drawerQuery = window.matchMedia(JOB_DRAWER_QUERY);
    const updateViewport = () => {
      setIsMobile(mobileQuery.matches);
      setUseJobDrawer(drawerQuery.matches);
    };
    updateViewport();
    mobileQuery.addEventListener('change', updateViewport);
    drawerQuery.addEventListener('change', updateViewport);
    return () => {
      mobileQuery.removeEventListener('change', updateViewport);
      drawerQuery.removeEventListener('change', updateViewport);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) {
      mobileNavWasOpen.current = false;
      setMobileNav(false);
      return;
    }
    const focusTarget = mobileNav ? firstMobileNavLinkRef.current : mobileNavWasOpen.current ? mobileMenuButtonRef.current : null;
    mobileNavWasOpen.current = mobileNav;
    if (!focusTarget) return;
    const timer = window.setTimeout(() => focusTarget.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isMobile, mobileNav]);

  useEffect(() => {
    if (!isMobile || !mobileNav) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isMobile, mobileNav]);

  useEffect(() => setFocusMessage(null), [activeJob?.id, activeJob?.status]);

  const openComposer = (
    workflowId: WorkflowId,
    selection: JobRequest['selection'] = { mode: 'allEligible' },
  ) => {
    if (jobCreationDisabledReason) return;
    setComposer({ workflowId, selection });
  };
  const confirmDiscard = (entry: RecoveryEntrySummary) => {
    const confirmed = window.confirm(`Loại bỏ recovery cho ${entry.email}? Hành động này không thể hoàn tác.`);
    if (confirmed) discardRecovery.mutate(entry.id);
  };

  return (
    <BrowserRouter>
      <div className="app-shell">
        <aside id="primary-sidebar" className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`} aria-hidden={isMobile && !mobileNav ? true : undefined} inert={isMobile && !mobileNav} onKeyDown={(event) => event.key === 'Escape' && setMobileNav(false)}>
          <div className="brand">
            <span className="brand-mark"><Activity size={19} /></span>
            <div><strong>MAIL OPS</strong><small>operator console</small></div>
          </div>
          <nav aria-label="Điều hướng chính">
            {NAVIGATION.map(({ to, label, icon: Icon }, index) => (
              <NavLink ref={index === 0 ? firstMobileNavLinkRef : undefined} key={to} to={to} onClick={() => setMobileNav(false)} className={({ isActive }) => isActive ? 'nav-link nav-link-active' : 'nav-link'}>
                <Icon size={17} aria-hidden="true" /><span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot"><span className="signal-dot signal-ready" /><span>127.0.0.1</span></div>
        </aside>

        <main className="main-shell">
          <header className="topbar">
            <button ref={mobileMenuButtonRef} className="mobile-menu" onClick={() => setMobileNav((value) => !value)} aria-label={mobileNav ? 'Đóng menu' : 'Mở menu'} aria-expanded={mobileNav} aria-controls="primary-sidebar"><PanelLeft size={19} aria-hidden="true" /></button>
            <div className="health-strip">
              <HealthItem icon={Database} label="Sheet" value={health.isLoading ? 'unchecked' : health.data?.sheets || 'unavailable'} />
              <HealthItem icon={Activity} label="GPM" value={health.isLoading ? 'unchecked' : health.data?.gpm || 'unavailable'} />
              <HealthItem icon={ListChecks} label="Worker" value={health.isLoading ? 'unchecked' : health.data?.workerLock || 'unavailable'} />
            </div>
            {activeJob ? <div className="topbar-job"><StatusPill status={activeJob.status} /><span>#{activeJob.id.slice(0, 8)}</span></div> : <span className="topbar-idle">{jobs.isLoading ? 'Đang kiểm tra worker' : jobs.error ? 'Không đọc được worker' : 'Worker sẵn sàng'}</span>}
          </header>

          {activeJob?.status === 'needs_attention' && (
            <div className="attention-bar" role="alert" aria-hidden={isMobile && mobileNav ? true : undefined} inert={isMobile && mobileNav}>
              <AlertTriangle size={19} />
              <div><strong>Cần xử lý CAPTCHA</strong><span>{activeJob.lastMessage}</span></div>
              {focusMessage && <span className="attention-feedback" role="alert">{focusMessage}</span>}
              <button className="button button-attention" disabled={focus.isPending} onClick={() => focus.mutate(activeJob.id)}>{focus.isPending ? 'Đang mở...' : 'Mở cửa sổ CAPTCHA'}</button>
            </div>
          )}

          {(recovery.isLoading || recovery.error || recovery.data?.entries.length) ? (
            <RecoveryBanner
              entries={recovery.data?.entries || []}
              loading={recovery.isLoading}
              error={recovery.error}
              activeAction={activeRecoveryAction}
              actionError={syncRecovery.error || discardRecovery.error}
              actionDisabledReason={recoveryActionDisabledReason}
              onSync={(id) => syncRecovery.mutate(id)}
              onDiscard={confirmDiscard}
              hidden={isMobile && mobileNav}
            />
          ) : null}

          {workflows.error ? <ErrorState error={workflows.error} /> : null}

          <div className="page-frame" aria-hidden={isMobile && mobileNav ? true : undefined} inert={isMobile && mobileNav}>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage jobCreationDisabledReason={jobCreationDisabledReason} onCreateJob={openComposer} />} />
              <Route path="/accounts" element={<AccountsPage jobCreationDisabledReason={jobCreationDisabledReason} onCreateJob={openComposer} />} />
              <Route path="/jobs" element={<JobsPage useDrawer={useJobDrawer} jobCreationDisabledReason={jobCreationDisabledReason} onRetry={openComposer} />} />
              <Route path="/settings" element={<SettingsPage jobCreationDisabledReason={jobCreationDisabledReason} onProxyCheck={() => openComposer('proxyCheck')} />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>
        </main>

        <nav className="bottom-nav" aria-label="Điều hướng di động" aria-hidden={isMobile && mobileNav ? true : undefined} inert={isMobile && mobileNav}>
          {NAVIGATION.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className={({ isActive }) => isActive ? 'bottom-link bottom-link-active' : 'bottom-link'}><Icon size={18} aria-hidden="true" /><span>{label}</span></NavLink>)}
        </nav>

        {composer && (
          <JobComposer
            state={composer}
            workflows={workflows.data || []}
            workflowError={workflows.error}
            settingsError={settings.error}
            settingsLoading={settings.isLoading}
            defaultInterval={settings.data?.values.defaultIntervalMinutes ?? 1}
            creationDisabledReason={jobCreationDisabledReason}
            onClose={() => setComposer(null)}
            onCreated={() => {
              void queryClient.invalidateQueries({ queryKey: ['jobs'] });
              void queryClient.invalidateQueries({ queryKey: ['health'] });
            }}
          />
        )}
        {mobileNav && <button className="nav-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMobileNav(false)}><X aria-hidden="true" /></button>}
      </div>
    </BrowserRouter>
  );
}

function RecoveryBanner({ entries, loading, error, activeAction, actionError, actionDisabledReason, onSync, onDiscard, hidden }: {
  entries: RecoveryEntrySummary[];
  loading: boolean;
  error: unknown;
  activeAction: { entryId: string; action: 'sync' | 'discard' } | null;
  actionError: unknown;
  actionDisabledReason?: string;
  onSync(id: string): void;
  onDiscard(entry: RecoveryEntrySummary): void;
  hidden: boolean;
}) {
  return (
    <section className="recovery-banner" role="alert" aria-hidden={hidden || undefined} inert={hidden}>
      <AlertTriangle size={20} aria-hidden="true" />
      <div className="recovery-banner-content">
        <strong>{loading ? 'Đang kiểm tra recovery journal' : error ? 'Không đọc được recovery journal' : `${entries.length} recovery cần xử lý`}</strong>
        {error ? <ErrorState error={error} /> : entries.map((entry) => (
          <div className="recovery-entry" key={entry.id}>
            <span><b>{entry.email}</b><small>{entry.state === 'prepared' ? 'Chưa xác nhận ghi Sheet — đang khóa job mới' : 'Đã xác nhận thao tác — có thể đồng bộ lại Sheet'}</small></span>
            <div>
              <button className="button button-primary button-compact" disabled={Boolean(activeAction) || Boolean(actionDisabledReason)} title={actionDisabledReason} onClick={() => onSync(entry.id)}>{activeAction?.entryId === entry.id && activeAction.action === 'sync' ? 'Đang đồng bộ...' : 'Đồng bộ'}</button>
              <button className="button button-danger-ghost button-compact" disabled={Boolean(activeAction) || Boolean(actionDisabledReason)} title={actionDisabledReason} onClick={() => onDiscard(entry)}>{activeAction?.entryId === entry.id && activeAction.action === 'discard' ? 'Đang loại bỏ...' : 'Loại bỏ'}</button>
            </div>
          </div>
        ))}
        {actionDisabledReason && entries.length > 0 ? <p className="action-disabled-reason" role="status">{actionDisabledReason}</p> : null}
        {actionError ? <ErrorState error={actionError} /> : null}
      </div>
    </section>
  );
}

function HealthItem({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  const ready = ['ready', 'free'].includes(value);
  const checking = value === 'unchecked';
  const displayValue = checking ? 'Đang kiểm tra' : value;
  return <span className="health-item" aria-label={`${label}: ${displayValue}`} title={`${label}: ${displayValue}`}><Icon size={14} aria-hidden="true" /><i aria-hidden="true" className={`signal-dot ${checking ? 'signal-neutral' : ready ? 'signal-ready' : 'signal-warning'}`} /><b aria-hidden="true">{label}</b><em aria-hidden="true">{displayValue}</em></span>;
}

function matchesMedia(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}
