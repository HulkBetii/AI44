import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle2, Database, Network, RadioTower, Save, Volume2 } from 'lucide-react';
import {
  type PublicRuntimeSettings,
  type RuntimeSettings,
  type SecretSettingKey,
  type SettingsUpdateRequest,
} from '../../shared/contracts';
import { api } from '../api';
import { ErrorState, LoadingLine } from '../components';

const ENV_OVERRIDE_MESSAGE = 'Được override bằng environment variable';
const JOB_LOCK_MESSAGE = 'Cấu hình bị khóa trong khi còn job active hoặc queued';
const SECRET_FIELDS: Array<{ key: SecretSettingKey; label: string }> = [
  { key: 'proxyApiKey', label: 'Proxy API Key' },
  { key: 'capsolverApiKey', label: 'CapSolver API Key' },
  { key: 'capbypassApiKey', label: 'CapBypass API Key' },
  { key: 'twoCaptchaApiKey', label: '2Captcha API Key' },
  { key: 'nonecapApiKey', label: 'NoneCap API Key' },
];

type SecretDrafts = Record<SecretSettingKey, { value: string; clear: boolean }>;

export function SettingsPage({ jobCreationDisabledReason, onProxyCheck }: { jobCreationDisabledReason?: string; onProxyCheck(): void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, refetchInterval: 5_000 });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 5_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 5_000 });
  const [form, setForm] = useState<PublicRuntimeSettings | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>(createSecretDrafts);
  const [sound, setSound] = useState(() => localStorage.getItem('mail-console-sound') !== 'off');
  const [notifications, setNotifications] = useState(() => localStorage.getItem('mail-console-notifications') === 'on');
  const hydratedRef = useRef(false);
  const pendingSaveRef = useRef<SettingsUpdateRequest | null>(null);
  const sheetsDiagnostic = useMutation({ mutationFn: api.diagnoseSheets });
  const gpmDiagnostic = useMutation({ mutationFn: api.diagnoseGpm });
  const save = useMutation({
    mutationFn: () => {
      const request = pendingSaveRef.current;
      if (!request) throw new Error('Không có cấu hình chờ lưu');
      return api.saveSettings(request);
    },
    onSuccess: (response) => {
      sheetsDiagnostic.reset();
      gpmDiagnostic.reset();
      setForm(response.values);
      setSecretDrafts(createSecretDrafts());
      queryClient.setQueryData(['settings'], response);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['account'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
    onSettled: () => { pendingSaveRef.current = null; },
  });
  const blockingJobs = jobs.data?.filter((job) => ['queued', 'running', 'needs_attention', 'cancelling'].includes(job.status)) || [];
  const jobLockKey = jobs.data ? blockingJobs.map((job) => `${job.id}:${job.status}`).join('|') : undefined;
  const lockReason = jobs.isLoading
    ? 'Đang kiểm tra hàng đợi trước khi mở khóa cấu hình'
    : jobs.error
      ? 'Không thể xác minh hàng đợi; cấu hình được khóa an toàn'
      : blockingJobs.length > 0
        ? JOB_LOCK_MESSAGE
        : health.isLoading
          ? 'Đang kiểm tra automation lock trước khi mở khóa cấu hình'
          : health.error
            ? 'Không thể xác minh automation lock; cấu hình được khóa an toàn'
            : health.data?.workerLock !== 'free'
              ? `Automation lock đang ${health.data?.workerLock || 'không xác định'}; cấu hình được khóa an toàn`
              : jobCreationDisabledReason
                ? jobCreationDisabledReason.replace(/\.$/, '')
                : settings.error
                  ? 'Không thể xác minh quyền sửa cấu hình; cấu hình được khóa an toàn'
                  : 'Server đang xử lý queue, recovery hoặc maintenance; cấu hình tạm khóa';
  const canEdit = Boolean(settings.data?.canEdit)
    && !settings.error
    && !jobs.isLoading
    && !jobs.error
    && Boolean(jobs.data)
    && blockingJobs.length === 0
    && !health.isLoading
    && !health.error
    && health.data?.workerLock === 'free'
    && !jobCreationDisabledReason;

  useEffect(() => {
    if (!settings.data || hydratedRef.current) return;
    hydratedRef.current = true;
    setForm(settings.data.values);
    setSecretDrafts(createSecretDrafts());
  }, [settings.data]);
  useEffect(() => {
    if (jobLockKey !== undefined) void queryClient.invalidateQueries({ queryKey: ['settings'] });
  }, [jobLockKey, queryClient]);
  const update = <K extends keyof PublicRuntimeSettings>(key: K, value: PublicRuntimeSettings[K]) => setForm((current) => current ? { ...current, [key]: value } : current);
  const updateSecret = (key: SecretSettingKey, value: string) => setSecretDrafts((current) => ({
    ...current,
    [key]: { value, clear: false },
  }));
  const toggleSecretClear = (key: SecretSettingKey) => setSecretDrafts((current) => ({
    ...current,
    [key]: { value: '', clear: !current[key].clear },
  }));
  const disabledReasonFor = (key: keyof RuntimeSettings) => settings.data?.envOverrides.includes(key)
    ? ENV_OVERRIDE_MESSAGE
    : canEdit ? undefined : lockReason;
  const requestNotifications = async (checked: boolean) => {
    if (checked && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      checked = permission === 'granted';
    }
    setNotifications(checked);
    localStorage.setItem('mail-console-notifications', checked ? 'on' : 'off');
  };
  const saveSettings = () => {
    if (!form || save.isPending || !canEdit) return;
    pendingSaveRef.current = buildSettingsUpdate(form, secretDrafts);
    save.mutate();
  };
  const settingsData = settings.data;

  return (
    <div className="page-stack page-enter">
      <header className="page-heading"><div><span className="eyebrow">Local runtime</span><h1>Cấu hình</h1><p>Cấu hình server được lưu local; giá trị override bằng environment sẽ bị khóa.</p></div></header>
      {!settingsData && settings.error ? <ErrorState error={settings.error} /> : (settings.isLoading && !settingsData) || !form || !settingsData ? <LoadingLine /> : <>
        {settings.error && <ErrorState error={settings.error} />}
        <section className="settings-section">
          <div className="section-heading"><div><span className="eyebrow">Server-side</span><h2>Kết nối hệ thống</h2></div><button className="button button-primary" disabled={!canEdit || save.isPending} onClick={saveSettings}><Save size={16} />{save.isPending ? 'Đang lưu...' : 'Lưu cấu hình'}</button></div>
          {!canEdit && <div className="warning-box">{lockReason}.</div>}
          {jobs.error && <ErrorState error={jobs.error} />}
          <div className="settings-grid">
            <SettingField label="Google Sheet ID" value={form.sheetId} disabledReason={disabledReasonFor('sheetId')} onChange={(value) => update('sheetId', value)} />
            <SettingField label="Sheet name" value={form.sheetName} disabledReason={disabledReasonFor('sheetName')} onChange={(value) => update('sheetName', value)} />
            <SettingField label="Service account path" value={form.serviceAccountPath} wide disabledReason={disabledReasonFor('serviceAccountPath')} onChange={(value) => update('serviceAccountPath', value)} />
            <SettingField label="GPM API base URL" value={form.gpmApiBase} disabledReason={disabledReasonFor('gpmApiBase')} onChange={(value) => update('gpmApiBase', value)} />
            <SettingField label="Interval mặc định" value={String(form.defaultIntervalMinutes)} type="number" disabledReason={disabledReasonFor('defaultIntervalMinutes')} onChange={(value) => update('defaultIntervalMinutes', Number(value))} />
            <SettingField label="Runtime directory" value={form.runtimeDirectory} wide disabledReason={disabledReasonFor('runtimeDirectory')} onChange={(value) => update('runtimeDirectory', value)} />

            <label>
              <span>Nguồn Proxy</span>
              <select
                value={form.proxyProvider || 'none'}
                disabled={Boolean(disabledReasonFor('proxyProvider'))}
                onChange={(event) => update('proxyProvider', event.target.value as PublicRuntimeSettings['proxyProvider'])}
              >
                <option value="none">Không dùng proxy</option>
                <option value="tinproxy">TinProxy</option>
                <option value="sp07">SP07</option>
              </select>
              {disabledReasonFor('proxyProvider') && <small>{disabledReasonFor('proxyProvider')}</small>}
            </label>
            {SECRET_FIELDS.map(({ key, label }) => (
              <SecretSettingField
                key={key}
                field={key}
                label={label}
                draft={secretDrafts[key]}
                configured={settingsData.configuredSecrets.includes(key)}
                disabledReason={disabledReasonFor(key)}
                onChange={(value) => updateSecret(key, value)}
                onToggleClear={() => toggleSecretClear(key)}
              />
            ))}
          </div>
          {save.error && <ErrorState error={save.error} />}
        </section>

        <section className="settings-section">
          <div className="section-heading"><div><span className="eyebrow">Diagnostics</span><h2>Kiểm tra kết nối</h2></div></div>
          <div className="diagnostic-grid">
            <button disabled={sheetsDiagnostic.isPending} onClick={() => sheetsDiagnostic.mutate()}><Database size={20} /><div><strong>Google Sheet</strong><small>Đọc credential và đếm data row</small></div>{sheetsDiagnostic.isPending ? <span>Đang kiểm tra...</span> : sheetsDiagnostic.data ? <span className="diagnostic-ok"><CheckCircle2 size={16} />{sheetsDiagnostic.data.rowCount} rows</span> : <span>Chạy kiểm tra</span>}</button>
            <button disabled={gpmDiagnostic.isPending} onClick={() => gpmDiagnostic.mutate()}><RadioTower size={20} /><div><strong>GPM API</strong><small>Kiểm tra TCP, không tạo profile</small></div>{gpmDiagnostic.isPending ? <span>Đang kiểm tra...</span> : gpmDiagnostic.data ? <span className="diagnostic-ok"><CheckCircle2 size={16} />Ready</span> : <span>Chạy kiểm tra</span>}</button>
            <button disabled={Boolean(jobCreationDisabledReason)} title={jobCreationDisabledReason} onClick={onProxyCheck}><Network size={20} /><div><strong>Proxy route</strong><small>Rotate proxy và kiểm tra ba host bắt buộc</small></div><span>Tạo diagnostic job</span></button>
          </div>
          {jobCreationDisabledReason && <p className="action-disabled-reason" role="status">{jobCreationDisabledReason}</p>}
          {sheetsDiagnostic.error && <ErrorState error={sheetsDiagnostic.error} />}
          {gpmDiagnostic.error && <ErrorState error={gpmDiagnostic.error} />}
        </section>

        <section className="settings-section">
          <div className="section-heading"><div><span className="eyebrow">Browser-local</span><h2>Thông báo</h2></div></div>
          <div className="toggle-list">
            <label><span><Volume2 size={18} /><span><strong>Âm báo CAPTCHA</strong><small>Phát tone khi job chuyển sang Needs attention</small></span></span><input type="checkbox" checked={sound} onChange={(event) => { setSound(event.target.checked); localStorage.setItem('mail-console-sound', event.target.checked ? 'on' : 'off'); }} /></label>
            <label><span><Bell size={18} /><span><strong>Desktop notification</strong><small>Hiển thị thông báo hệ thống khi tab ở background</small></span></span><input type="checkbox" checked={notifications} onChange={(event) => void requestNotifications(event.target.checked)} /></label>
          </div>
        </section>
      </>}
    </div>
  );
}

function SettingField({ label, value, disabledReason, onChange, wide = false, type = 'text' }: { label: string; value: string; disabledReason?: string; onChange(value: string): void; wide?: boolean; type?: string }) {
  return <label className={wide ? 'field-wide' : ''}><span>{label}</span><input type={type} value={value} disabled={Boolean(disabledReason)} onChange={(event) => onChange(event.target.value)} />{disabledReason && <small>{disabledReason}</small>}</label>;
}

function SecretSettingField({ field, label, draft, configured, disabledReason, onChange, onToggleClear }: { field: SecretSettingKey; label: string; draft: SecretDrafts[SecretSettingKey]; configured: boolean; disabledReason?: string; onChange(value: string): void; onToggleClear(): void }) {
  const helper = disabledReason
    || (draft.clear
      ? 'Sẽ xóa khi lưu'
      : draft.value.trim()
        ? 'Key mới sẽ thay thế khi lưu'
        : configured ? 'Đã cấu hình — để trống để giữ nguyên' : 'Chưa cấu hình');

  return (
    <div className="secret-setting">
      <label>
        <span>{label}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.value}
          disabled={Boolean(disabledReason) || draft.clear}
          placeholder={configured ? 'Đã cấu hình' : 'Nhập API key'}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="secret-setting-meta">
        <small>{helper}</small>
        {configured && !disabledReason && <button type="button" className="button button-compact button-ghost" aria-label={draft.clear ? `Hoàn tác xóa ${label}` : `Xóa ${label}`} onClick={onToggleClear}>{draft.clear ? 'Hoàn tác' : `Xóa ${field === 'proxyApiKey' ? 'proxy key' : 'key'}`}</button>}
      </div>
    </div>
  );
}

function createSecretDrafts(): SecretDrafts {
  return Object.fromEntries(SECRET_FIELDS.map(({ key }) => [key, { value: '', clear: false }])) as SecretDrafts;
}

function buildSettingsUpdate(values: PublicRuntimeSettings, drafts: SecretDrafts): SettingsUpdateRequest {
  const secrets: SettingsUpdateRequest['secrets'] = {};
  for (const { key } of SECRET_FIELDS) {
    const draft = drafts[key];
    if (draft.clear) secrets[key] = null;
    else if (draft.value.trim()) secrets[key] = draft.value.trim();
  }
  return Object.keys(secrets).length ? { ...values, secrets } : { ...values };
}
