/**
 * D4 — GET /api/kaiju/control-tower/projects/:project_id
 *
 * Spec refs:
 *   - ψ/writing/proposals/2026-05-03_phase-1-scope-amendment-D4-project-detail-drawer.md §"D4 spec"
 *   - ops/docs/STEWARD-DETAIL-MARKDOWN-CONTRACT-v0.md (§Detail markdown contract v0.1)
 *   - HELM bundle ψ/memory/forge/inbox/2026-05-03_helm-phase-1-forge-bundle.md §D4
 *
 * Tolerant parser: missing optional fields → empty string / null / [], NEVER 500.
 * Strict on: malformed `### N. NAME` header → return null block (caller 422); project_id absent → 404.
 * Cache: file-mtime invalidation (per David rec — small file, instant refresh better UX).
 */

import { existsSync, readFileSync, statSync } from "fs";
import { readStewardLog, stewardLogPath, type StewardRow } from "./steward-log-parser";

export type DetailLogEntry = {
  timestamp: string | null;
  actor: string;
  event: string;
};

export type ProjectDetailPayload = {
  project_id: string;
  received_from: string | null;
  current_owner: string | null;
  status: string;
  why: string | null;
  drift_check: "in-scope" | null;
  detail: {
    source: string;
    why_matters: string;
    owner_notes: string;
    related_files: string[];
  };
  plan: {
    dod: string;
    eta_active_hr: number | null;
    halt_criteria: string[];
    spec_path: string | null;
  };
  log: DetailLogEntry[];
};

export const DEFAULT_LOG_LIMIT = 10;

type ParsedField = {
  name: string;
  value: string;
  sub_bullets: string[];
};

type ParsedBlock = {
  row_number: number;
  project_name: string;
  fields: Map<string, ParsedField>;
  log_lines: string[];
};

/** Extract `## Project Detail[s]` zone — content between that H2 and the next H2 (or EOF). */
export function extractProjectDetailsZone(content: string): string | null {
  const headingRegex = /\n##\s+Project\s+Detail(?:s)?\b[^\n]*/i;
  const headingMatch = content.match(headingRegex);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const start = headingMatch.index + headingMatch[0].length;
  const tail = content.slice(start);
  const nextH2 = tail.search(/\n##\s+/);
  return nextH2 === -1 ? tail : tail.slice(0, nextH2);
}

/** Split the zone into per-project block strings, each starting with the `### N.` header line. */
export function splitDetailBlocks(zone: string): string[] {
  const blockHeaderRegex = /\n### \d+\. /g;
  const indices: number[] = [];
  for (const m of zone.matchAll(blockHeaderRegex)) {
    if (m.index !== undefined) indices.push(m.index + 1);
  }
  if (indices.length === 0) return [];
  const blocks: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : zone.length;
    blocks.push(zone.slice(start, end).replace(/\s+$/, ""));
  }
  return blocks;
}

const HEADER_PATTERN = /^### (\d+)\. (.+)$/m;
const FIELD_LINE_PATTERN = /^- \*\*([^*]+?)\*\*:\s?(.*)$/;
const SUB_BULLET_PATTERN = /^  - (.+)$/;

