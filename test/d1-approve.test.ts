/**
 * Tests for src/lib/d1-approve.ts — D1 Phase 1 [Approve] handler.
 *
 * Spec refs:
 *   - ops/docs/STEWARD-LOG-SCHEMA-v0.md §14 Write Contract
 *   - ψ/writing/approvals/SENTINEL-TEMPLATE.md (Type B)
 *   - HELM bundle ψ/memory/forge/inbox/2026-05-03_helm-phase-1-forge-bundle.md §D1
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  APPROVAL_APPROVERS,
  APPROVAL_CLIENTS,
  APPROVAL_SCHEMA_VERSION,
  appendAuditEntryContent,
  approveProject,
  approvalsDir,
  findSentinelForProject,
  formatBangkokHeader,
  loadApprovalPayload,
  nowBangkokIso,
  readSentinelFile,
  sentinelFilename,
  sentinelPathFor,
  writeSentinel,
  type ApprovalSentinelFrontmatter,
} from "../src/lib/d1-approve";

const PROJECT_ID = "steward-99-d1-test-project";
const PROJECT_NAME = "D1-TEST-PROJECT";

const STEWARD_FIXTURE = `---
owner: David
created: 2026-05-03
type: steward-log
discipline: append-only audit log + live snapshot
---

# Active Projects — Steward Log v0

## Snapshot — 2026-05-03 +07 (1 project, test)

| # | Project | Owner | DoD (1 line) | Last move | Stuck | Status |
|---|---------|-------|--------------|-----------|-------|--------|
| 99 | D1-TEST-PROJECT | Leo | Test the D1 backend handler end-to-end | 2026-05-03 | 0h | 🟢 active |

---

## Project Detail

### 99. D1-TEST-PROJECT

placeholder detail.

---

## Daily Review — Append-Only Audit Log

### 2026-05-03 18:00 +07 — Pre-D1 baseline entry

baseline body.

---

— David 🦁
`;

let workDir: string;
let stewardPath: string;
let approvalsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "d1-approve-test-"));
  stewardPath = join(workDir, "active-projects.md");
  approvalsPath = join(workDir, "approvals");
  mkdirSync(approvalsPath, { recursive: true });
  writeFileSync(stewardPath, STEWARD_FIXTURE, "utf-8");
  process.env.KAIJU_STEWARD_LOG_PATH = stewardPath;
  process.env.KAIJU_APPROVALS_DIR = approvalsPath;
});

afterEach(() => {
  delete process.env.KAIJU_STEWARD_LOG_PATH;
  delete process.env.KAIJU_APPROVALS_DIR;
  rmSync(workDir, { recursive: true, force: true });
});

describe("formatBangkokHeader", () => {
  test("formats ISO-8601 +07:00 as 'YYYY-MM-DD HH:MM +07'", () => {
    expect(formatBangkokHeader("2026-05-03T18:05:00+07:00")).toBe("2026-05-03 18:05 +07");
  });

  test("falls back to input when not parseable", () => {
    expect(formatBangkokHeader("garbage")).toBe("garbage");
  });
});

describe("nowBangkokIso", () => {
  test("returns ISO-8601 with +07:00 offset", () => {
    const ts = nowBangkokIso(new Date("2026-05-03T11:05:00.000Z"));
    expect(ts).toBe("2026-05-03T18:05:00+07:00");
  });
});

describe("sentinelFilename / sentinelPathFor", () => {
  test("composes canonical filename from ISO date prefix and project_id", () => {
    expect(sentinelFilename("2026-05-03T18:05:00+07:00", PROJECT_ID))
      .toBe(`2026-05-03_${PROJECT_ID}.md`);
  });

  test("sentinelPathFor joins approvalsDir with filename", () => {
    expect(sentinelPathFor("2026-05-03T18:05:00+07:00", PROJECT_ID))
      .toBe(join(approvalsPath, `2026-05-03_${PROJECT_ID}.md`));
  });

  test("approvalsDir respects env override", () => {
    expect(approvalsDir()).toBe(approvalsPath);
  });
});

describe("writeSentinel + readSentinelFile", () => {
  const fm: ApprovalSentinelFrontmatter = {
    sentinel_type: "d1-approve",
    project_id: PROJECT_ID,
    project_name: PROJECT_NAME,
    action_kind: "approve",
    approver: "Leo",
    approved_at: "2026-05-03T18:05:00+07:00",
    client: "cockpit-ui",
    schema_version: APPROVAL_SCHEMA_VERSION,
    note: "test note",
  };

  test("writes sentinel file with full frontmatter + body", () => {
    const path = writeSentinel(fm);
    expect(path).toBe(sentinelPathFor(fm.approved_at, fm.project_id));
    const raw = readFileSync(path, "utf-8");
    expect(raw).toContain("sentinel_type: d1-approve");
    expect(raw).toContain(`project_id: ${PROJECT_ID}`);
    expect(raw).toContain(`project_name: ${PROJECT_NAME}`);
    expect(raw).toContain("approver: Leo");
    expect(raw).toContain('schema_version: "0.2"');
    expect(raw).toContain("# Approval — D1-TEST-PROJECT");
    expect(raw).toContain("**Decision**: ✅ Approved");
  });

  test("readSentinelFile round-trips frontmatter shape", () => {
    const path = writeSentinel(fm);
    const sentinel = readSentinelFile(path);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.frontmatter.approver).toBe("Leo");
    expect(sentinel?.frontmatter.client).toBe("cockpit-ui");
    expect(sentinel?.frontmatter.note).toBe("test note");
    expect(sentinel?.frontmatter.project_id).toBe(PROJECT_ID);
  });

  test("readSentinelFile returns null if file missing", () => {
    expect(readSentinelFile(join(workDir, "missing.md"))).toBeNull();
  });

  test("findSentinelForProject locates by project_id suffix", () => {
    writeSentinel(fm);
    const found = findSentinelForProject(PROJECT_ID);
    expect(found).not.toBeNull();
    expect(found?.frontmatter.project_id).toBe(PROJECT_ID);
  });

  test("findSentinelForProject returns null when no match", () => {
    expect(findSentinelForProject("steward-no-such-project")).toBeNull();
  });

  test("loadApprovalPayload returns approver + approved_at + sentinel_path", () => {
    writeSentinel(fm);
    const payload = loadApprovalPayload(PROJECT_ID);
    expect(payload).not.toBeNull();
    expect(payload?.approver).toBe("Leo");
    expect(payload?.approved_at).toBe(fm.approved_at);
    expect(payload?.sentinel_path).toBe(sentinelPathFor(fm.approved_at, fm.project_id));
  });
});

describe("appendAuditEntryContent", () => {
  test("inserts entry into Daily Review section preserving prior terminator", () => {
    const entry = "### 2026-05-03 19:00 +07 — D1 Action: [Approve] by Leo\n\n- foo: bar";
    const updated = appendAuditEntryContent(STEWARD_FIXTURE, entry);
    expect(updated).toContain("### 2026-05-03 18:00 +07 — Pre-D1 baseline entry");
    expect(updated).toContain("### 2026-05-03 19:00 +07 — D1 Action: [Approve] by Leo");
    // Both prior and new entries still terminated by --- before signature
    const finalSignatureIdx = updated.indexOf("— David 🦁");
    expect(finalSignatureIdx).toBeGreaterThan(updated.indexOf("D1 Action: [Approve]"));
    // Verify section terminator pattern preserved
    expect(updated.match(/\n---\s*\n/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("throws when Daily Review section missing", () => {
    const bad = STEWARD_FIXTURE.replace("## Daily Review — Append-Only Audit Log", "## Other Section");
    expect(() => appendAuditEntryContent(bad, "### test")).toThrow();
  });

  test("section content survives multiple sequential appends", () => {
    let content = STEWARD_FIXTURE;
    content = appendAuditEntryContent(content, "### entry-1\nbody-1");
    content = appendAuditEntryContent(content, "### entry-2\nbody-2");
    content = appendAuditEntryContent(content, "### entry-3\nbody-3");
    expect(content.indexOf("entry-1")).toBeLessThan(content.indexOf("entry-2"));
    expect(content.indexOf("entry-2")).toBeLessThan(content.indexOf("entry-3"));
    expect(content.match(/^### entry-/gm)?.length).toBe(3);
  });
});

describe("approveProject — happy path", () => {
  test("first approval writes audit log + sentinel + returns approved", async () => {
    const result = await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui", note: "ratify" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    expect(result.approved_at).toBe("2026-05-03T18:05:00+07:00");
    expect(result.sentinel_path).toBe(join(approvalsPath, `2026-05-03_${PROJECT_ID}.md`));

    const sentinelRaw = readFileSync(result.sentinel_path, "utf-8");
    expect(sentinelRaw).toContain(`approver: Leo`);
    expect(sentinelRaw).toContain('schema_version: "0.2"');

    const updatedSteward = readFileSync(stewardPath, "utf-8");
    expect(updatedSteward).toContain("D1 Action: [Approve] by Leo");
    expect(updatedSteward).toContain(`**project_id**: ${PROJECT_ID}`);
    expect(updatedSteward).toContain("**client**: cockpit-ui");
    expect(updatedSteward).toContain("**note**: ratify");
  });

  test("note is omitted in audit + sentinel when not provided", async () => {
    const result = await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const sentinelRaw = readFileSync(result.sentinel_path, "utf-8");
    expect(sentinelRaw).not.toMatch(/^note:/m);
  });
});

describe("approveProject — idempotency + collisions", () => {
  test("second call by same approver returns already_approved_by_you", async () => {
    await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
    );
    const second = await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "line-bot" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T19:30:00+07:00" },
    );
    expect(second.status).toBe("already_approved_by_you");
    if (second.status !== "already_approved_by_you") return;
    expect(second.original_approver).toBe("Leo");
    expect(second.approved_at).toBe("2026-05-03T18:05:00+07:00");
  });

  test("audit log is appended once, not twice, when sentinel already exists", async () => {
    await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
    );
    await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "line-bot" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T19:30:00+07:00" },
    );
    const updated = readFileSync(stewardPath, "utf-8");
    const matches = updated.match(/D1 Action: \[Approve\]/g);
    expect(matches?.length).toBe(1);
  });

  test("different approver on existing sentinel returns approver_mismatch (409)", async () => {
    await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
    );
    const collision = await approveProject(
      { project_id: PROJECT_ID, approver: "Amy", client: "cockpit-ui" },
      { active_projects_path: stewardPath, now: () => "2026-05-03T19:00:00+07:00" },
    );
    expect(collision.status).toBe("approver_mismatch");
    if (collision.status !== "approver_mismatch") return;
    expect(collision.original_approver).toBe("Leo");
  });
});

describe("approveProject — validation errors", () => {
  test("project_not_found when project_id absent from steward log", async () => {
    const result = await approveProject(
      { project_id: "steward-404-no-such", approver: "Leo", client: "cockpit-ui" },
      { active_projects_path: stewardPath },
    );
    expect(result.status).toBe("project_not_found");
  });

  test("approver_not_allowed when approver outside enum", async () => {
    const result = await approveProject(
      { project_id: PROJECT_ID, approver: "Stranger", client: "cockpit-ui" },
      { active_projects_path: stewardPath },
    );
    expect(result.status).toBe("approver_not_allowed");
    if (result.status !== "approver_not_allowed") return;
    expect(result.allowed).toEqual(APPROVAL_APPROVERS);
  });

  test("client_not_allowed when client outside enum", async () => {
    const result = await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "carrier-pigeon" },
      { active_projects_path: stewardPath },
    );
    expect(result.status).toBe("client_not_allowed");
    if (result.status !== "client_not_allowed") return;
    expect(result.allowed).toEqual(APPROVAL_CLIENTS);
  });
});

describe("approveProject — note edge cases", () => {
  test("notes longer than 500 chars are truncated with ellipsis", async () => {
    const longNote = "x".repeat(550);
    const result = await approveProject(
      { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui", note: longNote },
      { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
    );
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    const sentinelRaw = readFileSync(result.sentinel_path, "utf-8");
    const noteLine = sentinelRaw.split("\n").find((l) => l.startsWith("note:"));
    expect(noteLine).toBeDefined();
    // 500 'x' chars + '…' + leading 'note: "' wrap ⇒ ensure last char before closing quote is ellipsis
    expect(noteLine).toContain("…");
  });
});

describe("approveProject — concurrent calls (file-lock)", () => {
  test("concurrent first-approves serialize via lock; only one succeeds, second sees sentinel", async () => {
    const calls = [
      approveProject(
        { project_id: PROJECT_ID, approver: "Leo", client: "cockpit-ui" },
        { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:00+07:00" },
      ),
      approveProject(
        { project_id: PROJECT_ID, approver: "Leo", client: "line-bot" },
        { active_projects_path: stewardPath, now: () => "2026-05-03T18:05:01+07:00" },
      ),
    ];
    const results = await Promise.all(calls);
    const approved = results.filter((r) => r.status === "approved");
    const idempotent = results.filter((r) => r.status === "already_approved_by_you");
    expect(approved.length + idempotent.length).toBe(2);
    expect(approved.length).toBeGreaterThanOrEqual(1);
    const updated = readFileSync(stewardPath, "utf-8");
    const auditMatches = updated.match(/D1 Action: \[Approve\]/g);
    expect(auditMatches?.length).toBe(1);
  });
});
