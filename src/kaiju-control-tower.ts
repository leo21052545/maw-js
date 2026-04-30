import { Elysia } from "elysia";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { readCompanyOsSurfaces } from "../lib/kaiju-state-store";

export const kaijuControlTowerApi = new Elysia();

type Health = "ok" | "watch" | "blocked" | "missing";
type Risk = "L1" | "L2" | "L3" | "L4";
type ApprovalOwner = "Leo" | "Amy" | "HELM" | "David" | "KaijuPM" | "NEXUS" | "FORGE" | "WATCHDOG";
type IssueStatus = "backlog" | "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
type IssuePriority = "critical" | "high" | "medium" | "low";
type ApprovalDecision = "pending" | "approved" | "rejected" | "changes_requested";
type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "stale";
const ACTIVE_RUN_STATES = new Set<RunStatus>(["queued", "running"]);

interface PaperclipState {
  schemaVersion: string;
  company: Record<string, unknown>;
  agentProfiles: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
  approvalRequests: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  routines: Array<Record<string, unknown>>;
  skillBindings: Array<Record<string, unknown>>;
  secrets: Array<Record<string, unknown>>;
  budgets: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
}

const COLLECTIONS = [
  "agentProfiles",
  "issues",
  "approvalRequests",
  "runs",
  "routines",
  "skillBindings",
  "secrets",
  "budgets",
  "activity",
] as const;

type CollectionName = (typeof COLLECTIONS)[number];

function latestPath(): string {
  return process.env.KAIJU_CONTROL_TOWER_LATEST
    || join(homedir(), "david-oracle", "ψ/state/control-tower/latest.json");
}

function stateDir(): string {
  return process.env.KAIJU_CONTROL_TOWER_STATE_DIR || dirname(latestPath());
}

function statePath(): string {
  return process.env.KAIJU_CONTROL_TOWER_PAPERCLIP_STATE || join(stateDir(), "paperclip-state.json");
}

function activityPath(): string {
  return process.env.KAIJU_CONTROL_TOWER_ACTIVITY || join(stateDir(), "paperclip-activity.ndjson");
}

function nowIso(): string {
  return new Date().toISOString();
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "item";
}

