import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, extname, join, relative, resolve, sep } from "path";

export type KaijuRisk = "L1" | "L2" | "L3" | "L4";
export type ApprovalOwner = "Leo" | "Amy" | "HELM" | "David" | "KaijuPM" | "NEXUS" | "FORGE" | "WATCHDOG";

export interface BridgeApprovalInput {
  title: string;
  summary: string;
  risk?: KaijuRisk;
  actionType: string;
  targetType: string;
  targetId: string;
  requestedBy?: string;
  payload?: Record<string, unknown>;
}

export interface DecisionBriefInput {
  id?: string;
  title?: string;
  status?: string;
  decisionOwner?: string;
  source?: string;
  sourceRef?: string;
  projectId?: string;
  workAreaId?: string;
  riskLevel?: string;
  urgency?: string;
  plainLanguageQuestion?: string;
  contextShort?: string;
  whyThisMatters?: string;
  options?: unknown[];
  recommendedOption?: string;
  impactIfApprove?: string;
  impactIfReject?: string;
  impactIfWait?: string;
  requiredApprovers?: unknown[];
  nextActionAfterDecision?: string;
  assignedAgentId?: string;
  assignedAgentName?: string;
  links?: unknown[];
  createdBy?: string;
  decisionComment?: string;
  decisionNote?: string;
  lastDecisionComment?: string;
  comments?: unknown[];
}

export interface OracleSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".ndjson",
  ".csv",
  ".yaml",
  ".yml",
  ".toml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
]);

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".cache", ".next"]);

export function nowIso(): string {
  return new Date().toISOString();
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "item";
}

