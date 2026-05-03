/**
 * Tests for D2 LINE bot — Phase 1.
 *
 * Spec refs:
 *   - HELM bundle ψ/memory/forge/inbox/2026-05-03_helm-phase-1-forge-bundle.md §D2
 *   - David spec  ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md
 *
 * Required test set per HELM bundle:
 *   - T1 push (surfaced-leo flip → push within dedup window)
 *   - R1 reply round-trip via D1 /approve
 *   - R5 identity (Rule 6) — must beat allowlist gate
 *   - R4 unknown (graceful)
 *   - Dedup proof (same project twice in window → 1 push)
 *   - Telegram fallback (transport=telegram path used)
 *
 * Plus parser + dedup + session unit coverage so failures localize.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { classifyReply, extractApproveIndex } from "../src/lib/d2-line-reply-parser";
import { LineSession } from "../src/lib/d2-line-session";
import {
  defaultDedupPath,
  loadDedup,
  pruneDedup,
  recordPush as recordDedupPush,
  saveDedup,
  shouldPush,
} from "../src/lib/d2-line-dedup";
import {
  defaultTemplatesPath,
  loadLineTemplates,
  renderTemplate,
} from "../src/lib/d2-line-templates";
import {
  detectFlips,
  renderPushVars,
  runTriggerScan,
} from "../src/lib/d2-line-trigger";
import {
  activeTransport,
  makePusher,
  verifyLineSignature,
} from "../src/lib/d2-line-client";
import {
  _recordPushForTest,
  _resetLineBotState,
  handleLineEvent,
} from "../src/api/kaiju-line-bot";
import type { StewardRow } from "../src/lib/steward-log-parser";

import { createHmac } from "crypto";

const D2_FIXTURE_TEMPLATES = `---
spec_id: D2-FIXTURE
version: test
---

## Push templates

### T1 — 🔴 surfaced-leo (test fixture)

\`\`\`
🔴 {project_name}

Why: {why_field}
Owner: {current_owner}
Stuck: {stuck_duration}

ดูเต็ม → {cockpit_url}
ตอบกลับ: อนุมัติ / เลื่อน / ปฏิเสธ
\`\`\`

### T2 — 🟠 awaiting-leo (test fixture)

\`\`\`
🟠 {project_name} — รอตัดสิน

{why_field}

Owner ปัจจุบัน: {current_owner}
ดู → {cockpit_url}
\`\`\`

### T3 — Halt (test fixture)

\`\`\`
⚠️ HALT — test
\`\`\`

### T4 — Ship report (test fixture)

\`\`\`
✅ test ship
\`\`\`

## Reply templates

### R1 — Approve

\`\`\`
✅ Approved {project_name} @ {timestamp}
Sentinel: ψ/writing/approvals/{date}_{project-id}.md
Audit log: ψ/memory/david/active-projects.md
\`\`\`

### R2 — Defer

\`\`\`
📝 รับทราบครับ — Defer ยังไม่ wire ใน Phase 1
\`\`\`

### R3 — Reject

\`\`\`
📝 รับทราบครับ — Reject ยังไม่ wire ใน Phase 1
\`\`\`

### R4 — Unknown

\`\`\`
🤔 รับข้อความแล้ว — ยังไม่เข้าใจคำสั่ง
\`\`\`

### R5 — Identity

\`\`\`
ใช่ครับ ผมคือ David Oracle 🦁
AI Chief of Staff ของลีโอ — Rule 6 compliance
\`\`\`
`;

const STEWARD_ONE_SURFACED = `---
owner: David
type: steward-log
---

# Active

## Snapshot — test (1 project)

| # | Project | Owner | DoD (1 line) | Last move | Stuck | Status |
|---|---------|-------|--------------|-----------|-------|--------|
| 18 | PHASE-1-MVP-SCOPE | HELM → Leo | gate decision | 2026-05-03 | 4h | 🔴 surfaced-leo |
`;

const STEWARD_AFTER_FLIP = `---
owner: David
type: steward-log
---

# Active

## Snapshot — test (2 projects)

| # | Project | Owner | DoD (1 line) | Last move | Stuck | Status |
|---|---------|-------|--------------|-----------|-------|--------|
| 18 | PHASE-1-MVP-SCOPE | HELM → Leo | gate decision | 2026-05-03 | 4h | 🔴 surfaced-leo |
| 6 | ROSE-SECRETARY | Leo | birth-now decision | 2026-05-01 | 48h | 🔴 surfaced-leo |
`;

let TMP: string;
let SPEC_PATH: string;
let DEDUP_PATH: string;
let STEWARD_PATH: string;

beforeAll(() => {
  // Sanity: David's real spec is parseable. Don't depend on it for the rest of
  // the suite (CI doesn't have ~/david-oracle), but if it's there, run a smoke.
  try {
    const real = loadLineTemplates(defaultTemplatesPath());
    expect(real.push.T1.body.length).toBeGreaterThan(0);
    expect(real.reply.identity.body.length).toBeGreaterThan(0);
  } catch { /* spec not on disk in this env — skip the smoke */ }
});

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "d2-line-"));
  SPEC_PATH = join(TMP, "templates.md");
  DEDUP_PATH = join(TMP, "dedup.json");
  STEWARD_PATH = join(TMP, "active-projects.md");
  writeFileSync(SPEC_PATH, D2_FIXTURE_TEMPLATES, "utf8");
  _resetLineBotState();
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- template loader ----

