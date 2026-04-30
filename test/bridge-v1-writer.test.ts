/**
 * ADR-003 v0.3 — maw-js Bridge writer migration to v1 schema
 *
 * Tests appendOracleIntent in src/lib/kaiju-state-store.ts.
 * Writer-side fixtures only — validator/replay/rate-limit fixtures
 * (handoff #7-9) live in NEXUS validator-bridge-intent test suite.
 *
 * Refs:
 * - ADR-003 v0.3 ψ/memory/forge/adrs/ADR-003_maw-js-bridge-v1-writer-migration.md
 * - ADR-HELM-011 v0.2 (4-field v1 schema source-of-truth)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Helper: fresh fixture root per test (env var redirects davidOracleRoot)
let FIXTURE_ROOT: string;
let MARKER_PATH: string;
let INTENTS_V0_PATH: string;
let INTENTS_V1_PATH: string;
let REJECT_PATH: string;
let CT_STATE_PATH: string;

beforeEach(() => {
  FIXTURE_ROOT = join(tmpdir(), `bridge-v1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.DAVID_ORACLE_ROOT = FIXTURE_ROOT;
  process.env.KAIJU_CONTROL_TOWER_STATE_DIR = join(FIXTURE_ROOT, "control-tower");

  mkdirSync(join(FIXTURE_ROOT, "ψ", "state", "oracle-bridge"), { recursive: true });
  mkdirSync(join(FIXTURE_ROOT, "control-tower"), { recursive: true });
  mkdirSync(join(FIXTURE_ROOT, "ψ", "memory", "company-os"), { recursive: true });

  MARKER_PATH = join(FIXTURE_ROOT, "ψ", "state", "oracle-bridge", "v1-active");
  INTENTS_V0_PATH = join(FIXTURE_ROOT, "ψ", "state", "oracle-bridge", "oracle-intents.ndjson");
  INTENTS_V1_PATH = join(FIXTURE_ROOT, "ψ", "state", "oracle-bridge", "oracle-intents.v1.ndjson");
  const day = new Date().toISOString().slice(0, 10);
  REJECT_PATH = join(FIXTURE_ROOT, "ψ", "state", "oracle-bridge", `oracle-intents-rejected-${day}.ndjson`);
  CT_STATE_PATH = join(FIXTURE_ROOT, "control-tower", "paperclip-state.json");
});

afterEach(() => {
  if (FIXTURE_ROOT && existsSync(FIXTURE_ROOT)) {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }
  delete process.env.DAVID_ORACLE_ROOT;
  delete process.env.KAIJU_CONTROL_TOWER_STATE_DIR;
});

function writeMarker(opts: Partial<{ schemaVersion: string; ratifiedAt: string }> = {}) {
  writeFileSync(
    MARKER_PATH,
    JSON.stringify({
      schemaVersion: opts.schemaVersion ?? "v1",
      ratifiedAt: opts.ratifiedAt ?? "2026-04-30T11:39:22+07:00",
    }),
  );
}

function readNdjson(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// Re-import per-test to bypass module-level memoization (Bun caches modules
// by absolute path; we use the env var to redirect file paths instead).
async function freshAppender() {
  const mod = await import(`../src/lib/kaiju-state-store?cb=${Date.now()}-${Math.random()}`);
  return mod.appendOracleIntent as (input: Record<string, unknown>) => Record<string, unknown>;
}

describe("appendOracleIntent — fixture #1: marker absent → v0 shape only", () => {
  test("writes to oracle-intents.ndjson (v0 path), no v1 fields, no v1 file", async () => {
    const appendOracleIntent = await freshAppender();
    const result = appendOracleIntent({
      kind: "general_intent",
      title: "Fixture 1 — v0 path",
      summary: "no marker, default v0 emission",
      risk: "L2",
    });

    expect(result.kind).toBe("general_intent");
    expect(result.title).toBe("Fixture 1 — v0 path");
    expect((result as Record<string, unknown>).idempotencyKey).toBeUndefined();
    expect((result as Record<string, unknown>).signedBy).toBeUndefined();
    expect((result as Record<string, unknown>).approvalOwner).toBeUndefined();
    expect((result as Record<string, unknown>).riskClass).toBeUndefined();

    expect(existsSync(INTENTS_V0_PATH)).toBe(true);
    expect(existsSync(INTENTS_V1_PATH)).toBe(false);
    const lines = readNdjson(INTENTS_V0_PATH);
    expect(lines.length).toBe(1);
    expect(lines[0].title).toBe("Fixture 1 — v0 path");
  });
});

describe("appendOracleIntent — fixture #2: marker present → v1 schema with 4 fields", () => {
  test("writes to oracle-intents.v1.ndjson with idempotencyKey/signedBy/approvalOwner/riskClass", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    const result = appendOracleIntent({
      kind: "general_intent",
      title: "Fixture 2 — v1 path",
      summary: "marker present, full v1 contract",
      risk: "L2",
      signedBy: "Codex",
      approvalOwner: "David",
      riskClass: "write_oracle",
    });

    expect(result.signedBy).toBe("Codex");
    expect(result.approvalOwner).toBe("David");
    expect(result.riskClass).toBe("write_oracle");
    expect(typeof result.idempotencyKey).toBe("string");
    expect((result.idempotencyKey as string).length).toBe(16);

    expect(existsSync(INTENTS_V0_PATH)).toBe(false);
    expect(existsSync(INTENTS_V1_PATH)).toBe(true);
    const lines = readNdjson(INTENTS_V1_PATH);
    expect(lines.length).toBe(1);
    expect(lines[0].signedBy).toBe("Codex");
  });
});

describe("appendOracleIntent — fixture #3: missing required field → reject", () => {
  test("missing riskClass throws bridge_writer_reject:missing_field + rejection log", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();

    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Fixture 3 — missing riskClass",
        summary: "should reject",
        risk: "L2",
        signedBy: "Codex",
        approvalOwner: "David",
        // riskClass intentionally missing
      }),
    ).toThrow("bridge_writer_reject:missing_field");

    const rejects = readNdjson(REJECT_PATH);
    expect(rejects.length).toBe(1);
    expect(rejects[0].rejection_reason).toBe("missing_field");
    expect((rejects[0].detail as Record<string, unknown>).fields).toEqual(["riskClass"]);

    // No v1 record written
    expect(existsSync(INTENTS_V1_PATH)).toBe(false);
  });

  test("missing signedBy AND approvalOwner reports both", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();

    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Fixture 3b — multi-missing",
        summary: "should reject",
        risk: "L2",
        riskClass: "write_oracle",
        // signedBy + approvalOwner missing
      }),
    ).toThrow("bridge_writer_reject:missing_field");

    const rejects = readNdjson(REJECT_PATH);
    expect(rejects.length).toBe(1);
    expect((rejects[0].detail as Record<string, unknown>).fields).toEqual(["signedBy", "approvalOwner"]);
  });
});

describe("appendOracleIntent — fixture #4: idempotency key", () => {
  test("caller-supplied idempotencyKey passes through unchanged", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    const result = appendOracleIntent({
      kind: "general_intent",
      title: "Fixture 4 — caller key",
      summary: "explicit idempotencyKey",
      risk: "L2",
      signedBy: "Codex",
      approvalOwner: "David",
      riskClass: "write_oracle",
      idempotencyKey: "abcdef1234567890",
    });

    expect(result.idempotencyKey).toBe("abcdef1234567890");
  });

  test("computed idempotencyKey changes when riskClass differs (NEXUS DVL §A)", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    const baseInput = {
      kind: "general_intent",
      title: "same logical intent",
      summary: "same summary",
      risk: "L2",
      signedBy: "Codex",
      approvalOwner: "David",
    } as Record<string, unknown>;

    const a = appendOracleIntent({ ...baseInput, riskClass: "write_oracle" });
    const b = appendOracleIntent({ ...baseInput, riskClass: "write_business" });

    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});

describe("appendOracleIntent — fixture #5: approvals[] sync on L2+", () => {
  test("L2 v1 intent creates Control Tower approval draft", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    const result = appendOracleIntent({
      kind: "general_intent",
      title: "Fixture 5 — L2 sync",
      summary: "approvals[] sync per ADR-HELM-011 §4.2",
      risk: "L2",
      signedBy: "Codex",
      approvalOwner: "David",
      riskClass: "write_oracle",
    });

    expect(existsSync(CT_STATE_PATH)).toBe(true);
    const ctState = JSON.parse(readFileSync(CT_STATE_PATH, "utf8"));
    expect(Array.isArray(ctState.approvalRequests)).toBe(true);
    expect(ctState.approvalRequests.length).toBe(1);
    const approval = ctState.approvalRequests[0];
    expect(approval.title).toBe("Fixture 5 — L2 sync");
    expect(approval.payload.intentId).toBe(result.id);
    expect(approval.payload.signedBy).toBe("Codex");
    expect(approval.payload.approvalOwner).toBe("David");
    expect(approval.payload.riskClass).toBe("write_oracle");
    expect(approval.payload.idempotencyKey).toBe(result.idempotencyKey);
  });

  test("L1 v1 intent skips approvals[] sync", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    appendOracleIntent({
      kind: "general_intent",
      title: "Fixture 5b — L1 no sync",
      summary: "L1 should not create approval",
      risk: "L1",
      signedBy: "Codex",
      approvalOwner: "David",
      riskClass: "read",
    });

    expect(existsSync(CT_STATE_PATH)).toBe(false);
  });
});

describe("appendOracleIntent — fixture #6: self-approval rejection (David architect lens)", () => {
  test("signedBy === approvalOwner throws bridge_writer_reject:self_approval", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();

    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Fixture 6 — self-approval attempt",
        summary: "David signs as David — must reject",
        risk: "L2",
        signedBy: "David",
        approvalOwner: "David",
        riskClass: "write_oracle",
      }),
    ).toThrow("bridge_writer_reject:self_approval");

    const rejects = readNdjson(REJECT_PATH);
    expect(rejects.length).toBe(1);
    expect(rejects[0].rejection_reason).toBe("self_approval");
    expect((rejects[0].detail as Record<string, unknown>).signedBy).toBe("David");
  });
});

describe("appendOracleIntent — Q5 soft-alias requestedBy ↔ signedBy", () => {
  test("requestedBy alone (no signedBy) emits warn + maps to signedBy", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    const result = appendOracleIntent({
      kind: "general_intent",
      title: "Soft-alias — requestedBy only",
      summary: "v0 caller path",
      risk: "L2",
      requestedBy: "Codex",
      approvalOwner: "David",
      riskClass: "write_oracle",
    });

    expect(result.signedBy).toBe("Codex");
    expect(result.requestedBy).toBe("Codex");
  });

  test("requestedBy + signedBy mismatch → reject", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();

    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Soft-alias mismatch",
        summary: "different signedBy and requestedBy must reject",
        risk: "L2",
        requestedBy: "Codex",
        signedBy: "HELM",
        approvalOwner: "David",
        riskClass: "write_oracle",
      }),
    ).toThrow("bridge_writer_reject:signedBy_requestedBy_mismatch");
  });
});

describe("appendOracleIntent — enum validation", () => {
  test("bad signedBy → reject", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Bad signedBy",
        summary: "x",
        risk: "L2",
        signedBy: "Mallory",
        approvalOwner: "David",
        riskClass: "write_oracle",
      }),
    ).toThrow("bridge_writer_reject:bad_signedBy");
  });

  test("bad approvalOwner → reject", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Bad approvalOwner",
        summary: "x",
        risk: "L2",
        signedBy: "Codex",
        approvalOwner: "Mallory",
        riskClass: "write_oracle",
      }),
    ).toThrow("bridge_writer_reject:bad_enum");
  });

  test("bad riskClass → reject", async () => {
    writeMarker();
    const appendOracleIntent = await freshAppender();
    expect(() =>
      appendOracleIntent({
        kind: "general_intent",
        title: "Bad riskClass",
        summary: "x",
        risk: "L2",
        signedBy: "Codex",
        approvalOwner: "David",
        riskClass: "definitely_not_a_risk_class",
      }),
    ).toThrow("bridge_writer_reject:bad_enum");
  });
});

describe("appendOracleIntent — marker rollback semantics", () => {
  test("delete marker after v1 writes → next call falls back to v0", async () => {
    writeMarker();
    let appendOracleIntent = await freshAppender();
    appendOracleIntent({
      kind: "general_intent",
      title: "Pre-rollback v1 write",
      summary: "x",
      risk: "L2",
      signedBy: "Codex",
      approvalOwner: "David",
      riskClass: "write_oracle",
    });
    expect(existsSync(INTENTS_V1_PATH)).toBe(true);

    // Rollback: delete marker
    rmSync(MARKER_PATH);

    appendOracleIntent = await freshAppender();
    appendOracleIntent({
      kind: "general_intent",
      title: "Post-rollback v0 write",
      summary: "x",
      risk: "L2",
    });

    expect(existsSync(INTENTS_V0_PATH)).toBe(true);
    const v0lines = readNdjson(INTENTS_V0_PATH);
    expect(v0lines.length).toBe(1);
    expect(v0lines[0].title).toBe("Post-rollback v0 write");
  });

  test("corrupt marker (invalid JSON) → falls back to v0", async () => {
    writeFileSync(MARKER_PATH, "{ not valid json");
    const appendOracleIntent = await freshAppender();
    const result = appendOracleIntent({
      kind: "general_intent",
      title: "Corrupt marker fallback",
      summary: "x",
      risk: "L2",
    });

    expect((result as Record<string, unknown>).signedBy).toBeUndefined();
    expect(existsSync(INTENTS_V1_PATH)).toBe(false);
    expect(existsSync(INTENTS_V0_PATH)).toBe(true);
  });

  test("marker schemaVersion=v0 → falls back to v0", async () => {
    writeMarker({ schemaVersion: "v0" });
    const appendOracleIntent = await freshAppender();
    appendOracleIntent({
      kind: "general_intent",
      title: "v0 marker fallback",
      summary: "x",
      risk: "L2",
    });
    expect(existsSync(INTENTS_V1_PATH)).toBe(false);
    expect(existsSync(INTENTS_V0_PATH)).toBe(true);
  });
});
