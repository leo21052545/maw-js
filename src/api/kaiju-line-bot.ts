/**
 * D2 LINE bot — Elysia router (webhook + health).
 *
 * Routes (mounted under /api/* via src/api/index.ts):
 *   POST /line/webhook  — LINE event receiver (HMAC-verified, classifies replies,
 *                         calls D1 /approve for R1, replies via LINE Reply API for R2-R5)
 *   GET  /line/health   — config sanity check (env presence; no creds leak)
 *
 * Per HELM bundle §D2 + David template spec §"Reply parser".
 *
 * Auth model:
 *   - Webhook is publicly callable (LINE servers post here). Auth = LINE's
 *     `x-line-signature` HMAC header. Without it, return 401 silently.
 *   - allowed_user_ids (env LEO_LINE_USER_ID, comma-separated) gates which userIds
 *     get a real reply. Unknown senders get R5 (identity) — Rule 6.
 *   - federationAuth bypasses /api/line/* (not in PROTECTED set in elysia-auth.ts).
 */

import { Elysia } from "elysia";
import { lineReplyHttp, verifyLineSignature } from "../lib/d2-line-client";
import { classifyReply, extractApproveIndex } from "../lib/d2-line-reply-parser";
import { LineSession } from "../lib/d2-line-session";
import { loadLineTemplates, renderTemplate, type LineTemplates } from "../lib/d2-line-templates";

type LineWebhookEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string; type?: string };
  message?: { type?: string; text?: string };
  timestamp?: number;
};

type LineWebhookBody = {
  destination?: string;
  events?: LineWebhookEvent[];
};

const session = new LineSession();
let cached_templates: LineTemplates | null = null;

function templates(): LineTemplates {
  if (!cached_templates) cached_templates = loadLineTemplates();
  return cached_templates;
}

/** Allow tests / hot-reload to reset module-level state. */
export function _resetLineBotState(): void {
  cached_templates = null;
  session.reset();
}

/** Test-only — record a push for a user. Production path is the trigger watcher. */
export function _recordPushForTest(user_id: string, project_id: string): void {
  session.recordPush(user_id, project_id);
}

function allowedUserIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.LEO_LINE_USER_ID ?? env.D2_LINE_ALLOWED_USER_IDS ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(ids);
}

function approverForUser(user_id: string, env: NodeJS.ProcessEnv = process.env): string {
  // Env-driven Leo userId → approver "Leo" (Phase 1 only Leo is wired).
  // Future: map per-userId to per-approver.
  const leo = env.LEO_LINE_USER_ID ?? "";
  if (leo && user_id === leo) return "Leo";
  return env.D2_LINE_DEFAULT_APPROVER ?? "Leo";
}

async function callD1Approve(args: {
  project_id: string;
  approver: string;
  note?: string;
  base_url?: string;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = args.base_url
    ?? process.env.D2_KAIJU_BASE_URL
    ?? process.env.KAIJU_BASE_URL
    ?? "http://localhost:3456";
  const url = `${base.replace(/\/$/, "")}/api/kaiju/control-tower/approve`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: args.project_id,
      approver: args.approver,
      client: "line-bot",
      note: args.note,
    }),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  return { ok: res.ok, status: res.status, body };
}

function replyTextForIntent(
  intent: ReturnType<typeof classifyReply>,
  ctx: { project_id?: string | null; project_name?: string | null; timestamp?: string; sentinel_path?: string; audit_log_path?: string },
): string {
  const tpl = templates();
  switch (intent) {
    case "approve":
      return renderTemplate(tpl.reply.approve.body, {
        project_name: ctx.project_name ?? ctx.project_id ?? "(unknown)",
        timestamp: ctx.timestamp ?? new Date().toISOString(),
        date: (ctx.timestamp ?? new Date().toISOString()).slice(0, 10),
        "project-id": ctx.project_id ?? "(unknown)",
        project_id: ctx.project_id ?? "(unknown)",
      });
    case "defer":     return tpl.reply.defer.body;
    case "reject":    return tpl.reply.reject.body;
    case "identity":  return tpl.reply.identity.body;
    case "unknown":
    default:          return tpl.reply.unknown.body;
  }
}

export type HandleEventResult = {
  intent: ReturnType<typeof classifyReply>;
  reply_text: string;
  approve_status?: number;
  approve_ok?: boolean;
  resolved_project_id?: string | null;
};