function makeId(prefix: string, value?: string): string {
  const stem = value ? slug(value).slice(0, 44) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${stem}-${Date.now().toString(36)}`;
}

function normalizeArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultCompany() {
  const timestamp = nowIso();
  return {
    id: "kaiju-ai-office",
    name: "Kaiju AI Office",
    mission: "Operate Kaiju with approval-gated AI departments, real source-of-truth data, and visible accountability.",
    description: "Paperclip-style operating cockpit on top of David Oracle, maw-js, and maw-ui.",
    brandColor: "#5b5ef7",
    requireApprovalForHires: true,
    approvalMode: "approval_gated",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultAgents() {
  const timestamp = nowIso();
  return [
    {
      id: "david",
      name: "David",
      title: "Chief of Staff / Steward",
      role: "Executive compression, routing, audit, and Leo-readable briefings.",
      owner: "Leo",
      lifecycle: "active",
      adapter: "Claude/Codex",
      model: "operator-selected",
      heartbeatSec: 3600,
      canCreateAgents: false,
      canAssignTasks: true,
      canUseSearch: false,
      capabilities: "Route work, maintain memory, prepare approvals, and escalate decisions.",
      skills: ["paperclip", "steward-compression"],
      toolSecretIds: [],
      budgetUsd: 0,
      observedSpendUsd: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "helm",
      name: "HELM",
      title: "Dev/System PM",
      role: "Engineering sequencing, runtime safety, contracts, and implementation quality.",
      reportsTo: "david",
      owner: "Leo",
      lifecycle: "active",
      adapter: "Codex",
      model: "gpt-5.3-codex",
      heartbeatSec: 3600,
      canCreateAgents: false,
      canAssignTasks: true,
      canUseSearch: false,
      capabilities: "Own technical gates, reviews, collector scripts, and runtime safety.",
      skills: ["paperclip-create-plugin", "control-tower-contracts"],
      toolSecretIds: [],
      budgetUsd: 0,
      observedSpendUsd: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "forge",
      name: "FORGE",
      title: "Implementation Engineer",
      role: "Code migration, bridge writer implementation, fixtures, and PR-ready patches.",
      reportsTo: "helm",
      owner: "Leo",
      lifecycle: "active",
      adapter: "Codex",
      model: "gpt-5.3-codex",
      heartbeatSec: 3600,
      canCreateAgents: false,
      canAssignTasks: true,
      canUseSearch: false,
      capabilities: "Implement approved engineering changes and return risky writes for review.",
      skills: ["implementation", "maw-js"],
      toolSecretIds: [],
      budgetUsd: 0,
      observedSpendUsd: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "nexus",
      name: "NEXUS",
      title: "Peer Review / Runtime Safety",
      role: "Peer review, runtime soak checks, budget watcher validation, and escalation routing.",
      reportsTo: "helm",
      owner: "Leo",
      lifecycle: "active",
      adapter: "Codex",
      model: "gpt-5.3-codex",
      heartbeatSec: 3600,
      canCreateAgents: false,
      canAssignTasks: true,
      canUseSearch: false,
      capabilities: "Review DVL packets, validate runtime changes, and report safety blockers.",
      skills: ["peer-review", "runtime-safety"],
      toolSecretIds: [],
      budgetUsd: 0,
      observedSpendUsd: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "kaijupm",
      name: "KaijuPM",
      title: "Business PM",
      role: "Future store-operations project manager and business queue owner.",
      reportsTo: "david",
      owner: "Leo",
      lifecycle: "pending_approval",
      adapter: "Codex",
      model: "gpt-5.3-codex",
      heartbeatSec: 3600,
      canCreateAgents: false,
      canAssignTasks: true,
      canUseSearch: false,
      capabilities: "Coordinate commerce, ops, finance, content, and approvals after activation.",
      skills: [],
      toolSecretIds: [],
      budgetUsd: 0,
      observedSpendUsd: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function defaultSkills() {
  return [
    {
      id: "skill-paperclip-operating-model",
      name: "paperclip-operating-model",
      description: "Use org charts, issues, approvals, runs, budgets, and audit trails as the operating model.",
      lifecycle: "live",
      risk: "L2",
      owner: "HELM",
      agentIds: ["david", "helm"],
      requiredApprovalOwner: "HELM",
      artifactPath: "ops/docs/PAPERCLIP-PATTERN-ADOPTION-v0.md",
    },
    {
      id: "skill-approval-gated-actions",
      name: "approval-gated-actions",
      description: "Draft actions first and require human/steward approval before production effects.",
      lifecycle: "live",
      risk: "L3",
      owner: "WATCHDOG",
      agentIds: ["david", "helm"],
      requiredApprovalOwner: "WATCHDOG",
      artifactPath: "ops/docs/AI-OFFICE-CONTROL-TOWER-v1.md",
    },
  ];
}

function emptyState(): PaperclipState {
  return {
    schemaVersion: "paperclip-parity-v1",
    company: defaultCompany(),
    agentProfiles: defaultAgents(),
    issues: [],
    approvalRequests: [],
    runs: [],
    routines: [],
    skillBindings: defaultSkills(),
    secrets: [],
    budgets: [
      {
        id: "budget-company-default",
        scope: "company",
        targetId: "kaiju-ai-office",
        limitUsd: 0,
        observedUsd: 0,
        alertAtPct: 80,
        mode: "soft",
        status: "ok",
        updatedAt: nowIso(),
      },
    ],
    activity: [],
  };
}

function readJson(path: string, fallback: unknown) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function readState(): PaperclipState {
  const loaded = readJson(statePath(), null) as Partial<PaperclipState> | null;
  const base = emptyState();
  if (!loaded || typeof loaded !== "object") return base;
  const loadedAgents = normalizeArray(loaded.agentProfiles);
  const agentProfiles = loadedAgents.length
    ? [
      ...loadedAgents,
      ...base.agentProfiles.filter((agent) => !loadedAgents.some((item) => item.id === agent.id)),
    ]
    : base.agentProfiles;

  const state: PaperclipState = {
    schemaVersion: typeof loaded.schemaVersion === "string" ? loaded.schemaVersion : base.schemaVersion,
    company: loaded.company && typeof loaded.company === "object" ? loaded.company : base.company,
    agentProfiles,
    issues: normalizeArray(loaded.issues),
    approvalRequests: normalizeArray(loaded.approvalRequests),
    runs: normalizeArray(loaded.runs),
    routines: normalizeArray(loaded.routines),
    skillBindings: normalizeArray(loaded.skillBindings).length ? normalizeArray(loaded.skillBindings) : base.skillBindings,
    secrets: normalizeArray(loaded.secrets),
    budgets: normalizeArray(loaded.budgets).length ? normalizeArray(loaded.budgets) : base.budgets,
    activity: normalizeArray(loaded.activity),
  };
  return state;
}

function sanitizeState(state: PaperclipState): PaperclipState {
  return {
    ...state,
    secrets: state.secrets.map(({ value: _value, raw: _raw, token: _token, ...secret }) => ({
      ...secret,
      sealed: true,
    })),
    activity: state.activity.slice(-200),
  };
}

function writeState(state: PaperclipState) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(sanitizeState(state), null, 2)}\n`, "utf-8");
}

