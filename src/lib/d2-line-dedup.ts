/**
 * D2 LINE bot — file-backed dedup state for push windows.
 *
 * Spec: ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md §"Trigger matrix"
 *   - T1 (🔴 surfaced-leo) → 24h dedup per project_id
 *   - T2 (🟠 awaiting-leo) → 12h dedup per project_id
 *
 * Per HELM bundle pre-auth: file-vs-in-memory is FORGE's call. We chose **file-backed**
 * so PM2 restarts during Phase 1 don't cause duplicate pushes (the 24h window is much
 * longer than typical restart cadence). Footprint is small (one record per
 * (template, project_id) pair).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { PushTemplateId } from "./d2-line-templates";

export type DedupRecord = {
  template_id: PushTemplateId;
  project_id: string;
  /** ISO-8601 of the push attempt. */
  pushed_at: string;
};

/** Keyed by `${template_id}:${project_id}` so T1 + T2 dedup independently. */
export type DedupState = Record<string, DedupRecord>;

export function defaultDedupPath(): string {
  return process.env.D2_LINE_DEDUP_PATH
    || join(homedir(), "david-oracle", "ψ", "state", "d2-line-dedup.json");
}

function dedupKey(template_id: PushTemplateId, project_id: string): string {
  return `${template_id}:${project_id}`;
}

export function loadDedup(path: string = defaultDedupPath()): DedupState {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as DedupState;
    }
    return {};
  } catch {
    // Corrupt file → start clean rather than crash the watcher.
    return {};
  }
}

export function saveDedup(state: DedupState, path: string = defaultDedupPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Should we send this push given the dedup window?
 * Returns true if no prior push OR if the prior push is older than `window_sec`.
 * window_sec=0 means "always push" (no dedup).
 */
export function shouldPush(
  state: DedupState,
  template_id: PushTemplateId,
  project_id: string,
  window_sec: number,
  now_ms: number = Date.now()
): boolean {
  if (window_sec <= 0) return true;
  const rec = state[dedupKey(template_id, project_id)];
  if (!rec) return true;
  const last_ms = Date.parse(rec.pushed_at);
  if (!Number.isFinite(last_ms)) return true; // bad timestamp — re-push
  return now_ms - last_ms >= window_sec * 1000;
}

/**
 * Mark a push as sent. Returns a NEW state object (caller saves).
 */
export function recordPush(
  state: DedupState,
  template_id: PushTemplateId,
  project_id: string,
  now_ms: number = Date.now()
): DedupState {
  const next: DedupState = { ...state };
  next[dedupKey(template_id, project_id)] = {
    template_id,
    project_id,
    pushed_at: new Date(now_ms).toISOString(),
  };
  return next;
}

/** Drop records older than `max_age_sec` to keep the file small. */
export function pruneDedup(
  state: DedupState,
  max_age_sec: number = 86400 * 7,
  now_ms: number = Date.now()
): DedupState {
  const cutoff = now_ms - max_age_sec * 1000;
  const next: DedupState = {};
  for (const [k, v] of Object.entries(state)) {
    const ts = Date.parse(v.pushed_at);
    if (Number.isFinite(ts) && ts >= cutoff) next[k] = v;
  }
  return next;
}
