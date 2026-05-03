/**
 * Commerce Office agent activity sources — F3 wire for SHIP-TODAY.
 *
 * For each agent in AGENT_OFFICE_AGENTS, scan its oracle vault under
 * ~/<agent>-oracle/ψ/memory/ for recent markdown activity. Falls back to
 * mockAgentOfficeRow() when no source available — VELA's UI MUST badge
 * `[MOCK]` for those rows (HELM pre-authorized fallback).
 *
 * Spec ref: ψ/memory/forge/inbox/2026-05-03_helm-ship-today-forge-backend.md §F3
 *
 * Day-2+ candidates:
 *   - parse memory file frontmatter for richer activity_summary
 *   - sweep ~/david-oracle/ψ/data/control-tower/ for cross-agent reports
 *   - integrate paperclipState.activity feed
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  AGENT_OFFICE_AGENTS,
  AgentName,
  AgentOfficeRow,
  AgentSurfacedFor,
  mockAgentOfficeRow,
} from "./agent-office-types";

const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_FILES_PER_AGENT = 200;

const SURFACED_FOR_MAP: Record<AgentName, AgentSurfacedFor> = {
  PULSE: "amy",
  MONEY: "amy",
  MEMO: "both",
  SCOUT: "leo",
  PRINT: "amy",
};

function agentVaultRoot(agent: AgentName): string {
  return join(homedir(), `${agent.toLowerCase()}-oracle`, "ψ", "memory");
}

type ScanResult = {
  totalRecent: number;
  latestMtimeMs: number | null;
  latestRelPath: string | null;
  latestTitle: string | null;
};

function walkVault(root: string, sinceMs: number, accumulator: ScanResult, depth = 0): void {
  if (depth > 3) return;
  if (accumulator.totalRecent >= MAX_FILES_PER_AGENT) return;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = join(root, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkVault(full, sinceMs, accumulator, depth + 1);
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    if (stat.mtimeMs < sinceMs) continue;

    accumulator.totalRecent += 1;
    if (accumulator.latestMtimeMs === null || stat.mtimeMs > accumulator.latestMtimeMs) {
      accumulator.latestMtimeMs = stat.mtimeMs;
      accumulator.latestRelPath = full;
      accumulator.latestTitle = extractTitle(full);
    }
  }
}

function extractTitle(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8");
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const titleField = frontmatterMatch[1].match(/^(?:title|subject|name)\s*:\s*(.+)$/im);
      if (titleField) return titleField[1].trim().slice(0, 100);
    }
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) return h1[1].trim().slice(0, 100);
    const filename = path.split("/").pop() || "";
    return filename.replace(/\.md$/, "").replace(/^[\d_-]+/, "").replace(/[-_]/g, " ").slice(0, 100);
  } catch {
    return null;
  }
}

function scanAgentVault(agent: AgentName): ScanResult {
  const root = agentVaultRoot(agent);
  const acc: ScanResult = {
    totalRecent: 0,
    latestMtimeMs: null,
    latestRelPath: null,
    latestTitle: null,
  };
  if (!existsSync(root)) return acc;
  const sinceMs = Date.now() - RECENT_WINDOW_MS;
  walkVault(root, sinceMs, acc);
  return acc;
}

function scanResultToRow(agent: AgentName, scan: ScanResult): AgentOfficeRow {
  const vaultRoot = agentVaultRoot(agent);
  const vaultExists = existsSync(vaultRoot);

  if (!vaultExists) {
    return mockAgentOfficeRow(agent);
  }

  const isActive = scan.totalRecent > 0 && scan.latestMtimeMs !== null;

  return {
    agent,
    activity_summary: scan.latestTitle
      ? `${scan.latestTitle} (${scan.totalRecent} recent files)`
      : `${agent} vault present, no recent activity (last 7d)`,
    last_run_ts: scan.latestMtimeMs ? new Date(scan.latestMtimeMs).toISOString() : null,
    output_count: scan.totalRecent,
    status: isActive ? "active" : "idle",
    surfaced_for: SURFACED_FOR_MAP[agent],
    is_mock: false,
  };
}

export type AgentOfficeFeed = {
  rows: AgentOfficeRow[];
  /** ISO-8601 of when the scan ran. */
  scanned_at: string;
  /** Number of agents wired with real-source data (rest are mocked). */
  real_count: number;
  /** Number of agents emitted with `is_mock: true`. */
  mock_count: number;
};

export function getAgentOfficeFeed(): AgentOfficeFeed {
  const rows: AgentOfficeRow[] = [];
  let realCount = 0;
  let mockCount = 0;

  for (const agent of AGENT_OFFICE_AGENTS) {
    try {
      const scan = scanAgentVault(agent);
      const row = scanResultToRow(agent, scan);
      rows.push(row);
      if (row.is_mock) mockCount += 1;
      else realCount += 1;
    } catch {
      rows.push(mockAgentOfficeRow(agent));
      mockCount += 1;
    }
  }

  return {
    rows,
    scanned_at: new Date().toISOString(),
    real_count: realCount,
    mock_count: mockCount,
  };
}
