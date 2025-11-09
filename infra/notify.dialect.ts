/**
 * Dialect notifier (optional driver)
 *
 * Purpose
 * - Concrete NotifyPort that sends messages via a Dialect-style HTTP API.
 * - Processors call NotifyPort methods; this module hides provider details.
 *
 * Safety and assumptions
 * - Uses Node 18+ global `fetch` (no extra deps).
 * - Throws on non-2xx responses so callers can rely on BullMQ retries.
 * - Redacts secrets in logs. Never prints NOTIFY_DIALECT_KEY.
 *
 * Configuration (env)
 * - NOTIFY_DRIVER=dialect
 * - NOTIFY_DIALECT_KEY=<api key/token>
 * - NOTIFY_DIALECT_BASEURL=https://api.dialect.example.com/ (must end with /)
 *
 * API contract (expected; adapt to your provider)
 *   POST {BASE}/notify/reviewer
 *   POST {BASE}/notify/parties
 *   POST {BASE}/notify/reminder
 * Payloads mirror NotifyPort inputs and include an Idempotency-Key header.
 *
 * Idempotency
 * - We compute a stable SHA-256 digest over the payload and set it as
 *   `Idempotency-Key`. Provider should de-duplicate on this key.
 */

import { createHash } from "crypto";
import type {
  NotifyPort,
  NotifyReviewerInput,
  NotifyPartiesInput,
  SendReminderInput
} from "../ports/NotifyPort";

/* -----------------------------------------------------------
 * Public factory
 * --------------------------------------------------------- */

export function createDialectNotifier(): NotifyPort {
  const base = mustGetBaseUrl();
  const key = mustGetKey();

  return {
    async notifyReviewer(input) {
      await post(`${base}notify/reviewer`, key, input);
    },

    async notifyParties(input) {
      await post(`${base}notify/parties`, key, input);
    },

    async sendReminder(input) {
      await post(`${base}notify/reminder`, key, input);
    }
  };
}

/* -----------------------------------------------------------
 * HTTP helper
 * --------------------------------------------------------- */

async function post(url: string, key: string, body: unknown): Promise<void> {
  const idemp = idempotencyKey(body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
      "Idempotency-Key": idemp
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await safeText(res);
    throw new Error(
      `dialect notifier HTTP ${res.status} ${res.statusText} at ${url} :: ${truncate(txt, 500)}`
    );
  }
}

/* -----------------------------------------------------------
 * Utilities
 * --------------------------------------------------------- */

function mustGetBaseUrl(): string {
  const raw = process.env.NOTIFY_DIALECT_BASEURL;
  if (!raw || !/^https?:\/\/.+\/$/.test(raw)) {
    throw new Error(
      "NOTIFY_DIALECT_BASEURL is required and must end with a trailing slash, e.g., https://api.dialect.example.com/"
    );
  }
  return raw;
}

function mustGetKey(): string {
  const key = process.env.NOTIFY_DIALECT_KEY;
  if (!key || key.trim() === "") {
    throw new Error("NOTIFY_DIALECT_KEY is required for dialect notifier");
  }
  return key;
}

/**
 * Build a stable idempotency key for a JSON-like value.
 * We stringify with sorted keys to avoid spurious changes.
 */
function idempotencyKey(v: unknown): string {
  const json = stableStringify(v);
  const h = createHash("sha256");
  h.update(json);
  return h.digest("hex");
}

/** Deterministic JSON stringify (keys sorted). */
function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(sortKeys);
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {});
  }
  return v;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/* -----------------------------------------------------------
 * Notes for adapters
 * --------------------------------------------------------- *
 * If your provider expects different endpoints or fields:
 * - Adjust the POST URLs above.
 * - Transform the input payloads (NotifyReviewerInput, NotifyPartiesInput,
 *   SendReminderInput) to provider-specific schemas before sending.
 * - Keep idempotency keys stable for the same logical notification.
 */