describe("d2-line-templates", () => {
  test("parses all push (T1-T4) and reply (R1-R5) blocks", () => {
    const t = loadLineTemplates(SPEC_PATH);
    for (const id of ["T1", "T2", "T3", "T4"] as const) {
      expect(t.push[id].body.length).toBeGreaterThan(0);
    }
    for (const intent of ["approve", "defer", "reject", "unknown", "identity"] as const) {
      expect(t.reply[intent].body.length).toBeGreaterThan(0);
    }
  });

  test("dedup_sec set per spec table (T1=24h, T2=12h, T3/T4=0)", () => {
    const t = loadLineTemplates(SPEC_PATH);
    expect(t.push.T1.dedup_sec).toBe(86400);
    expect(t.push.T2.dedup_sec).toBe(43200);
    expect(t.push.T3.dedup_sec).toBe(0);
    expect(t.push.T4.dedup_sec).toBe(0);
  });

  test("renderTemplate substitutes known tokens, leaves unknowns visible", () => {
    const out = renderTemplate("hello {name}, {missing}", { name: "Leo" });
    expect(out).toBe("hello Leo, {missing}");
  });

  test("missing T1 block throws with informative message", () => {
    writeFileSync(SPEC_PATH, "## Push\n### R5 — Identity\n```\nx\n```\n", "utf8");
    expect(() => loadLineTemplates(SPEC_PATH)).toThrow(/missing push template T1/);
  });
});

// ---- reply parser (R1-R5) ----

describe("d2-line-reply-parser", () => {
  test("R1 approve — Thai + English + emoji variants", () => {
    for (const t of ["อนุมัติ", "approve", "Approve", "✅", "OK", "yes", "เอา"]) {
      expect(classifyReply(t)).toBe("approve");
    }
  });

  test("R2 defer — Thai + English variants", () => {
    for (const t of ["เลื่อน", "defer", "later", "ทีหลัง"]) {
      expect(classifyReply(t)).toBe("defer");
    }
  });

  test("R3 reject — Thai + English variants", () => {
    for (const t of ["ปฏิเสธ", "reject", "no", "ไม่เอา", "ยกเลิก"]) {
      expect(classifyReply(t)).toBe("reject");
    }
  });

  test("R5 identity beats other intents (Rule 6)", () => {
    // Even if user types "approve" inside an identity question, identity wins
    expect(classifyReply("คุณคือใคร")).toBe("identity");
    expect(classifyReply("who are you?")).toBe("identity");
    expect(classifyReply("are you AI")).toBe("identity");
    expect(classifyReply("นายเป็น AI ใช่ไหม")).toBe("identity");
  });

  test("R4 unknown — random text, empty, garbage", () => {
    expect(classifyReply("")).toBe("unknown");
    expect(classifyReply("hmmmm")).toBe("unknown");
    expect(classifyReply("🤔")).toBe("unknown");
  });

  test("approve index — 'อนุมัติ 2' → 2", () => {
    expect(extractApproveIndex("อนุมัติ 2")).toBe(2);
    expect(extractApproveIndex("approve 1")).toBe(1);
    expect(extractApproveIndex("อนุมัติ")).toBe(null);
    expect(extractApproveIndex("ok 5")).toBe(5);
  });
});