/**
 * Handle one LINE message event end-to-end (classify → side-effect → reply text).
 * Pure-ish: side-effect is the optional D1 /approve call. Sending the LINE reply
 * back over the wire is the route handler's job (so this fn is unit-testable).
 */
export async function handleLineEvent(event: LineWebhookEvent, opts: {
  env?: NodeJS.ProcessEnv;
  approve?: typeof callD1Approve;
} = {}): Promise<HandleEventResult> {
  const env = opts.env ?? process.env;
  const approve = opts.approve ?? callD1Approve;

  const text = event.message?.text ?? "";
  const user_id = event.source?.userId ?? "";

  // Identity check beats authorization — Rule 6 says always answer "are you AI"
  // truthfully even from unknown senders.
  const intent = classifyReply(text);

  if (intent === "identity") {
    return { intent, reply_text: replyTextForIntent("identity", {}) };
  }

  // For non-identity intents, gate by allowlist. Unknown senders get R4 (unknown
  // command) — they shouldn't see Phase-2-stub responses or trigger approves.
  const allowlist = allowedUserIds(env);
  if (allowlist.size > 0 && !allowlist.has(user_id)) {
    return { intent: "unknown", reply_text: replyTextForIntent("unknown", {}) };
  }

  if (intent !== "approve") {
    return { intent, reply_text: replyTextForIntent(intent, {}) };
  }

  // Approve path — resolve project, call D1, reply with confirmation.
  const explicit_idx = extractApproveIndex(text);
  let project_id: string | null = null;
  if (explicit_idx) {
    project_id = session.peekAt(user_id, explicit_idx);
  } else {
    project_id = session.resolveLatest(user_id);
  }

  if (!project_id) {
    // No recent push to apply — degrade gracefully via R4.
    return { intent: "approve", reply_text: replyTextForIntent("unknown", {}), resolved_project_id: null };
  }

  const approver = approverForUser(user_id, env);
  const approve_res = await approve({ project_id, approver });
  const reply_text = replyTextForIntent("approve", {
    project_id,
    project_name: project_id, // we don't carry project_name in session; id is fine
    timestamp: new Date().toISOString(),
  });
  return {
    intent: "approve",
    reply_text,
    approve_ok: approve_res.ok,
    approve_status: approve_res.status,
    resolved_project_id: project_id,
  };
}

export const kaijuLineBotApi = new Elysia()
  .get("/line/health", () => {
    const env = process.env;
    return {
      ok: true,
      transport: (env.D2_LINE_TRANSPORT ?? "line"),
      configured: {
        channel_secret: Boolean(env.LINE_CHANNEL_SECRET),
        access_token:   Boolean(env.LINE_CHANNEL_ACCESS_TOKEN),
        leo_user_id:    Boolean(env.LEO_LINE_USER_ID),
      },
      session_size: session.size(),
    };
  })
  .post("/line/webhook", async ({ request, set }) => {
    const raw_body = await request.text();
    const signature = request.headers.get("x-line-signature") ?? undefined;
    const channel_secret = process.env.LINE_CHANNEL_SECRET ?? "";

    if (!channel_secret) {
      set.status = 503;
      return { ok: false, error: "LINE_CHANNEL_SECRET not configured" };
    }
    if (!verifyLineSignature(raw_body, signature, channel_secret)) {
      set.status = 401;
      return { ok: false, error: "invalid signature" };
    }

    let parsed: LineWebhookBody;
    try {
      parsed = raw_body ? (JSON.parse(raw_body) as LineWebhookBody) : {};
    } catch {
      set.status = 400;
      return { ok: false, error: "malformed json" };
    }

    const events = Array.isArray(parsed.events) ? parsed.events : [];
    const handled: Array<{ event_type: string; intent?: string; replied: boolean }> = [];

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") {
        handled.push({ event_type: event.type, replied: false });
        continue;
      }

      const result = await handleLineEvent(event);
      let replied = false;
      if (event.replyToken) {
        const r = await lineReplyHttp({ reply_token: event.replyToken, text: result.reply_text }, process.env as Record<string, string | undefined>);
        replied = r.ok;
      }
      handled.push({ event_type: event.type, intent: result.intent, replied });
    }

    return { ok: true, handled };
  });
