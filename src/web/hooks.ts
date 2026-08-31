import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { JobEvent } from '../shared/contracts';

const JOB_EVENT_CHANNEL = 'job-event';
const REPLAY_END_CHANNEL = 'replay-end';

function soundEnabled(): boolean {
  return localStorage.getItem('mail-console-sound') !== 'off';
}

function notificationsEnabled(): boolean {
  return localStorage.getItem('mail-console-notifications') === 'on';
}

function playAttentionTone(): void {
  if (!soundEnabled()) return;
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.setValueAtTime(740, context.currentTime);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
  oscillator.connect(gain).connect(context.destination);
  oscillator.addEventListener('ended', () => {
    void context.close().catch(() => undefined);
  }, { once: true });
  oscillator.start();
  oscillator.stop(context.currentTime + 0.4);
}

export function useJobEvents(): void {
  const queryClient = useQueryClient();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const source = new EventSource('/api/events');
    let replaying = true;
    const replayInvalidations = {
      jobs: false,
      health: false,
      accounts: false,
      accountDetails: false,
      jobDetails: false,
      settings: false,
    };

    const beginReplay = () => {
      replaying = true;
    };

    const invalidate = (event: JobEvent, defer: boolean) => {
      if (event.type === 'log') return;

      const changesRuntimeState = ['job.state', 'attention.required', 'attention.cleared'].includes(event.type);
      const changesRuntimeDisplay = changesRuntimeState || ['step.changed', 'phase.started'].includes(event.type);
      const changesAccount = ['account.succeeded', 'account.failed'].includes(event.type);

      const targets = {
        jobs: true,
        health: changesRuntimeState,
        accounts: changesRuntimeDisplay || changesAccount,
        accountDetails: changesRuntimeDisplay || changesAccount,
        jobDetails: true,
        settings: event.type === 'job.state',
      };

      if (defer) {
        for (const key of Object.keys(targets) as Array<keyof typeof targets>) {
          replayInvalidations[key] ||= targets[key];
        }
        return;
      }

      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', event.jobId] });
      if (targets.health) void queryClient.invalidateQueries({ queryKey: ['health'] });
      if (targets.accounts) void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      if (targets.accountDetails) {
        void queryClient.invalidateQueries({
          queryKey: event.rowIndex ? ['account', event.rowIndex] : ['account'],
        });
      }
      if (targets.settings) void queryClient.invalidateQueries({ queryKey: ['settings'] });
    };

    const handleJobEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as JobEvent;
      if (seen.current.has(event.id)) return;
      seen.current.add(event.id);
      if (seen.current.size > 1_000) seen.current = new Set([...seen.current].slice(-500));

      invalidate(event, replaying);
      if (!replaying && event.type === 'attention.required') {
        playAttentionTone();
        if (notificationsEnabled() && Notification.permission === 'granted') {
          new Notification('Mail Automation cần thao tác', { body: event.message });
        }
      }
    };

    const finishReplay = () => {
      replaying = false;
      if (replayInvalidations.jobs) void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      if (replayInvalidations.jobDetails) void queryClient.invalidateQueries({ queryKey: ['job'] });
      if (replayInvalidations.health) void queryClient.invalidateQueries({ queryKey: ['health'] });
      if (replayInvalidations.accounts) void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      if (replayInvalidations.accountDetails) void queryClient.invalidateQueries({ queryKey: ['account'] });
      if (replayInvalidations.settings) void queryClient.invalidateQueries({ queryKey: ['settings'] });
      for (const key of Object.keys(replayInvalidations) as Array<keyof typeof replayInvalidations>) {
        replayInvalidations[key] = false;
      }
    };

    source.addEventListener(JOB_EVENT_CHANNEL, handleJobEvent as EventListener);
    source.addEventListener(REPLAY_END_CHANNEL, finishReplay);
    source.addEventListener('open', beginReplay);
    return () => {
      source.removeEventListener(JOB_EVENT_CHANNEL, handleJobEvent as EventListener);
      source.removeEventListener(REPLAY_END_CHANNEL, finishReplay);
      source.removeEventListener('open', beginReplay);
      source.close();
    };
  }, [queryClient]);
}
