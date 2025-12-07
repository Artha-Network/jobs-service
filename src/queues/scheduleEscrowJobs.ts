// src/queues/scheduleEscrowJobs.ts
//
// Utilities to schedule/cancel all jobs for a single escrow.
// Used by your Helius handler (on escrow create/update) to
// set deadlines, reminders, and escalation windows in one place.

import { Queue, JobsOptions } from "bullmq";

export type EscrowSchedule = {
  /** Escrow account public key (string form). */
  escrowPubkey: string;

  /**
   * UNIX timestamp of final delivery deadline in milliseconds.
   * Example: Date.now() + 3 * 24 * 60 * 60 * 1000
   */
  deliveryAtMs: number;

  /**
   * Reminder offsets (in minutes) *before* deliveryAtMs.
   * Example: [1440, 60] = 24h before, 1h before.
   */
  reminderMinutesBefore: number[];

  /**
   * Dispute window *after* delivery deadline, in seconds.
   * After this window expires we enqueue an escalation job.
   */
  disputeWindowSeconds: number;
};

export type EscrowQueues = {
  deadlineQueue: Queue;
  reminderQueue: Queue;
  escalationQueue: Queue;
};

/**
 * Schedules deadline, reminders and escalation jobs for an escrow.
 * Jobs are idempotent by using deterministic jobIds per escrow.
 */
export async function scheduleEscrowJobs(
  queues: EscrowQueues,
  schedule: EscrowSchedule,
  baseJobOptions: JobsOptions = {}
): Promise<void> {
  const { deadlineQueue, reminderQueue, escalationQueue } = queues;
  const { escrowPubkey, deliveryAtMs, reminderMinutesBefore, disputeWindowSeconds } =
    schedule;

  const now = Date.now();
  if (deliveryAtMs <= now) {
    // No point scheduling in the past; caller can decide how to handle.
    console.warn(
      JSON.stringify({
        event: "scheduleEscrowJobs.skipped",
        reason: "delivery_in_past",
        escrowPubkey,
        deliveryAtMs,
        now,
      })
    );
    return;
  }

  const baseId = `escrow:${escrowPubkey}`;
  const deadlineDelay = deliveryAtMs - now;

  // 1) Final deadline job
  await deadlineQueue.add(
    "deadline",
    { escrowPubkey, deliveryAtMs },
    {
      ...baseJobOptions,
      jobId: `${baseId}:deadline`,
      delay: deadlineDelay,
    }
  );

  // 2) Reminder jobs
  for (const minutesBefore of reminderMinutesBefore) {
    const offsetMs = minutesBefore * 60 * 1000;
    const reminderDelay = deliveryAtMs - now - offsetMs;

    // skip reminders that would fire in the past
    if (reminderDelay <= 0) continue;

    await reminderQueue.add(
      "reminder",
      {
        escrowPubkey,
        deliveryAtMs,
        minutesBefore,
      },
      {
        ...baseJobOptions,
        jobId: `${baseId}:reminder:${minutesBefore}m`,
        delay: reminderDelay,
      }
    );
  }

  // 3) Escalation job (deadline + dispute window)
  const escalationDelay = deadlineDelay + disputeWindowSeconds * 1000;

  await escalationQueue.add(
    "escalation",
    {
      escrowPubkey,
      deliveryAtMs,
      disputeWindowSeconds,
    },
    {
      ...baseJobOptions,
      jobId: `${baseId}:escalation`,
      delay: escalationDelay,
    }
  );

  console.log(
    JSON.stringify({
      event: "scheduleEscrowJobs.scheduled",
      escrowPubkey,
      deliveryAtMs,
      reminderMinutesBefore,
      disputeWindowSeconds,
    })
  );
}

/**
 * Cancels all scheduled jobs for a given escrow (deadline + reminders + escalation).
 * Useful when an escrow is resolved early / cancelled on-chain.
 */
export async function cancelEscrowJobs(
  queues: EscrowQueues,
  escrowPubkey: string
): Promise<void> {
  const { deadlineQueue, reminderQueue, escalationQueue } = queues;
  const baseId = `escrow:${escrowPubkey}`;

  const ids = [
    `${baseId}:deadline`,