function addActivity(
  state: PaperclipState,
  event: {
    type: string;
    actor?: string;
    targetType: string;
    targetId: string;
    summary: string;
    severity?: "info" | "watch" | "blocked" | "ok";
    correlationId?: string;
    artifactPath?: string;
  },
) {
  const item = {
    id: makeId("activity", event.type),
    actor: event.actor || "Control Tower",
    severity: event.severity || "info",
    createdAt: nowIso(),
    ...event,
  };
  state.activity.push(item);
  if (state.activity.length > 500) state.activity = state.activity.slice(-500);
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(activityPath(), `${JSON.stringify(item)}\n`, "utf-8");
}

function collection(state: PaperclipState, name: CollectionName): Array<Record<string, unknown>> {
  return state[name];
}

function findById(items: Array<Record<string, unknown>>, id: string) {
  return items.find((item) => item.id === id);
}

function updateItem(items: Array<Record<string, unknown>>, id: string, patch: Record<string, unknown>) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  items[index] = { ...items[index], ...patch, id, updatedAt: nowIso() };
  return items[index];
}

function missingPayload() {
  return {
    version: "0",
    updatedAt: nowIso(),
    correlationId: "ct-missing-latest",
    commerce: [
      { label: "Orders Today", value: "No feed", source: "Google Sheets / marketplace APIs", health: "missing", owner: "PULSE" },
      { label: "Revenue Today", value: "No feed", source: "Google Sheets / marketplace APIs", health: "missing", owner: "PULSE" },
      { label: "Top SKU", value: "No feed", source: "PULSE", health: "missing", owner: "PULSE" },
    ],
    operations: [
      { label: "Packing Queue", value: "No feed", source: "OPS sheet", health: "missing", owner: "KaijuPM" },
      { label: "Stock Risks", value: "No feed", source: "stock sheet", health: "missing", owner: "PULSE" },
      { label: "Worker Instructions", value: "No feed", source: "Amy / OPS bot", health: "missing", owner: "Amy" },
    ],
    finance: [
      { label: "Estimated Margin", value: "No feed", source: "MONEY / SKU costs", health: "missing", owner: "MONEY" },
      { label: "Missing Costs", value: "No feed", source: "sku_costs", health: "missing", owner: "Amy" },
      { label: "Docs Pending", value: "No feed", source: "Drive/accounting", health: "missing", owner: "MONEY" },
    ],
    content: [
      { label: "Creator Pipeline", value: "No feed", source: "SCOUT", health: "missing", owner: "SCOUT" },
      { label: "Content Ready", value: "No feed", source: "PRINT", health: "missing", owner: "PRINT" },
      { label: "Campaign Approvals", value: "No feed", source: "approval queue", health: "missing", owner: "KaijuPM" },
    ],
    projects: [],
    tasks: [],
    approvals: [],
    sources: [
      { label: "Control Tower Cache", value: "Missing", source: latestPath(), health: "missing", owner: "HELM" },
    ],
  };
}

function readLatestPayload() {
  const path = latestPath();
  if (!existsSync(path)) return missingPayload();
  return readJson(path, missingPayload()) as Record<string, unknown>;
}

function ownerForRisk(risk: Risk): ApprovalOwner {
  if (risk === "L4") return "Leo";
  if (risk === "L3") return "HELM";
  return "David";
}

function createApproval(
  state: PaperclipState,
  input: {
    title: string;
    summary: string;
    owner?: ApprovalOwner;
    risk?: Risk;
    actionType: string;
    targetType: string;
    targetId: string;
    requestedBy?: string;
    payload?: Record<string, unknown>;
  },
) {
  const risk = input.risk || "L2";
  const approval = {
    id: makeId("approval", input.title),
    title: input.title,
    summary: input.summary,
    owner: input.owner || ownerForRisk(risk),
    risk,
    decision: "pending" as ApprovalDecision,
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: input.targetId,
    requestedBy: input.requestedBy || "Control Tower",
    requestedAt: nowIso(),
    payload: input.payload || {},
  };
  state.approvalRequests.push(approval);
  addActivity(state, {
    type: "approval_requested",
    actor: approval.requestedBy,
    targetType: approval.targetType,
    targetId: approval.targetId,
    summary: approval.title,
    severity: "watch",
  });
  return approval;
}

function budgetBlocked(state: PaperclipState, targetId: string) {
  return state.budgets.some((budget) => (
    (budget.targetId === targetId || budget.scope === "company")
    && budget.approvalStatus !== "pending"
    && budget.mode === "hard"
    && budget.status === "blocked"
  ));
}

function activeRunWithLock(state: PaperclipState, lockKey: string) {
  return state.runs.find((run) => (
    run.lockKey === lockKey
    && ACTIVE_RUN_STATES.has(String(run.status || "queued") as RunStatus)
  ));
}