// ---- session ----

describe("d2-line-session", () => {
  test("recordPush + resolveLatest returns most recent", () => {
    const s = new LineSession({ ttl_ms: 60_000 });
    s.recordPush("U1", "proj-a");
    s.recordPush("U1", "proj-b");
    expect(s.resolveLatest("U1")).toBe("proj-b");
  });

  test("expired entries return null and are pruned", () => {
    const s = new LineSession({ ttl_ms: 1000 });
    s.recordPush("U1", "proj-a", 0);
    expect(s.resolveLatest("U1", 500)).toBe("proj-a");
    expect(s.resolveLatest("U1", 5000)).toBe(null);
    expect(s.size()).toBe(0);
  });

  test("keeps last-3 newest-first; duplicate id moves to head", () => {
    const s = new LineSession({ ttl_ms: 60_000, keep: 3 });
    s.recordPush("U1", "a");
    s.recordPush("U1", "b");
    s.recordPush("U1", "c");
    s.recordPush("U1", "d");
    expect(s.listActive("U1")).toEqual(["d", "c", "b"]);
    s.recordPush("U1", "b");
    expect(s.listActive("U1")).toEqual(["b", "d", "c"]);
  });

  test("peekAt resolves ambiguous-multi-push selection", () => {
    const s = new LineSession({ ttl_ms: 60_000 });
    s.recordPush("U1", "a");
    s.recordPush("U1", "b");
    expect(s.peekAt("U1", 1)).toBe("b");
    expect(s.peekAt("U1", 2)).toBe("a");
    expect(s.peekAt("U1", 3)).toBe(null);
  });
});

// ---- dedup (file-backed) ----

describe("d2-line-dedup", () => {
  test("first push allowed; second within window blocked; after window allowed", () => {
    let s = loadDedup(DEDUP_PATH);
    expect(shouldPush(s, "T1", "p1", 86400, 1_000_000)).toBe(true);
    s = recordDedupPush(s, "T1", "p1", 1_000_000);
    saveDedup(s, DEDUP_PATH);
    s = loadDedup(DEDUP_PATH);
    expect(shouldPush(s, "T1", "p1", 86400, 1_000_000 + 1000)).toBe(false);
    expect(shouldPush(s, "T1", "p1", 86400, 1_000_000 + 86400_000 + 1)).toBe(true);
  });

  test("template_id is part of the key — T1 + T2 dedup independently", () => {
    let s: ReturnType<typeof loadDedup> = {};
    s = recordDedupPush(s, "T1", "p1", 1_000_000);
    expect(shouldPush(s, "T2", "p1", 86400, 1_000_001)).toBe(true);
  });

  test("window_sec=0 always allows push (no dedup)", () => {
    const s = recordDedupPush({}, "T3", "p1", 1_000_000);
    expect(shouldPush(s, "T3", "p1", 0, 1_000_001)).toBe(true);
  });

  test("pruneDedup drops stale records", () => {
    let s: ReturnType<typeof loadDedup> = {};
    s = recordDedupPush(s, "T1", "old", 1_000_000);
    s = recordDedupPush(s, "T1", "new", 2_000_000);
    s = pruneDedup(s, 500, 2_000_500);
    expect(s["T1:new"]).toBeDefined();
    expect(s["T1:old"]).toBeUndefined();
  });

  test("corrupt file returns empty state (no crash)", () => {
    writeFileSync(DEDUP_PATH, "{not json", "utf8");
    expect(loadDedup(DEDUP_PATH)).toEqual({});
  });
});

