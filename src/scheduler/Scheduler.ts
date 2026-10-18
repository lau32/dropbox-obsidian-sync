import type { TriggerReason } from '../types';
import type { SelfWriteTracker } from './SelfWriteTracker';

export interface TriggerSettings {
  onStartup: boolean;
  onResume: boolean;
  onEdit: boolean;
  editDebounceSec: number;
  interval: boolean;
  intervalMin: number;
  longpoll: boolean;
}

export interface SchedulerOptions {
  run: (t: TriggerReason) => Promise<void>;
  settings: () => TriggerSettings;
  isPaused: () => boolean;
  selfWrites: SelfWriteTracker;
  longpoll: (signal: AbortSignal) => Promise<'changed' | 'timeout' | 'error'>;
}

export class Scheduler {
  private isRunning = false;
  private editDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  private activeRun: Promise<void> | null = null;
  private pendingTrigger: TriggerReason | null = null;
  private pendingManualResolvers: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  constructor(private readonly opts: SchedulerOptions) {}

  get running(): boolean {
    return this.isRunning;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    if (this.opts.settings().onStartup && !this.opts.isPaused()) {
      this.enqueueTrigger('startup');
    }

    this.scheduleInterval();

    if (this.opts.settings().longpoll) {
      void this.startLongpollLoop();
    }
  }

  stop(): void {
    this.isRunning = false;

    if (this.editDebounceTimer !== null) {
      clearTimeout(this.editDebounceTimer);
      this.editDebounceTimer = null;
    }

    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }

    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.pendingTrigger = null;

    for (const res of this.pendingManualResolvers) {
      res.reject(new Error('Scheduler stopped'));
    }
    this.pendingManualResolvers = [];
  }

  notifyLocalChange(path: string): void {
    if (!this.isRunning) return;
    if (this.opts.isPaused()) return;
    if (!this.opts.settings().onEdit) return;
    if (this.opts.selfWrites.isSelfWrite(path)) return;

    if (this.editDebounceTimer !== null) {
      clearTimeout(this.editDebounceTimer);
      this.editDebounceTimer = null;
    }

    const sec = this.opts.settings().editDebounceSec;
    const ms = Math.max(0, sec) * 1000;

    this.editDebounceTimer = setTimeout(() => {
      this.editDebounceTimer = null;
      if (!this.isRunning) return;
      if (this.opts.isPaused()) return;
      if (!this.opts.settings().onEdit) return;
      this.enqueueTrigger('edit');
    }, ms);
  }

  notifyResume(): void {
    if (!this.isRunning) return;
    if (this.opts.isPaused()) return;
    if (!this.opts.settings().onResume) return;
    this.enqueueTrigger('resume');
  }

  requestManual(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingManualResolvers.push({ resolve, reject });
      if (this.activeRun !== null) {
        this.pendingTrigger = 'manual';
      } else {
        void this.startRunLoop('manual');
      }
    });
  }

  private enqueueTrigger(reason: TriggerReason): void {
    if (!this.isRunning) return;
    if (this.opts.isPaused()) return;

    if (this.activeRun !== null) {
      if (this.pendingTrigger !== 'manual') {
        this.pendingTrigger = reason;
      }
      return;
    }

    void this.startRunLoop(reason);
  }

  private async startRunLoop(initialReason: TriggerReason): Promise<void> {
    let nextReason: TriggerReason | null = initialReason;

    while (nextReason !== null) {
      const currentReason = nextReason;
      nextReason = null;
      this.pendingTrigger = null;

      if (currentReason !== 'manual' && (!this.isRunning || this.opts.isPaused())) {
        break;
      }

      const manualResolvers =
        currentReason === 'manual' ? [...this.pendingManualResolvers] : [];
      if (currentReason === 'manual') {
        this.pendingManualResolvers = [];
      }

      let runFinished: () => void;
      this.activeRun = new Promise<void>((r) => {
        runFinished = r;
      });

      try {
        await this.opts.run(currentReason);
        for (const res of manualResolvers) {
          res.resolve();
        }
      } catch (err) {
        if (manualResolvers.length > 0) {
          for (const res of manualResolvers) {
            res.reject(err);
          }
        }
      } finally {
        this.activeRun = null;
        runFinished!();
      }

      if (this.pendingTrigger !== null) {
        if (this.pendingTrigger === 'manual') {
          nextReason = 'manual';
        } else if (this.isRunning && !this.opts.isPaused()) {
          nextReason = this.pendingTrigger;
        }
        this.pendingTrigger = null;
      }
    }
  }

  private scheduleInterval(): void {
    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (!this.isRunning) return;

    const s = this.opts.settings();
    const intervalMin = s.intervalMin > 0 ? s.intervalMin : 5;
    const intervalMs = intervalMin * 60 * 1000;

    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      if (!this.isRunning) return;
      const current = this.opts.settings();
      if (current.interval && !this.opts.isPaused()) {
        this.enqueueTrigger('interval');
      }
      this.scheduleInterval();
    }, intervalMs);
  }

  private async startLongpollLoop(): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal) return;

    while (this.isRunning && !signal.aborted) {
      if (!this.opts.settings().longpoll) {
        break;
      }

      try {
        const result = await this.opts.longpoll(signal);
        if (!this.isRunning || signal.aborted) break;

        if (result === 'changed') {
          if (!this.opts.isPaused()) {
            this.enqueueTrigger('remote');
          }
        } else if (result === 'error') {
          await this.delay(60_000, signal);
        }
      } catch {
        if (!this.isRunning || signal.aborted) break;
        await this.delay(60_000, signal);
      }
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      timer = setTimeout(() => {
        timer = null;
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
