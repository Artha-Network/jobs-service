/**
 * Helius webhook HTTP handler (framework agnostic).
 *
 * Purpose
 * - Verify incoming Helius webhooks.
 * - Normalize to internal WebhookEvent objects.
 * - For each relevant effect, fetch the current deal snapshot and schedule
 *   deadlines and reminders accordingly. Queues are idempotent by jobId.
 *
 * Works with any server:
 * - You must provide the raw request body bytes for signature verification.
 * - Pass headers as a plain record of strings.
 *
 * Scheduling policy (default, safe):
 * - On deal-funded:
 *     if snapshot.deliveryBy exists, schedule a delivery deadline at deliveryBy
 *     and a reminder 24h before if there is enough time.
 * - On deal-delivered:
 *     if snapshot.disputeUntil exists, schedule a dispute deadline at disputeUntil
 *     and a reminder 2h before if there is enough time.
 * - Other effects are observed but do not schedule timers here.
 *
 * Environment
 * - HELIUS_WEBHOOK_SECRET required by infra/helius.webhook
 * - REDIS_URL for queues
 * - ACTIONS_BASEURL for ApiPort snapshot fetches
 *
 * Usage example (Express):
 *   app.post("/webhooks/helius", express.raw({ type: "*/*" }), async (req, res) => {
 *     const result = await handleHeliusWebhookRequest({
 *       headers: req.headers as Record<string, string>,
 *       rawBody: req.body
 *     });
 *     res.status(result.statusCode).json(result.body);
 *   });
 */

import { normalizeHeliusWebhook, verifyHeliusSignature } from "../infra/helius.webhook";
import { getApiPort } from "../ports/ApiPort";
import {
  scheduleDeadline
} from "../queues/deadlines.queue";
import {
  scheduleReminder
} from "../queues/reminders.queue";

/* -----------------------------------------------------------
 * Types
 * --------------------------------------------------------- */

export type WebhookRequest = {
  headers: Record<string, unknown>;
  rawBody: Buffer | Uint8Array | string;
};

export type WebhookResponse = {
  statusCode: number;
  body: { ok: boolean; accepted?: number; ignored?: number; reason?: string };
};

/* -----------------------------------------------------------
 * Tuning knobs for reminder offsets
 * --------------------------------------------------------- */

const REMINDER_BEFORE_DELIVERY_SEC = 24 * 60 * 60; // 24h
const REMINDER_BEFORE_DISPUTE_SEC = 2 * 60 * 60;   // 2h

/* -----------------------------------------------------------
 * Handler
 * --------------------------------------------------------- */

export async function handleHeliusWebhookRequest(req: WebhookRequest): Promise<WebhookResponse> {
  // 1) Verify signature
  const ok = verifyHeliusSignature(req.headers, req.rawBody);
  if (!ok) {
    return { statusCode: 401, body: { ok: false, reason: "signature verification failed" } };
  }

  // 2) Normalize events
  let events = [];
  try {
    events = normalizeHeliusWebhook(req.rawBody, req.headers);
  } catch (e) {
    return { statusCode: 400, body: { ok: false, reason: "malformed json" } };
  }

  if (!events.length) {
    return { statusCode: 200, body: { ok: true, accepted: 0, ignored: 0 } };
  }

  // 3) Act on events: schedule timers based on a fresh snapshot
  const api = getApiPort();
  const nowSec = Math.floor(Date.now() / 1000);

  let accepted = 0;
  let ignored = 0;

  for (const e of events) {
    try {
      switch (e.effect.type) {
        case "deal-funded": {
          const snap = await api.getDealSnapshot(e.effect.dealId);
          if (typeof snap.deliveryBy === "number" && snap.deliveryBy > nowSec) {
            // delivery deadline
            await scheduleDeadline({
              dealId: snap.id,
              deadlineAt: snap.deliveryBy,
              kind: "delivery",
              nonce: 0 // producer should bump if you reschedule; 0 is fine for first schedule
            });

            const remindAt = snap.deliveryBy - REMINDER_BEFORE_DELIVERY_SEC;
            if (remindAt > nowSec) {
              await scheduleReminder({
                dealId: snap.id,
                notifyAt: remindAt,
                for: "both",
                reason: "deadline-upcoming"
              });
            }
          }
          accepted++;
          break;
        }

        case "deal-delivered": {
          const snap = await api.getDealSnapshot(e.effect.dealId);
          if (typeof snap.disputeUntil === "number" && snap.disputeUntil > nowSec) {
            // dispute window deadline
            await scheduleDeadline({
              dealId: snap.id,
              deadlineAt: snap.disputeUntil,
              kind: "dispute",
              nonce: 0
            });

            const remindAt = snap.disputeUntil - REMINDER_BEFORE_DISPUTE_SEC;
            if (remindAt > nowSec) {
              await scheduleReminder({
                dealId: snap.id,
                notifyAt: remindAt,
                for: "both",
                reason: "dispute-window-closing"
              });
            }
          }
          accepted++;
          break;
        }

        case "deal-disputed":
        case "deal-released":
        case "deal-refunded":
          // No timers scheduled here by default. Processor logic will
          // handle escalations and notifications as needed.
          ignored++;
          break;
      }
    } catch {
      // Fail open for a single event but continue with others.
      // In production, prefer logging with correlation ids.
      ignored++;
    }
  }

  return { statusCode: 200, body: { ok: true, accepted, ignored } };
}

/