// ---- trigger detection ----

describe("d2-line-trigger detectFlips", () => {
  function row(id: string, status: any, n = 1): StewardRow {
    return {
      id, row_number: n, project_name: id,
      received_from: null, current_owner: "Leo",
      status, why: "test", drift_check: null,
    };
  }

  test("first scan with surfaced-leo emits T1", () => {
    const flips = detectFlips(null, [row("p1", "surfaced-leo")]);
    expect(flips).toHaveLength(1);
    expect(flips[0]?.template_id).toBe("T1");
  });

  test("status unchanged → no flip", () => {
    const prev = [row("p1", "surfaced-leo")];
    const curr = [row("p1", "surfaced-leo")];
    expect(detectFlips(prev, curr)).toEqual([]);
  });

  test("status changed from active → surfaced-leo emits T1", () => {
    const prev = [row("p1", "active")];
    const curr = [row("p1", "surfaced-leo")];
    const flips = detectFlips(prev, curr);
    expect(flips).toHaveLength(1);
    expect(flips[0]?.template_id).toBe("T1");
  });

  test("awaiting-leo flip emits T2", () => {
    const prev = [row("p1", "active")];
    const curr = [row("p1", "awaiting-leo")];
    const flips = detectFlips(prev, curr);
    expect(flips[0]?.template_id).toBe("T2");
  });

  test("non-leo statuses (active, parked, stuck-ping) emit nothing", () => {
    const curr = [
      row("a", "active", 1),
      row("b", "parked", 2),
      row("c", "stuck-ping", 3),
    ];
    expect(detectFlips(null, curr)).toEqual([]);
  });
});

describe("d2-line-trigger renderPushVars", () => {
  test("populates project_name, current_owner, cockpit_url with row_number", () => {
    const row: StewardRow = {
      id: "phase-1-mvp-scope", row_number: 18, project_name: "PHASE-1-MVP-SCOPE",
      received_from: "HELM", current_owner: "Leo",
      status: "surfaced-leo", why: "gate decision", drift_check: null,
    };
    const vars = renderPushVars(row, { cockpit_base_url: "http://localhost:3456" });
    expect(vars.project_name).toBe("PHASE-1-MVP-SCOPE");
    expect(vars.current_owner).toBe("Leo");
    expect(vars.cockpit_url).toBe("http://localhost:3456/control_tower.html#project-18");
    expect(vars.why_field).toBe("gate decision");
  });

  test("missing fields fall back to safe placeholders", () => {
    const row: StewardRow = {
      id: "x", row_number: 0, project_name: "",
      received_from: null, current_owner: null, status: "surfaced-leo",
      why: null, drift_check: null,
    };
    const vars = renderPushVars(row, { cockpit_base_url: "http://localhost:3456/" });
    expect(vars.project_name).toBe("x");                   // falls back to id
    expect(vars.current_owner).toBe("(unassigned)");
    expect(vars.why_field).toBe("(no DoD recorded)");
    expect(vars.cockpit_url).not.toMatch(/\/$/);            // trailing slash stripped
  });
});

// ---- T1 push integration (REQUIRED by HELM bundle) ----

