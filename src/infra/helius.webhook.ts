/**
 * Helius webhook intake and normalization.
 *
 * Responsibilities
 * - Verify webhook authenticity using a shared secret (HMAC-SHA256 of raw body).
 * - Parse the raw JSON and extract only escrow-relevant events.
 * - Normalize to the internal WebhookEvent shape used by processors.
 *
 * Design
 * - Pure, framework-agnostic helpers. Works with any HTTP server.
 * - Requires the *raw* request body bytes (before JSON parsing) for signature verification.
 * - Defensive parsing: unknown shapes are ignored instead of throwing.
 *
 * Environment
 * - HELIUS_WEBHOOK_SECRET   (required for verification)
 *
 * Headers (defaults; override via options if your gateway rewrites them)
 * - X-Helius-Signature: hex HMAC-SHA256(rawBody, secret)
 * - X-Webhook-Id (optional): stable provider id used in idempotency key derivation
 *
 * Usage (example with an HTTP framework pseudocode)
 *   const rawBody = await readRaw(req);
 *   if (!verifyHeliusSignature(req.headers, rawBody)) return res.status(401).end();
 *   const events = normalizeHeliusWebhook(rawBody, req.headers);
 *   for (const e of events) enqueueFromWebhook(e);
 */

import { createHmac } from "crypto";
import { WebhookEvent, WebhookEventSchema, computeWebhookId } from "../types/jobs";

/* -----------------------------------------------------------
 * Options and header helpers
 * --------------------------------------------------------- */

export type VerifyOptions = {
  headerName?: string; // defaults to "x-helius-signature"
  secret?: string;     // defaults to process.env.HELIUS_WEBHOOK_SECRET
};

export type NormalizeOptions = {
  webhookIdHeader?: string;  // defaults to "x-webhook-id"
};

/** Get a header value case-insensitively. */
function getHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return typeof v === "string" ? v : String(v ?? "");
  }
  return undefined;
}

/* -----------------------------------------------------------
 * Signature verification
 * --------------------------------------------------------- */

/**
 * Verify Helius signature as HMAC-SHA256 over the raw body.
 * Returns false if secret or signature are missing.
 */
export function verifyHeliusSignature(
  headers: Record<string, unknown>,
  rawBody: Buffer | Uint8Array | string,
  opts?: VerifyOptions
): boolean {
  const headerName = opts?.headerName ?? "x-helius-signature";
  const secret = opts?.secret ?? process.env.HELIUS_WEBHOOK_SECRET;

  const provided = getHeader(headers, headerName);
  if (!secret || !provided) return false;

  const bodyBytes = typeof rawBody === "string" ? Buffer.from(rawBody) : Buffer.from(rawBody);
  const h = createHmac("sha256", Buffer.from(secret));
  h.update(bodyBytes);
  const expected = h.digest("hex");

  // Constant-time-ish comparison
  if (expected.length !== provided.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return ok === 0;
}

/* -----------------------------------------------------------
 * Normalization to internal event shape
 * --------------------------------------------------------- */

/**
 * Normalize a raw Helius webhook body into internal WebhookEvent[].
 * Unknown or irrelevant events are ignored.
 *
 * Accepts Buffer/Uint8Array/string for convenience. Throws on malformed JSON only.
 */
export function normalizeHeliusWebhook(
  rawBody: Buffer | Uint8Array | string,
  headers: Record<string, unknown> = {},
  opts?: NormalizeOptions
): WebhookEvent[] {
  const json = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8")) as unknown;

  // Try multiple known-ish shapes defensively:
  // 1) { type, signature, events: [...] }
  // 2) Array of entries with { type, signature, ... }
  // 3) Provider-specific "notifications" arrays
  const entries = extractEntries(json);

  const webhookId = getHeader(headers, opts?.webhookIdHeader ?? "x-webhook-id");

  const out: WebhookEvent[] = [];
  for (const e of entries) {
    const effect = mapEffect(e);
    if (!effect) continue;

    const id = computeWebhookId({
      webhookId: webhookId,
      txSignature: e.sig,
      index: e.index ?? 0
    });

    const candidate: WebhookEvent = {
      id,
      sig: e.sig,
      slot: e.slot ?? 0,
      when: e.when ?? Math.floor(Date.now() / 1000),
      effect
    };

    // Validate each event to keep processors safe
    const valid = WebhookEventSchema.safeParse(candidate);
    if (valid.success) out.push(valid.data);
  }
  return out;
}

/* -----------------------------------------------------------
 * Internal helpers: entry extraction and effect mapping
 * --------------------------------------------------------- */

type RawEntry = {
  type?: string;
  sig: string;
  slot?: number;
  when?: number;
  dealId?: string;
  index?: number;
  // plus provider fields we ignore
};

/**
 * Extract a flat list of raw entries describing transaction-level events.
 * This is tolerant to provider payload drift and keeps only fields we need.
 */
function extractEntries(json: unknown): RawEntry[] {
  const list: RawEntry[] = [];

  // Case A: payload is already an array of objects
  if (Array.isArray(json)) {
    for (let i = 0; i < json.length; i++) {
      const e = coerceEntry(json[i]);
      if (e) list.push({ ...e, index: e.index ?? i });
    }
    return list;
  }

  // Case B: object with events array
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.events)) {
      for (let i = 0; i < obj.events.length; i++) {
        const e = coerceEntry(obj.events[i]);
        if (e) list.push({ ...e, index: e.index ?? i });
      }
    } else {
      // Try to coerce the object itself
      const single = coerceEntry(obj);
      if (single) list.push({ ...single, index: single.index ?? 0 });
    }
  }

  return list;
}

/**
 * Coerce an unknown value to a minimal RawEntry if possible.
 */
function coerceEntry(v: unknown): RawEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;

  // Transaction signature may be under different keys; check a few common ones.
  const sig =
    typeof o.signature === "string"
      ? o.signature
      : typeof o.sig === "string"
      ? o.sig
      : typeof o.txSignature === "string"
      ? o.txSignature
      : undefined;

  if (!sig) return null;

  // Optional fields
  const type = typeof o.type === "string" ? o.type : undefined;
  const slot = typeof o.slot === "number" ? o.slot : undefined;
  const when =
    typeof o.timestamp === "number"
      ? o.timestamp
      : typeof o.blockTime === "number"
      ? o.blockTime
      : undefi
