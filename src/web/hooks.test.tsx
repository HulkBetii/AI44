// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '../shared/contracts';
import { useJobEvents } from './hooks';

class EventSourceStub extends EventTarget {
  static instance: EventSourceStub;

  constructor(public readonly url: string) {
    super();
    EventSourceStub.instance = this;
  }

  close = vi.fn();

  emit(type: string, event: JobEvent | Record<string, never> = {}) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event) }));
  }
}

function Harness({ children }: { children?: ReactNode }) {
  useJobEvents();
  return children;
}

function event(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    id: 'event-1',
    jobId: 'job-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    level: 'warning',
    type: 'attention.required',
    rowIndex: 2,
    message: 'Solve CAPTCHA',
    ...overrides,
  };
}

describe('job event stream', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem('mail-console-sound', 'off');
    localStorage.setItem('mail-console-notifications', 'on');
    vi.stubGlobal('EventSource', EventSourceStub);
  });

  it('refreshes replayed state once without notifying for historical attention', () => {
    const notify = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notify, { permission: 'granted' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('job-event', event());
      EventSourceStub.instance.emit('job-event', event({ id: 'event-2', type: 'job.state' }));
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    act(() => EventSourceStub.instance.emit('replay-end'));
    expect(invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'jobs')).toHaveLength(1);
    expect(invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'job')).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies exactly once for a live attention event', () => {
    const notify = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notify, { permission: 'granted' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.emit('job-event', event());
      EventSourceStub.instance.emit('job-event', event());
    });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('releases the audio context after the attention tone ends', async () => {
    localStorage.setItem('mail-console-sound', 'on');
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }));
    const close = vi.fn().mockResolvedValue(undefined);
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const oscillator = {
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(() => gain),
      addEventListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    class AudioContextStub {
      currentTime = 0;
      destination = {};
      createOscillator = () => oscillator;
      createGain = () => gain;
      close = close;
    }
    vi.stubGlobal('AudioContext', AudioContextStub);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.emit('job-event', event());
    });

    expect(oscillator.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function), { once: true });
    const onEnded = oscillator.addEventListener.mock.calls[0][1] as () => void;
    await act(async () => onEnded());
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('treats replayed attention as historical again after reconnect', () => {
    const notify = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notify, { permission: 'granted' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.dispatchEvent(new Event('open'));
      EventSourceStub.instance.emit('job-event', event());
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.emit('job-event', event({ id: 'event-2' }));
    });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps deferred invalidation when reconnect happens before replay-end', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('job-event', event({ type: 'job.state', level: 'info' }));
      EventSourceStub.instance.dispatchEvent(new Event('open'));
      EventSourceStub.instance.emit('job-event', event({ type: 'job.state', level: 'info' }));
      EventSourceStub.instance.emit('replay-end');
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts'] });
  });

  it('invalidates the changed account detail and settings only for matching events', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.emit('job-event', event({ type: 'account.succeeded', level: 'info' }));
      EventSourceStub.instance.emit('job-event', event({ id: 'event-2', type: 'job.state', level: 'info' }));
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 2] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] });
  });

  it('refreshes all account runtime state on a job transition', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.emit('job-event', event({ type: 'job.state', rowIndex: undefined, level: 'info' }));
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account'] });
  });

  it('refreshes account runtime labels when the worker changes step', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    act(() => {
      EventSourceStub.instance.emit('replay-end');
      EventSourceStub.instance.emit('job-event', event({ type: 'step.changed', level: 'info' }));
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 2] });
  });
});