export function makeId(prefix: string, value?: string): string {
  const stem = value ? slug(value).slice(0, 44) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${stem}-${Date.now().toString(36)}`;
}

function latestPath(): string {
  return process.env.KAIJU_CONTROL_TOWER_LATEST
    || join(homedir(), "david-oracle", "ψ/state/control-tower/latest.json");
}

export function davidOracleRoot(): string {
  if (process.env.DAVID_ORACLE_ROOT) return resolve(process.env.DAVID_ORACLE_ROOT);
  const marker = `${sep}ψ${sep}`;
  const latest = resolve(latestPath());
  const markerIndex = latest.indexOf(marker);
  if (markerIndex > 0) return latest.slice(0, markerIndex);
  return join(homedir(), "david-oracle");
}

export function psiRoot(): string {
  return join(davidOracleRoot(), "ψ");
}

export function stateRoot(): string {
  return join(psiRoot(), "state");
}

export function stateFile(surface: string, filename: string): string {
  return join(stateRoot(), surface, filename);
}

function controlTowerStateFile(): string {
  const stateDir = process.env.KAIJU_CONTROL_TOWER_STATE_DIR || dirname(latestPath());
  return process.env.KAIJU_CONTROL_TOWER_PAPERCLIP_STATE || join(stateDir, "paperclip-state.json");
}

function controlTowerActivityFile(): string {
  const stateDir = process.env.KAIJU_CONTROL_TOWER_STATE_DIR || dirname(latestPath());
  return process.env.KAIJU_CONTROL_TOWER_ACTIVITY || join(stateDir, "paperclip-activity.ndjson");
}

export function ensureDirFor(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  ensureDirFor(path);
  writeFileSync(path, `${JSON.stringify(maskSecrets(value), null, 2)}\n`, "utf-8");
}

export function appendNdjson(path: string, value: unknown): void {
  ensureDirFor(path);
  appendFileSync(path, `${JSON.stringify(maskSecrets(value))}\n`, "utf-8");
}

export function readStateWithExample<T>(
  surface: string,
  filename: string,
  exampleFilename: string,
  fallback: T,
): T {
  const primary = stateFile(surface, filename);
  if (existsSync(primary)) return readJsonFile(primary, fallback);
  return readJsonFile(stateFile(surface, exampleFilename), fallback);
}

export function maskSecrets<T>(value: T): T {
  const secretKey = /(secret|token|password|api[_-]?key|credential|raw|privateKey)/i;

  function walk(item: unknown, parentKey = ""): unknown {
    if (Array.isArray(item)) return item.map((entry) => walk(entry, parentKey));
    if (!item || typeof item !== "object") return item;
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(item as Record<string, unknown>)) {
      if (secretKey.test(key) && typeof inner === "string" && inner.length > 0) {
        output[key] = "[sealed]";
      } else if (parentKey === "secrets" && key === "value") {
        output[key] = "[sealed]";
      } else {
        output[key] = walk(inner, key);
      }
    }
    return output;
  }

  return walk(value) as T;
}

function defaultMissionRoomState() {
  return {
    schemaVersion: "kaiju-mission-room-v0",
    updatedAt: nowIso(),
    rooms: [],
  };
}

function defaultCommerceOfficeState() {
  return {
    schemaVersion: "kaiju-commerce-office-v0",
    updatedAt: nowIso(),
    staffAccess: {
      defaultRole: "operator",
      allowedSurfaces: ["workQueue", "packing", "stockCount", "productionLog"],
      blockedSurfaces: ["controlTower", "missionRooms", "oracle", "agents", "runs", "secrets", "costs"],
    },
    workQueues: [],
    operatorTasks: [],
    stockMovementDrafts: [],
    productionBatchDrafts: [],
  };
}

function defaultCompanyOsState() {
  return {
    schemaVersion: "kaiju-company-os-v0",
    updatedAt: nowIso(),
    tokenLedgers: [],
  };
}

function defaultDecisionQueueState() {
  return {
    schemaVersion: "kaiju-decision-queue-v0",
    updatedAt: nowIso(),
    status: "active",
    summary: "Default decision interface for Leo/Amy/HELM proposals. Raw requests must become DecisionBrief records before approval.",
    openCount: 0,
    criticalCount: 0,
    briefs: [],
  };
}

function defaultWorkMapState() {
  return {
    schemaVersion: "kaiju-work-map-v0",
    updatedAt: nowIso(),
    hierarchy: [],
    peopleQueues: [],
    workAreas: [],
    projectFlow: [],
    agentUseCases24x7: [],
    oracleHandoff: {
      status: "drafted",
      owner: "David",
      targetInbox: "ψ/memory/helm/inbox",
      nextAction: "Awaiting Oracle Agent Team intake.",
      sourcePaths: [],
    },
  };
}

export function readMissionRoomState(): Record<string, unknown> {
  return readStateWithExample(
    "mission-room",
    "mission-room-state.json",
    "mission-room-state.example.json",
    defaultMissionRoomState(),
  );
}

export function writeMissionRoomState(state: Record<string, unknown>): void {
  writeJsonFile(stateFile("mission-room", "mission-room-state.json"), {
    ...state,
    updatedAt: nowIso(),
  });
}

export function readCommerceOfficeState(): Record<string, unknown> {
  return readStateWithExample(
    "commerce-office",
    "commerce-office-state.json",
    "commerce-office-state.example.json",
    defaultCommerceOfficeState(),
  );
}

export function writeCommerceOfficeState(state: Record<string, unknown>): void {
  writeJsonFile(stateFile("commerce-office", "commerce-office-state.json"), {
    ...state,
    updatedAt: nowIso(),
  });
}

export function readCompanyOsState(): Record<string, unknown> {
  return readStateWithExample(
    "company-os",
    "company-os-state.json",
    "company-os-state.example.json",
    defaultCompanyOsState(),
  );
}

export function readWorkMapState(): Record<string, unknown> {
  return readStateWithExample(
    "company-os",
    "work-map-state.json",
    "work-map-state.example.json",
    defaultWorkMapState(),
  );
}

function normalizeDecisionQueue(state: Record<string, unknown>): Record<string, unknown> {
  const briefs = Array.isArray(state.briefs) ? state.briefs as Array<Record<string, unknown>> : [];
  const openStatuses = new Set(["pending", "draft_context_needed", "request_changes", "deferred"]);
  const openCount = briefs.filter((brief) => openStatuses.has(String(brief.status || "pending"))).length;
  const criticalCount = briefs.filter((brief) => openStatuses.has(String(brief.status || "pending")) && brief.riskLevel === "critical").length;
  return {
    ...defaultDecisionQueueState(),
    ...state,
    briefs,
    openCount,
    criticalCount,
    updatedAt: state.updatedAt || nowIso(),
  };
}

export function readDecisionQueueState(): Record<string, unknown> {
  const primary = stateFile("company-os", "decision-queue-state.json");
  if (existsSync(primary)) return normalizeDecisionQueue(readJsonFile(primary, defaultDecisionQueueState()));

  const example = stateFile("company-os", "decision-queue-state.example.json");
  if (existsSync(example)) return normalizeDecisionQueue(readJsonFile(example, defaultDecisionQueueState()));

  const companyOs = readCompanyOsState();
  const embedded = companyOs.decisionQueue && typeof companyOs.decisionQueue === "object"
    ? companyOs.decisionQueue as Record<string, unknown>
    : {};
  return normalizeDecisionQueue(embedded);
}

export function writeDecisionQueueState(state: Record<string, unknown>): void {
  writeJsonFile(stateFile("company-os", "decision-queue-state.json"), normalizeDecisionQueue({
    ...state,
    updatedAt: nowIso(),
  }));
}

export function buildDecisionBrief(input: DecisionBriefInput, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const title = String(input.title || existing.title || "Decision needed");
  const missingContext = !input.plainLanguageQuestion && !existing.plainLanguageQuestion
    || !input.whyThisMatters && !existing.whyThisMatters
    || !input.nextActionAfterDecision && !existing.nextActionAfterDecision;
  const status = String(input.status || existing.status || (missingContext ? "draft_context_needed" : "pending"));
  return maskSecrets({
    ...existing,
    id: String(input.id || existing.id || makeId("decision", title)),
    title,
    status,
    decisionOwner: String(input.decisionOwner || existing.decisionOwner || "Leo / Amy"),
    source: String(input.source || existing.source || "control_tower"),
    sourceRef: input.sourceRef ?? existing.sourceRef,
    projectId: input.projectId ?? existing.projectId,
    workAreaId: input.workAreaId ?? existing.workAreaId,
    riskLevel: String(input.riskLevel || existing.riskLevel || "medium"),
    urgency: String(input.urgency || existing.urgency || "this_week"),
    plainLanguageQuestion: String(input.plainLanguageQuestion || existing.plainLanguageQuestion || ""),
    contextShort: String(input.contextShort || existing.contextShort || ""),
    whyThisMatters: String(input.whyThisMatters || existing.whyThisMatters || ""),
    options: Array.isArray(input.options) ? input.options : Array.isArray(existing.options) ? existing.options : [],
    recommendedOption: input.recommendedOption ?? existing.recommendedOption,
    impactIfApprove: input.impactIfApprove ?? existing.impactIfApprove,
    impactIfReject: input.impactIfReject ?? existing.impactIfReject,
    impactIfWait: input.impactIfWait ?? existing.impactIfWait,
    requiredApprovers: Array.isArray(input.requiredApprovers)
      ? input.requiredApprovers
      : Array.isArray(existing.requiredApprovers) ? existing.requiredApprovers : [String(input.decisionOwner || existing.decisionOwner || "Leo")],
    nextActionAfterDecision: String(input.nextActionAfterDecision || existing.nextActionAfterDecision || ""),
    assignedAgentId: input.assignedAgentId ?? existing.assignedAgentId,
    assignedAgentName: input.assignedAgentName ?? existing.assignedAgentName,
    links: Array.isArray(input.links) ? input.links : Array.isArray(existing.links) ? existing.links : [],
    comments: Array.isArray(input.comments) ? input.comments : Array.isArray(existing.comments) ? existing.comments : [],
    lastDecisionComment: input.lastDecisionComment || input.decisionComment || input.decisionNote || existing.lastDecisionComment,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
  });
}

export function readCompanyOsSurfaces() {
  const missionState = readMissionRoomState();
  const commerceState = readCommerceOfficeState();
  const companyOs = readCompanyOsState();
  const decisionQueue = readDecisionQueueState();
  const workMap = {
    ...readWorkMapState(),
    decisionQueue,
  };
  const primaryIntentFile = stateFile("oracle-bridge", "oracle-intents.ndjson");
  const exampleIntentFile = stateFile("oracle-bridge", "oracle-intents.example.ndjson");
  const intentFile = existsSync(primaryIntentFile) ? primaryIntentFile : exampleIntentFile;

  return maskSecrets({
    missionRooms: Array.isArray(missionState.rooms) ? missionState.rooms : [],
    commerceOffice: commerceState,
    decisionQueue,
    tokenLedgers: Array.isArray(companyOs.tokenLedgers) ? companyOs.tokenLedgers : [],
    workMap,
    oracleBridge: {
      mode: "read_link_intent",
      root: davidOracleRoot(),
      allowlist: ["ψ/", "ops/docs/"],
      writable: [
        "ψ/state/oracle-bridge/oracle-intents.ndjson",
        "ψ/state/oracle-bridge/oracle-links.ndjson",
        "ψ/state/oracle-bridge/oracle-activity.ndjson",
      ],
      intentCount: countNdjson(intentFile),
      updatedAt: nowIso(),
    },
  });
}

export function staffCommerceView() {
  const state = readCommerceOfficeState();
  return maskSecrets({
    schemaVersion: state.schemaVersion,
    updatedAt: state.updatedAt,
    staffAccess: state.staffAccess,
    workQueues: state.workQueues,
    operatorTasks: state.operatorTasks,
    stockMovementDrafts: state.stockMovementDrafts,
    productionBatchDrafts: state.productionBatchDrafts,
  });
}

export function resolveOraclePath(requestedPath: string): { absolutePath: string; relativePath: string } {
  const root = resolve(davidOracleRoot());
  const cleaned = requestedPath.replace(/^\/+/, "");
  const absolutePath = resolve(root, cleaned);
  const relativePath = relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`${sep}..${sep}`)) {
    throw new Error("Path is outside David Oracle root");
  }
  const allowed = relativePath === "ψ"
    || relativePath.startsWith(`ψ${sep}`)
    || relativePath === join("ops", "docs")
    || relativePath.startsWith(`${join("ops", "docs")}${sep}`);
  if (!allowed) throw new Error("Path is not in the Oracle Bridge allowlist");
  return { absolutePath, relativePath };
}

export function readOracleArtifact(requestedPath: string, maxBytes = 120_000) {
  const resolved = resolveOraclePath(requestedPath);
  if (!existsSync(resolved.absolutePath)) throw new Error("Oracle artifact does not exist");
  const stat = statSync(resolved.absolutePath);
  if (!stat.isFile()) throw new Error("Oracle artifact is not a file");
  const ext = extname(resolved.absolutePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) throw new Error("Oracle artifact type is not readable through the bridge");
  const content = readFileSync(resolved.absolutePath, "utf-8").slice(0, maxBytes);
  return maskSecrets({
    path: resolved.relativePath,
    bytes: stat.size,
    truncated: stat.size > maxBytes,
    content,
  });
}

function listTextFiles(start: string, maxFiles: number, output: string[]): void {
  if (output.length >= maxFiles || !existsSync(start)) return;
  const stat = statSync(start);
  if (stat.isFile()) {
    const ext = extname(start).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) && stat.size <= 260_000) output.push(start);
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of readdirSync(start, { withFileTypes: true })) {
    if (output.length >= maxFiles) return;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    listTextFiles(join(start, entry.name), maxFiles, output);
  }
}

export function searchOracleText(query: string, limit = 12): OracleSearchResult[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const root = davidOracleRoot();
  const files: string[] = [];
  listTextFiles(join(root, "ops", "docs"), 120, files);
  listTextFiles(join(root, "ψ"), 260, files);

  const results: OracleSearchResult[] = [];
  for (const absolutePath of files) {
    const content = readFileSync(absolutePath, "utf-8");
    const haystack = content.toLowerCase();
    const index = haystack.indexOf(trimmed);
    if (index < 0) continue;
    const start = Math.max(0, index - 90);
    const end = Math.min(content.length, index + trimmed.length + 180);
    results.push({
      path: relative(root, absolutePath),
      title: relative(root, absolutePath).split(sep).slice(-2).join("/"),
      snippet: content.slice(start, end).replace(/\s+/g, " ").trim(),
      score: Math.max(1, 1000 - index),
    });
    if (results.length >= limit) break;
  }
  return maskSecrets(results.sort((a, b) => b.score - a.score).slice(0, limit));
}

interface V1MarkerContents {
  schemaVersion: "v1" | "v0";
  ratifiedAt: string;
}

function v1MarkerPath(): string {
  return join(davidOracleRoot(), "ψ", "state", "oracle-bridge", "v1-active");
}

function readV1Marker(): V1MarkerContents | null {
  const path = v1MarkerPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.schemaVersion !== "v1") return null;
    if (!data.ratifiedAt || isNaN(Date.parse(data.ratifiedAt))) return null;
    return data;
  } catch {
    return null;
  }
}

function computeIdempotencyKey(input: Record<string, unknown>): string {
  const canonical = {
    kind: input.kind,
    riskClass: input.riskClass,
    title: input.title,
    summary: input.summary,
    targetPath: input.targetPath,
    targetId: input.targetId,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

const SIGNED_BY_ALLOW = new Set([
  "Codex", "Control Tower", "HELM", "David", "NEXUS",
  "FORGE", "WATCHDOG", "Leo", "Amy",
]);

const APPROVAL_OWNERS = new Set([
  "Leo", "Amy", "HELM", "David", "KaijuPM", "WATCHDOG",
]);

const RISK_CLASSES = new Set([
  "read", "propose", "link",
  "write_oracle", "write_business",
  "tool_grant", "secret_access",
  "budget_spend", "external_message",
  "stock_change", "formula_change", "finance_change",
  "deploy",
]);

export function appendOracleIntent(input: Record<string, unknown>) {
  const v1Active = readV1Marker();
  const title = String(input.title || input.kind || "Oracle intent");

  const baseIntent = {
    id: String(input.id || makeId("intent", title)),
    kind: String(input.kind || "general_intent"),
    title,
    summary: String(input.summary || ""),
    risk: String(input.risk || "L2") as KaijuRisk,
    requestedBy: String(input.requestedBy || "Control Tower"),
    targetPath: input.targetPath ? String(input.targetPath) : undefined,
    targetId: input.targetId ? String(input.targetId) : undefined,
    approvalId: input.approvalId || null,
    createdAt: nowIso(),
  };

  if (!v1Active) {
    appendNdjson(stateFile("oracle-bridge", "oracle-intents.ndjson"), baseIntent);
    return maskSecrets(baseIntent);
  }

  const requestedByValue = input.requestedBy as string | undefined;
  const signedByValue = (input.signedBy as string | undefined) ?? requestedByValue;

  const missing: string[] = [];
  if (!signedByValue) missing.push("signedBy");
  if (!input.approvalOwner) missing.push("approvalOwner");
  if (!input.riskClass) missing.push("riskClass");
  if (missing.length) {
    return rejectIntent(baseIntent, "missing_field", { fields: missing });
  }

  if (
    requestedByValue !== undefined &&
    (input.signedBy as string | undefined) !== undefined &&
    requestedByValue !== signedByValue
  ) {
    return rejectIntent(baseIntent, "signedBy_requestedBy_mismatch",
      { signedBy: signedByValue, requestedBy: requestedByValue });
  }

  if ((input.signedBy as string | undefined) === undefined && requestedByValue !== undefined) {
    console.warn(
      "[bridge-writer] requestedBy is deprecated; use signedBy. Will be removed in v1.1.",
      { intentId: baseIntent.id, requestedBy: requestedByValue },
    );
  }

  const signedBy = signedByValue!;
  const approvalOwner = input.approvalOwner as string;
  const riskClass = input.riskClass as string;

  if (!SIGNED_BY_ALLOW.has(signedBy)) {
    return rejectIntent(baseIntent, "bad_signedBy", { value: signedBy });
  }
  if (!APPROVAL_OWNERS.has(approvalOwner)) {
    return rejectIntent(baseIntent, "bad_enum",
      { field: "approvalOwner", value: approvalOwner });
  }
  if (!RISK_CLASSES.has(riskClass)) {
    return rejectIntent(baseIntent, "bad_enum",
      { field: "riskClass", value: riskClass });
  }

  if (signedBy === approvalOwner) {
    return rejectIntent(baseIntent, "self_approval", { signedBy });
  }

  const idempotencyKey = (input.idempotencyKey as string | undefined)
    ?? computeIdempotencyKey(input);

  const intent = {
    ...baseIntent,
    idempotencyKey,
    signedBy,
    requestedBy: requestedByValue ?? signedBy,
    approvalOwner,
    riskClass,
  };

  appendNdjson(stateFile("oracle-bridge", "oracle-intents.v1.ndjson"), intent);
  syncToApprovals(intent);

  return maskSecrets(intent);
}

function rejectIntent(
  base: Record<string, unknown>,
  reason: string,
  detail?: Record<string, unknown>,
): never {
  const day = new Date().toISOString().slice(0, 10);
  appendNdjson(
    stateFile("oracle-bridge", `oracle-intents-rejected-${day}.ndjson`),
    {
      rejected_at: nowIso(),
      rejected_by: "writer",
      rejection_reason: reason,
      detail: detail ?? {},
      original_intent: base,
    },
  );
  throw new Error(`bridge_writer_reject:${reason}`);
}

function syncToApprovals(intent: Record<string, unknown>): void {
  if (intent.risk === "L1") return;
  createControlTowerApprovalDraft({
    title: String(intent.title || ""),
    summary: String(intent.summary || ""),
    risk: intent.risk as KaijuRisk,
    actionType: "oracle_intent",
    targetType: "company",
    targetId: String(intent.targetId || intent.id),
    requestedBy: String(intent.requestedBy || ""),
    payload: {
      intentId: intent.id,
      idempotencyKey: intent.idempotencyKey,
      signedBy: intent.signedBy,
      approvalOwner: intent.approvalOwner,
      riskClass: intent.riskClass,
    },
  });
}

export function appendOracleLink(input: Record<string, unknown>) {
  const link = {
    id: String(input.id || makeId("oracle-link", String(input.sourceId || input.targetPath || "link"))),
    sourceType: String(input.sourceType || "unknown"),
    sourceId: String(input.sourceId || ""),
    targetPath: String(input.targetPath || ""),
    summary: String(input.summary || ""),
    createdBy: String(input.createdBy || "Control Tower"),
    createdAt: nowIso(),
  };
  appendNdjson(stateFile("oracle-bridge", "oracle-links.ndjson"), link);
  appendControlTowerActivity({
    type: "oracle_link_created",
    actor: link.createdBy,
    targetType: link.sourceType,
    targetId: link.sourceId,
    summary: `Linked to ${link.targetPath}`,
    severity: "info",
  });
  return maskSecrets(link);
}

function ownerForRisk(risk: KaijuRisk): ApprovalOwner {
  if (risk === "L4") return "Leo";
  if (risk === "L3") return "HELM";
  return "David";
}

export function createControlTowerApprovalDraft(input: BridgeApprovalInput) {
  const path = controlTowerStateFile();
  const state = readJsonFile<Record<string, unknown>>(path, {
    schemaVersion: "paperclip-parity-v1",
    approvalRequests: [],
    activity: [],
  });
  const approvalRequests = Array.isArray(state.approvalRequests) ? state.approvalRequests as Array<Record<string, unknown>> : [];
  const activity = Array.isArray(state.activity) ? state.activity as Array<Record<string, unknown>> : [];
  const risk = input.risk || "L3";
  const approval = {
    id: makeId("approval", input.title),
    title: input.title,
    summary: input.summary,
    owner: ownerForRisk(risk),
    risk,
    decision: "pending",
    actionType: input.actionType,
    targetType: input.targetType,
    targetId: input.targetId,
    requestedBy: input.requestedBy || "Control Tower",
    requestedAt: nowIso(),
    payload: input.payload || {},
  };
  const event = {
    id: makeId("activity", "approval-requested"),
    type: "approval_requested",
    actor: approval.requestedBy,
    targetType: approval.targetType,
    targetId: approval.targetId,
    summary: approval.title,
    severity: "watch",
    createdAt: nowIso(),
  };

  state.approvalRequests = [...approvalRequests, approval];
  state.activity = [...activity, event].slice(-500);
  writeJsonFile(path, state);
  appendNdjson(controlTowerActivityFile(), event);
  return maskSecrets(approval);
}

function controlTowerArray(state: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = state[key];
  const items = Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>
    : [];
  state[key] = items;
  return items;
}

function decisionText(brief: Record<string, unknown>): string {
  return [
    brief.title,
    brief.contextShort,
    brief.whyThisMatters,
    brief.nextActionAfterDecision,
    brief.recommendedOption,
    brief.assignedAgentId,
    brief.assignedAgentName,
    brief.projectId,
    brief.workAreaId,
  ].filter(Boolean).join(" ").toLowerCase();
}

function agentForDecisionBrief(brief: Record<string, unknown>): { id: string; name: string } {
  const explicitId = String(brief.assignedAgentId || "").trim().toLowerCase();
  const explicitName = String(brief.assignedAgentName || "").trim();
  if (explicitId) return { id: explicitId, name: explicitName || explicitId.toUpperCase() };

  const text = decisionText(brief);
  if (
    text.includes("forge")
    || text.includes("maw-js")
    || text.includes("writer migration")
    || text.includes("appendoracleintent")
    || text.includes("open pr")
    || text.includes("implementation")
  ) {
    return { id: "forge", name: "FORGE" };
  }
  if (text.includes("nexus") || text.includes("peer-review") || text.includes("peer review")) {
    return { id: "nexus", name: "NEXUS" };
  }
  if (text.includes("helm") || text.includes("governance") || text.includes("oracle bridge") || text.includes("runtime")) {
    return { id: "helm", name: "HELM" };
  }
  if (text.includes("kaijupm") || text.includes("commerce") || text.includes("stock") || text.includes("packing")) {
    return { id: "kaijupm", name: "KaijuPM" };
  }
  return { id: "david", name: "David" };
}

function priorityForDecisionBrief(brief: Record<string, unknown>): string {
  const risk = String(brief.riskLevel || "").toLowerCase();
  if (risk === "critical") return "critical";
  if (risk === "high") return "high";
  if (risk === "low") return "low";
  return "medium";
}

function decisionBriefDescription(brief: Record<string, unknown>, actor: string): string {
  const lines = [
    `Approved by: ${actor}`,
    `Decision: ${String(brief.title || "Decision approved")}`,
    "",
    String(brief.plainLanguageQuestion || "") ? `Question: ${String(brief.plainLanguageQuestion)}` : "",
    String(brief.contextShort || "") ? `Context: ${String(brief.contextShort)}` : "",
    String(brief.whyThisMatters || "") ? `Why it matters: ${String(brief.whyThisMatters)}` : "",
    String(brief.recommendedOption || "") ? `Recommended path: ${String(brief.recommendedOption)}` : "",
    String(brief.nextActionAfterDecision || "") ? `Next action: ${String(brief.nextActionAfterDecision)}` : "",
    "",
    `Source decision brief: ${String(brief.id || "")}`,
  ];
  return lines.filter((line, index) => line || lines[index - 1]).join("\n").trim();
}

function decisionAgentInboxArtifact(
  brief: Record<string, unknown>,
  issue: Record<string, unknown>,
  run: Record<string, unknown>,
  agent: { id: string; name: string },
  actor: string,
): { absolutePath: string; relativePath: string; created: boolean } {
  const date = nowIso().slice(0, 10);
  const decisionBriefId = String(brief.id || run.id || issue.id || "decision");
  const filename = `${date}_control-tower-run-${slug(decisionBriefId)}.md`;
  const relativePath = join("ψ", "memory", agent.id, "inbox", filename);
  const absolutePath = join(davidOracleRoot(), relativePath);
  if (existsSync(absolutePath)) return { absolutePath, relativePath, created: false };

  const content = [
    `# Control Tower Approved Run: ${String(issue.title || brief.title || "Agent handoff")}`,
    "",
    `- Agent: ${agent.name} (${agent.id})`,
    `- Issue: ${String(issue.id)}`,
    `- Run: ${String(run.id)}`,
    `- Decision brief: ${decisionBriefId}`,
    `- Approved by: ${actor}`,
    `- Project: ${String(issue.projectId || brief.projectId || "kaiju-company-os")}`,
    `- Priority: ${String(issue.priority || "medium")}`,
    "",
    "## Task",
    String(issue.title || brief.nextActionAfterDecision || brief.title || ""),
    "",
    "## CEO Context",
    String(brief.contextShort || brief.plainLanguageQuestion || ""),
    "",
    "## Why This Matters",
    String(brief.whyThisMatters || ""),
    "",
    "## Expected Output",
    String(brief.nextActionAfterDecision || issue.title || ""),
    "",
    "## Guardrails",
    "- Read and summarize freely.",
    "- Do not change Oracle core structure directly.",
    "- Any risky write/action/tool/secret/budget/deploy/stock/formula/finance change must return to Control Tower as an approval request first.",
    "- Keep output short enough for Leo/Amy to decide quickly.",
    "",
    "## Source Links",
    ...(Array.isArray(brief.links) ? brief.links.map((link) => `- ${String(link)}`) : []),
    "",
  ].join("\n");

  ensureDirFor(absolutePath);
  writeFileSync(absolutePath, content, "utf-8");
  return { absolutePath, relativePath, created: true };
}