function applyApprovedAction(state: PaperclipState, approval: Record<string, unknown>, actor: string) {
  const actionType = String(approval.actionType || "");
  const targetId = String(approval.targetId || "");
  const payload = approval.payload && typeof approval.payload === "object" ? approval.payload as Record<string, unknown> : {};

  if (actionType === "hire_agent") {
    updateItem(state.agentProfiles, targetId, { lifecycle: "active" });
  } else if (actionType === "create_routine") {
    updateItem(state.routines, targetId, { status: "active" });
  } else if (actionType === "grant_tool") {
    const agentId = String(payload.agentId || "");
    const secretId = String(payload.secretId || targetId);
    const agent = findById(state.agentProfiles, agentId);
    const secret = findById(state.secrets, secretId);
    if (agent) {
      const current = Array.isArray(agent.toolSecretIds) ? agent.toolSecretIds as string[] : [];
      agent.toolSecretIds = [...new Set([...current, secretId])];
      agent.updatedAt = nowIso();
    }
    if (secret) {
      const current = Array.isArray(secret.agentIds) ? secret.agentIds as string[] : [];
      secret.agentIds = [...new Set([...current, agentId])];
      secret.updatedAt = nowIso();
    }
  } else if (actionType === "promote_skill") {
    updateItem(state.skillBindings, targetId, { lifecycle: payload.lifecycle || "live" });
  } else if (actionType === "budget_change") {
    updateItem(state.budgets, targetId, payload);
  }

  addActivity(state, {
    type: "approved_action_applied",
    actor,
    targetType: String(approval.targetType || "unknown"),
    targetId,
    summary: `Applied approved ${actionType}`,
    severity: "ok",
  });
}

kaijuControlTowerApi.get("/kaiju/control-tower", () => {
  const latest = readLatestPayload();
  const state = sanitizeState(readState());
  const companyOs = readCompanyOsSurfaces();
  return {
    ...latest,
    company: state.company,
    agentProfiles: state.agentProfiles,
    issues: state.issues,
    approvalRequests: state.approvalRequests,
    runs: state.runs,
    routines: state.routines,
    skillBindings: state.skillBindings,
    secrets: state.secrets,
    budgets: state.budgets,
    activity: state.activity,
    missionRooms: companyOs.missionRooms,
    commerceOffice: companyOs.commerceOffice,
    decisionQueue: companyOs.decisionQueue,
    tokenLedgers: companyOs.tokenLedgers,
    oracleBridge: companyOs.oracleBridge,
    workMap: companyOs.workMap,
    sources: [
      ...(Array.isArray(latest.sources) ? latest.sources as unknown[] : []),
      {
        label: "Paperclip-Parity State",
        value: "File-backed",
        source: statePath(),
        health: "ok" as Health,
        owner: "HELM",
      },
      {
        label: "Company OS Surfaces",
        value: "File-backed",
        source: "ψ/state/company-os + ψ/state/mission-room + ψ/state/commerce-office",
        health: "watch" as Health,
        owner: "HELM",
      },
    ],
  };
});

kaijuControlTowerApi.get("/kaiju/company", () => sanitizeState(readState()).company);

kaijuControlTowerApi.patch("/kaiju/company", async ({ body }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  state.company = { ...state.company, ...patch, id: state.company.id, approvalMode: "approval_gated", updatedAt: nowIso() };
  addActivity(state, {
    type: "company_updated",
    actor: String(patch.updatedBy || "Control Tower"),
    targetType: "company",
    targetId: String(state.company.id || "kaiju-ai-office"),
    summary: "Updated company profile",
  });
  writeState(state);
  return sanitizeState(state).company;
});

kaijuControlTowerApi.get("/kaiju/:collection", ({ params, set }) => {
  const name = params.collection as CollectionName;
  if (!COLLECTIONS.includes(name)) {
    set.status = 404;
    return { error: "unknown collection" };
  }
  return collection(sanitizeState(readState()), name);
});

kaijuControlTowerApi.post("/kaiju/agents", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const timestamp = nowIso();
  const name = String(input.name || "New Agent");
  const agent = {
    id: String(input.id || makeId("agent", name)),
    name,
    title: String(input.title || name),
    role: String(input.role || input.capabilities || "Draft agent awaiting approval."),
    reportsTo: input.reportsTo ? String(input.reportsTo) : "david",
    owner: String(input.owner || "Leo"),
    lifecycle: "pending_approval",
    adapter: String(input.adapter || "Codex"),
    model: String(input.model || "gpt-5.3-codex"),
    thinkingEffort: String(input.thinkingEffort || "auto"),
    heartbeatSec: Number(input.heartbeatSec || 3600),
    canCreateAgents: Boolean(input.canCreateAgents),
    canAssignTasks: Boolean(input.canAssignTasks ?? true),
    canUseSearch: Boolean(input.canUseSearch),
    capabilities: String(input.capabilities || "Describe what this agent can do."),
    skills: Array.isArray(input.skills) ? input.skills : [],
    toolSecretIds: [],
    budgetUsd: Number(input.budgetUsd || 0),
    observedSpendUsd: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.agentProfiles.push(agent);
  const approval = createApproval(state, {
    title: `Hire Agent: ${agent.name}`,
    summary: `${agent.title} must be approved before it can run as an active Kaiju agent.`,
    risk: "L2",
    actionType: "hire_agent",
    targetType: "agent",
    targetId: String(agent.id),
    requestedBy: String(input.requestedBy || "Control Tower"),
  });
  writeState(state);
  return { agent: sanitizeState(state).agentProfiles.find((item) => item.id === agent.id), approval };
});

