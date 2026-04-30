import { Elysia } from "elysia";
import {
  appendOracleIntent,
  appendOracleLink,
  createControlTowerApprovalDraft,
  davidOracleRoot,
  readOracleArtifact,
  searchOracleText,
  stateFile,
  type KaijuRisk,
} from "../lib/kaiju-state-store";

export const kaijuOracleBridgeApi = new Elysia();

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function riskOf(value: unknown): KaijuRisk {
  return value === "L1" || value === "L2" || value === "L3" || value === "L4" ? value : "L3";
}

kaijuOracleBridgeApi.get("/kaiju/oracle-bridge/context", () => ({
  mode: "read_link_intent",
  root: davidOracleRoot(),
  allowlist: ["ψ/", "ops/docs/"],
  writable: [
    "ψ/state/oracle-bridge/oracle-intents.ndjson",
    "ψ/state/oracle-bridge/oracle-links.ndjson",
    "ψ/state/oracle-bridge/oracle-activity.ndjson",
  ],
  intentFile: stateFile("oracle-bridge", "oracle-intents.ndjson"),
}));

kaijuOracleBridgeApi.get("/kaiju/oracle-bridge/search", ({ query, set }) => {
  const q = typeof query.q === "string" ? query.q : "";
  const limit = Number(query.limit || 12);
  if (!q.trim()) {
    set.status = 400;
    return { error: "q is required" };
  }
  return {
    query: q,
    results: searchOracleText(q, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 30) : 12),
  };
});

kaijuOracleBridgeApi.get("/kaiju/oracle-bridge/artifact", ({ query, set }) => {
  const path = typeof query.path === "string" ? query.path : "";
  if (!path.trim()) {
    set.status = 400;
    return { error: "path is required" };
  }
  try {
    return readOracleArtifact(path);
  } catch (err) {
    set.status = 400;
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

kaijuOracleBridgeApi.post("/kaiju/oracle-bridge/intents", async ({ body }) => {
  const input = bodyRecord(body);
  const risk = riskOf(input.risk);
  const intent = appendOracleIntent({
    ...input,
    risk,
    kind: String(input.kind || "oracle_bridge_intent"),
    requestedBy: String(input.requestedBy || "Control Tower"),
  });
  const approval = risk === "L1" ? null : createControlTowerApprovalDraft({
    title: String(input.title || "Oracle Bridge intent"),
    summary: String(input.summary || "Approval requested for Oracle Bridge intent."),
    risk,
    actionType: "oracle_intent",
    targetType: "company",
    targetId: String(input.targetId || intent.id),
    requestedBy: String(input.requestedBy || "Control Tower"),
    payload: { intentId: intent.id, targetPath: input.targetPath || null },
  });
  return { intent: { ...intent, approvalId: approval ? approval.id : null }, approval };
});

kaijuOracleBridgeApi.post("/kaiju/oracle-bridge/links", async ({ body }) => {
  const input = bodyRecord(body);
  return {
    link: appendOracleLink({
      sourceType: String(input.sourceType || "project"),
      sourceId: String(input.sourceId || ""),
      targetPath: String(input.targetPath || ""),
      summary: String(input.summary || ""),
      createdBy: String(input.createdBy || "Control Tower"),
    }),
  };
});
