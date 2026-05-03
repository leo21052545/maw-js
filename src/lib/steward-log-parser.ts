/**
 * Steward log markdown parser — F2 wire for SHIP-TODAY (HELM 2026-05-03).
 *
 * Source of truth: ~/david-oracle/ψ/memory/david/active-projects.md (markdown,
 * append-only audit log + live snapshot table). David sweep updates every 30 min.
 *
 * Spec ref: ψ/memory/forge/inbox/2026-05-03_helm-ship-today-forge-backend.md §F2
 *
 * Each row → 5-column response (Leo's verbatim spec):
 *   - received_from   — originator (LHS of "→" arrow in Owner col, else same as current_owner)
 *   - current_owner   — Owner column (first identifiable name, parentheticals stripped)
 *   - status          — emoji-mapped enum (active|stuck-ping|awaiting-leo|surfaced-leo|parked)
 *   - why             — DoD column, code-formatting stripped
 *   - drift_check     — "in-scope" if Project Detail section matches row name, else null
 *
 * Closed rows (✅ CLOSED) are filtered — Cockpit shows ACTIVE projects only.
 *
 * Per spec rule 6: malformed rows emit with null + log warning, do NOT crash.
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type StewardStatus =
  | "active"
  | "stuck-ping"
  | "awaiting-leo"
  | "surfaced-leo"
  | "parked";

export type StewardRow = {
  /** Stable id derived from row number + slug — used for UI keys / merge collision check. */
  id: string;
  /** Row number from Steward log table (preserves Steward's ordering). */
  row_number: number;
  /** Original project name for collision detection vs hardcoded projects. */
  project_name: string;
  /** Who originated/handed off the work. Same as current_owner unless arrow split. */
  received_from: string | null;
  /** Current responsible party. */
  current_owner: string | null;
  status: StewardStatus;
  /** DoD or first-line rationale — Leo emphasis: MUST NOT be lost. */
  why: string | null;
  /** "in-scope" if matched against detail section, else null. */
  drift_check: string | null;
};

export type StewardParseResult = {
  rows: StewardRow[];
  warnings: string[];
  /** ISO-8601 of file mtime for staleness checks. */
  parsed_at: string;
  /** Source file path — for UI debugging. */
  source_path: string;
};

const STATUS_EMOJI_MAP: Array<[RegExp, StewardStatus | "closed"]> = [
  [/✅\s*CLOSED/iu, "closed"],
  [/🟡/u, "stuck-ping"],
  [/🟠/u, "awaiting-leo"],
  [/🔴/u, "surfaced-leo"],
  [/⏸/u, "parked"],
  [/🟢/u, "active"],
];

export function stewardLogPath(): string {
  return process.env.KAIJU_STEWARD_LOG_PATH
    || join(homedir(), "david-oracle", "ψ", "memory", "david", "active-projects.md");
}

/**
 * Map a status cell's emoji + text → enum (or "closed" sentinel for filtering).
 * Returns null if no recognizable marker.
 */
function classifyStatus(cell: string): StewardStatus | "closed" | null {
  for (const [re, status] of STATUS_EMOJI_MAP) {
    if (re.test(cell)) return status;
  }
  return null;
}

/**
 * Parse Owner column. Returns [received_from, current_owner].
 * - "X → Y" arrow → [X, Y]
 * - "X+Y", "X / Y", multi-entity → first entity for both
 * - Single entity (with annotations stripped) → both same
 */
function parseOwners(cell: string): [string | null, string | null] {
  const cleaned = cell
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim();
  if (!cleaned) return [null, null];

  const arrowSplit = cleaned.split(/→|->/);
  if (arrowSplit.length >= 2) {
    const lhs = firstEntity(arrowSplit[0]);
    const rhs = firstEntity(arrowSplit[arrowSplit.length - 1]);
    return [lhs || null, rhs || null];
  }

  const first = firstEntity(cleaned);
  return [first || null, first || null];
}

