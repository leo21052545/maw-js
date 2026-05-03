/**
 * Tests for src/lib/agent-office-types.ts + src/lib/agent-office-sources.ts
 *
 * F3 wire (HELM SHIP-TODAY 2026-05-03):
 *   - AgentOfficeRow contract
 *   - mockAgentOfficeRow factory
 *   - getAgentOfficeFeed real-or-mock scan
 *   - Mock fallback when vault missing (HELM-pre-authorized)
 */

import { describe, test, expect } from "bun:test";
import {
  AGENT_OFFICE_AGENTS,
  type AgentName,
  mockAgentOfficeRow,
} from "../src/lib/agent-office-types";
import { getAgentOfficeFeed } from "../src/lib/agent-office-sources";

describe("agent-office-types", () => {
  test("AGENT_OFFICE_AGENTS roster has 5 agents (PULSE/MONEY/MEMO/SCOUT/PRINT)", () => {
    expect(AGENT_OFFICE_AGENTS).toEqual(["PULSE", "MONEY", "MEMO", "SCOUT", "PRINT"]);
  });

  test("mockAgentOfficeRow always sets is_mock=true (UI badge contract)", () => {
    for (const agent of AGENT_OFFICE_AGENTS) {
      const row = mockAgentOfficeRow(agent);
      expect(row.is_mock).toBe(true);
    }
  });

  test("mockAgentOfficeRow surfaced_for assignment per spec", () => {
    const expected: Record<AgentName, string> = {
      PULSE: "amy",
      MONEY: "amy",
      MEMO: "both",
      SCOUT: "leo",
      PRINT: "amy",
    };
    for (const agent of AGENT_OFFICE_AGENTS) {
      expect(mockAgentOfficeRow(agent).surfaced_for).toBe(expected[agent] as never);
    }
  });

  test("mockAgentOfficeRow activity_summary includes [MOCK] tag", () => {
    for (const agent of AGENT_OFFICE_AGENTS) {
      expect(mockAgentOfficeRow(agent).activity_summary).toContain("[MOCK]");
    }
  });

  test("mockAgentOfficeRow status defaults to idle", () => {
    for (const agent of AGENT_OFFICE_AGENTS) {
      expect(mockAgentOfficeRow(agent).status).toBe("idle");
    }
  });

  test("mockAgentOfficeRow last_run_ts is null + output_count is 0", () => {
    for (const agent of AGENT_OFFICE_AGENTS) {
      const row = mockAgentOfficeRow(agent);
      expect(row.last_run_ts).toBeNull();
      expect(row.output_count).toBe(0);
    }
  });
});

describe("getAgentOfficeFeed — live vault scan", () => {
  test("returns 5 rows total (one per agent in roster)", () => {
    const feed = getAgentOfficeFeed();
    expect(feed.rows.length).toBe(5);
  });

  test("real_count + mock_count sums to 5 (no rows lost)", () => {
    const feed = getAgentOfficeFeed();
    expect(feed.real_count + feed.mock_count).toBe(5);
  });

  test("each row has the required AgentOfficeRow shape", () => {
    const feed = getAgentOfficeFeed();
    for (const row of feed.rows) {
      expect(row).toHaveProperty("agent");
      expect(row).toHaveProperty("activity_summary");
      expect(row).toHaveProperty("last_run_ts");
      expect(row).toHaveProperty("output_count");
      expect(row).toHaveProperty("status");
      expect(row).toHaveProperty("surfaced_for");
      expect(row).toHaveProperty("is_mock");
    }
  });

  test("status is one of active|idle|blocked", () => {
    const feed = getAgentOfficeFeed();
    const valid = new Set(["active", "idle", "blocked"]);
    for (const row of feed.rows) {
      expect(valid.has(row.status)).toBe(true);
    }
  });

  test("scanned_at is a valid ISO-8601 timestamp", () => {
    const feed = getAgentOfficeFeed();
    expect(() => new Date(feed.scanned_at).toISOString()).not.toThrow();
  });

  test("real-source rows have non-mock activity_summary", () => {
    const feed = getAgentOfficeFeed();
    for (const row of feed.rows) {
      if (!row.is_mock) {
        expect(row.activity_summary).not.toContain("[MOCK]");
      }
    }
  });
});
