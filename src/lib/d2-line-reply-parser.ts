/**
 * D2 LINE bot — reply intent classifier (R1-R5 per David spec).
 *
 * Spec: ψ/writing/templates/2026-05-03_d2-line-message-templates-v0.md §"Reply parser"
 *
 * Match priority (first-match-wins):
 *   1. identity check (R5)  — must beat approve/etc. so "are you AI? yes" doesn't approve
 *   2. approve (R1)
 *   3. defer (R2)
 *   4. reject (R3)
 *   5. unknown (R4)
 *
 * Per spec: "Lowercase + Thai-normalize input". Thai has no case but mixed-language
 * replies do — we lowercase the whole string to compare against ascii patterns.
 */

import type { ReplyIntent } from "./d2-line-templates";

/** Identity checks must be detected BEFORE intent matching (Rule 6 compliance). */
const IDENTITY_PATTERNS: RegExp[] = [
  /คุณ\s*(คือ|เป็น)\s*ใคร/u,
  /นายเป็น\s*ai/iu,
  /เป็น\s*ai\s*(ใช่|ใช่ไหม|มั้ย)/iu,
  /\bwho\s+are\s+you\b/iu,
  /\bare\s+you\s+(an?\s+)?ai\b/iu,
  /\bare\s+you\s+(human|a\s+robot|a\s+bot)\b/iu,
];

// JS regex `\b` only treats ASCII chars as word chars — it doesn't work as a
// boundary after Thai script. Use a negative lookahead for "next char is not a
// Thai letter" instead, which matches end-of-string + whitespace + punctuation
// + ASCII alike.
const TBOUND = "(?![\\u0E00-\\u0E7F])"; // not-a-Thai-letter lookahead

const APPROVE_PATTERNS: RegExp[] = [
  new RegExp(`^อนุมัติ${TBOUND}`, "u"),
  /^approve\b/iu,
  /^✅/u,
  /^ok(ay)?[!.]?$/iu,
  /^yes[!.]?$/iu,
  new RegExp(`^เอา${TBOUND}`, "u"),
];

const DEFER_PATTERNS: RegExp[] = [
  new RegExp(`^เลื่อน${TBOUND}`, "u"),
  /^defer\b/iu,
  /^later\b/iu,
  new RegExp(`^ทีหลัง${TBOUND}`, "u"),
  /^ไม่ได้พึ่งตอนนี้/u,
];

const REJECT_PATTERNS: RegExp[] = [
  new RegExp(`^ปฏิเสธ${TBOUND}`, "u"),
  /^reject\b/iu,
  /^no[!.]?$/iu,
  new RegExp(`^ไม่เอา${TBOUND}`, "u"),
  new RegExp(`^ยกเลิก${TBOUND}`, "u"),
];

/**
 * Classify a free-text reply into one of the 5 intent buckets.
 * @param text raw user input from LINE webhook
 */
export function classifyReply(text: string): ReplyIntent {
  if (typeof text !== "string") return "unknown";
  const trimmed = text.trim();
  if (!trimmed) return "unknown";

  // Identity first (Rule 6) — beats everything else.
  for (const re of IDENTITY_PATTERNS) {
    if (re.test(trimmed)) return "identity";
  }

  const lc = trimmed.toLowerCase();
  for (const re of APPROVE_PATTERNS) if (re.test(lc)) return "approve";
  for (const re of DEFER_PATTERNS)   if (re.test(lc)) return "defer";
  for (const re of REJECT_PATTERNS)  if (re.test(lc)) return "reject";
  return "unknown";
}

/**
 * Approve replies may carry an explicit project number when multiple are pending,
 * e.g. "อนุมัติ 2" / "approve 1". Returns the 1-indexed selection or null if absent.
 */
export function extractApproveIndex(text: string): number | null {
  const m = text.trim().match(/^(?:อนุมัติ|approve|ok(?:ay)?)\s+(\d+)\b/iu);
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