kaijuControlTowerApi.patch("/kaiju/agents/:id", async ({ params, body, set }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (patch.lifecycle === "active") {
    delete patch.lifecycle;
    createApproval(state, {
      title: `Activate Agent: ${params.id}`,
      summary: "Agent activation requires approval-gated review.",
      risk: "L2",
      actionType: "hire_agent",
      targetType: "agent",
      targetId: params.id,
      requestedBy: String(patch.updatedBy || "Control Tower"),
    });
  }
  const item = updateItem(state.agentProfiles, params.id, patch);
  if (!item) {
    set.status = 404;
    return { error: "agent not found" };
  }
  addActivity(state, {
    type: "agent_updated",
    actor: String(patch.updatedBy || "Control Tower"),
    targetType: "agent",
    targetId: params.id,
    summary: `Updated ${String(item.name || params.id)}`,
  });
  writeState(state);
  return sanitizeState(state).agentProfiles.find((agent) => agent.id === params.id);
});

kaijuControlTowerApi.post("/kaiju/agents/:id/heartbeat", ({ params, set }) => {
  const state = readState();
  const agent = findById(state.agentProfiles, params.id);
  if (!agent) {
    set.status = 404;
    return { error: "agent not found" };
  }
  if (agent.lifecycle !== "active") {
    set.status = 409;
    return { error: "agent must be active before heartbeat can run" };
  }
  if (budgetBlocked(state, params.id)) {
    set.status = 409;
    return { error: "budget hard-stop blocks this heartbeat" };
  }
  const lockKey = `heartbeat:${params.id}`;
  const existingRun = activeRunWithLock(state, lockKey);
  if (existingRun) {
    set.status = 409;
    return { error: "heartbeat already queued or running", run: existingRun };
  }
  const run = {
    id: makeId("run", String(agent.name || params.id)),
    agentId: params.id,
    agentName: String(agent.name || params.id),
    trigger: "heartbeat",
    status: "queued" as RunStatus,
    summary: "Heartbeat queued. Runtime execution remains approval-gated and scheduler-controlled.",
    createdAt: nowIso(),
    lockKey,
  };
  state.runs.push(run);
  agent.lastRunId = run.id;
  agent.updatedAt = nowIso();
  addActivity(state, {
    type: "heartbeat_queued",
    actor: "Control Tower",
    targetType: "agent",
    targetId: params.id,
    summary: `Queued heartbeat for ${String(agent.name || params.id)}`,
    severity: "watch",
  });
  writeState(state);
  return run;
});

kaijuControlTowerApi.post("/kaiju/agents/:id/pause", ({ params, set }) => {
  const state = readState();
  const item = updateItem(state.agentProfiles, params.id, { lifecycle: "paused" });
  if (!item) {
    set.status = 404;
    return { error: "agent not found" };
  }
  addActivity(state, { type: "agent_paused", targetType: "agent", targetId: params.id, summary: `Paused ${String(item.name || params.id)}`, severity: "watch" });
  writeState(state);
  return item;
});

kaijuControlTowerApi.post("/kaiju/agents/:id/resume", ({ params, set }) => {
  const state = readState();
  const agent = findById(state.agentProfiles, params.id);
  if (!agent) {
    set.status = 404;
    return { error: "agent not found" };
  }
  if (agent.lifecycle !== "paused") {
    set.status = 409;
    return { error: "only paused agents can be resumed directly" };
  }
  const item = updateItem(state.agentProfiles, params.id, { lifecycle: "active" });
  addActivity(state, { type: "agent_resumed", targetType: "agent", targetId: params.id, summary: `Resumed ${String(agent.name || params.id)}`, severity: "ok" });
  writeState(state);
  return item;
});

