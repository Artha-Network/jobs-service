/**
 * Job and event type definitions for the Jobs Service.
 *
 * Why this file exists
 * - Provide a single source of truth for queue payloads and webhook event shapes.
 * - Enforce invariants with Zod so processors can trust their inputs.
 * - Offer helpers to compute stable, deduplicated job IDs per payload.
 *
 * Design principles
 * - Pure and deterministic: no IO, no global state.
 * - Explicit versioning through narrow enums, not free-form strings.
 * - Unix timestamps in seconds. All numeric fields are integers.
 */

import { z } from "zod";
import { createHash } from "crypto";

/* -----------------------------------------------------------
 * Common primitives
 * --------------------------------------------------------- */

export const UnixSeconds = z
  .number()
  .int()
  .positive("must be a positive unix timestamp in seconds");

export const NonNegativeInt = z
  .number()
  .int()
  .nonnegative("must be a non negative integer");

/* -----------------------------------------------------------
 * Deadline jobs
 * --------------------------------------------------------- */

export const DeadlineKind = z.enum(["delivery", "dispute"]);
export type DeadlineKind = z.infer<typeof DeadlineKind>;

export const DeadlineJobSchema = z.object({
  dealId: z.string().min(1, "dealId is required"),
  deadlineAt: UnixSeconds,
  kind: DeadlineKind,
  nonce: NonNegativeInt
});

export type DeadlineJob = z.infer<typeof DeadlineJobSchema>;

/**
 * Build a stable deduplication key for a deadline job.
 * Key format: deadline:<dealId>:<deadlineAt>:<kind>:<nonce>
 */
export function jobIdForDeadline(j: DeadlineJob): string {
  return `deadline:${j.dealId}:${j.deadlineAt}:${j.kind}:${j.nonce}`;
}

/* -----------------------------------------------------------
 * Reminder jobs
 * --------------------------------------------------------- */

export const ReminderAudience = z.enum(["buyer", "seller", "both"]);
export type ReminderAudience = z.infer<typeof ReminderAudience>;

export const ReminderReason = z.enum(["deadline-upcoming", "dispute-window-closing"]);
export type ReminderReason = z.infer<typeof ReminderReason>;

export const ReminderJobSchema = z.object({
  dealId: z.string().min(1, "dealId is required"),
  notifyAt: UnixSeconds,
  for: ReminderAudience,
  reason: ReminderReason
});

export type ReminderJob = z.infer<typeof ReminderJobSchema>;

/**
 * Build a stable deduplication key for a reminder job.
 * Key format: reminder:<dealId>:<notifyAt>:<for>:<reason>
 */
export function jobIdForReminder(j: ReminderJob): string {
  return `reminder:${j.dealId}:${j.notifyAt}:${j.for}:${j.reason}`;
}

/* -----------------------------------------------------------
 * Escalation jobs
 * --------------------------------------------------------- */

export const EscalationReason = z.enum(["deadline-expired", "no-ack", "no-delivery"]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const EscalationSuggestion = z.enum(["RELEASE", "REFUND", "REVIEW"]);
export type EscalationSuggestion = z.infer<typeof EscalationSuggestion>;

export const EscalationJobSchema = z.object({
  dealId: z.string().min(1, "dealId is required"),
  reason: EscalationReason,
  suggested: EscalationSuggestion
});

export type EscalationJob = z.infer<typeof EscalationJobSchema>;

/**
 * Build a stable deduplication key for an escalation job.
 * Key format: escalation:<dealId>:<reason>:<suggested>
 */
export function jobIdForEscalation(j: EscalationJob): string {
  return `escalation:${j.dealId}:${j.reason}:${j.suggested}`;
}

/* -----------------------------------------------------------
 * Webhook events
 * --------------------------------------------------------- */

/**
 * Minimal normalized webhook event shape consumed by processors.
 * Upstream payloads are verified and normalized in infra/helius.webhook.ts.
 */
export const WebhookEffect = z.discriminatedUnion("type", [
  z.object({ type: z.literal("deal-funded"), dealId: z.string().min(1) }),
  z.object({ type: z.literal("deal-delivered"), dealId: z.string().min(1) }),
  z.object({ type: z.literal("deal-disputed"), dealId: z.string().min(1) }),
  z.object({ type: z.literal("deal-released"), dealId: z.string().min(1) }),
  z.object({ type: z.literal("deal-refunded"), dealId: z.string().min(1) })
]);
export type WebhookEffect = z.infer<typeof WebhookEffect>;

export const WebhookEventSchema = z.object({
  id: z.string().min(8, "idempotency id is required"),
  sig: z.string().min(8, "transaction signature is required"),
  slot: NonNegativeInt,
  when: UnixSeconds,
  effect: WebhookEffect
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/**
 * Build a deterministic idempotency key for a webhook event
 * from upstream identifiers. The output is a lowercase hex digest.
 *
 * Inputs:
 * - webhookId a provider level identifier if present
 * - txSignature transaction signature string
 * - index optional event index within a transaction
 */
export function computeWebhookId(params: {
  webhookId?: string;
  txSignature: string;
  index?: number;
}): string {
  const w = params.webhookId ?? "";
  const i = params.index ?? 0;
  const h = createHash("sha256");
  h.update(w);
  h.update("|");
  h.update(params.txSignature);
  h.update("|");
  h.update(String(i));
  return h.digest("hex");
}

/* -----------------------------------------------------------
 * Runtime validators
 * --------------------------------------------------------- */

export function assertDeadlineJob(input: unknown): DeadlineJob {
  return DeadlineJobSchema.parse(input);
}

export function assertReminderJob(input: unknown): ReminderJob {
  return ReminderJobSchema.parse(input);
}

export function assertEscalationJob(input: unknown): EscalationJob {
  return EscalationJobSchema.parse(input);
}

export function assertWebhookEvent(input: unknown): WebhookEvent {
  return WebhookEventSchema.parse(input);
}
