/**
 * D1 — POST /api/kaiju/control-tower/approve
 *
 * Spec refs:
 *   - ops/docs/STEWARD-LOG-SCHEMA-v0.md §14 Write Contract
 *   - ψ/writing/approvals/SENTINEL-TEMPLATE.md (Type B sentinel shape)
 *   - ψ/writing/approvals/EXAMPLE-2026-05-03_steward-18-phase-1-mvp-scope.md (worked example)
 *
 * Two side effects per successful approve:
 *   1. Append structured entry to active-projects.md ## Daily Review section (file-locked)
 *   2. Write sentinel file at ψ/writing/approvals/{date}_{project-id}.md
 *
 * Idempotency: sentinel file existence = "approved" guard. Double-click returns
 * `already_approved_by_you` if same approver, `409 approver_mismatch` if different.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import lockfile from "proper-lockfile";
import { readStewardLog, stewardLogPath, type StewardRow } from "./steward-log-parser";

export const APPROVAL_APPROVERS = ["Leo", "Amy", "HELM", "David", "KaijuPM", "WATCHDOG"] as const;
export type ApprovalApprover = (typeof APPROVAL_APPROVERS)[number];

export const APPROVAL_CLIENTS = ["cockpit-ui", "line-bot", "telegram-bot", "cli"] as const;
export type ApprovalClient = (typeof APPROVAL_CLIENTS)[number];

export const APPROVAL_SCHEMA_VERSION = "0.2" as const;

export type ApprovalSentinelFrontmatter = {
  sentinel_type: "d1-approve";
  project_id: string;
  project_name: string;
  action_kind: "approve";
  approver: ApprovalApprover;
  approved_at: string;
  client: ApprovalClient;
  schema_version: typeof APPROVAL_SCHEMA_VERSION;
  note?: string;
};

export type ApprovalSentinel = {
  path: string;
  frontmatter: ApprovalSentinelFrontmatter;
};

export type ApproveRequest = {
  project_id: string;
  approver: string;
  client: string;
  note?: string;
};

export type ApproveResult =
  | { status: "approved"; approved_at: string; sentinel_path: string }
  | {
      status: "already_approved_by_you";
      approved_at: string;
      sentinel_path: string;
      original_approver: ApprovalApprover;
    }
  | {
      status: "approver_mismatch";
      approved_at: string;
      sentinel_path: string;
      original_approver: ApprovalApprover;
    }
  | { status: "project_not_found"; project_id: string }
  | { status: "approver_not_allowed"; approver: string; allowed: readonly string[] }
  | { status: "client_not_allowed"; client: string; allowed: readonly string[] }
  | { status: "lock_timeout" };

const NOTE_MAX_CHARS = 500;

export function approvalsDir(): string {
  return (
    process.env.KAIJU_APPROVALS_DIR
    || join(homedir(), "david-oracle", "ψ", "writing", "approvals")
  );
}

export function sentinelFilename(approvedAt: string, projectId: string): string {
  const date = approvedAt.slice(0, 10);
  return `${date}_${projectId}.md`;
}

export function sentinelPathFor(approvedAt: string, projectId: string): string {
  return join(approvalsDir(), sentinelFilename(approvedAt, projectId));
}

/**
 * Bangkok-zone timestamp suitable for the audit-log entry header.
 * Matches existing convention: `YYYY-MM-DD HH:MM +07`.
 */
export function formatBangkokHeader(isoTs: string): string {
  // ISO has the offset baked in if we generated it that way; if it's plain Z,
  // shift to +07 manually.
  const m = isoTs.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return isoTs;
  return `${m[1]} ${m[2]}:${m[3]} +07`;
}

/**
 * ISO-8601 timestamp at Asia/Bangkok offset (UTC+07:00).
 */
