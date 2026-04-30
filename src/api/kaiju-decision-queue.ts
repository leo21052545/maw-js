import { Elysia } from "elysia";
import {
  appendControlTowerActivity,
  buildDecisionBrief,
  createControlTowerApprovalDraft,
  materializeApprovedDecisionBrief,
  readDecisionQueueState,
  writeDecisionQueueState,
  type DecisionBriefInput,
  type KaijuRisk,
} from "../lib/kaiju-state-store";

export const kaijuDecisionQueueApi = new Elysia();

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function briefsFrom(state: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(state.briefs) ? state.briefs as Array<Record<string, unknown>> : [];
}

function riskToKaiju(risk: unknown): KaijuRisk {
  if (risk === "critical") return "L4";
  if (risk === "high") return "L3";
  if (risk === "low") return "L1";
  return "L2";
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

kaijuDecisionQueueApi.get("/kaiju/decision-queue", () => readDecisionQueueState());

kaijuDecisionQueueApi.post("/kaiju/decision-queue/briefs", async ({ body }) => {
  const state = readDecisionQueueState();
  const input = bodyRecord(body) as DecisionBriefInput;
  const brief = buildDecisionBrief(input);
  const briefs = briefsFrom(state);
  writeDecisionQueueState({ ...state, briefs: [...briefs, brief] });
  appendControlTowerActivity({
    type: "decision_brief_created",
    actor: String(input.createdBy || input.decisionOwner || "Control Tower"),
    targetType: "decision_brief",
    targetId: String(brief.id),
    summary: String(brief.title),
    severity: brief.status === "draft_context_needed" ? "watch" : "info",
  });
  return brief;
});

kaijuDecisionQueueApi.patch("/kaiju/decision-queue/briefs/:id", async ({ params, body, set }) => {
  const state = readDecisionQueueState();
  const input = bodyRecord(body);
  const briefs = briefsFrom(state);
  const index = briefs.findIndex((brief) => brief.id === params.id);
  if (index < 0) {
    set.status = 404;
    return { error: "decision brief not found" };
  }

  const previous = briefs[index];
  const patch = input as DecisionBriefInput;
  const updated = buildDecisionBrief(patch, previous);
  const decisionComment = textValue(input.decisionComment) || textValue(input.decisionNote) || textValue(input.comment);
  const actor = String(input.decidedBy || input.updatedBy || "Control Tower");
  const timestamp = new Date().toISOString();
  if (input.decidedBy && ["approved", "rejected", "deferred", "request_changes"].includes(String(updated.status))) {
    updated.decidedBy = String(input.decidedBy);
    updated.decidedAt = timestamp;
  }

  if (decisionComment) {
    const comments = Array.isArray(previous.comments) ? previous.comments as Array<Record<string, unknown>> : [];
    updated.comments = [
      ...comments,
      {
        id: `decision-comment-${timestamp.replace(/[-:.TZ]/g, "")}`,
        author: actor,
        body: decisionComment,
        status: String(updated.status),
        createdAt: timestamp,
      },
    ];
    updated.lastDecisionComment = decisionComment;
  }

  if (updated.status === "approved" && input.createApprovalDraft === true) {
    const approval = createControlTowerApprovalDraft({
      title: String(updated.title),
      summary: String(updated.plainLanguageQuestion || updated.contextShort || updated.title),
      risk: riskToKaiju(updated.riskLevel),
      actionType: String(input.actionType || "issue_gate"),
      targetType: String(input.targetType || "company"),
      targetId: String(input.targetId || updated.id),
      requestedBy: String(input.decidedBy || updated.decisionOwner || "Control Tower"),
      payload: {
        decisionBriefId: updated.id,
        recommendedOption: updated.recommendedOption,
        nextActionAfterDecision: updated.nextActionAfterDecision,
      },
    });
    updated.approvalId = approval.id;
  }

  if (updated.status === "approved") {
    const materialized = materializeApprovedDecisionBrief(
      updated,
      String(input.decidedBy || input.updatedBy || updated.decisionOwner || "Control Tower"),
    );
    if (materialized.issueId) updated.issueId = materialized.issueId;
    if (materialized.runId) updated.runId = materialized.runId;
    if (materialized.agentId) updated.assignedAgentId = materialized.agentId;
    if (materialized.agentName) updated.assignedAgentName = materialized.agentName;
    if (materialized.materializedAt) updated.materializedAt = materialized.materializedAt;
  }

  briefs[index] = updated;
  writeDecisionQueueState({ ...state, briefs });
  appendControlTowerActivity({
    type: ["approved", "rejected", "deferred", "request_changes"].includes(String(updated.status))
      ? "decision_brief_resolved"
      : "decision_brief_updated",
    actor,
    targetType: "decision_brief",
    targetId: String(updated.id),
    summary: decisionComment
      ? `${updated.title} -> ${updated.status}: ${decisionComment.slice(0, 160)}`
      : `${updated.title} -> ${updated.status}`,
    severity: updated.status === "approved" ? "ok" : updated.status === "rejected" ? "blocked" : "watch",
  });
  return updated;
});
