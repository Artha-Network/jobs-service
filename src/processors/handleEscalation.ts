/**
 * Escalation processor
 *
 * Runs when a deadline expires or when upstream logic requests a follow-up.
 * Decides whether to:
 *  - prepare a safe finalize action (RELEASE or REFUND) for human approval, or
 *  - route directly to a human reviewer (REVIEW).
 *
 * Inputs
 * - Job data must match EscalationJobSchema:
 *   {
 *     dealId: string;
 *     reason: "deadline-expired" | "no-ack" | "no-delivery";
 *     suggested: "RELEASE" | "REFUND" | "REVIEW";
 *   }
 *
 * Outputs
 * - Returns a structured result for logs:
 *   { action: "prepared" | "review", dealId, reason, suggested, approvalUrl?, blinkUrl? }
 *
 * Determinism and safety
 * - Pure decision logic; all side effects go through ports.
 * - No direct on-chain finalization here. We only *prepare* ready-to-sign
 *   transactions or notify reviewers. Keys live outside this service.
 */

import type { Job } from "bullmq";
import {
  assertEscalationJob,
  EscalationSuggestion
} from "../types/jobs";

// Lazy import ports to keep this module easily testable.
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
 * Prepare step is best-effort and must not throw fatally for user-visible paths.
 * If preparation fails, we downgrade to REVIEW and notify a human.
 */
async function tryPrepareFinalize(
  api: ReturnType<typeof (await import("../ports/ApiPort")).getApiPort>,
  dealId: string,
  action: Extract<EscalationSuggestion, "RELEASE" | "REFUND">
): Promise<{ approvalUrl?: string; blinkUrl?: string } | null> {
  try {
    // Minimal contract: ApiPort returns an approval URL and/or a Blink URL
    // that a reviewer can click to open a ready-to-sign transaction.
    const prepared = await api.prepareFinalize({ dealId, action });
    // Defensive normalization of optional fields
    return {
      approvalUrl: typeof prepared?.approvalUrl === "string" ? prepared.approvalUrl : undefined,
      blinkUrl: typeof prepared?.blinkUrl === "string" ? prepared.blinkUrl : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Processor entry expected by worker.ts
 */
export async function handleEscalation(job: Job<Record<string, unknown>>) {
  const payload = assertEscalationJob(job.data);
  const { api, notify, policy } = await getPorts();
  const nowSec = Math.floor(Date.now() / 1000);

  // Default route: human review
  let route: "review" | "prepared" = "review";
  let approvalUrl: string | undefined;
  let blinkUrl: string | undefined;

  if (payload.suggested === "RELEASE" || payload.suggested === "REFUND") {
    const allowed = policy.allowsAutoFinalize(payload.suggested);
    if (allowed) {
      const prepared = await tryPrepareFinalize(api, payload.dealId, payload.suggested);
      if (prepared) {
        route = "prepared";
        approvalUrl = prepared.approvalUrl;
        blinkUrl = prepared.blinkUrl;
      }
    }
  }

  if (route === "prepared") {
    // Notify reviewer with approval context and share optional Blink for convenience.
    await notify.notifyReviewer({
      dealId: payload.dealId,
      reason: payload.reason,
      when: nowSec,
      context: {
        suggested: payload.suggested,
        approvalUrl,
        blinkUrl
      }
    });

    // Optionally inform parties that a decision is pending review (non-binding).
    await notify.notifyParties({
      dealId: payload.dealId,
      event: "finalize-prepared",
      when: nowSec,
      context: {
        suggested: payload.suggested
      }
    });

    return {
      action: "prepared" as const,
      dealId: payload.dealId,
      reason: payload.reason,
      suggested: payload.suggested,
      approvalUrl,
      blinkUrl
    };
  }

  // Route to human review (either suggested was REVIEW, policy forbids auto-finalize, or prepare failed)
  await notify.notifyReviewer({
    dealId: payload.dealId,
    reason: payload.reason,
    when: nowSec,
    context: { suggested: "REVIEW" }
  });

  return {
    action: "review" as const,
    dealId: payload.dealId,
    reason: payload.reason,
    suggested: "REVIEW" as const
  };
}

/**
 * Port contracts referenced here:
 *
 *  // Chain policy (read-only capability checks)
 *  export interface ChainPolicy {
 *    allowsAutoFinalize(action: "RELEASE" | "REFUND"): boolean;
 *  }
 *  export function getChainPolicy(): ChainPolicy;
 *
 *  // API port (server/Actions integration)
 *  export interface ApiPort {
 *    prepareFinalize(input: { dealId: string; action: "RELEASE" | "REFUND" }):
 *      Promise<{ approvalUrl?: string; blinkUrl?: string }>;
 *  }
 *  export function getApiPort(): ApiPort;
 *
 *  // Notifications
 *  export interface NotifyPort {
 *    notifyReviewer(input: {
 *      dealId: string;
 *      reason: string;
 *      when: number;
 *      context?: Record<string, unknown>;
 *    }): Promise<void>;
 *
 *    notifyParties(input: {
 *      dealId: string;
 *      event: "finalize-prepared" | "deadline-reminder" | "escalated";
 *      when: number;
 *      context?: Record<string, unknown>;
 *    }): Promise<void>;
 *  }
 *  export function getNotifyPort(): NotifyPort;
 */