export function parseDetailBlock(block: string): ParsedBlock | null {
  const lines = block.split(/\r?\n/);
  const headerMatch = lines[0].match(HEADER_PATTERN);
  if (!headerMatch) return null;
  const rowNumber = Number.parseInt(headerMatch[1], 10);
  const projectName = headerMatch[2].replace(/\s+$/, "");

  const fields = new Map<string, ParsedField>();
  let logLines: string[] = [];
  let currentField: ParsedField | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const fieldMatch = line.match(FIELD_LINE_PATTERN);
    if (fieldMatch) {
      const name = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();
      currentField = { name, value, sub_bullets: [] };
      fields.set(name.toLowerCase(), currentField);
      if (name.toLowerCase() === "log") logLines = [];
      continue;
    }
    const subMatch = line.match(SUB_BULLET_PATTERN);
    if (subMatch && currentField) {
      currentField.sub_bullets.push(subMatch[1]);
      if (currentField.name.toLowerCase() === "log") {
        logLines.push(subMatch[1]);
      }
      continue;
    }
    // Continuation lines deeper than 2-space sub-bullet — append to current field/log entry.
    const deeperIndent = line.match(/^    (.+)$/);
    if (deeperIndent && currentField && currentField.sub_bullets.length > 0) {
      const lastIdx = currentField.sub_bullets.length - 1;
      currentField.sub_bullets[lastIdx] += " " + deeperIndent[1];
      if (currentField.name.toLowerCase() === "log" && logLines.length > 0) {
        logLines[logLines.length - 1] += " " + deeperIndent[1];
      }
      continue;
    }
    // Otherwise blank line or unrecognized → reset current field collector.
    if (/^\s*$/.test(line)) currentField = null;
  }

  return { row_number: rowNumber, project_name: projectName, fields, log_lines: logLines };
}

const LOG_ENTRY_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s+(\S+)(?:\s+(.+))?$/;

export function parseLogEntry(line: string): DetailLogEntry {
  const match = line.match(LOG_ENTRY_PATTERN);
  if (!match) {
    return { timestamp: null, actor: "unknown", event: line.trim() };
  }
  const date = match[1];
  const time = match[2] || "00:00";
  const actor = match[3];
  const event = (match[4] || "").trim();
  const timestamp = `${date}T${time}:00+07:00`;
  return { timestamp, actor, event };
}

export type SortDir = "newest_first" | "oldest_first";

export function sortLogEntries(entries: DetailLogEntry[], dir: SortDir = "newest_first"): DetailLogEntry[] {
  const cmp = (a: DetailLogEntry, b: DetailLogEntry) => {
    const ta = a.timestamp || "";
    const tb = b.timestamp || "";
    if (ta === tb) return 0;
    return dir === "newest_first" ? (ta < tb ? 1 : -1) : (ta < tb ? -1 : 1);
  };
  return [...entries].sort(cmp);
}

const RELATED_FILE_PATTERN = /(?:`)?(\S+\.(?:md|ts|js|json|sh|toml|yaml|yml))(?:`)?|(\bhttps?:\/\/\S+)|(ψ\/[^\s`)\]]+)|(ops\/[^\s`)\]]+)/g;