export function materializeApprovedDecisionBrief(
  brief: Record<string, unknown>,
  actor = "Control Tower",
): Record<string, unknown> {
  if (String(brief.status) !== "approved") return {};

  const path = controlTowerStateFile();
  const state = readJsonFile<Record<string, unknown>>(path, {
    schemaVersion: "paperclip-parity-v1",
    issues: [],
    runs: [],
    activity: [],
  });
  const issues = controlTowerArray(state, "issues");
  const runs = controlTowerArray(state, "runs");
  const activity = controlTowerArray(state, "activity");
  const timestamp = nowIso();
  const decisionBriefId = String(brief.id || "");
  const agent = agentForDecisionBrief(brief);
  const title = String(brief.nextActionAfterDecision || brief.title || "Approved decision follow-up");

  let issue = issues.find((item) => item.sourceDecisionBriefId === decisionBriefId)
    || issues.find((item) => item.id === brief.issueId);
  let createdIssue = false;

  if (!issue) {
    issue = {
      id: makeId("issue", title),
      title,
      description: decisionBriefDescription(brief, actor),
      status: "todo",
      priority: priorityForDecisionBrief(brief),
      assigneeId: agent.id,
      assigneeName: agent.name,
      projectId: brief.projectId ? String(brief.projectId) : "kaiju-company-os",
      workAreaId: brief.workAreaId ? String(brief.workAreaId) : undefined,
      labels: ["decision-approved", "agent-handoff"],
      sourceDecisionBriefId: decisionBriefId,
      runIds: [],
      approvalIds: brief.approvalId ? [String(brief.approvalId)] : [],
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    issues.push(issue);
    createdIssue = true;
  } else {
    issue.assigneeId = agent.id;
    issue.assigneeName = agent.name;
    issue.sourceDecisionBriefId = decisionBriefId;
    issue.updatedAt = timestamp;
  }

  const lockKey = `decision:${decisionBriefId}:${agent.id}`;
  let run = runs.find((item) => item.sourceDecisionBriefId === decisionBriefId)
    || runs.find((item) => item.id === brief.runId)
    || runs.find((item) => item.lockKey === lockKey);
  let createdRun = false;

  if (!run) {
    run = {
      id: makeId("run", agent.name),
      issueId: String(issue.id),
      agentId: agent.id,
      agentName: agent.name,
      trigger: "decision-approved",
      status: "queued",
      summary: `Approved decision queued for ${agent.name}: ${title}`,
      stdoutPreview: "Queued by Control Tower after Leo/Amy approval. Agent runtime must pick up this run on heartbeat.",
      lockKey,
      sourceDecisionBriefId: decisionBriefId,
      createdAt: timestamp,
    };
    runs.push(run);
    createdRun = true;
  } else {
    run.issueId = run.issueId || String(issue.id);
    run.agentId = agent.id;
    run.agentName = agent.name;
    run.lockKey = lockKey;
    run.sourceDecisionBriefId = decisionBriefId;
    run.updatedAt = timestamp;
  }

  issue.runIds = [...new Set([...(Array.isArray(issue.runIds) ? issue.runIds as string[] : []), String(run.id)])];
  issue.updatedAt = timestamp;

  const inboxArtifact = decisionAgentInboxArtifact(brief, issue, run, agent, actor);
  issue.lastArtifact = inboxArtifact.relativePath;
  run.agentInboxArtifactPath = inboxArtifact.relativePath;
  run.dispatchedAt = run.dispatchedAt || timestamp;

  if (createdIssue) {
    activity.push({
      id: makeId("activity", "decision-materialized-issue"),
      type: "decision_materialized_issue",
      actor,
      targetType: "issue",
      targetId: String(issue.id),
      summary: `Approved decision became issue: ${title}`,
      severity: "ok",
      createdAt: timestamp,
    });
  }
  if (createdRun) {
    activity.push({
      id: makeId("activity", "decision-run-queued"),
      type: "run_queued",
      actor,
      targetType: "run",
      targetId: String(run.id),
      summary: String(run.summary),
      severity: "watch",
      createdAt: timestamp,
    });
  }
  if (inboxArtifact.created) {
    activity.push({
      id: makeId("activity", "run-dispatched-agent-inbox"),
      type: "run_dispatched_agent_inbox",
      actor,
      targetType: "run",
      targetId: String(run.id),
      summary: `Dispatched ${String(run.id)} to ${agent.name} inbox`,
      severity: "watch",
      artifactPath: inboxArtifact.relativePath,
      createdAt: timestamp,
    });
  }
  state.activity = activity.slice(-500);
  writeJsonFile(path, state);

  return maskSecrets({
    issueId: issue.id,
    runId: run.id,
    agentId: agent.id,
    agentName: agent.name,
    createdIssue,
    createdRun,
    materializedAt: timestamp,
  });
}

export function appendControlTowerActivity(input: {
  type: string;
  actor?: string;
  targetType: string;
  targetId: string;
  summary: string;
  severity?: "info" | "watch" | "blocked" | "ok";
  artifactPath?: string;
}) {
  const path = controlTowerStateFile();
  const state = readJsonFile<Record<string, unknown>>(path, {
    schemaVersion: "paperclip-parity-v1",
    approvalRequests: [],
    activity: [],
  });
  const activity = Array.isArray(state.activity) ? state.activity as Array<Record<string, unknown>> : [];
  const event = {
    id: makeId("activity", input.type),
    actor: input.actor || "Control Tower",
    severity: input.severity || "info",
    createdAt: nowIso(),
    ...input,
  };
  state.activity = [...activity, event].slice(-500);
  writeJsonFile(path, state);
  appendNdjson(controlTowerActivityFile(), event);
  return maskSecrets(event);
}

function countNdjson(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf-8").split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}
