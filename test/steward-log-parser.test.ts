/**
 * Tests for src/lib/steward-log-parser.ts — F2 wire (HELM SHIP-TODAY 2026-05-03)
 *
 * Fixture: test/fixtures/steward-log/snapshot-2026-05-03.md
 *   — frozen copy of ~/david-oracle/ψ/memory/david/active-projects.md as of ship day.
 *   The live file evolves; tests assert against the frozen snapshot.
 *
 * Coverage:
 *   - 14 active rows parse cleanly (16 in source minus 2 ✅ CLOSED)
 *   - 5-column shape on every row
 *   - status enum mapping (🟡 stuck-ping, 🟠 awaiting-leo, ⏸ parked, 🟢 active)
 *   - escaped pipe `\|` in DoD column handled (row #13 WD re-audit)
 *   - owner parser: arrow split, parenthetical strip, lowercase truncation
 *   - drift_check derived from Project Detail section presence
 *   - merge with hardcoded: collision detected (CT v0, Skill Registry v1) → steward wins
 *   - malformed input: empty, missing snapshot, missing required columns
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  mergeStewardWithHardcoded,
  parseStewardLog,
  type HardcodedProject,
} from "../src/lib/steward-log-parser";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "steward-log", "snapshot-2026-05-03.md");
const FIXTURE_CONTENT = readFileSync(FIXTURE_PATH, "utf-8");

const HARDCODED_FIXTURE: HardcodedProject[] = [
  { id: "agent-activation", title: "Agent Activation", owner: "David", status: "active" },
  { id: "business-data-access", title: "Business Data Access", owner: "PULSE", status: "active" },
  { id: "control-tower-v0", title: "Control Tower v0", owner: "HELM", status: "active" },
  { id: "skill-registry-v1-1", title: "Skill Registry v1.1", owner: "HELM", status: "active" },
];

describe("parseStewardLog — fixture", () => {
  const result = parseStewardLog(FIXTURE_CONTENT, { source_path: FIXTURE_PATH });

  test("parses 14 active rows (closed filtered)", () => {
    expect(result.rows.length).toBe(14);
  });

  test("emits no warnings on the canonical fixture", () => {
    expect(result.warnings).toEqual([]);
  });

  test("each row has all 5 required columns", () => {
    for (const row of result.rows) {
      expect(row).toHaveProperty("received_from");
      expect(row).toHaveProperty("current_owner");
      expect(row).toHaveProperty("status");
      expect(row).toHaveProperty("why");
      expect(row).toHaveProperty("drift_check");
    }
  });

  test("status values fall within the 5-value enum", () => {
    const validStatuses = new Set(["active", "stuck-ping", "awaiting-leo", "surfaced-leo", "parked"]);
    for (const row of result.rows) {
      expect(validStatuses.has(row.status)).toBe(true);
    }
  });

  test("filters ✅ CLOSED rows (rows #1 and #11 in fixture)", () => {
    const rowNumbers = result.rows.map((r) => r.row_number);
    expect(rowNumbers).not.toContain(1);
    expect(rowNumbers).not.toContain(11);
  });

  test("preserves Steward row ordering (numbering may skip due to closed rows)", () => {
    const numbers = result.rows.map((r) => r.row_number);
    expect(numbers).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 16, 15]);
  });

  test("row #5 'CT v0 promotion' → awaiting-leo, owner Leo", () => {
    const row = result.rows.find((r) => r.row_number === 5);
    expect(row).toBeDefined();
    expect(row!.status).toBe("awaiting-leo");
    expect(row!.current_owner).toBe("Leo");
    expect(row!.why).toBe("Leo approve bundle");
  });

  test("row #2 'ADR-003' → stuck-ping, owner FORGE (parses 'FORGE+HELM' compound)", () => {
    const row = result.rows.find((r) => r.row_number === 2);
    expect(row).toBeDefined();
    expect(row!.status).toBe("stuck-ping");
    expect(row!.current_owner).toBe("FORGE");
  });

  test("row #12 'REBOOT-TEST-001' arrow owner → received_from David, current_owner Leo", () => {
    const row = result.rows.find((r) => r.row_number === 12);
    expect(row).toBeDefined();
    expect(row!.received_from).toBe("David");
    expect(row!.current_owner).toBe("Leo");
  });

  test("row #13 'WD re-audit' — escaped \\| in DoD does not break parsing", () => {
    const row = result.rows.find((r) => r.row_number === 13);
    expect(row).toBeDefined();
    expect(row!.status).toBe("active");
    expect(row!.current_owner).toBe("WATCHDOG");
    expect(row!.why).toContain("verdict (adequate|refine|close)");
  });

  test("rows with Project Detail subsection have drift_check 'in-scope'", () => {
    const row5 = result.rows.find((r) => r.row_number === 5);
    expect(row5!.drift_check).toBe("in-scope");
  });

  test("rows without matching detail subsection have drift_check null (logged not crashed)", () => {
    const row12 = result.rows.find((r) => r.row_number === 12);
    expect(row12!.drift_check).toBeNull();
  });

  test("'why' column never silently empty (Leo emphasis)", () => {
    const emptyWhy = result.rows.filter((r) => !r.why || r.why.length === 0);
    expect(emptyWhy.length).toBe(0);
  });

  test("Owner cleanup truncates trailing lowercase annotations", () => {
    const row14 = result.rows.find((r) => r.row_number === 14);
    expect(row14).toBeDefined();
    expect(row14!.current_owner).toBe("NEXUS");
  });
});

describe("parseStewardLog — malformed input (per spec rule 6: emit + warn, do not crash)", () => {
  test("empty string → empty rows + warning", () => {
    const result = parseStewardLog("");
    expect(result.rows).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("missing snapshot heading → empty rows + warning", () => {
    const result = parseStewardLog("# Some other doc\n\nNo snapshot here.\n");
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain("Snapshot");
  });

  test("snapshot heading but no table → empty rows + warning", () => {
    const result = parseStewardLog("## Snapshot — empty\n\nJust prose, no table.\n\n---\n");
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain("table");
  });

  test("table missing required column → warning emitted", () => {
    const malformed = `## Snapshot — bad columns\n\n| Foo | Bar |\n|---|---|\n| x | y |\n\n---\n`;
    const result = parseStewardLog(malformed);
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toMatch(/required columns missing/i);
  });

  test("row with unrecognized status emits warning + skips, does NOT crash", () => {
    const malformed = `## Snapshot — bad status\n\n| # | Project | Owner | DoD | Status |\n|---|---|---|---|---|\n| 1 | Test Proj | Leo | do thing | INVALID-STATUS |\n\n---\n`;
    const result = parseStewardLog(malformed);
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toMatch(/unrecognized status/i);
  });
});

describe("mergeStewardWithHardcoded — collision detection per spec rule 3", () => {
  const stewardResult = parseStewardLog(FIXTURE_CONTENT, { source_path: FIXTURE_PATH });

  test("Steward log wins on collision: CT v0 + Skill Registry v1", () => {
    const { merged, collisions } = mergeStewardWithHardcoded(stewardResult, HARDCODED_FIXTURE);
    expect(collisions.length).toBe(2);
    expect(collisions[0]).toContain("control-tower-v0");
    expect(collisions[1]).toContain("skill-registry-v1-1");
  });

  test("Hardcoded survives if no Steward collision: agent-activation + business-data-access", () => {
    const { merged } = mergeStewardWithHardcoded(stewardResult, HARDCODED_FIXTURE);
    const hardcodedSurvivors = merged.filter((m) => m.source === "hardcoded").map((m) => m.id);
    expect(hardcodedSurvivors).toContain("agent-activation");
    expect(hardcodedSurvivors).toContain("business-data-access");
    expect(hardcodedSurvivors).not.toContain("control-tower-v0");
    expect(hardcodedSurvivors).not.toContain("skill-registry-v1-1");
  });

  test("Total merged count: 14 steward + 2 hardcoded survivors = 16", () => {
    const { merged } = mergeStewardWithHardcoded(stewardResult, HARDCODED_FIXTURE);
    expect(merged.length).toBe(16);
  });

  test("Every merged row has the 5 required columns", () => {
    const { merged } = mergeStewardWithHardcoded(stewardResult, HARDCODED_FIXTURE);
    for (const row of merged) {
      expect(row).toHaveProperty("received_from");
      expect(row).toHaveProperty("current_owner");
      expect(row).toHaveProperty("status");
      expect(row).toHaveProperty("why");
      expect(row).toHaveProperty("drift_check");
    }
  });

  test("Empty hardcoded list → all merged rows are steward-source", () => {
    const { merged, collisions } = mergeStewardWithHardcoded(stewardResult, []);
    expect(collisions.length).toBe(0);
    expect(merged.length).toBe(14);
    expect(merged.every((m) => m.source === "steward")).toBe(true);
  });
});