function firstEntity(text: string): string | null {
  const tokens = text
    .split(/[+/,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const first = tokens[0].replace(/\s+/g, " ").trim();
  if (!first) return null;
  const words = first.split(/\s+/);
  const truncated: string[] = [];
  for (const w of words) {
    if (truncated.length > 0 && /^[a-z]/.test(w)) break;
    truncated.push(w);
  }
  return truncated.join(" ") || null;
}

function stripCodeFormatting(text: string): string {
  return text.replace(/`/g, "").trim();
}

function rowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Parse a markdown table starting at the first table delimiter row.
 * Returns rows as cell arrays, or null if no table found.
 */
function parseMarkdownTable(snippet: string): string[][] | null {
  const lines = snippet.split(/\r?\n/);
  let headerIdx = -1;
  let delimiterIdx = -1;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (
      line.includes("|")
      && /^\s*\|?[\s|:-]+\|[\s|:-]+/.test(next)
    ) {
      headerIdx = i;
      delimiterIdx = i + 1;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const splitTableRow = (raw: string): string[] => {
    const PLACEHOLDER = "\x00ESC_PIPE\x00";
    return raw
      .replace(/\\\|/g, PLACEHOLDER)
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.replaceAll(PLACEHOLDER, "|").trim());
  };

  const rows: string[][] = [];
  for (let i = delimiterIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|")) break;
    if (/^\s*$/.test(line)) break;
    rows.push(splitTableRow(line));
  }

  const header = splitTableRow(lines[headerIdx]);

  return [header, ...rows];
}

/**
 * Find the Snapshot table in active-projects.md.
 * Returns the table region as string, or null if not found.
 *
 * Splits content by H2 headings (`\n## `) to isolate the Snapshot block,
 * trimmed at the next `---` horizontal rule (which separates Snapshot
 * from Project Detail in the Steward log convention).
 */
function extractSnapshotSection(content: string): string | null {
  const normalized = content.startsWith("## ") ? `\n${content}` : content;
  const sections = normalized.split(/\n##\s+/);
  const snapshot = sections.find((s) => /^Snapshot\b/i.test(s));
  if (!snapshot) return null;
  const horizontalRule = snapshot.search(/\n---\s*\n/);
  return horizontalRule >= 0 ? snapshot.slice(0, horizontalRule) : snapshot;
}

export function parseStewardLog(
  content: string,
  options: { source_path?: string } = {},
): StewardParseResult {
  const warnings: string[] = [];
  const result: StewardParseResult = {
    rows: [],
    warnings,
    parsed_at: new Date().toISOString(),
    source_path: options.source_path || stewardLogPath(),
  };

  const snapshotSection = extractSnapshotSection(content);
  if (!snapshotSection) {
    warnings.push("steward-log: no '## Snapshot' heading found");
    return result;
  }

  const table = parseMarkdownTable(snapshotSection);
  if (!table || table.length < 2) {
    warnings.push("steward-log: no parseable table under Snapshot heading");
    return result;
  }

  const [header, ...dataRows] = table;
  const headerLower = header.map((h) => h.toLowerCase());

  const idxNum = headerLower.findIndex((h) => h === "#" || h.includes("row"));
  const idxProject = headerLower.findIndex((h) => h.includes("project"));
  const idxOwner = headerLower.findIndex((h) => h.includes("owner"));
  const idxDod = headerLower.findIndex((h) => h.includes("dod") || h.includes("purpose"));
  const idxStatus = headerLower.findIndex((h) => h === "status");

  if (idxProject === -1 || idxOwner === -1 || idxStatus === -1) {
    warnings.push(
      `steward-log: required columns missing (project=${idxProject} owner=${idxOwner} status=${idxStatus})`,
    );
    return result;
  }

  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i];
    const rowLabel = `row ${i + 1}`;

    const numCell = idxNum >= 0 ? cells[idxNum] : "";
    const rowNumber = Number.parseInt(numCell, 10);
    const projectName = (cells[idxProject] || "").replace(/\*\*/g, "").trim();
    const ownerCell = cells[idxOwner] || "";
    const dodCell = idxDod >= 0 ? cells[idxDod] || "" : "";
    const statusCell = cells[idxStatus] || "";

    if (!projectName) {
      warnings.push(`${rowLabel}: missing project name; skipped`);
      continue;
    }

    const status = classifyStatus(statusCell);
    if (status === null) {
      warnings.push(
        `${rowLabel} (${projectName}): unrecognized status "${statusCell.slice(0, 40)}"; skipped`,
      );
      continue;
    }
    if (status === "closed") {
      continue;
    }

    const [receivedFrom, currentOwner] = parseOwners(ownerCell);
    if (!currentOwner) {
      warnings.push(`${rowLabel} (${projectName}): owner unparseable; emitting with null owner`);
    }

    const why = stripCodeFormatting(dodCell) || null;
    if (!why) {
      warnings.push(`${rowLabel} (${projectName}): DoD/why missing — Leo flagged as critical-not-to-lose`);
    }

    const driftCheck = projectName && content.includes(`### ${Number.isFinite(rowNumber) ? rowNumber : i + 1}.`)
      ? "in-scope"
      : null;

    result.rows.push({
      id: `steward-${Number.isFinite(rowNumber) ? rowNumber : i + 1}-${rowSlug(projectName)}`,
      row_number: Number.isFinite(rowNumber) ? rowNumber : i + 1,
      project_name: projectName,
      received_from: receivedFrom,
      current_owner: currentOwner,
      status,
      why,
      drift_check: driftCheck,
    });
  }

  return result;
}

export function readStewardLog(path: string = stewardLogPath()): StewardParseResult {
  if (!existsSync(path)) {
    return {
      rows: [],
      warnings: [`steward-log: file not found at ${path}`],
      parsed_at: new Date().toISOString(),
      source_path: path,
    };
  }
  try {
    const content = readFileSync(path, "utf-8");
    return parseStewardLog(content, { source_path: path });
  } catch (err) {
    return {
      rows: [],
      warnings: [`steward-log: read failed — ${String((err as Error).message || err)}`],
      parsed_at: new Date().toISOString(),
      source_path: path,
    };
  }
}

/**
 * Merge Steward log rows with the 4 hardcoded projects from latest.json.
 * Per spec rule 3: Steward log wins on collision; otherwise hardcoded preserved.
 *
 * Collision detection: case-insensitive substring match on hardcoded id/title
 * vs Steward project_name. Examples:
 *   - hardcoded "control-tower-v0" / "Control Tower v0" matches Steward
 *     row "CT v0 promotion → daily-test"
 *   - hardcoded "skill-registry-v1-1" / "Skill Registry v1.1" matches Steward
 *     row "Skill Registry v1 (Codex draft)"
 */
export type HardcodedProject = {
  id: string;
  title?: string;
  owner?: string;
  status?: string;
  summary?: string;
  [key: string]: unknown;
};

export type MergedProject = {
  source: "steward" | "hardcoded";
  /** 5-column shape per F2 spec — present on every emitted row. */
  received_from: string | null;
  current_owner: string | null;
  status: string;
  why: string | null;
  drift_check: string | null;
  /** Original project identifier — preserved for backward compat with existing UI. */
  id: string;
  /** Display name. */
  title: string;
  /** Unmodified raw row (for debugging / future field needs). */
  raw?: Record<string, unknown>;
};

function hardcodedCollidesWith(hard: HardcodedProject, stewardRow: StewardRow): boolean {
  const haystack = `${hard.id} ${hard.title || ""}`.toLowerCase();
  const needle = stewardRow.project_name.toLowerCase();

  const idTokens = (hard.id || "").toLowerCase().split(/[-_]/).filter((t) => t.length > 2);
  for (const token of idTokens) {
    if (needle.includes(token)) return true;
  }

  const titleTokens = (hard.title || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (titleTokens.length >= 2) {
    const matchCount = titleTokens.filter((t) => needle.includes(t)).length;
    if (matchCount >= Math.ceil(titleTokens.length * 0.5)) return true;
  }

  if (haystack.includes(needle.split(/[-—–]/)[0].trim())) return true;

  const titleWords = (hard.title || "").split(/\s+/).filter((w) => /^[A-Z]/.test(w));
  if (titleWords.length >= 2) {
    const acronym = titleWords.map((w) => w[0]).join("").toLowerCase();
    const acronymHits = needle.match(new RegExp(`\\b${acronym}\\b`, "g"));
    if (acronymHits) {
      const versionMatch = haystack.match(/\bv\d+(?:\.\d+)?\b/);
      if (versionMatch) {
        const versionPattern = new RegExp(`\\b${versionMatch[0]}\\b`);
        if (versionPattern.test(needle)) return true;
      } else {
        return true;
      }
    }
  }

  return false;
}

export function mergeStewardWithHardcoded(
  stewardResult: StewardParseResult,
  hardcoded: HardcodedProject[],
): { merged: MergedProject[]; collisions: string[] } {
  const collisions: string[] = [];
  const merged: MergedProject[] = [];

  for (const row of stewardResult.rows) {
    merged.push({
      source: "steward",
      received_from: row.received_from,
      current_owner: row.current_owner,
      status: row.status,
      why: row.why,
      drift_check: row.drift_check,
      id: row.id,
      title: row.project_name,
      raw: row as unknown as Record<string, unknown>,
    });
  }

  for (const hard of hardcoded) {
    const collision = stewardResult.rows.find((r) => hardcodedCollidesWith(hard, r));
    if (collision) {
      collisions.push(
        `hardcoded "${hard.id}" collides with steward row #${collision.row_number} "${collision.project_name}" — steward wins`,
      );
      continue;
    }

    merged.push({
      source: "hardcoded",
      received_from: typeof hard.owner === "string" ? hard.owner : null,
      current_owner: typeof hard.owner === "string" ? hard.owner : null,
      status: typeof hard.status === "string" ? hard.status : "active",
      why: typeof hard.summary === "string" ? hard.summary : null,
      drift_check: "in-scope",
      id: hard.id,
      title: typeof hard.title === "string" ? hard.title : hard.id,
      raw: hard as Record<string, unknown>,
    });
  }

  return { merged, collisions };
}
