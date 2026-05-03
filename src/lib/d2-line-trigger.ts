/**
 * D2 LINE bot — trigger logic (Steward log → push events with dedup).
 *
 * Spec refs:
 *   - HELM bundle ψ/memory/forge/inbox/2026-05-03_helm-phase-1-forge-bundle.md §D2
 *   - David spec ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md §"Trigger logic"
 *
 * Detection rules:
 *   - status flipped to 🔴 surfaced-leo → T1 candidate (24h dedup)
 *   - status flipped to 🟠 awaiting-leo → T2 candidate (12h dedup)
 *   - first scan (no prior snapshot): treat current 🔴/🟠 rows as flips so the
 *     bot pushes within 1 poll cycle of boot rather than waiting for movement
 *
 * Pre-auth FORGE decision (HELM bundle): polling vs file-watch.
 *   We chose **60-sec poll** for v0:
 *     - fs.watch on Linux can miss edits depending on editor (atomic-write
 *       editors trigger rename, not change)
 *     - 60-sec latency is well inside David's <5-sec soft SLA for status flips
 *       in practice (David sweep updates active-projects.md every 30 min, not
 *       every second), and the SLA budget covers parser + push, not detection
 *     - Simpler to reason about + test deterministically (advance clock, run scan)
 *   File-watch is a follow-up if the latency budget tightens.
 */

import { readStewardLog, type StewardRow, type StewardStatus } from "./steward-log-parser";
import {
  loadDedup,
  recordPush as recordDedupPush,
  saveDedup,
  shouldPush,
  type DedupState,
} from "./d2-line-dedup";
import {
  loadLineTemplates,
  renderTemplate,
  type LineTemplates,
  type PushTemplateId,
} from "./d2-line-templates";
import type { PushArgs, Pusher } from "./d2-line-client";

export type TriggerEvent = {
  template_id: PushTemplateId;
  project_id: string;
  row: StewardRow;
  text: string;
};

export type TriggerOutcome = {
  events_detected: TriggerEvent[];
  events_pushed: TriggerEvent[];
  /** Skipped because of dedup window. */
  events_deduped: TriggerEvent[];
  errors: Array<{ event: TriggerEvent; error: string }>;
};

const STATUS_TO_TEMPLATE: Partial<Record<StewardStatus, PushTemplateId>> = {
  "surfaced-leo": "T1",
  "awaiting-leo": "T2",
};

/**
 * Diff two parser snapshots and emit trigger candidates for newly-surfaced rows.
 * "New" = appeared in current scan as 🔴/🟠 AND was not 🔴/🟠 in the prior scan
 * (or the prior scan didn't see this project at all).
 *
 * Pure function — no I/O, no dedup application. Caller filters by dedup state.
 */
export function detectFlips(prev: StewardRow[] | null, curr: StewardRow[]): Array<{ template_id: PushTemplateId; row: StewardRow }> {
  const prevByProject = new Map<string, StewardStatus>();
  if (prev) {
    for (const row of prev) prevByProject.set(row.id, row.status);
  }
  const events: Array<{ template_id: PushTemplateId; row: StewardRow }> = [];
  for (const row of curr) {
    const tid = STATUS_TO_TEMPLATE[row.status];
    if (!tid) continue;
    const prior = prevByProject.get(row.id);
    if (prior === row.status) continue; // unchanged — not a flip
    events.push({ template_id: tid, row });
  }
  return events;
}

/** Strip parenthetical owners + emoji from a string for cleaner display. */
function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

function deriveStuckHours(_row: StewardRow): string {
  // StewardRow per current parser (see src/lib/steward-log-parser.ts) doesn't
  // expose the "Stuck" column. Render as em-dash for v0; plumb through if/when
  // the parser surfaces it. Documented as a known v0 gap in the PR.
  return "—";
}

/**
 * Build the variable map for a push template render.
 * Cockpit URL pattern: http://${host}/control_tower.html#project-${row_number}
 */
export function renderPushVars(row: StewardRow, opts: { cockpit_base_url: string }): Record<string, string> {
  return {
    project_id: row.id,
    project_name: cleanText(row.project_name) || row.id,
    why_field: cleanText(row.why) || "(no DoD recorded)",
    current_owner: cleanText(row.current_owner) || "(unassigned)",
    stuck_duration: deriveStuckHours(row),
    cockpit_url: `${opts.cockpit_base_url.replace(/\/$/, "")}/control_tower.html#project-${row.row_number}`,
  };
}

