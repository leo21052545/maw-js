import { Elysia } from "elysia";
import {
  appendControlTowerActivity,
  createControlTowerApprovalDraft,
  makeId,
  nowIso,
  readCommerceOfficeState,
  staffCommerceView,
  writeCommerceOfficeState,
} from "../lib/kaiju-state-store";

export const kaijuCommerceOfficeApi = new Elysia();

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function listFrom(state: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  return Array.isArray(state[key]) ? state[key] as Array<Record<string, unknown>> : [];
}

kaijuCommerceOfficeApi.get("/kaiju/commerce-office", () => readCommerceOfficeState());

kaijuCommerceOfficeApi.get("/kaiju/commerce-office/staff-view", () => staffCommerceView());

kaijuCommerceOfficeApi.post("/kaiju/commerce-office/work-queue", async ({ body }) => {
  const state = readCommerceOfficeState();
  const tasks = listFrom(state, "operatorTasks");
  const input = bodyRecord(body);
  const title = String(input.title || "Operator task");
  const task = {
    id: String(input.id || makeId("operator-task", title)),
    queueId: String(input.queueId || "queue-daily-ops"),
    type: String(input.type || "packing"),
    title,
    assignee: String(input.assignee || "staff-operator-01"),
    status: String(input.status || "todo"),
    priority: String(input.priority || "medium"),
    instructions: String(input.instructions || ""),
    createdBy: String(input.createdBy || "Amy"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeCommerceOfficeState({ ...state, operatorTasks: [...tasks, task] });
  appendControlTowerActivity({
    type: "commerce_operator_task_created",
    actor: task.createdBy,
    targetType: "commerce_task",
    targetId: task.id,
    summary: task.title,
    severity: "ok",
  });
  return task;
});

kaijuCommerceOfficeApi.patch("/kaiju/commerce-office/operator-tasks/:id", async ({ params, body, set }) => {
  const state = readCommerceOfficeState();
  const tasks = listFrom(state, "operatorTasks");
  const task = tasks.find((item) => item.id === params.id);
  if (!task) {
    set.status = 404;
    return { error: "operator task not found" };
  }
  const patch = bodyRecord(body);
  task.status = String(patch.status || task.status || "todo");
  if (patch.note) task.note = String(patch.note);
  task.updatedAt = nowIso();
  writeCommerceOfficeState({ ...state, operatorTasks: tasks });
  appendControlTowerActivity({
    type: "commerce_operator_task_updated",
    actor: String(patch.updatedBy || "staff-operator-01"),
    targetType: "commerce_task",
    targetId: String(task.id),
    summary: `${task.title}: ${task.status}`,
  });
  return task;
});

kaijuCommerceOfficeApi.post("/kaiju/commerce-office/stock-drafts", async ({ body }) => {
  const state = readCommerceOfficeState();
  const drafts = listFrom(state, "stockMovementDrafts");
  const input = bodyRecord(body);
  const sku = String(input.sku || "UNKNOWN-SKU");
  const draft = {
    id: String(input.id || makeId("stock-draft", sku)),
    type: String(input.type || "cycle_count"),
    sku,
    warehouse: String(input.warehouse || "main"),
    quantity: Number(input.quantity || 0),
    reason: String(input.reason || ""),
    status: "pending_approval",
    approvalRequired: true,
    createdBy: String(input.createdBy || "Commerce Office"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const approval = createControlTowerApprovalDraft({
    title: `Approve stock movement: ${sku}`,
    summary: `${draft.type} ${draft.quantity} at ${draft.warehouse}. Reason: ${draft.reason}`,
    risk: "L3",
    actionType: "stock_movement",
    targetType: "company",
    targetId: draft.id,
    requestedBy: draft.createdBy,
    payload: draft,
  });
  writeCommerceOfficeState({ ...state, stockMovementDrafts: [...drafts, { ...draft, approvalId: approval.id }] });
  return { draft: { ...draft, approvalId: approval.id }, approval };
});

kaijuCommerceOfficeApi.post("/kaiju/commerce-office/production-batches", async ({ body }) => {
  const state = readCommerceOfficeState();
  const drafts = listFrom(state, "productionBatchDrafts");
  const input = bodyRecord(body);
  const outputSku = String(input.outputSku || "UNKNOWN-FG");
  const draft = {
    id: String(input.id || makeId("batch-draft", outputSku)),
    formulaId: String(input.formulaId || "formula-unknown"),
    outputSku,
    plannedQty: Number(input.plannedQty || 0),
    consumedSkus: Array.isArray(input.consumedSkus) ? input.consumedSkus : [],
    qcNotes: String(input.qcNotes || ""),
    status: "pending_approval",
    approvalRequired: true,
    createdBy: String(input.createdBy || "Commerce Office"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const approval = createControlTowerApprovalDraft({
    title: `Approve production batch: ${outputSku}`,
    summary: `Planned output ${draft.plannedQty} for ${outputSku}; formula ${draft.formulaId}.`,
    risk: "L3",
    actionType: "production_batch",
    targetType: "company",
    targetId: draft.id,
    requestedBy: draft.createdBy,
    payload: draft,
  });
  writeCommerceOfficeState({ ...state, productionBatchDrafts: [...drafts, { ...draft, approvalId: approval.id }] });
  return { draft: { ...draft, approvalId: approval.id }, approval };
});
