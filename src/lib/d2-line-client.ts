/**
 * D2 LINE bot — messaging transport (LINE / Telegram fallback) + signature verify.
 *
 * Spec refs:
 *   - HELM bundle §D2 — halt-cap: >1 cal-day OAuth → Telegram fallback (pre-auth)
 *   - Pre-auth FORGE decision: SDK choice. We use **stdlib + fetch** rather than
 *     `@line/bot-sdk` / `telegraf` for v0 — webhook signature verify is one HMAC,
 *     push is one POST. Smaller surface, no new deps, easier to mock in tests.
 *     Revisit if we need rich features (Flex, follow events, etc.).
 *
 * Public surface:
 *   - verifyLineSignature(body, signature, secret) → boolean
 *   - makePusher(transport, env) → Pusher
 *   - linePushHttp / telegramPushHttp — the underlying transports (also exported
 *     for direct use in tests)
 */

import { createHmac } from "crypto";

export type Transport = "line" | "telegram";

export type PushArgs = {
  /** LINE userId or Telegram chat_id. */
  recipient: string;
  /** Plain-text message body. (LINE supports rich messages but v0 is text-only.) */
  text: string;
};

export type PushResult = {
  ok: boolean;
  transport: Transport;
  status?: number;
  body?: string;
};

export type Pusher = (args: PushArgs) => Promise<PushResult>;

/**
 * Verify LINE webhook HMAC signature. LINE sends `X-Line-Signature` = base64-
 * encoded HMAC-SHA256 of the raw request body, keyed with the channel secret.
 * Per https://developers.line.biz/en/reference/messaging-api/#signature-validation
 */
export function verifyLineSignature(raw_body: string, signature: string | undefined, channel_secret: string): boolean {
  if (!signature || !channel_secret) return false;
  const expected = createHmac("sha256", channel_secret).update(raw_body).digest("base64");
  // Constant-time compare via length + char-XOR fold; Buffer.compare on equal lengths
  // is the cleanest approach — but signature lengths must match first.
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Push a text message via LINE Messaging API.
 * Endpoint: https://api.line.me/v2/bot/message/push
 * Auth: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}
 */
export async function linePushHttp(args: PushArgs, env: Record<string, string | undefined>): Promise<PushResult> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, transport: "line", body: "missing LINE_CHANNEL_ACCESS_TOKEN" };
  }
  const url = env.LINE_API_BASE_URL
    ? `${env.LINE_API_BASE_URL.replace(/\/$/, "")}/v2/bot/message/push`
    : "https://api.line.me/v2/bot/message/push";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: args.recipient,
      messages: [{ type: "text", text: args.text }],
    }),
  });
  const body = await res.text().catch(() => "");
  return { ok: res.ok, transport: "line", status: res.status, body };
}

/**
 * Reply via LINE Reply API. Different from push — uses replyToken from the webhook
 * event, which is single-use and must be consumed within ~1 minute. Free of charge
 * (push messages are billed; replies are not). Used for R1-R5 responses.
 */
export async function lineReplyHttp(
  args: { reply_token: string; text: string },
  env: Record<string, string | undefined>,
): Promise<PushResult> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, transport: "line", body: "missing LINE_CHANNEL_ACCESS_TOKEN" };
  }
  const url = env.LINE_API_BASE_URL
    ? `${env.LINE_API_BASE_URL.replace(/\/$/, "")}/v2/bot/message/reply`
    : "https://api.line.me/v2/bot/message/reply";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken: args.reply_token,
      messages: [{ type: "text", text: args.text }],
    }),
  });
  const body = await res.text().catch(() => "");
  return { ok: res.ok, transport: "line", status: res.status, body };
}

/**
 * Push a text message via Telegram Bot API (fallback transport).
 * Endpoint: https://api.telegram.org/bot${token}/sendMessage
 */
export async function telegramPushHttp(args: PushArgs, env: Record<string, string | undefined>): Promise<PushResult> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, transport: "telegram", body: "missing TELEGRAM_BOT_TOKEN" };
  }
  const base = env.TELEGRAM_API_BASE_URL
    ? env.TELEGRAM_API_BASE_URL.replace(/\/$/, "")
    : "https://api.telegram.org";
  const url = `${base}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: args.recipient, text: args.text }),
  });
  const body = await res.text().catch(() => "");
  return { ok: res.ok, transport: "telegram", status: res.status, body };
}

/**
 * Build a `Pusher` for the configured transport. The returned function captures
 * the env at construction time — change env + re-construct to swap transports.
 *
 * Per HELM halt-cap: setting `D2_LINE_TRANSPORT=telegram` + restart = the
 * pre-authorized Telegram fallback path.
 */
export function makePusher(transport: Transport, env: Record<string, string | undefined>): Pusher {
  if (transport === "telegram") {
    return (args: PushArgs) => telegramPushHttp(args, env);
  }
  return (args: PushArgs) => linePushHttp(args, env);
}

/** Resolve the active transport from env (default: line). */
export function activeTransport(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Transport {
  const v = (env.D2_LINE_TRANSPORT ?? "line").toLowerCase();
  return v === "telegram" ? "telegram" : "line";
}