kaijuControlTowerApi.post("/kaiju/issues", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const timestamp = nowIso();
  const title = String(input.title || "Untitled Issue");
  const assignee = input.assigneeId ? findById(state.agentProfiles, String(input.assigneeId)) : undefined;
  const issue = {
    id: String(input.id || makeId("issue", title)),
    title,
    description: String(input.description || ""),
    status: (input.status || "todo") as IssueStatus,
    priority: (input.priority || "medium") as IssuePriority,
    assigneeId: input.assigneeId ? String(input.assigneeId) : undefined,
    assigneeName: assignee ? String(assignee.name || assignee.id) : input.assigneeName ? String(input.assigneeName) : undefined,
    projectId: input.projectId ? String(input.projectId) : undefined,
    goalId: input.goalId ? String(input.goalId) : undefined,
    labels: Array.isArray(input.labels) ? input.labels : [],
    blockedBy: input.blockedBy ? String(input.blockedBy) : undefined,
    parentIssueId: input.parentIssueId ? String(input.parentIssueId) : undefined,
    subIssueIds: Array.isArray(input.subIssueIds) ? input.subIssueIds : [],
    approvalIds: [],
    runIds: [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    createdBy: String(input.createdBy || "Control Tower"),
    createdAt: timestamp,
    updatedAt: timestamp,
    dueAt: input.dueAt ? String(input.dueAt) : undefined,
    lastArtifact: input.lastArtifact ? String(input.lastArtifact) : undefined,
  };
  state.issues.push(issue);
  addActivity(state, {
    type: "issue_created",
    actor: issue.createdBy,
    targetType: "issue",
    targetId: issue.id,
    summary: issue.title,
    severity: issue.status === "blocked" ? "blocked" : "info",
  });
  writeState(state);
  return issue;
});

kaijuControlTowerApi.patch("/kaiju/issues/:id", async ({ params, body, set }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const item = updateItem(state.issues, params.id, patch);
  if (!item) {
    set.status = 404;
    return { error: "issue not found" };
  }
  addActivity(state, {
    type: "issue_updated",
    actor: String(patch.updatedBy || "Control Tower"),
    targetType: "issue",
    targetId: params.id,
    summary: `${String(item.title || params.id)} -> ${String(item.status || "updated")}`,
    severity: item.status === "blocked" ? "blocked" : "info",
  });
  writeState(state);
  return item;
});

kaijuControlTowerApi.post("/kaiju/runs", async ({ body, set }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const agentId = String(input.agentId || "");
  const agent = findById(state.agentProfiles, agentId);
  if (!agent) {
    set.status = 404;
    return { error: "agent not found" };
  }
  if (agent.lifecycle !== "active") {
    set.status = 409;
    return { error: "agent must be active before a run can be queued" };
  }
  if (budgetBlocked(state, agentId)) {
    set.status = 409;
    return { error: "budget hard-stop blocks this run" };
  }
  const lockKey = input.issueId ? `issue:${String(input.issueId)}:${agentId}` : `manual:${agentId}`;
  const existingRun = activeRunWithLock(state, lockKey);
  if (existingRun) {
    set.status = 409;
    return { error: "run already queued or running for this lock", run: existingRun };
  }
  const run = {
    id: String(input.id || makeId("run", String(agent.name || agentId))),
    issueId: input.issueId ? String(input.issueId) : undefined,
    agentId,
    agentName: String(agent.name || agentId),
    trigger: String(input.trigger || "manual"),
    status: (input.status || "queued") as RunStatus,
    summary: String(input.summary || "Run queued from Control Tower."),
    stdoutPreview: input.stdoutPreview ? String(input.stdoutPreview).slice(0, 1000) : undefined,
    startedAt: input.startedAt ? String(input.startedAt) : undefined,
    finishedAt: input.finishedAt ? String(input.finishedAt) : undefined,
    tokenCount: input.tokenCount ? Number(input.tokenCount) : undefined,
    costUsd: input.costUsd ? Number(input.costUsd) : undefined,
    lockKey,
    createdAt: nowIso(),
  };
  state.runs.push(run);
  if (run.issueId) {
    const issue = findById(state.issues, String(run.issueId));
    if (issue) {
      issue.runIds = [...new Set([...(Array.isArray(issue.runIds) ? issue.runIds as string[] : []), run.id])];
      issue.updatedAt = nowIso();
    }
  }
  addActivity(state, { type: "run_queued", targetType: "run", targetId: run.id, summary: run.summary, severity: "watch" });
  writeState(state);
  return run;
});

kaijuControlTowerApi.patch("/kaiju/runs/:id", async ({ params, body, set }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const item = updateItem(state.runs, params.id, patch);
  if (!item) {
    set.status = 404;
    return { error: "run not found" };
  }
  addActivity(state, {
    type: "run_updated",
    actor: String(patch.updatedBy || "Control Tower"),
    targetType: "run",
    targetId: params.id,
    summary: `${String(item.agentName || "Agent")} run ${String(item.status || "updated")}`,
    severity: item.status === "failed" ? "blocked" : item.status === "done" ? "ok" : "info",
  });
  writeState(state);
  return item;
});

