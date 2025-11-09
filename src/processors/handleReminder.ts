/**
 * Reminder processor
 *
 * Fires ahead of a deadline to notify parties about upcoming actions
 * (delivery due, dispute window closing, etc.).
 *
 * Responsibilities
 * - Validate the job payload shape and enums.
 * - Optionally load a minimal deal snapshot to avoid redundant notifications.
 * - Send templated notifications to the requested audience via NotifyPort.
 * - Remain idempotent on (dealId, notifyAt, reason).
 *
 * Inputs
 * - Job data must match ReminderJobSchema:
 *   {
 *     dealId: string,
 *     notifyAt: unixSeconds,
 *     for: "buyer" | "seller" | "both",
 *     reason: "deadline-upcoming" | "dispute-window-closing"
 *   }
 *
 * Outputs
 * - Returns { action: "notified" | "noop", audience, reason } for logs.
 */

import type { Job } from "bullmq";
import {
  assertReminderJob,
  jobIdForReminder,
  ReminderJob,
  ReminderReason
} from "../types/jobs";

// Lazy ports to keep this module pure and testable with fakes.
async function getPorts() {
  const [{ getApiPort }, { getNotifyPort }] = await Promise.all([
    import("../ports/ApiPort"),
    import("../ports/NotifyPort")
  ]);
  return {
    api: getApiPort(),
    notify: getNotifyPort()
  };
}

/**
 * Minimal snapshot shape inspected to decide whether a reminder is still relevant.
 * Processors avoid heavy fetching or large payloads; only fields read here are required.
 */
type DealState = "INIT" | "FUNDED" | "DELIVERED" | "DISPUTED" | "RESOLVED" | "RELEASED" | "REFUNDED";
type DealSnapshot = {
  id: string;
  state: DealState;
  deliveryBy?: number;   // unix seconds
  disputeUntil?: number; // unix seconds
};

function isReminderStillUseful(
  reason: ReminderReason,
  snap: DealSnapshot,
  nowSec: number,
  notifyAt: number
): boolean {
  // If deal is finalized, reminders are stale.
  if (snap.state === "RESOLVED" || snap.state === "RELEASED" || snap.state === "REFUNDED") {
    return false;
  }
  // If we're far past the intended notify time (e.g., due to outages), still send
  // as a courtesy unless the underlying deadline has also passed.
  if (reason === "deadline-upcoming") {
    if (typeof snap.deliveryBy === "number") {
      // If delivery deadline already passed, skip this reminder.
      if (nowSec >= snap.deliveryBy) return false;
    }
  }
  if (reason === "dispute-window-closing") {
    if (typeof snap.disputeUntil === "number") {
      // If dispute window already ended, skip this reminder.
      if (nowSec >= snap.disputeUntil) return false;
    }
  }
  // Otherwise, send once (BullMQ dedupe ensures exactly-once).
  return true;
}

/**
 * Processor entry expected by worker.ts
 */
export async function handleReminder(job: Job<Record<string, unknown>>) {
  const payload = assertReminderJob(job.data);
  const expectedId = jobIdForReminder(payload);
  if (typeof job.id === "string" && job.id !== expectedId) {
    // Not fatal. Return value will include both ids for log correlation.
  }

  const { api, notify } = await getPorts();

  // Lightweight snapshot check to prevent noisy reminders.
  const snap: DealSnapshot = await api.getDealSnapshot(payload.dealId);

  const nowSec = Math.floor(Date.now() / 1000);
  if (!isReminderStillUseful(payload.reason, snap, nowSec, payload.notifyAt)) {
    return {
      action: "noop",
      dealId: payload.dealId,
      audience: payload.for,
      reason: payload.reason
    };
  }

  // Dispatch the reminder. NotifyPort decides channels (email, SMS, Dialect, etc.)
  await notify.sendReminder({
    dealId: payload.dealId,
    when: nowSec,
    audience: payload.for,
    reason: payload.reason,
    context: {
      deliveryBy: snap.deliveryBy,
      disputeUntil: snap.disputeUntil
    }
  });

  return {
    action: "notified",
    dealId: payload.dealId,
    audience: payload.for,
    reason: payload.reason,
    id: job.id ?? expectedId
  };
}

/**
 * Expected NotifyPort surface used here:
 *
 *   type ReminderAudience = "buyer" | "seller" | "both";
 *   type ReminderReason = "deadline-upcoming" | "dispute-window-closing";
 *
 *   interface NotifyPort {
 *     sendReminder(input: {
 *       dealId: string;
 *       when: number; // unix seconds
 *       audience: ReminderAudience;
 *       reason: ReminderReason;
 *       context?: Record<string, unknown>;
 *     }): Promise<void>;
 *   }
 *
 *   export function getNotifyPort(): NotifyPort { ... }
 *
 * ApiPort only needs to expose:
 *
 *   interface ApiPort {
 *     getDealSnapshot(dealId: string): Promise<{
 *       id: string;
 *       state: "INIT"|"FUNDED"|"DELIVERED"|"DISPUTED"|"RESOLVED"|"RELEASED"|"REFUNDED";
 *       deliveryBy?: number;
 *       disputeUntil?: number;
 *     }>;
 *   }
 *
 *   export function getApiPort(): ApiPort { ... }
 */