export function nowBangkokIso(now: Date = new Date()): string {
  const utcMs = now.getTime();
  const bkk = new Date(utcMs + 7 * 60 * 60 * 1000);
  const yyyy = bkk.getUTCFullYear();
  const mm = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bkk.getUTCDate()).padStart(2, "0");
  const hh = String(bkk.getUTCHours()).padStart(2, "0");
  const mi = String(bkk.getUTCMinutes()).padStart(2, "0");
  const ss = String(bkk.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+07:00`;
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key) fields[key] = value;
  }
  return fields;
}

export function readSentinelFile(path: string): ApprovalSentinel | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const fields = parseFrontmatter(raw);
  if (!fields) return null;
  if (fields.sentinel_type !== "d1-approve") return null;
  if (!APPROVAL_APPROVERS.includes(fields.approver as ApprovalApprover)) return null;
  if (!APPROVAL_CLIENTS.includes(fields.client as ApprovalClient)) return null;
  return {
    path,
    frontmatter: {
      sentinel_type: "d1-approve",
      project_id: fields.project_id,
      project_name: fields.project_name,
      action_kind: "approve",
      approver: fields.approver as ApprovalApprover,
      approved_at: fields.approved_at,
      client: fields.client as ApprovalClient,
      schema_version: APPROVAL_SCHEMA_VERSION,
      note: fields.note || undefined,
    },
  };
}

/**
 * Look up the existing sentinel for a project (any date).
 * Returns the most-recent match by filename (date prefix sort).
 */
export function findSentinelForProject(projectId: string): ApprovalSentinel | null {
  const dir = approvalsDir();
  if (!existsSync(dir)) return null;
  const suffix = `_${projectId}.md`;
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}_/.test(name))
    .sort();
  if (candidates.length === 0) return null;
  const latest = candidates[candidates.length - 1];
  return readSentinelFile(join(dir, latest));
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSentinelMarkdown(fm: ApprovalSentinelFrontmatter): string {
  const noteText = fm.note ? fm.note : "(no note provided)";
  const yamlLines = [
    "---",
    `sentinel_type: ${fm.sentinel_type}`,
    `project_id: ${fm.project_id}`,
    `project_name: ${fm.project_name}`,
    `action_kind: ${fm.action_kind}`,
    `approver: ${fm.approver}`,
    `approved_at: ${fm.approved_at}`,
    `client: ${fm.client}`,
    `schema_version: "${fm.schema_version}"`,
  ];
  if (fm.note !== undefined) {
    yamlLines.push(`note: "${escapeYamlString(fm.note)}"`);
  }
  yamlLines.push("---", "");
  const body = [
    `# Approval — ${fm.project_name}`,
    "",
    `**Approver**: ${fm.approver}`,
    `**Decision**: ✅ Approved`,
    `**When**: ${fm.approved_at}`,
    `**Via**: ${fm.client}`,
    "",
    "## Note",
    "",
    noteText,
    "",
    "---",
    "",
    "## Audit trail",
    "",
    `- Linked Steward log: \`${stewardLogPath()}\` §"Daily Review" entry @ ${fm.approved_at}`,
    `- Linked correlation: ${fm.project_id}`,
    "",
    "— D1 backend (cockpit/api/kaiju/control-tower/approve)",
    "",
  ].join("\n");
  return yamlLines.join("\n") + body;
}

export function writeSentinel(fm: ApprovalSentinelFrontmatter): string {
  const dir = approvalsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = sentinelPathFor(fm.approved_at, fm.project_id);
  writeFileSync(path, buildSentinelMarkdown(fm), "utf-8");
  return path;
}

function buildAuditEntry(fm: ApprovalSentinelFrontmatter): string {
  const lines = [
    `### ${formatBangkokHeader(fm.approved_at)} — D1 Action: [Approve] by ${fm.approver}`,
    "",
    `- **project_id**: ${fm.project_id}`,
    `- **project_name**: ${fm.project_name}`,
    `- **action_kind**: ${fm.action_kind}`,
    `- **approver**: ${fm.approver}`,
    `- **timestamp**: ${fm.approved_at}`,
    `- **client**: ${fm.client}`,
  ];
  if (fm.note !== undefined) lines.push(`- **note**: ${fm.note}`);
  return lines.join("\n");
}