kaijuControlTowerApi.post("/kaiju/approvals", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const approval = createApproval(state, {
    title: String(input.title || "Approval request"),
    summary: String(input.summary || "Approval is required before this action can go live."),
    owner: input.owner as ApprovalOwner | undefined,
    risk: input.risk as Risk | undefined,
    actionType: String(input.actionType || "issue_gate"),
    targetType: String(input.targetType || "issue"),
    targetId: String(input.targetId || "unknown"),
    requestedBy: String(input.requestedBy || "Control Tower"),
    payload: input.payload && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {},
  });
  writeState(state);
  return approval;
});

kaijuControlTowerApi.patch("/kaiju/approvals/:id", async ({ params, body, set }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const decision = String(input.decision || "pending") as ApprovalDecision;
  if (!["pending", "approved", "rejected", "changes_requested"].includes(decision)) {
    set.status = 400;
    return { error: "invalid decision" };
  }
  const previous = findById(state.approvalRequests, params.id);
  const decisionComment = textValue(input.decisionComment) || textValue(input.decisionNote) || textValue(input.comment);
  const actor = input.decidedBy ? String(input.decidedBy) : "Control Tower";
  const timestamp = nowIso();
  const comments = Array.isArray(previous?.comments) ? previous?.comments as Array<Record<string, unknown>> : [];
  const approval = updateItem(state.approvalRequests, params.id, {
    decision,
    decidedBy: actor,
    decidedAt: decision === "pending" ? undefined : timestamp,
    ...(decisionComment ? {
      lastDecisionComment: decisionComment,
      comments: [
        ...comments,
        {
          id: `approval-comment-${timestamp.replace(/[-:.TZ]/g, "")}`,
          author: actor,
          body: decisionComment,
          decision,
          createdAt: timestamp,
        },
      ],
    } : {}),
  });
  if (!approval) {
    set.status = 404;
    return { error: "approval not found" };
  }
  if (decision === "approved") applyApprovedAction(state, approval, String(approval.decidedBy || "Control Tower"));
  addActivity(state, {
    type: "approval_decided",
    actor: String(approval.decidedBy || "Control Tower"),
    targetType: "approval",
    targetId: params.id,
    summary: decisionComment
      ? `${String(approval.title || params.id)} -> ${decision}: ${decisionComment.slice(0, 160)}`
      : `${String(approval.title || params.id)} -> ${decision}`,
    severity: decision === "approved" ? "ok" : decision === "rejected" ? "blocked" : "watch",
  });
  writeState(state);
  return sanitizeState(state).approvalRequests.find((item) => item.id === params.id);
});

kaijuControlTowerApi.post("/kaiju/routines", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const timestamp = nowIso();
  const title = String(input.title || "New Routine");
  const routine = {
    id: String(input.id || makeId("routine", title)),
    title,
    description: String(input.description || ""),
    status: "draft",
    schedule: String(input.schedule || "manual"),
    assigneeId: input.assigneeId ? String(input.assigneeId) : undefined,
    projectId: input.projectId ? String(input.projectId) : undefined,
    createsIssueTemplate: input.createsIssueTemplate && typeof input.createsIssueTemplate === "object"
      ? input.createsIssueTemplate
      : { title, description: String(input.description || ""), priority: "medium" },
    approvalRequired: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.routines.push(routine);
  const approval = createApproval(state, {
    title: `Create Routine: ${title}`,
    summary: "Recurring work requires approval before it can create live issues.",
    risk: "L3",
    actionType: "create_routine",
    targetType: "routine",
    targetId: routine.id,
    requestedBy: String(input.requestedBy || "Control Tower"),
  });
  writeState(state);
  return { routine, approval };
});

kaijuControlTowerApi.patch("/kaiju/routines/:id", async ({ params, body, set }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (patch.status === "active") {
    delete patch.status;
    createApproval(state, {
      title: `Activate Routine: ${params.id}`,
      summary: "Routine activation requires approval.",
      risk: "L3",
      actionType: "create_routine",
      targetType: "routine",
      targetId: params.id,
      requestedBy: String(patch.updatedBy || "Control Tower"),
    });
  }
  const item = updateItem(state.routines, params.id, patch);
  if (!item) {
    set.status = 404;
    return { error: "routine not found" };
  }
  addActivity(state, { type: "routine_updated", targetType: "routine", targetId: params.id, summary: `Updated ${String(item.title || params.id)}` });
  writeState(state);
  return item;
});