describe("T1 push (HELM-required) — surfaced-leo flip", () => {
  test("first scan with one surfaced row → 1 push to recipient with rendered T1", async () => {
    writeFileSync(STEWARD_PATH, STEWARD_ONE_SURFACED, "utf8");
    const calls: Array<{ recipient: string; text: string }> = [];
    const pusher = async (args: { recipient: string; text: string }) => {
      calls.push(args);
      return { ok: true, transport: "line" as const, status: 200 };
    };

    const out = await runTriggerScan({
      recipient: "U_LEO",
      pusher,
      templates: loadLineTemplates(SPEC_PATH),
      steward_log_path: STEWARD_PATH,
      dedup_path: DEDUP_PATH,
      cockpit_base_url: "http://localhost:3456",
    });

    expect(out.events_pushed).toHaveLength(1);
    expect(out.events_pushed[0]?.template_id).toBe("T1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipient).toBe("U_LEO");
    expect(calls[0]?.text).toContain("🔴");
    expect(calls[0]?.text).toContain("PHASE-1-MVP-SCOPE");
    expect(calls[0]?.text).toContain("/control_tower.html#project-18");
  });
});

// ---- Dedup proof (HELM-required) ----

describe("Dedup proof (HELM-required) — same project twice in window → 1 push", () => {
  test("two scans of same surfaced row produce 1 push only (file-backed dedup persists)", async () => {
    writeFileSync(STEWARD_PATH, STEWARD_ONE_SURFACED, "utf8");
    const calls: Array<{ recipient: string; text: string }> = [];
    const pusher = async (args: { recipient: string; text: string }) => {
      calls.push(args);
      return { ok: true, transport: "line" as const, status: 200 };
    };
    const templates = loadLineTemplates(SPEC_PATH);

    const first = await runTriggerScan({
      recipient: "U_LEO", pusher, templates,
      steward_log_path: STEWARD_PATH, dedup_path: DEDUP_PATH,
    });
    expect(first.events_pushed).toHaveLength(1);

    // Re-flip detection: pretend we just booted (prev=null), same row still 🔴.
    const second = await runTriggerScan({
      recipient: "U_LEO", pusher, templates,
      steward_log_path: STEWARD_PATH, dedup_path: DEDUP_PATH,
      prev_rows: null,
    });
    expect(second.events_detected).toHaveLength(1);
    expect(second.events_pushed).toHaveLength(0);
    expect(second.events_deduped).toHaveLength(1);

    expect(calls).toHaveLength(1); // only the first push went out
  });

  test("a SECOND surfaced project added → only the new one pushes (dedup is per-project)", async () => {
    writeFileSync(STEWARD_PATH, STEWARD_ONE_SURFACED, "utf8");
    const calls: Array<{ text: string }> = [];
    const pusher = async (args: { recipient: string; text: string }) => {
      calls.push({ text: args.text });
      return { ok: true, transport: "line" as const, status: 200 };
    };
    const templates = loadLineTemplates(SPEC_PATH);

    const first = await runTriggerScan({
      recipient: "U_LEO", pusher, templates,
      steward_log_path: STEWARD_PATH, dedup_path: DEDUP_PATH,
    });
    expect(first.events_pushed).toHaveLength(1);

    writeFileSync(STEWARD_PATH, STEWARD_AFTER_FLIP, "utf8");
    const second = await runTriggerScan({
      recipient: "U_LEO", pusher, templates,
      steward_log_path: STEWARD_PATH, dedup_path: DEDUP_PATH,
      prev_rows: first.snapshot,
    });
    expect(second.events_pushed).toHaveLength(1);
    expect(second.events_pushed[0]?.project_id).not.toBe(first.events_pushed[0]?.project_id);
    expect(calls).toHaveLength(2);
  });
});

// ---- R1 round-trip (HELM-required) ----

describe("R1 round-trip (HELM-required) — Leo replies 'อนุมัติ' → D1 /approve called", () => {
  test("approve intent + recent push → fake D1 receives correct payload", async () => {
    process.env.LEO_LINE_USER_ID = "U_LEO";
    _recordPushForTest("U_LEO", "phase-1-mvp-scope");
    // Need templates loaded for reply rendering
    process.env.D2_LINE_TEMPLATES_PATH = SPEC_PATH;

    const seen: Array<{ project_id: string; approver: string }> = [];
    const fakeApprove = async (args: { project_id: string; approver: string }) => {
      seen.push({ project_id: args.project_id, approver: args.approver });
      return { ok: true, status: 200, body: { status: "approved", approved_at: "2026-05-03T00:00:00Z", sentinel_path: "ψ/x" } };
    };

    const result = await handleLineEvent(
      {
        type: "message",
        replyToken: "tok-1",
        source: { userId: "U_LEO", type: "user" },
        message: { type: "text", text: "อนุมัติ" },
      },
      { approve: fakeApprove },
    );

    expect(result.intent).toBe("approve");
    expect(result.resolved_project_id).toBe("phase-1-mvp-scope");
    expect(result.approve_ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.project_id).toBe("phase-1-mvp-scope");
    expect(seen[0]?.approver).toBe("Leo");
    expect(result.reply_text).toContain("✅");

    delete process.env.LEO_LINE_USER_ID;
    delete process.env.D2_LINE_TEMPLATES_PATH;
  });

  test("approve from unknown user → R4 unknown, D1 NOT called", async () => {
    process.env.LEO_LINE_USER_ID = "U_LEO";
    process.env.D2_LINE_TEMPLATES_PATH = SPEC_PATH;
    _recordPushForTest("U_LEO", "p1");

    let called = false;
    const fakeApprove = async () => { called = true; return { ok: true, status: 200, body: {} }; };

    const result = await handleLineEvent(
      {
        type: "message",
        source: { userId: "STRANGER", type: "user" },
        message: { type: "text", text: "อนุมัติ" },
      },
      { approve: fakeApprove },
    );
    expect(result.intent).toBe("unknown");
    expect(called).toBe(false);

    delete process.env.LEO_LINE_USER_ID;
    delete process.env.D2_LINE_TEMPLATES_PATH;
  });

  test("approve with no recent push → R4 (graceful), D1 NOT called", async () => {
    process.env.LEO_LINE_USER_ID = "U_LEO";
    process.env.D2_LINE_TEMPLATES_PATH = SPEC_PATH;

    let called = false;
    const fakeApprove = async () => { called = true; return { ok: true, status: 200, body: {} }; };

    const result = await handleLineEvent(
      {
        type: "message",
        source: { userId: "U_LEO", type: "user" },
        message: { type: "text", text: "อนุมัติ" },
      },
      { approve: fakeApprove },
    );
    expect(result.intent).toBe("approve");
    expect(result.resolved_project_id).toBe(null);
    expect(called).toBe(false);

    delete process.env.LEO_LINE_USER_ID;
    delete process.env.D2_LINE_TEMPLATES_PATH;
  });
});

// ---- R5 identity (HELM-required) ----

describe("R5 identity (HELM-required) — Rule 6 must answer truthfully", () => {
  test("identity question from ALLOWED user → R5 reply", async () => {
    process.env.LEO_LINE_USER_ID = "U_LEO";
    process.env.D2_LINE_TEMPLATES_PATH = SPEC_PATH;
    const r = await handleLineEvent({
      type: "message",
      source: { userId: "U_LEO", type: "user" },
      message: { type: "text", text: "คุณคือใคร" },
    });
    expect(r.intent).toBe("identity");
    expect(r.reply_text).toMatch(/AI/);
    delete process.env.LEO_LINE_USER_ID;
    delete process.env.D2_LINE_TEMPLATES_PATH;
  });

  test("identity question from STRANGER also gets R5 (Rule 6 — beats allowlist)", async () => {
    process.env.LEO_LINE_USER_ID = "U_LEO";
    process.env.D2_LINE_TEMPLATES_PATH = SPEC_PATH;
    const r = await handleLineEvent({
      type: "message",
      source: { userId: "STRANGER", type: "user" },
      message: { type: "text", text: "are you AI" },
    });
    expect(r.intent).toBe("identity");
    expect(r.reply_text).toMatch(/AI/);
    delete process.env.LEO_LINE_USER_ID;
    delete process.env.D2_LINE_TEMPLATES_PATH;
  });
});

// ---- R4 unknown (HELM-required) ----

describe("R4 unknown (HELM-required) — graceful response", () => {
  test("garbage text from allowed user → R4", async () => {
    process.env.LEO_LINE_USER_ID = "U_LEO";
    process.env.D2_LINE_TEMPLATES_PATH = SPEC_PATH;
    const r = await handleLineEvent({
      type: "message",
      source: { userId: "U_LEO", type: "user" },
      message: { type: "text", text: "🤔 ???" },
    });
    expect(r.intent).toBe("unknown");
    expect(r.reply_text).toMatch(/ยังไม่เข้าใจ/);
    delete process.env.LEO_LINE_USER_ID;
    delete process.env.D2_LINE_TEMPLATES_PATH;
  });
});

// ---- Telegram fallback (HELM-required) ----

describe("Telegram fallback (HELM-required) — D2_LINE_TRANSPORT=telegram swap", () => {
  test("activeTransport reads env knob", () => {
    expect(activeTransport({ D2_LINE_TRANSPORT: "telegram" })).toBe("telegram");
    expect(activeTransport({ D2_LINE_TRANSPORT: "line" })).toBe("line");
    expect(activeTransport({})).toBe("line");
  });

  test("makePusher('telegram') hits Telegram API base, not LINE", async () => {
    // Stand up a tiny capture server to verify which URL the pusher hits.
    const seen: Array<{ url: string; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        seen.push({ url: req.url, body });
        return new Response(`{"ok":true}`, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const base = `http://localhost:${server.port}`;
    try {
      const env = { TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_API_BASE_URL: base };
      const push = makePusher("telegram", env);
      const r = await push({ recipient: "12345", text: "hi" });
      expect(r.ok).toBe(true);
      expect(r.transport).toBe("telegram");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toContain("/botfake/sendMessage");
      const parsed = JSON.parse(seen[0]?.body ?? "{}");
      expect(parsed.chat_id).toBe("12345");
      expect(parsed.text).toBe("hi");
    } finally {
      server.stop();
    }
  });

  test("makePusher('line') hits LINE API base", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ url: req.url, auth: req.headers.get("authorization") });
        return new Response(`{}`, { status: 200 });
      },
    });
    const base = `http://localhost:${server.port}`;
    try {
      const env = { LINE_CHANNEL_ACCESS_TOKEN: "tok", LINE_API_BASE_URL: base };
      const push = makePusher("line", env);
      const r = await push({ recipient: "U_LEO", text: "hi" });
      expect(r.ok).toBe(true);
      expect(seen[0]?.url).toContain("/v2/bot/message/push");
      expect(seen[0]?.auth).toBe("Bearer tok");
    } finally {
      server.stop();
    }
  });

  test("trigger scan uses whichever pusher the caller injects (full T1 → telegram path)", async () => {
    writeFileSync(STEWARD_PATH, STEWARD_ONE_SURFACED, "utf8");
    const calls: Array<{ transport: string }> = [];
    const fakeTelegramPush = async (args: { recipient: string; text: string }) => {
      calls.push({ transport: "telegram" });
      return { ok: true, transport: "telegram" as const, status: 200 };
    };
    const out = await runTriggerScan({
      recipient: "12345",
      pusher: fakeTelegramPush,
      templates: loadLineTemplates(SPEC_PATH),
      steward_log_path: STEWARD_PATH,
      dedup_path: DEDUP_PATH,
    });
    expect(out.events_pushed).toHaveLength(1);
    expect(calls[0]?.transport).toBe("telegram");
  });
});

// ---- LINE webhook signature ----

describe("verifyLineSignature", () => {
  test("valid HMAC matches; tampered body fails", () => {
    const secret = "s3cret";
    const body = `{"events":[]}`;
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyLineSignature(body, sig, secret)).toBe(true);
    expect(verifyLineSignature(`${body} `, sig, secret)).toBe(false);
    expect(verifyLineSignature(body, sig, "wrong")).toBe(false);
    expect(verifyLineSignature(body, undefined, secret)).toBe(false);
    expect(verifyLineSignature(body, sig, "")).toBe(false);
  });

  test("constant-time compare — different-length signatures fail without leaking", () => {
    expect(verifyLineSignature("body", "short", "secret")).toBe(false);
  });
});
