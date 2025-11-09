/**
 * Deadline processor
 *
 * Triggered exactly at a deadline to decide whether to no-op, notify, or escalate.
 *
 * Responsibilities
 * - Validate the incoming job payload (shape, timestamps, enums).
 * - Fetch the current deal snapshot from the API port.
 * - If the deadline has been satisfied already, no-op.
 * - If overdue and unmet, enqueue an escalation with a conservative suggestion
 *   and notify a human reviewer when automation is not allowed.
 *
 * Determinism and safety
 * - Pure decision logic based on the snapshot at processing time.
 * - Idempotent enqueue using a stable jobId derived from payload.
 * - All side effects (API calls, notifications) go through ports.
 *
 * Inputs
 * - Job data must match DeadlineJobSchema:
 *    { dealId: string, deadlineAt: unixSeconds, kind: "delivery" | "dispute", nonce: number }
 *
 * Outputs
 * - Returns a small result object for logs: { action: "noop" | "escalate", reason?, suggested? }
 * - Side effects: may enqueue an escalation job and emit a notification.
 */

import type { Job } from "bullmq";
import { Queue } from "bullmq";
import {
  assertDeadlineJob,
  jobIdForDeadline,
  EscalationJob,
  EscalationJobSchema,
  EscalationReason,
  EscalationSuggestion,
  jobIdForEscalation
} from "../types/jobs";

// Queue name constants. Keep in sync with worker.ts.
const Q_ESCALATION = "escalation";

// Minimal queue options for enqueue; worker controls attempts/backoff on the consumer side.
const enqueueOpts = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400, count: 1000 }
};

// Lazy ports to avoid import cycles and to keep this module testable by injecting fakes if needed.
async function getPorts() {
  const [{ getApiPort }, { getNotifyPort }, { getChainPolicy }] = await Promise.all([
    import("../ports/ApiPort"),
    import("../ports/NotifyPort"),
    import("../ports/ChainPort")
  ]);
  return {
    api: getApiPort(),
    notify: getNotifyPort(),
    policy: getChainPolicy()
  };
}

/**
 * Domain snapshot shape used by this processor.
 * Adapted from ApiPort.getDeal response; we only require the fields we read.
 */
type DealState = "INIT" | "FUNDED" | "DELIVERED" | "DISPUTED" | "RESOLVED" | "RELEASED" | "REFUNDED";
type DealSnapshot = {
  id: string;
  state: DealState;
  deliveryBy?: number;   // unix seconds
  disputeUntil?: number; // unix seconds
  // Additional fields may exist; ignored for this decision
};

/**
 * Decide an escalation suggestion given the deadline kind and snapshot.
 * Returns { action: "noop" } if nothing needs to happen.
 */
function decide(
  kind: "delivery" | "dispute",
  snap: DealSnapshot,
  nowSec: number
):
  | { action: "noop" }
  | { action: "escalate"; reason: EscalationReason; suggested: EscalationSuggestion } {
  switch (kind) {
    case "delivery": {
      // If already delivered or beyond delivery logic, noop
      if (snap.state === "DELIVERED" || snap.state === "RELEASED" || snap.state === "REFUNDED" || snap.state === "RESOLVED") {
        return { action: "noop" };
      }
      // If delivery deadline passed and still not delivered, suggest REVIEW (human) by default
      const overdue = typeof snap.deliveryBy === "number" && nowSec >= snap.deliveryBy;
      if (overdue) {
        // Conservative: don't push funds automatically; ask human reviewer.
        return { action: "escalate", reason: "no-delivery", suggested: "REVIEW" };
      }
      return { action: "noop" };
    }
    case "dispute": {
      // If already resolved or released/refunded, noop
      if (snap.state === "RESOLVED" || snap.state === "RELEASED" || snap.state === "REFUNDED") {
        return { action: "noop" };
      }
      const windowEnded = typeof snap.disputeUntil === "number" && nowSec >= snap.disputeUntil;
      if (!windowEnded) return { action: "noop" };

      // If nobody disputed by the end of the window and we are funded/delivered, lean RELEASE.
      if (snap.state === "FUNDED" || snap.state === "DELIVERED") {
        return { action: "escalate", reason: "deadline-expired", suggested: "RELEASE" };
      }

      // Otherwise default to REVIEW for safety.
      return { action: "escalate", reason: "deadline-expired", suggested: "REVIEW" };
    }
  }
}

/**
 * Processor entry expected by worker.ts
 */
export async function handleDeadline(job: Job<Record<string, unknown>>) {
  // Validate payload strictly
  const payload = assertDeadlineJob(job.data);

  // Defensive: assert job id derivation matches our convention when present
  const expectedId = jobIdForDeadline(payload);
  if (typeof job.id === "string" && job.id !== expectedId) {
    // Not fatal; log via return value
  }

  const { api, notify, policy } = await getPorts();

  // Load current snapshot from API
  const snap: DealSnapshot = await api.getDealSnapshot(payload.dealId);

  const nowSec = Math.floor(Date.now() / 1000);
  const decision = decide(payload.kind, snap, nowSec);

  if (decision.action === "noop") {
    return { action: "noop", dealId: payload.dealId, kind: payload.kind };
  }

  // Check policy: if automation for the suggested action is not allowed, downgrade to REVIEW.
  let suggested: EscalationSuggestion = decision.suggested;
  if (suggested !== "REVIEW" && !policy.allowsAutoFinalize(suggested)) {
    suggested = "REVIEW";
  }

  // Enqueue escalation idempotently with a stable jobId.
  const esc: EscalationJob = {
    dealId: payload.dealId,
    reason: decision.reason,
    suggested
  };
  const jobId = jobIdForEscalation(esc);

  const escalationQueue = new Queue<Readonly<EscalationJob>>(Q_ESCALATION, {
    connection: { url: process.env.REDIS_URL! }
  });
  try {
    await escalationQueue.add(Q_ESCALATION, esc, { jobId, ...enqueueOpts });
  } finally {
    // Ensure we close the producer queue handle to avoid leaking connections in tests
    await escalationQueue.close();
  }

  // Notify a human reviewer if we landed on REVIEW
  if (suggested === "REVIEW") {
    await notify.notifyReviewer({
      dealId: payload.dealId,
      reason: decision.reason,
      when: nowSec,
      context: { kind: payload.kind }
    });
  }

  return {
    action: "escalate",
    dealId: payload.dealId,
    reason: decision.reason,
    suggested
  };
}

/**
 * Notes for implementers of ports used above:
 *
 * ApiPort:
 *   interface ApiPort {
 *     getDealSnapshot(dealId: string): Promise<{
 *       id: string; state: "INIT"|"FUNDED"|"DELIVERED"|"DISPUTED"|"RESOLVED"|"RELEASED"|"REFUNDED";
 *       deliveryBy?: number; disputeUntil?: number;
 *     }>;
 *   }
 *
 * NotifyPort:
 *   interface NotifyPort {
 *     notifyReviewer(input: { dealId: string; reason: string; when: number; context?: Record<string, unknown> }): Promise<void>;
 *   }
 *
 * ChainPolicy (from ChainPort):
 *   interface ChainPolicy {
 *     allowsAutoFinalize(s: "RELEASE"|"REFUND"): boolean;
 *   }
 *   export function getChainPolicy(): ChainPolicy { ... }
 */
