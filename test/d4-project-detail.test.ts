/**
 * Tests for src/lib/d4-project-detail.ts — D4 Phase 1 Project Detail backend.
 *
 * Spec refs:
 *   - ψ/writing/proposals/2026-05-03_phase-1-scope-amendment-D4-project-detail-drawer.md §"D4 spec"
 *   - ops/docs/STEWARD-DETAIL-MARKDOWN-CONTRACT-v0.md §Detail markdown contract v0.1
 *   - HELM bundle ψ/memory/forge/inbox/2026-05-03_helm-phase-1-forge-bundle.md §D4
 *
 * Coverage: rich §Detail block (worked example A), sparse §Detail (worked example B),
 * legacy row without §Detail subsection, malformed header, log sort/limit, related_files,
 * eta extraction, mtime cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_LOG_LIMIT,
  clearProjectDetailCache,
  extractEtaActiveHr,
  extractProjectDetailsZone,
  extractRelatedFiles,
  loadProjectDetail,
  parseDetailBlock,
  parseLogEntry,
  sortLogEntries,
  splitDetailBlocks,
} from "../src/lib/d4-project-detail";

const STEWARD_FIXTURE = `---
owner: David
created: 2026-05-03
type: steward-log
discipline: append-only audit log + live snapshot
---

# Active Projects — Steward Log v0

## Snapshot — 2026-05-03 +07 (3 projects, test)

| # | Project | Owner | DoD (1 line) | Last move | Stuck | Status |
|---|---------|-------|--------------|-----------|-------|--------|
| 18 | PHASE-1-MVP-SCOPE | HELM → FORGE | D1+D2+D3+D4 ship green | 2026-05-03 | 0h | 🟢 active |
| 6 | Rose secretary decision | Leo | Leo decide birth-now | 2026-05-01 | 48h | 🟠 awaiting-leo |
| 50 | Legacy row (no §Detail) | David | placeholder DoD | 2026-04-01 | 0h | 🟢 active |

---

## Project Detail

### 18. PHASE-1-MVP-SCOPE

- **Source**: Leo "ทำไมไม่เริ่มลงมือทำซักที" 16:48 → David ship-today mandate
- **Owner**: HELM PM (execution) → FORGE + VELA + David
- **DoD**: D1 [Approve] button + D2 LINE bot + D3 schema lock + D4 drawer all green
- **Why matters**: Phase 1 sprint requires gate decision
- **Spec**: \`ψ/writing/proposals/2026-05-03_phase-1-scope-MVP-draft-v0.md\`
- **ETA**: ~33-51 active-hr
- **Halt criteria**:
  - lock contention >1% test runs → escalate
  - LINE OAuth >1 day → fallback Telegram
- **Status**: 🟢 in-execution
- **Log**:
  - 2026-05-03 17:50 David draft v0 filed
  - 2026-05-03 18:10 Leo "ตามที่นาย Approve" — all 4 Qs locked
  - 2026-05-03 19:05 HELM ACK + Sprint Plan filed
  - 2026-05-03 21:50 Leo amendment + pace override

---

### 6. Rose secretary decision

- **Source**: ADR-007 v2 (2026-04-12), Amy's secretary mirror of David, LINE
- **Owner**: Leo (decision)
- **DoD**: Leo decide birth-now vs hold-for-MEMO-pilot
- **Why long-cycle**: gated behind MEMO pilot — ไม่ stuck, แค่รอ
- **Log**:
  - 2026-04-12 ADR-007 v2
  - 2026-05-01 12:00 David recall (memory file saved \`project_rose_amy_secretary.md\`)

---

## Daily Review — Append-Only Audit Log

### 2026-05-03 18:00 +07 — baseline

baseline body.

---

— David 🦁
`;

let workDir: string;
let stewardPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "d4-detail-test-"));
  stewardPath = join(workDir, "active-projects.md");
  writeFileSync(stewardPath, STEWARD_FIXTURE, "utf-8");
  process.env.KAIJU_STEWARD_LOG_PATH = stewardPath;
  clearProjectDetailCache();
});

afterEach(() => {
  delete process.env.KAIJU_STEWARD_LOG_PATH;
  rmSync(workDir, { recursive: true, force: true });
  clearProjectDetailCache();
});

describe("extractProjectDetailsZone", () => {
  test("extracts content between '## Project Detail' and next H2", () => {
    const zone = extractProjectDetailsZone(STEWARD_FIXTURE);
    expect(zone).not.toBeNull();
    expect(zone).toContain("### 18. PHASE-1-MVP-SCOPE");
    expect(zone).toContain("### 6. Rose secretary decision");
    expect(zone).not.toContain("Daily Review");
  });

  test("matches both 'Project Detail' (singular) and 'Project Details' (plural)", () => {
    const plural = STEWARD_FIXTURE.replace("## Project Detail", "## Project Details");
    expect(extractProjectDetailsZone(plural)).not.toBeNull();
  });

  test("returns null when section absent", () => {
    expect(extractProjectDetailsZone("# nope\n\n## Other Section")).toBeNull();
  });
});

describe("splitDetailBlocks", () => {
  test("splits zone by '### N.' headers preserving block content", () => {
    const zone = extractProjectDetailsZone(STEWARD_FIXTURE)!;
    const blocks = splitDetailBlocks(zone);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toMatch(/^### 18\./);
    expect(blocks[1]).toMatch(/^### 6\./);
  });

  test("returns empty array on zone without ### headers", () => {
    expect(splitDetailBlocks("\n\n  no headers here  \n\n")).toEqual([]);
  });
});

describe("parseDetailBlock", () => {
  test("captures row_number, project_name, fields, log_lines for rich block", () => {
    const zone = extractProjectDetailsZone(STEWARD_FIXTURE)!;
    const block = parseDetailBlock(splitDetailBlocks(zone)[0])!;
    expect(block.row_number).toBe(18);
    expect(block.project_name).toBe("PHASE-1-MVP-SCOPE");
    expect(block.fields.get("source")?.value).toContain("ทำไมไม่เริ่มลงมือทำซักที");
    expect(block.fields.get("dod")?.value).toContain("D1 [Approve] button");
    expect(block.fields.get("halt criteria")?.sub_bullets).toEqual([
      "lock contention >1% test runs → escalate",
      "LINE OAuth >1 day → fallback Telegram",
    ]);
    expect(block.log_lines.length).toBe(4);
  });

  test("returns null on malformed `### N. NAME` header", () => {
    expect(parseDetailBlock("not a header\n- **Field**: x")).toBeNull();
  });

  test("captures sparse block (no DoD, no Spec)", () => {
    const zone = extractProjectDetailsZone(STEWARD_FIXTURE)!;
    const block = parseDetailBlock(splitDetailBlocks(zone)[1])!;
    expect(block.row_number).toBe(6);
    expect(block.fields.get("source")?.value).toBeTruthy();
    expect(block.fields.get("spec")).toBeUndefined();
    expect(block.fields.get("eta")).toBeUndefined();
  });
});

describe("parseLogEntry", () => {
  test("parses 'YYYY-MM-DD HH:MM actor event' to timestamp + actor + event", () => {
    const e = parseLogEntry("2026-05-03 18:10 Leo \"ตามที่นาย Approve\" — all 4 Qs locked");
    expect(e.timestamp).toBe("2026-05-03T18:10:00+07:00");
    expect(e.actor).toBe("Leo");
    expect(e.event).toContain("ตามที่นาย");
  });

  test("falls back to 00:00 when time-of-day absent", () => {
    const e = parseLogEntry("2026-04-12 ADR-007 v2");
    expect(e.timestamp).toBe("2026-04-12T00:00:00+07:00");
    expect(e.actor).toBe("ADR-007");
  });

  test("returns timestamp:null actor:'unknown' for unparseable line", () => {
    const e = parseLogEntry("a stray bullet line");
    expect(e.timestamp).toBeNull();
    expect(e.actor).toBe("unknown");
    expect(e.event).toBe("a stray bullet line");
  });
});

describe("sortLogEntries", () => {
  test("newest_first sorts ISO timestamps descending", () => {
    const entries = [
      { timestamp: "2026-05-03T18:10:00+07:00", actor: "Leo", event: "x" },
      { timestamp: "2026-05-03T17:50:00+07:00", actor: "David", event: "y" },
      { timestamp: "2026-05-03T19:05:00+07:00", actor: "HELM", event: "z" },
    ];
    const sorted = sortLogEntries(entries, "newest_first");
    expect(sorted.map((e) => e.actor)).toEqual(["HELM", "Leo", "David"]);
  });

  test("entries with null timestamp sink to end", () => {
    const entries = [
      { timestamp: "2026-05-03T18:00:00+07:00", actor: "A", event: "" },
      { timestamp: null, actor: "B", event: "" },
    ];
    const sorted = sortLogEntries(entries, "newest_first");
    expect(sorted[0].actor).toBe("A");
    expect(sorted[1].actor).toBe("B");
  });
});

describe("extractRelatedFiles", () => {
  test("extracts ψ/, ops/, *.md, https:// patterns", () => {
    const text = "see `ψ/writing/proposals/foo.md` and ops/docs/bar.md or https://example.com/x";
    const files = extractRelatedFiles(text);
    expect(files).toContain("ψ/writing/proposals/foo.md");
    expect(files).toContain("ops/docs/bar.md");
    expect(files).toContain("https://example.com/x");
  });

  test("dedupes repeated paths", () => {
    const text = "`a.md` then `a.md` again";
    expect(extractRelatedFiles(text)).toEqual(["a.md"]);
  });
});

describe("extractEtaActiveHr", () => {
  test("extracts midpoint from range '~33-51 active-hr'", () => {
    expect(extractEtaActiveHr("~33-51 active-hr")).toBe(42);
  });

  test("extracts single value 'X active-hr'", () => {
    expect(extractEtaActiveHr("4 active-hr")).toBe(4);
  });

  test("returns null when no match", () => {
    expect(extractEtaActiveHr("no eta here")).toBeNull();
  });
});

describe("loadProjectDetail — happy paths", () => {
  test("rich block returns full payload (Source/DoD/Halt/Log)", () => {
    const result = loadProjectDetail("steward-18-phase-1-mvp-scope", {
      active_projects_path: stewardPath,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const p = result.payload;
    expect(p.project_id).toBe("steward-18-phase-1-mvp-scope");
    expect(p.detail.source).toContain("ship-today mandate");
    expect(p.detail.why_matters).toContain("Phase 1 sprint");
    expect(p.plan.dod).toContain("D1 [Approve] button");
    expect(p.plan.eta_active_hr).toBe(42);
    expect(p.plan.halt_criteria.length).toBe(2);
    expect(p.plan.spec_path).toBe("ψ/writing/proposals/2026-05-03_phase-1-scope-MVP-draft-v0.md");
    expect(p.log.length).toBe(4);
    expect(p.log[0].actor).toBe("Leo");
    expect(p.log[0].timestamp).toBe("2026-05-03T21:50:00+07:00");
  });

  test("sparse block returns payload with empty optional fields", () => {
    const result = loadProjectDetail("steward-6-rose-secretary-decision", {
      active_projects_path: stewardPath,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const p = result.payload;
    expect(p.detail.source).toContain("ADR-007");
    expect(p.detail.why_matters).toContain("MEMO pilot");
    expect(p.plan.spec_path).toBeNull();
    expect(p.plan.eta_active_hr).toBeNull();
    expect(p.plan.halt_criteria).toEqual([]);
    expect(p.log.length).toBe(2);
    expect(p.log[0].actor).toBe("David");
  });

  test("legacy row missing §Detail subsection returns payload with empty detail/plan + 5-col preserved", () => {
    const result = loadProjectDetail("steward-50-legacy-row-no-detail", {
      active_projects_path: stewardPath,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const p = result.payload;
    expect(p.project_id).toBe("steward-50-legacy-row-no-detail");
    expect(p.detail.owner_notes).toBe("");
    expect(p.plan.dod).toBe("");
    expect(p.log).toEqual([]);
  });

  test("project_not_found returns 404 sentinel for unknown id", () => {
    const result = loadProjectDetail("steward-9999-no-such", {
      active_projects_path: stewardPath,
    });
    expect(result.status).toBe("not_found");
  });
});

describe("loadProjectDetail — log limit + paging", () => {
  test("default limit caps log at DEFAULT_LOG_LIMIT (10)", () => {
    expect(DEFAULT_LOG_LIMIT).toBe(10);
    // PHASE-1 fixture has 4 entries; default limit doesn't truncate; the cap is exercised by config
    const result = loadProjectDetail("steward-18-phase-1-mvp-scope", {
      active_projects_path: stewardPath,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.payload.log.length).toBeLessThanOrEqual(10);
  });

  test("explicit log_limit caps results", () => {
    const result = loadProjectDetail("steward-18-phase-1-mvp-scope", {
      active_projects_path: stewardPath,
      log_limit: 2,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.payload.log.length).toBe(2);
    // newest-first preserved
    expect(result.payload.log[0].timestamp! > result.payload.log[1].timestamp!).toBe(true);
  });

  test("log_all bypasses limit", () => {
    const result = loadProjectDetail("steward-18-phase-1-mvp-scope", {
      active_projects_path: stewardPath,
      log_all: true,
      log_limit: 1,
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.payload.log.length).toBe(4);
  });
});

describe("loadProjectDetail — cache + mtime invalidation", () => {
  test("repeated calls hit cache (no re-parse) until mtime changes", () => {
    const r1 = loadProjectDetail("steward-18-phase-1-mvp-scope", { active_projects_path: stewardPath });
    expect(r1.status).toBe("ok");
    const r2 = loadProjectDetail("steward-18-phase-1-mvp-scope", { active_projects_path: stewardPath });
    expect(r2.status).toBe("ok");
    if (r1.status === "ok" && r2.status === "ok") {
      expect(r1.payload.detail.source).toBe(r2.payload.detail.source);
    }
  });

  test("file mtime change invalidates cache and reflects new content", () => {
    loadProjectDetail("steward-18-phase-1-mvp-scope", { active_projects_path: stewardPath });
    const updated = STEWARD_FIXTURE.replace(
      "ship-today mandate",
      "ship-today mandate (UPDATED)",
    );
    writeFileSync(stewardPath, updated, "utf-8");
    // Bump mtime explicitly to ensure delta is observable on quick filesystems
    const future = new Date(Date.now() + 5000);
    utimesSync(stewardPath, future, future);
    const r2 = loadProjectDetail("steward-18-phase-1-mvp-scope", { active_projects_path: stewardPath });
    if (r2.status !== "ok") throw new Error("expected ok");
    expect(r2.payload.detail.source).toContain("UPDATED");
  });
});
