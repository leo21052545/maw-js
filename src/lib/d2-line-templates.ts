/**
 * D2 LINE bot — template loader (Phase 1, Leo↔David only).
 *
 * Source of truth: `~/david-oracle/ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md`.
 * Per HELM ACK §6 pre-auth #4: templates passed in via shared config file (David's markdown),
 * NOT hardcoded. This loader parses David's spec at runtime — keeps templates editable
 * without code changes.
 *
 * Spec refs:
 *   - HELM bundle ψ/memory/forge/inbox/2026-05-03_helm-phase-1-forge-bundle.md §D2
 *   - David spec  ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md
 *
 * Public surface:
 *   - loadLineTemplates(path?) → parsed T1-T4 + R1-R5
 *   - renderTemplate(body, vars) → substitute {placeholder} tokens
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type PushTemplateId = "T1" | "T2" | "T3" | "T4";
export type ReplyIntent = "approve" | "defer" | "reject" | "identity" | "unknown";

export type PushTemplate = {
  id: PushTemplateId;
  name: string;
  body: string;
  /** Dedup window in seconds. 0 = always push (no dedup). */
  dedup_sec: number;
};

export type ReplyTemplate = {
  intent: ReplyIntent;
  body: string;
};

export type LineTemplates = {
  push: Record<PushTemplateId, PushTemplate>;
  reply: Record<ReplyIntent, ReplyTemplate>;
  source_path: string;
};

const PUSH_DEDUP_SEC: Record<PushTemplateId, number> = {
  T1: 86400, // 🔴 surfaced-leo — 24h per project_id
  T2: 43200, // 🟠 awaiting-leo — 12h per project_id
  T3: 0,     // halt-trigger — no dedup
  T4: 0,     // ship report relay — no dedup
};

const PUSH_HEADINGS: Record<PushTemplateId, RegExp> = {
  T1: /^###\s+T1\b/u,
  T2: /^###\s+T2\b/u,
  T3: /^###\s+T3\b/u,
  T4: /^###\s+T4\b/u,
};

const REPLY_HEADINGS: Record<ReplyIntent, RegExp> = {
  approve: /^###\s+R1\b/u,
  defer:   /^###\s+R2\b/u,
  reject:  /^###\s+R3\b/u,
  unknown: /^###\s+R4\b/u,
  identity:/^###\s+R5\b/u,
};

export function defaultTemplatesPath(): string {
  return process.env.D2_LINE_TEMPLATES_PATH
    || join(homedir(), "david-oracle", "ψ", "writing", "templates",
            "2026-05-03_d2-line-message-templates-v0.md");
}

/**
 * Extract the first fenced code block after a heading line.
 * Returns the body text (no fences) trimmed of leading/trailing blank lines.
 * Returns "" if no fenced block found before the next ### heading.
 */
function extractFirstFencedBlock(lines: string[], startIdx: number): string {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^###\s/u.test(line)) return ""; // hit next section without finding a block
    if (/^```/u.test(line)) {
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const inner = lines[j] ?? "";
        if (/^```/u.test(inner)) return buf.join("\n").replace(/^\n+|\n+$/g, "");
        buf.push(inner);
      }
      return buf.join("\n").replace(/^\n+|\n+$/g, ""); // unterminated — yield what we got
    }
  }
  return "";
}

function findHeadingLine(lines: string[], pattern: RegExp): { idx: number; name: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (pattern.test(line)) {
      // strip leading "### " and any trailing parenthetical for a friendly name
      const name = line.replace(/^###\s+/u, "").replace(/\s+$/u, "");
      return { idx: i, name };
    }
  }
  return null;
}

export function loadLineTemplates(specPath?: string): LineTemplates {
  const path = specPath ?? defaultTemplatesPath();
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);

  const push = {} as Record<PushTemplateId, PushTemplate>;
  for (const id of ["T1", "T2", "T3", "T4"] as const) {
    const hit = findHeadingLine(lines, PUSH_HEADINGS[id]);
    if (!hit) {
      throw new Error(`d2-line-templates: missing push template ${id} in ${path}`);
    }
    const body = extractFirstFencedBlock(lines, hit.idx);
    if (!body) {
      throw new Error(`d2-line-templates: empty body for push template ${id} in ${path}`);
    }
    push[id] = { id, name: hit.name, body, dedup_sec: PUSH_DEDUP_SEC[id] };
  }

  const reply = {} as Record<ReplyIntent, ReplyTemplate>;
  for (const intent of ["approve", "defer", "reject", "unknown", "identity"] as const) {
    const hit = findHeadingLine(lines, REPLY_HEADINGS[intent]);
    if (!hit) {
      throw new Error(`d2-line-templates: missing reply template for ${intent} in ${path}`);
    }
    const body = extractFirstFencedBlock(lines, hit.idx);
    if (!body) {
      throw new Error(`d2-line-templates: empty body for reply ${intent} in ${path}`);
    }
    reply[intent] = { intent, body };
  }

  return { push, reply, source_path: path };
}

/**
 * Substitute `{token}` placeholders in a template body with values from `vars`.
 * Unmatched tokens are left as-is (so a missing field renders the literal `{field}` —
 * easier to spot in QA than a silent empty string).
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{([a-z0-9_]+)\}/gi, (full, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : full;
  });
}
