import { toKey } from '../paths';

export class SelfWriteTracker {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly activeCounts = new Map<string, number>();
  private readonly completedAt = new Map<string, number>();

  constructor(windowMs: number = 5000, now: () => number = () => Date.now()) {
    this.windowMs = windowMs;
    this.now = now;
  }

  mark(path: string): void {
    const key = toKey(path);
    this.completedAt.set(key, this.now());
  }

  begin(path: string): () => void {
    const key = toKey(path);
    this.activeCounts.set(key, (this.activeCounts.get(key) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const count = (this.activeCounts.get(key) ?? 1) - 1;
      if (count <= 0) {
        this.activeCounts.delete(key);
      } else {
        this.activeCounts.set(key, count);
      }
      this.completedAt.set(key, this.now());
    };
  }

  isSelfWrite(path: string): boolean {
    const key = toKey(path);
    if ((this.activeCounts.get(key) ?? 0) > 0) {
      return true;
    }
    const completed = this.completedAt.get(key);
    if (completed !== undefined) {
      if (this.now() - completed <= this.windowMs) {
        return true;
      }
      this.completedAt.delete(key);
    }
    return false;
  }
}
