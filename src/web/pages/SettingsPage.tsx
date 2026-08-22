import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle2, Database, Network, RadioTower, Save, Volume2 } from 'lucide-react';
import type { RuntimeSettings } from '../../shared/contracts';
import { api } from '../api';
import { ErrorState, LoadingLine } from '../components';

export function SettingsPage({ onProxyCheck }: { onProxyCheck(): void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 5_000 });
  const [form, setForm] = useState<RuntimeSettings | null>(null);
  const [sound, setSound] = useState(() => localStorage.getItem('mail-console-sound') !== 'off');
  const [notifications, setNotifications] = useState(() => localStorage.getItem('mail-console-notifications') === 'on');
  const sheetsDiagnostic = useMutation({ mutationFn: api.diagnoseSheets });
  const gpmDiagnostic = useMutation({ mutationFn: api.diagnoseGpm });
  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: () => {
      sheetsDiagnostic.reset();
      gpmDiagnostic.reset();
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['account'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });
  const blockingJobs = jobs.data?.filter((job) => ['queued', 'running', 'needs_attention', 'cancelling'].includes(job.status)) || [];
  const jobLockKey = jobs.data ? blockingJobs.map((job) => `${job.id}:${job.status}`).join('|') : undefined;
  const canEdit = Boolean(settings.data?.canEdit) && Boolean(jobs.data) && blockingJobs.length === 0;

  useEffect(() => { if (settings.data) setForm(settings.data.values); }, [settings.data]);
  useEffect(() => {
    if (jobLockKey !== undefined) void queryClient.invalidateQueries({ queryKey: ['settings'] });
  }, [jobLockKey, queryClient]);
  const update = <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => setForm((current) => current ? { ...current, [key]: value } : current);
  const requestNotifications = async (checked: boolean) => {
    if (checked && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      checked = permission === 'granted';
    }
    setNotifications(checked);
    localStorage.setItem('mail-console-notifications', checked ? 'on' : 'off');
  };

  return (
    <div className="page-stack page-enter">
      <header className="page-heading"><div><span className="eyebrow">Local runtime</span><h1>Cấu hình</h1><p>Cấu hình server được lưu local; giá trị override bằng environment sẽ bị khóa.</p></div></header>
      {settings.error ? <ErrorState error={settings.error} /> : settings.isLoading || !form ? <LoadingLine /> : <>
        <section className="settings-section">
          <div className="section-heading"><div><span className="eyebrow">Server-side</span><h2>Kết nối hệ thống</h2></div><button className="button button-primary" disabled={!canEdit || save.isPending} onClick={() => save.mutate(form)}><Save size={16} />{save.isPending ? 'Đang lưu...' : 'Lưu cấu hình'}</button></div>
          {!canEdit && <div className="warning-box">{jobs.isLoading
            ? 'Đang kiểm tra hàng đợi trước khi mở khóa cấu hình.'
            : jobs.error
              ? 'Không thể xác minh hàng đợi; cấu hình được khóa an toàn.'
              : 'Cấu hình bị khóa trong khi còn job active hoặc queued.'}</div>}
          {jobs.error && <ErrorState error={jobs.error} />}
          <div className="settings-grid">
            <SettingField label="Google Sheet ID" value={form.sheetId} disabled={!canEdit || settings.data.envOverrides.includes('sheetId')} envOverride={settings.data.envOverrides.includes('sheetId')} onChange={(value) => update('sheetId', value)} />
            <SettingField label="Sheet name" value={form.sheetName} disabled={!canEdit || settings.data.envOverrides.includes('sheetName')} envOverride={settings.data.envOverrides.includes('sheetName')} onChange={(value) => update('sheetName', value)} />
            <SettingField label="Service account path" value={form.serviceAccountPath} wide disabled={!canEdit || settings.data.envOverrides.includes('serviceAccountPath')} envOverride={settings.data.envOverrides.includes('serviceAccountPath')} onChange={(value) => update('serviceAccountPath', value)} />
            <SettingField label="GPM API base URL" value={form.gpmApiBase} disabled={!canEdit || settings.data.envOverrides.includes('gpmApiBase')} envOverride={settings.data.envOverrides.includes('gpmApiBase')} onChange={(value) => update('gpmApiBase', value)} />
            <SettingField label="Interval mặc định" value={String(form.defaultIntervalMinutes)} type="number" disabled={!canEdit || settings.data.envOverrides.includes('defaultIntervalMinutes')} envOverride={settings.data.envOverrides.includes('defaultIntervalMinutes')} onChange={(value) => update('defaultIntervalMinutes', Number(value))} />
            <SettingField label="Runtime directory" value={form.runtimeDirectory} wide disabled={!canEdit || settings.data.envOverrides.includes('runtimeDirectory')} envOverride={settings.data.envOverrides.includes('runtimeDirectory')} onChange={(value) => update('runtimeDirectory', value)} />
          </div>
          {save.error && <ErrorState error={save.error} />}
        </section>

        <section className="settings-section">
          <div className="section-heading"><div><span className="eyebrow">Diagnostics</span><h2>Kiểm tra kết nối</h2></div></div>
          <div className="diagnostic-grid">
            <button disabled={sheetsDiagnostic.isPending} onClick={() => sheetsDiagnostic.mutate()}><Database size={20} /><div><strong>Google Sheet</strong><small>Đọc credential và đếm data row</small></div>{sheetsDiagnostic.isPending ? <span>Đang kiểm tra...</span> : sheetsDiagnostic.data ? <span className="diagnostic-ok"><CheckCircle2 size={16} />{sheetsDiagnostic.data.rowCount} rows</span> : <span>Chạy kiểm tra</span>}</button>
            <button disabled={gpmDiagnostic.isPending} onClick={() => gpmDiagnostic.mutate()}><RadioTower size={20} /><div><strong>GPM API</strong><small>Kiểm tra TCP, không tạo profile</small></div>{gpmDiagnostic.isPending ? <span>Đang kiểm tra...</span> : gpmDiagnostic.data ? <span className="diagnostic-ok"><CheckCircle2 size={16} />Ready</span> : <span>Chạy kiểm tra</span>}</button>
            <button onClick={onProxyCheck}><Network size={20} /><div><strong>Proxy route</strong><small>Rotate proxy và kiểm tra ba host bắt buộc</small></div><span>Tạo diagnostic job</span></button>
          </div>
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

function SettingField({ label, value, disabled, envOverride, onChange, wide = false, type = 'text' }: { label: string; value: string; disabled: boolean; envOverride: boolean; onChange(value: string): void; wide?: boolean; type?: string }) {
  return <label className={wide ? 'field-wide' : ''}><span>{label}</span><input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />{disabled && <small>{envOverride ? 'Được override bằng environment variable' : 'Đang khóa vì còn job active hoặc queued'}</small>}</label>;
}
