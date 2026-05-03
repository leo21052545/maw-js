/**
 * Commerce Office agent embed — type contract.
 *
 * Defined per HELM SHIP-TODAY F3 spec (2026-05-03). VELA renders against this shape;
 * `is_mock: true` rows MUST be visually badged `[MOCK]` until real wire lands.
 *
 * Source of truth for field semantics:
 *   ψ/memory/forge/inbox/2026-05-03_helm-ship-today-forge-backend.md §F3
 */

export type AgentName = "PULSE" | "MONEY" | "MEMO" | "SCOUT" | "PRINT";

export type AgentOfficeStatus = "active" | "idle" | "blocked";

export type AgentSurfacedFor = "amy" | "leo" | "both";

export type AgentOfficeRow = {
  agent: AgentName;
  /** 1-line "what they did today" — UI displays directly. */
  activity_summary: string;
  /** ISO-8601 timestamp of most recent run, or null if never. */
  last_run_ts: string | null;
  /** Domain-specific count: SKUs analyzed, listings published, memories logged, etc. */
  output_count: number;
  status: AgentOfficeStatus;
  /** Whose attention this agent's output flows to. */
  surfaced_for: AgentSurfacedFor;
  /** REQUIRED. true = placeholder (UI must badge `[MOCK]`); false = real wire. */
  is_mock: boolean;
};

export const AGENT_OFFICE_AGENTS: readonly AgentName[] = [
  "PULSE",
  "MONEY",
  "MEMO",
  "SCOUT",
  "PRINT",
] as const;

/**
 * Default mock row generator — used when no real source is available for an agent.
 * VELA's UI MUST render `is_mock: true` with explicit `[MOCK]` badge.
 */
export function mockAgentOfficeRow(agent: AgentName): AgentOfficeRow {
  const surfacedFor: Record<AgentName, AgentSurfacedFor> = {
    PULSE: "amy",
    MONEY: "amy",
    MEMO: "both",
    SCOUT: "leo",
    PRINT: "amy",
  };
  return {
    agent,
    activity_summary: `[MOCK] ${agent} activity not yet wired`,
    last_run_ts: null,
    output_count: 0,
    status: "idle",
    surfaced_for: surfacedFor[agent],
    is_mock: true,
  };
}
