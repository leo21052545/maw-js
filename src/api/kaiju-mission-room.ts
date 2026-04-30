import { Elysia } from "elysia";
import {
  appendControlTowerActivity,
  createControlTowerApprovalDraft,
  makeId,
  nowIso,
  readMissionRoomState,
  writeMissionRoomState,
  type KaijuRisk,
} from "../lib/kaiju-state-store";

export const kaijuMissionRoomApi = new Elysia();

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function roomsFrom(state: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(state.rooms) ? state.rooms as Array<Record<string, unknown>> : [];
}

function riskOf(value: unknown): KaijuRisk {
  return value === "L1" || value === "L2" || value === "L3" || value === "L4" ? value : "L2";
}

kaijuMissionRoomApi.get("/kaiju/mission-rooms", () => readMissionRoomState());

kaijuMissionRoomApi.post("/kaiju/mission-rooms", async ({ body }) => {
  const state = readMissionRoomState();
  const rooms = roomsFrom(state);
  const input = bodyRecord(body);
  const title = String(input.title || "New Project Room");
  const room = {
    id: String(input.id || makeId("room", title)),
    projectId: String(input.projectId || makeId("project", title)),
    title,
    mission: String(input.mission || ""),
    status: "active",
    owners: Array.isArray(input.owners) ? input.owners : ["Leo", "Amy", "HELM"],
    participants: Array.isArray(input.participants) ? input.participants : ["David", "HELM"],
    contextCapsule: {
      id: makeId("capsule", title),
      mission: String(input.mission || ""),
      currentState: [],
      constraints: ["Approval-gated by default", "No direct Oracle core mutation"],
      openQuestions: [],
      sourceLinks: [],
      retrievalLimit: 8,
      updatedAt: nowIso(),
    },
    messages: [],
    decisions: [],
    linkedIssueIds: [],
    linkedRunIds: [],
    linkedApprovalIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeMissionRoomState({ ...state, rooms: [...rooms, room] });
  appendControlTowerActivity({
    type: "mission_room_created",
    actor: String(input.createdBy || "Control Tower"),
    targetType: "mission_room",
    targetId: room.id,
    summary: `Created project operating room: ${title}`,
    severity: "ok",
  });
  return room;
});

kaijuMissionRoomApi.post("/kaiju/mission-rooms/:id/messages", async ({ params, body, set }) => {
  const state = readMissionRoomState();
  const rooms = roomsFrom(state);
  const room = rooms.find((item) => item.id === params.id);
  if (!room) {
    set.status = 404;
    return { error: "mission room not found" };
  }
  const input = bodyRecord(body);
  const messages = Array.isArray(room.messages) ? room.messages as Array<Record<string, unknown>> : [];
  const message = {
    id: makeId("msg", String(input.author || "message")),
    author: String(input.author || "Leo"),
    role: String(input.role || "owner"),
    summary: String(input.summary || input.message || ""),
    sourceModel: input.sourceModel ? String(input.sourceModel) : undefined,
    createdAt: nowIso(),
  };
  room.messages = [...messages, message].slice(-80);
  room.updatedAt = nowIso();
  writeMissionRoomState({ ...state, rooms });
  appendControlTowerActivity({
    type: "mission_message_summarized",
    actor: message.author,
    targetType: "mission_room",
    targetId: String(room.id),
    summary: String(message.summary).slice(0, 140),
  });
  return message;
});

kaijuMissionRoomApi.post("/kaiju/mission-rooms/:id/decisions", async ({ params, body, set }) => {
  const state = readMissionRoomState();
  const rooms = roomsFrom(state);
  const room = rooms.find((item) => item.id === params.id);
  if (!room) {
    set.status = 404;
    return { error: "mission room not found" };
  }
  const input = bodyRecord(body);
  const risk = riskOf(input.risk);
  const decisions = Array.isArray(room.decisions) ? room.decisions as Array<Record<string, unknown>> : [];
  const decision = {
    id: makeId("decision", String(input.title || "decision")),
    owner: String(input.owner || "Leo"),
    risk,
    title: String(input.title || "Project decision"),
    status: risk === "L1" || risk === "L2" ? "accepted" : "pending_approval",
    rationale: String(input.rationale || input.summary || ""),
    approvalId: null as string | null,
    createdAt: nowIso(),
  };
  if (risk === "L3" || risk === "L4") {
    const approval = createControlTowerApprovalDraft({
      title: decision.title,
      summary: decision.rationale || "Approval requested for project decision.",
      risk,
      actionType: "project_decision",
      targetType: "company",
      targetId: String(room.id),
      requestedBy: decision.owner,
      payload: { roomId: room.id, decisionId: decision.id },
    });
    decision.approvalId = String(approval.id);
    const linked = Array.isArray(room.linkedApprovalIds) ? room.linkedApprovalIds as string[] : [];
    room.linkedApprovalIds = [...new Set([...linked, approval.id])];
  }
  room.decisions = [...decisions, decision];
  room.updatedAt = nowIso();
  writeMissionRoomState({ ...state, rooms });
  appendControlTowerActivity({
    type: "mission_decision_recorded",
    actor: decision.owner,
    targetType: "mission_room",
    targetId: String(room.id),
    summary: decision.title,
    severity: decision.approvalId ? "watch" : "ok",
  });
  return decision;
});

kaijuMissionRoomApi.patch("/kaiju/mission-rooms/:id/context", async ({ params, body, set }) => {
  const state = readMissionRoomState();
  const rooms = roomsFrom(state);
  const room = rooms.find((item) => item.id === params.id);
  if (!room) {
    set.status = 404;
    return { error: "mission room not found" };
  }
  const input = bodyRecord(body);
  const current = room.contextCapsule && typeof room.contextCapsule === "object" ? room.contextCapsule as Record<string, unknown> : {};
  room.contextCapsule = {
    ...current,
    ...input,
    retrievalLimit: Number(input.retrievalLimit || current.retrievalLimit || 8),
    updatedAt: nowIso(),
  };
  room.updatedAt = nowIso();
  writeMissionRoomState({ ...state, rooms });
  appendControlTowerActivity({
    type: "context_capsule_updated",
    actor: String(input.updatedBy || "Control Tower"),
    targetType: "mission_room",
    targetId: String(room.id),
    summary: "Updated project context capsule",
  });
  return room.contextCapsule;
});