/**
 * Insert a new entry into `## Daily Review — Append-Only Audit Log`.
 *
 * Strategy: locate the last `\n---\n` inside the Daily Review section (currently
 * terminates the section / last entry) and insert the new entry block + its own
 * `\n---\n` right AFTER it. The previous terminator stays put as the previous
 * last entry's terminator; ours becomes the new section terminator.
 */
export function appendAuditEntryContent(content: string, entryText: string): string {
  const headingMarker = "\n## Daily Review";
  const headingIdx = content.indexOf(headingMarker);
  if (headingIdx === -1) {
    throw new Error("appendAuditEntryContent: '## Daily Review' section not found");
  }

  const afterHeadingIdx = headingIdx + headingMarker.length;
  const afterHeading = content.slice(afterHeadingIdx);
  const nextH2Match = afterHeading.search(/\n##\s+/);
  const sectionEnd = nextH2Match === -1 ? content.length : afterHeadingIdx + nextH2Match;

  const sectionContent = content.slice(afterHeadingIdx, sectionEnd);
  const terminatorRegex = /\n---\s*\n/g;
  let lastTerminatorRelative = -1;
  let lastTerminatorLen = 0;
  for (const match of sectionContent.matchAll(terminatorRegex)) {
    if (match.index !== undefined) {
      lastTerminatorRelative = match.index;
      lastTerminatorLen = match[0].length;
    }
  }

  const insertion = `\n${entryText.trim()}\n\n---\n`;

  if (lastTerminatorRelative === -1) {
    // No terminator inside the section — append before the section boundary.
    const before = content.slice(0, sectionEnd).replace(/\s+$/, "");
    const after = content.slice(sectionEnd);
    const sep = before.endsWith("\n") ? "\n" : "\n\n";
    return `${before}${sep}${entryText.trim()}\n\n---\n${after}`;
  }

  const insertAt = afterHeadingIdx + lastTerminatorRelative + lastTerminatorLen;
  return content.slice(0, insertAt) + insertion + content.slice(insertAt);
}

export type AppendAuditEntryOptions = {
  active_projects_path?: string;
  lock_retries?: number;
  lock_stale_ms?: number;
};

export async function appendAuditLogEntry(
  fm: ApprovalSentinelFrontmatter,
  options: AppendAuditEntryOptions = {},
): Promise<void> {
  const path = options.active_projects_path || stewardLogPath();
  if (!existsSync(path)) {
    throw new Error(`appendAuditLogEntry: active-projects.md not found at ${path}`);
  }

  const release = await lockfile.lock(path, {
    retries: { retries: options.lock_retries ?? 3, factor: 1, minTimeout: 50, maxTimeout: 500 },
    stale: options.lock_stale_ms ?? 5000,
    realpath: false,
  });
  try {
    const content = readFileSync(path, "utf-8");
    const updated = appendAuditEntryContent(content, buildAuditEntry(fm));
    writeFileSync(path, updated, "utf-8");
  } finally {
    await release();
  }
}

function validateApprover(approver: string): ApprovalApprover | null {
  return (APPROVAL_APPROVERS as readonly string[]).includes(approver)
    ? (approver as ApprovalApprover)
    : null;
}

function validateClient(client: string): ApprovalClient | null {
  return (APPROVAL_CLIENTS as readonly string[]).includes(client)
    ? (client as ApprovalClient)
    : null;
}

function truncateNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  if (note.length <= NOTE_MAX_CHARS) return note;
  return note.slice(0, NOTE_MAX_CHARS) + "…";
}

function findStewardRow(projectId: string): StewardRow | null {
  const result = readStewardLog();
  return result.rows.find((row) => row.id === projectId) || null;
}

export type ApproveProjectOptions = {
  active_projects_path?: string;
  approvals_dir?: string;
  /** Override clock for tests. */
  now?: () => string;
  /** Skip Steward-log lookup (tests). When true, project_name MUST be provided in extras. */
  skip_steward_lookup?: boolean;
  project_name_override?: string;
};

