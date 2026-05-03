/**
 * D2 LINE bot — per-user session state (last-N push project_ids, TTL).
 *
 * Spec: ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md
 *   "Session state: keep last-3 push project_ids per Leo's LINE userId, TTL 1h"
 *
 * Used to resolve the project_id when Leo replies "อนุมัติ" to the most-recent push.
 * In-memory only — restart drops state, which is fine: TTL is 1h, and any in-flight
 * decisions can be re-pushed by re-flipping the row's status.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_KEEP = 3;

type Entry = {
  /** Newest first. */
  project_ids: string[];
  /** epoch-ms of the most recent push for this userId. */
  last_touched: number;
};

export class LineSession {
  private readonly store = new Map<string, Entry>();
  private readonly ttl_ms: number;
  private readonly keep: number;

  constructor(opts: { ttl_ms?: number; keep?: number } = {}) {
    this.ttl_ms = opts.ttl_ms ?? DEFAULT_TTL_MS;
    this.keep = opts.keep ?? DEFAULT_KEEP;
  }

  recordPush(user_id: string, project_id: string, now_ms: number = Date.now()): void {
    if (!user_id || !project_id) return;
    const existing = this.store.get(user_id);
    const next: string[] = existing
      ? [project_id, ...existing.project_ids.filter((id) => id !== project_id)]
      : [project_id];
    this.store.set(user_id, {
      project_ids: next.slice(0, this.keep),
      last_touched: now_ms,
    });
  }

  /**
   * Return the most recent project_id pushed to this user, or null if none / expired.
   * Caller-side: if reply has explicit index ("อนุมัติ 2"), use peekAt(userId, 2) instead.
   */
  resolveLatest(user_id: string, now_ms: number = Date.now()): string | null {
    const entry = this.store.get(user_id);
    if (!entry) return null;
    if (now_ms - entry.last_touched > this.ttl_ms) {
      this.store.delete(user_id);
      return null;
    }
    return entry.project_ids[0] ?? null;
  }

  /** 1-indexed lookup for ambiguous-multi-push selection. */
  peekAt(user_id: string, index_1based: number, now_ms: number = Date.now()): string | null {
    const entry = this.store.get(user_id);
    if (!entry) return null;
    if (now_ms - entry.last_touched > this.ttl_ms) {
      this.store.delete(user_id);
      return null;
    }
    return entry.project_ids[index_1based - 1] ?? null;
  }

  /** All non-expired projects for a user (newest first). Used to render "ambiguous" reply. */
  listActive(user_id: string, now_ms: number = Date.now()): string[] {
    const entry = this.store.get(user_id);
    if (!entry) return [];
    if (now_ms - entry.last_touched > this.ttl_ms) {
      this.store.delete(user_id);
      return [];
    }
    return [...entry.project_ids];
  }

  /** Drop all expired entries. Call periodically or before snapshots. */
  pruneExpired(now_ms: number = Date.now()): number {
    let dropped = 0;
    for (const [uid, entry] of this.store.entries()) {
      if (now_ms - entry.last_touched > this.ttl_ms) {
        this.store.delete(uid);
        dropped += 1;
      }
    }
    return dropped;
  }

  size(): number {
    return this.store.size;
  }

  /** Drop all state — for tests + ops reset. */
  reset(): void {
    this.store.clear();
  }
}
