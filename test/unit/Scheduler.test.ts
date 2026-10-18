import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SelfWriteTracker } from '../../src/scheduler/SelfWriteTracker';
import { Scheduler, type TriggerSettings } from '../../src/scheduler/Scheduler';
import type { TriggerReason } from '../../src/types';

describe('SelfWriteTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks begin() across a 10 s write and for 5 s after end(), normalizing case', () => {
    const tracker = new SelfWriteTracker(5000);

    const end = tracker.begin('A.md');

    // During the 10 s write, isSelfWrite is true
    expect(tracker.isSelfWrite('a.md')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(tracker.isSelfWrite('a.md')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(tracker.isSelfWrite('a.md')).toBe(true);

    // End write
    end();

    // Still true for 5 s after end()
    expect(tracker.isSelfWrite('a.md')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(tracker.isSelfWrite('a.md')).toBe(true);

    // Beyond 5 s after end(), isSelfWrite is false
    vi.advanceTimersByTime(1);
    expect(tracker.isSelfWrite('a.md')).toBe(false);
  });

  it('marks path as self-write and normalizes via toKey', () => {
    const tracker = new SelfWriteTracker(5000);

    tracker.mark('Folder/File.MD');
    expect(tracker.isSelfWrite('folder/file.md')).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(tracker.isSelfWrite('folder/file.md')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tracker.isSelfWrite('folder/file.md')).toBe(false);
  });

  it('handles multiple concurrent writes for the same path', () => {
    const tracker = new SelfWriteTracker(5000);

    const end1 = tracker.begin('a.md');
    const end2 = tracker.begin('A.MD');

    end1();
    // end1 finished, but end2 is still active
    expect(tracker.isSelfWrite('a.md')).toBe(true);

    vi.advanceTimersByTime(6000);
    expect(tracker.isSelfWrite('a.md')).toBe(true);

    end2();
    // Both finished; now 5 s window applies
    vi.advanceTimersByTime(5000);
    expect(tracker.isSelfWrite('a.md')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isSelfWrite('a.md')).toBe(false);
  });
});

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function defaultSettings(): TriggerSettings {
    return {
      onStartup: false,
      onResume: false,
      onEdit: true,
      editDebounceSec: 10,
      interval: false,
      intervalMin: 5,
      longpoll: false,
    };
  }

  it('debounces three notifyLocalChange calls 2 s apart to exactly one run, 10 s after the last', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);
    let settings = defaultSettings();

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => settings,
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();

    // Call 1 at t = 0
    scheduler.notifyLocalChange('a.md');
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toEqual([]);

    // Call 2 at t = 2s
    scheduler.notifyLocalChange('b.md');
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toEqual([]);

    // Call 3 at t = 4s
    scheduler.notifyLocalChange('c.md');
    await vi.advanceTimersByTimeAsync(9999);
    expect(runs).toEqual([]);

    // Exactly 10 s after call 3 (t = 14s)
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['edit']);

    scheduler.stop();
  });

  it('ignores self-write in notifyLocalChange, but runs after 5 s window (Review Focus 4)', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);
    const settings = defaultSettings();

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => settings,
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();

    selfWrites.mark('a.md');
    scheduler.notifyLocalChange('a.md');

    // Debounce is 10 s, advance past it
    await vi.advanceTimersByTimeAsync(12000);
    expect(runs).toEqual([]);

    // Now after the 5 s window, a user edit happens
    scheduler.notifyLocalChange('a.md');
    await vi.advanceTimersByTimeAsync(10000);
    expect(runs).toEqual(['edit']);

    scheduler.stop();
  });

  it('executes trigger during a running run as exactly one follow-up run', async () => {
    const runs: TriggerReason[] = [];
    let resolveRun: (() => void) | null = null;
    const selfWrites = new SelfWriteTracker(5000);
    const settings = { ...defaultSettings(), onResume: true };

    const scheduler = new Scheduler({
      run: (t) => {
        runs.push(t);
        return new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
      },
      settings: () => settings,
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();

    // Trigger first run via resume
    scheduler.notifyResume();
    expect(runs).toEqual(['resume']);
    expect(resolveRun).not.toBeNull();

    // While first run is in-flight, trigger multiple times
    scheduler.notifyResume();
    scheduler.notifyResume();

    // Finish first run
    resolveRun!();
    await Promise.resolve(); // flush microtask

    // Exactly one follow-up run starts
    expect(runs).toEqual(['resume', 'resume']);

    // Finish follow-up run
    resolveRun!();
    await Promise.resolve();

    // No further runs
    expect(runs).toEqual(['resume', 'resume']);

    scheduler.stop();
  });

  it('manual trigger takes precedence over automatic triggers during a running run', async () => {
    const runs: TriggerReason[] = [];
    let resolveRun: (() => void) | null = null;
    const selfWrites = new SelfWriteTracker(5000);
    const settings = { ...defaultSettings(), onResume: true };

    const scheduler = new Scheduler({
      run: (t) => {
        runs.push(t);
        return new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
      },
      settings: () => settings,
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();

    scheduler.notifyResume();
    expect(runs).toEqual(['resume']);

    // While run 1 is active, queue an automatic trigger then manual trigger
    scheduler.notifyResume();
    const manualPromise = scheduler.requestManual();

    let manualFinished = false;
    manualPromise.then(() => { manualFinished = true; });

    // Finish run 1
    resolveRun!();
    await Promise.resolve();

    // Follow-up should be 'manual' because manual takes precedence
    expect(runs).toEqual(['resume', 'manual']);
    expect(manualFinished).toBe(false);

    // Finish run 2 (the manual run)
    resolveRun!();
    await manualPromise;
    expect(manualFinished).toBe(true);

    // No further runs
    expect(runs).toEqual(['resume', 'manual']);

    scheduler.stop();
  });

  it('suppresses automatic triggers when isPaused() === true, but requestManual() runs', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);
    const settings = { ...defaultSettings(), interval: true, intervalMin: 5 };
    let paused = true;

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => settings,
      isPaused: () => paused,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();

    // Interval fires while paused → no run
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(runs).toEqual([]);

    // Edit while paused → no run
    scheduler.notifyLocalChange('a.md');
    await vi.advanceTimersByTimeAsync(15000);
    expect(runs).toEqual([]);

    // Resume while paused → no run
    scheduler.notifyResume();
    expect(runs).toEqual([]);

    // requestManual() ignores isPaused
    await scheduler.requestManual();
    expect(runs).toEqual(['manual']);

    scheduler.stop();
  });

  it('runs interval according to settings: interval: false produces no runs, true produces one run per 5 min', async () => {
    const runsFalse: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);

    const schedulerFalse = new Scheduler({
      run: async (t) => { runsFalse.push(t); },
      settings: () => ({ ...defaultSettings(), interval: false, intervalMin: 5 }),
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    schedulerFalse.start();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(runsFalse).toEqual([]);
    schedulerFalse.stop();

    // With interval: true
    const runsTrue: TriggerReason[] = [];
    const schedulerTrue = new Scheduler({
      run: async (t) => { runsTrue.push(t); },
      settings: () => ({ ...defaultSettings(), interval: true, intervalMin: 5 }),
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    schedulerTrue.start();
    // In 30 min, triggers at 5m, 10m, 15m, 20m, 25m, 30m = 6 runs
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(runsTrue).toEqual(['interval', 'interval', 'interval', 'interval', 'interval', 'interval']);
    schedulerTrue.stop();
  });

  it('triggers startup run when onStartup is true', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => ({ ...defaultSettings(), onStartup: true }),
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();
    await Promise.resolve();
    expect(runs).toEqual(['startup']);

    scheduler.stop();
  });

  it('handles longpoll changed by triggering remote, and stop() aborts signal and clears timers', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);
    let abortObserved = false;
    let callCount = 0;

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => ({ ...defaultSettings(), longpoll: true }),
      isPaused: () => false,
      selfWrites,
      longpoll: (signal) => {
        callCount++;
        signal.addEventListener('abort', () => {
          abortObserved = true;
        });

        if (callCount === 1) {
          return Promise.resolve('changed');
        }
        // Second call stays pending until aborted
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('timeout'));
        });
      },
    });

    scheduler.start();

    // Flush microtasks for the first longpoll response
    await Promise.resolve();
    await Promise.resolve();

    expect(runs).toEqual(['remote']);
    expect(callCount).toBe(2);

    // Stop scheduler: abort signal should fire and timers be cleared
    scheduler.stop();
    expect(abortObserved).toBe(true);

    // Advancing time produces no new runs
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runs).toEqual(['remote']);
  });

  it('retries longpoll after 60 s delay on error', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);
    let callCount = 0;

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => ({ ...defaultSettings(), longpoll: true }),
      isPaused: () => false,
      selfWrites,
      longpoll: async (signal) => {
        callCount++;
        if (callCount === 1) {
          return 'error';
        }
        if (callCount === 2) {
          return 'changed';
        }
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('timeout'));
        });
      },
    });

    scheduler.start();

    // Call 1 returns 'error' immediately
    await Promise.resolve();
    expect(callCount).toBe(1);

    // Advancing 59 s: still waiting on retry delay
    await vi.advanceTimersByTimeAsync(59_000);
    expect(callCount).toBe(1);

    // Advancing past 60 s: call 2 executes and returns 'changed', triggering 'remote' and next poll
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(callCount).toBe(3);
    expect(runs).toEqual(['remote']);

    scheduler.stop();
  });

  it('rejects pending manual request if stop() is called while queued', async () => {
    let resolveRun: (() => void) | null = null;
    const selfWrites = new SelfWriteTracker(5000);

    const scheduler = new Scheduler({
      run: () => new Promise<void>((r) => { resolveRun = r; }),
      settings: () => ({ ...defaultSettings(), onResume: true }),
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();
    scheduler.notifyResume(); // run 1 starts

    const manualPromise = scheduler.requestManual(); // queued behind run 1
    scheduler.stop(); // stops scheduler and rejects pending manual resolvers

    await expect(manualPromise).rejects.toThrow('Scheduler stopped');

    resolveRun!();
  });

  it('propagates errors thrown during manual run to requestManual caller', async () => {
    const selfWrites = new SelfWriteTracker(5000);

    const scheduler = new Scheduler({
      run: async (t) => {
        if (t === 'manual') {
          throw new Error('manual run failed');
        }
      },
      settings: () => defaultSettings(),
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    await expect(scheduler.requestManual()).rejects.toThrow('manual run failed');
  });

  it('does not run onStartup if isPaused() is true at startup', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => ({ ...defaultSettings(), onStartup: true }),
      isPaused: () => true,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();
    await Promise.resolve();
    expect(runs).toEqual([]);

    scheduler.stop();
  });

  it('suppresses pending automatic triggers if isPaused() becomes true during run', async () => {
    const runs: TriggerReason[] = [];
    let resolveRun: (() => void) | null = null;
    let paused = false;
    const selfWrites = new SelfWriteTracker(5000);

    const scheduler = new Scheduler({
      run: (t) => {
        runs.push(t);
        return new Promise<void>((r) => { resolveRun = r; });
      },
      settings: () => ({ ...defaultSettings(), onResume: true }),
      isPaused: () => paused,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();
    scheduler.notifyResume();
    expect(runs).toEqual(['resume']);

    // Queue another automatic trigger while run 1 is active
    scheduler.notifyResume();

    // Now pause before run 1 completes
    paused = true;
    resolveRun!();
    await Promise.resolve();

    // The pending 'resume' trigger was suppressed because paused became true
    expect(runs).toEqual(['resume']);

    scheduler.stop();
  });

  it('calling start() multiple times is idempotent', async () => {
    const runs: TriggerReason[] = [];
    const selfWrites = new SelfWriteTracker(5000);

    const scheduler = new Scheduler({
      run: async (t) => { runs.push(t); },
      settings: () => ({ ...defaultSettings(), onStartup: true }),
      isPaused: () => false,
      selfWrites,
      longpoll: async () => 'timeout',
    });

    scheduler.start();
    scheduler.start();
    expect(scheduler.running).toBe(true);

    await Promise.resolve();
    expect(runs).toEqual(['startup']);

    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });
});