export function extractRelatedFiles(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(RELATED_FILE_PATTERN)) {
    const candidate = (m[1] || m[2] || m[3] || m[4] || "").replace(/[`)]+$/, "").trim();
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

const ETA_PATTERN = /~?(\d+)(?:\s*-\s*(\d+))?\s*active-hr/i;

export function extractEtaActiveHr(text: string): number | null {
  const match = text.match(ETA_PATTERN);
  if (!match) return null;
  const lo = Number.parseInt(match[1], 10);
  if (!Number.isFinite(lo)) return null;
  if (match[2]) {
    const hi = Number.parseInt(match[2], 10);
    if (Number.isFinite(hi)) return Math.round((lo + hi) / 2);
  }
  return lo;
}

function fieldValue(block: ParsedBlock, ...names: string[]): string {
  for (const name of names) {
    const f = block.fields.get(name.toLowerCase());
    if (f && f.value) return f.value;
  }
  return "";
}

function findSpecPath(block: ParsedBlock): string | null {
  const candidateNames = ["spec", "schema", "sprint plan", "prep doc", "spec v1 (locked)", "spec amendment (v2)"];
  for (const name of candidateNames) {
    const f = block.fields.get(name);
    if (!f) continue;
    const text = f.value || f.sub_bullets.join(" ");
    const files = extractRelatedFiles(text);
    if (files.length > 0) return files[0];
    if (text) return text;
  }
  return null;
}

function aggregateRelatedFiles(block: ParsedBlock): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const field of block.fields.values()) {
    if (field.name.toLowerCase() === "log") continue;
    const text = field.value + "\n" + field.sub_bullets.join("\n");
    for (const path of extractRelatedFiles(text)) {
      if (!seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

function buildPayloadFromBlock(
  row: StewardRow,
  block: ParsedBlock | null,
  options: { logLimit?: number; logAll?: boolean } = {},
): ProjectDetailPayload {
  const detail = {
    source: "",
    why_matters: "",
    owner_notes: "",
    related_files: [] as string[],
  };
  const plan = {
    dod: "",
    eta_active_hr: null as number | null,
    halt_criteria: [] as string[],
    spec_path: null as string | null,
  };
  let logEntries: DetailLogEntry[] = [];

  if (block) {
    detail.source = fieldValue(block, "source");
    detail.why_matters = fieldValue(block, "why matters", "why long-cycle", "why");
    detail.owner_notes = fieldValue(block, "owner");
    detail.related_files = aggregateRelatedFiles(block);

    plan.dod = fieldValue(block, "dod");
    const etaText = fieldValue(block, "eta") || (block.fields.get("eta")?.sub_bullets.join(" ") || "");
    plan.eta_active_hr = extractEtaActiveHr(etaText) ?? extractEtaActiveHr(plan.dod);
    plan.halt_criteria = block.fields.get("halt criteria")?.sub_bullets ?? [];
    plan.spec_path = findSpecPath(block);

    logEntries = block.log_lines.map(parseLogEntry);
    logEntries = sortLogEntries(logEntries, "newest_first");
    if (!options.logAll) {
      const limit = options.logLimit ?? DEFAULT_LOG_LIMIT;
      logEntries = logEntries.slice(0, limit);
    }
  }

  return {
    project_id: row.id,
    received_from: row.received_from,
    current_owner: row.current_owner,
    status: row.status,
    why: row.why,
    drift_check: (row.drift_check === "in-scope" ? "in-scope" : null),
    detail,
    plan,
    log: logEntries,
  };
}

type CacheEntry = {
  mtime_ms: number;
  blocks_by_row: Map<number, ParsedBlock>;
};

const cache = new Map<string, CacheEntry>();

function loadDetailBlocks(path: string): Map<number, ParsedBlock> {
  const stat = statSync(path);
  const cached = cache.get(path);
  if (cached && cached.mtime_ms === stat.mtimeMs) return cached.blocks_by_row;

  const content = readFileSync(path, "utf-8");
  const zone = extractProjectDetailsZone(content);
  const blocks = new Map<number, ParsedBlock>();
  if (zone) {
    for (const block of splitDetailBlocks(zone)) {
      const parsed = parseDetailBlock(block);
      if (parsed) blocks.set(parsed.row_number, parsed);
    }
  }
  cache.set(path, { mtime_ms: stat.mtimeMs, blocks_by_row: blocks });
  return blocks;
}

export function clearProjectDetailCache(): void {
  cache.clear();
}

export type LoadProjectDetailOptions = {
  log_limit?: number;
  log_all?: boolean;
  active_projects_path?: string;
};

export type LoadProjectDetailResult =
  | { status: "ok"; payload: ProjectDetailPayload }
  | { status: "not_found"; project_id: string };

export function loadProjectDetail(
  projectId: string,
  options: LoadProjectDetailOptions = {},
): LoadProjectDetailResult {
  const stewardResult = readStewardLog(options.active_projects_path);
  const row = stewardResult.rows.find((r) => r.id === projectId);
  if (!row) return { status: "not_found", project_id: projectId };

  const path = options.active_projects_path || stewardLogPath();
  const blocks = existsSync(path) ? loadDetailBlocks(path) : new Map<number, ParsedBlock>();
  const block = blocks.get(row.row_number) || null;

  const payload = buildPayloadFromBlock(row, block, {
    logLimit: options.log_limit,
    logAll: options.log_all,
  });
  return { status: "ok", payload };
}