export async function approveProject(
  request: ApproveRequest,
  options: ApproveProjectOptions = {},
): Promise<ApproveResult> {
  const approver = validateApprover(request.approver);
  if (!approver) {
    return {
      status: "approver_not_allowed",
      approver: request.approver,
      allowed: APPROVAL_APPROVERS,
    };
  }

  const client = validateClient(request.client);
  if (!client) {
    return {
      status: "client_not_allowed",
      client: request.client,
      allowed: APPROVAL_CLIENTS,
    };
  }

  let projectName = options.project_name_override;
  if (!options.skip_steward_lookup) {
    const stewardRow = findStewardRow(request.project_id);
    if (!stewardRow) {
      return { status: "project_not_found", project_id: request.project_id };
    }
    projectName = projectName || stewardRow.project_name;
  }
  if (!projectName) {
    return { status: "project_not_found", project_id: request.project_id };
  }

  // Fast-path optimistic check (avoids taking the lock when sentinel already exists).
  const existing = findSentinelForProject(request.project_id);
  if (existing) {
    return existing.frontmatter.approver === approver
      ? {
          status: "already_approved_by_you",
          approved_at: existing.frontmatter.approved_at,
          sentinel_path: existing.path,
          original_approver: existing.frontmatter.approver,
        }
      : {
          status: "approver_mismatch",
          approved_at: existing.frontmatter.approved_at,
          sentinel_path: existing.path,
          original_approver: existing.frontmatter.approver,
        };
  }

  const stewardPath = options.active_projects_path || stewardLogPath();
  if (!existsSync(stewardPath)) {
    throw new Error(`approveProject: active-projects.md not found at ${stewardPath}`);
  }

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(stewardPath, {
      retries: { retries: 5, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
      stale: 5000,
      realpath: false,
    });
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (/lock|ELOCKED|EEXIST/i.test(msg)) return { status: "lock_timeout" };
    throw err;
  }

  try {
    // Re-check sentinel under the lock — closes the check-then-act race
    // when two callers both passed the optimistic check above.
    const lockedExisting = findSentinelForProject(request.project_id);
    if (lockedExisting) {
      return lockedExisting.frontmatter.approver === approver
        ? {
            status: "already_approved_by_you",
            approved_at: lockedExisting.frontmatter.approved_at,
            sentinel_path: lockedExisting.path,
            original_approver: lockedExisting.frontmatter.approver,
          }
        : {
            status: "approver_mismatch",
            approved_at: lockedExisting.frontmatter.approved_at,
            sentinel_path: lockedExisting.path,
            original_approver: lockedExisting.frontmatter.approver,
          };
    }

    const approvedAt = (options.now ?? nowBangkokIso)();
    const note = truncateNote(request.note);

    const fm: ApprovalSentinelFrontmatter = {
      sentinel_type: "d1-approve",
      project_id: request.project_id,
      project_name: projectName,
      action_kind: "approve",
      approver,
      approved_at: approvedAt,
      client,
      schema_version: APPROVAL_SCHEMA_VERSION,
      note,
    };

    const content = readFileSync(stewardPath, "utf-8");
    const updated = appendAuditEntryContent(content, buildAuditEntry(fm));
    writeFileSync(stewardPath, updated, "utf-8");

    const sentinelPath = writeSentinel(fm);
    return { status: "approved", approved_at: approvedAt, sentinel_path: sentinelPath };
  } finally {
    await release();
  }
}

export type ApprovalPayload = {
  approver: ApprovalApprover;
  approved_at: string;
  sentinel_path: string;
};

/**
 * Lookup approval payload for a project — used by GET /api/kaiju/control-tower
 * to attach `approval` field to each steward-source project.
 */
export function loadApprovalPayload(projectId: string): ApprovalPayload | null {
  const sentinel = findSentinelForProject(projectId);
  if (!sentinel) return null;
  return {
    approver: sentinel.frontmatter.approver,
    approved_at: sentinel.frontmatter.approved_at,
    sentinel_path: sentinel.path,
  };
}