kaijuControlTowerApi.post("/kaiju/skills", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const name = String(input.name || "new-skill");
  const skill = {
    id: String(input.id || makeId("skill", name)),
    name,
    description: String(input.description || ""),
    lifecycle: String(input.lifecycle || "draft"),
    risk: String(input.risk || "L2"),
    owner: String(input.owner || "HELM"),
    agentIds: Array.isArray(input.agentIds) ? input.agentIds : [],
    requiredApprovalOwner: String(input.requiredApprovalOwner || "HELM"),
    artifactPath: input.artifactPath ? String(input.artifactPath) : undefined,
  };
  state.skillBindings.push(skill);
  addActivity(state, { type: "skill_created", targetType: "skill", targetId: skill.id, summary: `Created skill ${name}` });
  writeState(state);
  return skill;
});

kaijuControlTowerApi.patch("/kaiju/skills/:id", async ({ params, body, set }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (patch.lifecycle === "live") {
    delete patch.lifecycle;
    createApproval(state, {
      title: `Promote Skill: ${params.id}`,
      summary: "Skill promotion to live requires approval.",
      risk: "L3",
      actionType: "promote_skill",
      targetType: "skill",
      targetId: params.id,
      requestedBy: String(patch.updatedBy || "Control Tower"),
      payload: { lifecycle: "live" },
    });
  }
  const item = updateItem(state.skillBindings, params.id, patch);
  if (!item) {
    set.status = 404;
    return { error: "skill not found" };
  }
  addActivity(state, { type: "skill_updated", targetType: "skill", targetId: params.id, summary: `Updated ${String(item.name || params.id)}` });
  writeState(state);
  return item;
});

kaijuControlTowerApi.post("/kaiju/secrets", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const key = String(input.key || "SECRET_KEY").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const timestamp = nowIso();
  const secret = {
    id: String(input.id || makeId("secret", key)),
    key,
    label: String(input.label || key),
    provider: String(input.provider || "external"),
    scope: String(input.scope || "company"),
    agentIds: [],
    sealed: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.secrets.push(secret);
  addActivity(state, { type: "secret_sealed", targetType: "secret", targetId: secret.id, summary: `Sealed ${key}`, severity: "ok" });
  writeState(state);
  return sanitizeState(state).secrets.find((item) => item.id === secret.id);
});

kaijuControlTowerApi.post("/kaiju/secrets/:id/grant", async ({ params, body, set }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const secret = findById(state.secrets, params.id);
  const agentId = String(input.agentId || "");
  const agent = findById(state.agentProfiles, agentId);
  if (!secret || !agent) {
    set.status = 404;
    return { error: "secret or agent not found" };
  }
  const approval = createApproval(state, {
    title: `Grant Tool Secret: ${String(secret.key || params.id)} to ${String(agent.name || agentId)}`,
    summary: "Tool and secret access must be approved before the agent can use it.",
    risk: "L3",
    actionType: "grant_tool",
    targetType: "secret",
    targetId: params.id,
    requestedBy: String(input.requestedBy || "Control Tower"),
    payload: { secretId: params.id, agentId },
  });
  writeState(state);
  return approval;
});

kaijuControlTowerApi.post("/kaiju/budgets", async ({ body }) => {
  const state = readState();
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const budget = {
    id: String(input.id || makeId("budget", String(input.targetId || "company"))),
    scope: String(input.scope || "company"),
    targetId: String(input.targetId || "kaiju-ai-office"),
    limitUsd: Number(input.limitUsd || 0),
    observedUsd: Number(input.observedUsd || 0),
    alertAtPct: Number(input.alertAtPct || 80),
    mode: String(input.mode || "soft"),
    status: String(input.status || "ok"),
    approvalStatus: "pending",
    updatedAt: nowIso(),
  };
  state.budgets.push(budget);
  createApproval(state, {
    title: `Budget Policy: ${budget.targetId}`,
    summary: "Budget policy changes require approval before enforcement.",
    risk: "L3",
    actionType: "budget_change",
    targetType: "budget",
    targetId: budget.id,
    requestedBy: String(input.requestedBy || "Control Tower"),
    payload: { ...budget, approvalStatus: "approved" },
  });
  writeState(state);
  return budget;
});

kaijuControlTowerApi.patch("/kaiju/budgets/:id", async ({ params, body, set }) => {
  const state = readState();
  const patch = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const item = findById(state.budgets, params.id);
  if (!item) {
    set.status = 404;
    return { error: "budget not found" };
  }
  const approval = createApproval(state, {
    title: `Budget Policy Change: ${params.id}`,
    summary: "Budget policy changes require approval before enforcement.",
    risk: "L3",
    actionType: "budget_change",
    targetType: "budget",
    targetId: params.id,
    requestedBy: String(patch.requestedBy || patch.updatedBy || "Control Tower"),
    payload: { ...patch, approvalStatus: "approved" },
  });
  addActivity(state, { type: "budget_change_requested", targetType: "budget", targetId: params.id, summary: `Requested budget change ${params.id}`, severity: "watch" });
  writeState(state);
  return { budget: item, approval };
});