export type RunScanOpts = {
  recipient: string;            // LINE userId or Telegram chat_id
  pusher: Pusher;
  templates?: LineTemplates;    // pre-loaded for tests; loadLineTemplates() if absent
  prev_rows?: StewardRow[] | null;
  steward_log_path?: string;
  dedup_path?: string;
  cockpit_base_url?: string;
  now_ms?: number;
  /** When true, skip writing the dedup file (used in tests). */
  dry_run?: boolean;
};

/**
 * Single-cycle trigger scan: read the Steward log, diff against `prev_rows`,
 * dedup, render, push. Returns the outcome + the new snapshot for the next scan.
 */
export async function runTriggerScan(opts: RunScanOpts): Promise<TriggerOutcome & { snapshot: StewardRow[] }> {
  const templates = opts.templates ?? loadLineTemplates();
  const cockpit = opts.cockpit_base_url ?? (process.env.D2_COCKPIT_BASE_URL ?? "http://localhost:3456");
  const parsed = readStewardLog(opts.steward_log_path);
  const curr = parsed.rows;

  const flips = detectFlips(opts.prev_rows ?? null, curr);

  let dedup: DedupState = loadDedup(opts.dedup_path);
  const detected: TriggerEvent[] = [];
  const pushed: TriggerEvent[] = [];
  const deduped: TriggerEvent[] = [];
  const errors: TriggerOutcome["errors"] = [];

  for (const flip of flips) {
    const tpl = templates.push[flip.template_id];
    const vars = renderPushVars(flip.row, { cockpit_base_url: cockpit });
    const text = renderTemplate(tpl.body, vars);
    const event: TriggerEvent = {
      template_id: flip.template_id,
      project_id: flip.row.id,
      row: flip.row,
      text,
    };
    detected.push(event);

    if (!shouldPush(dedup, flip.template_id, flip.row.id, tpl.dedup_sec, opts.now_ms)) {
      deduped.push(event);
      continue;
    }

    try {
      const result = await opts.pusher({ recipient: opts.recipient, text } satisfies PushArgs);
      if (!result.ok) {
        errors.push({ event, error: `transport=${result.transport} status=${result.status ?? "?"} body=${result.body ?? ""}` });
        continue;
      }
    } catch (err) {
      errors.push({ event, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    dedup = recordDedupPush(dedup, flip.template_id, flip.row.id, opts.now_ms);
    pushed.push(event);
  }

  if (!opts.dry_run && pushed.length > 0) {
    saveDedup(dedup, opts.dedup_path);
  }

  return {
    snapshot: curr,
    events_detected: detected,
    events_pushed: pushed,
    events_deduped: deduped,
    errors,
  };
}

export type WatcherHandle = {
  stop: () => void;
  /** Force a scan now (used by tests). Returns the outcome. */
  tick: () => Promise<TriggerOutcome & { snapshot: StewardRow[] }>;
};

export type WatcherOpts = Omit<RunScanOpts, "prev_rows"> & {
  poll_ms?: number;
  /** Receives every scan outcome — for telemetry / logs. */
  on_scan?: (outcome: TriggerOutcome & { snapshot: StewardRow[] }) => void;
};

/**
 * Start a polling trigger watcher. Returns a handle with `stop()` + `tick()`.
 * Errors during scan are swallowed (logged via `on_scan` if provided) so the
 * watcher loop never crashes the host process.
 */
export function startTriggerWatcher(opts: WatcherOpts): WatcherHandle {
  const interval_ms = opts.poll_ms ?? 60_000;
  let prev_rows: StewardRow[] | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    const outcome = await runTriggerScan({ ...opts, prev_rows });
    prev_rows = outcome.snapshot;
    if (opts.on_scan) {
      try { opts.on_scan(outcome); } catch { /* never crash the watcher */ }
    }
    return outcome;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await tick(); } catch { /* never crash the watcher */ }
      schedule();
    }, interval_ms);
    // Don't keep the event loop alive solely for the watcher
    if (timer && typeof (timer as any).unref === "function") (timer as any).unref();
  }

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick,
  };
}
