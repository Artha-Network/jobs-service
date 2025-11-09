/**
 * Escalation queue
 *
 * Purpose
 * - Central place to enqueue escalation jobs triggered by deadline processors
 *   or webhook-derived conditions.
 * - Enforce stable job IDs for natural deduplication.
 * - No delay scheduling: escalations run ASAP.
 *
 * Job shape (validated upstream):
 *   {
 *     dealId: string;
 *     reason: "deadline-expired" | "no-ack" | "no-delivery";
 *     suggested: "RELEASE" | "REFUND" | "REVIEW";
 *   }
 *
 * Dedup key:
 *   escalation:<dealId>:<reason>:<suggested>
 *
 * Notes
 * - Escalations are processed immediately. If you need time-based behavior,
 *   schedule it in the deadlines or reminders queues and let *those* enqueue
 *   the escalation when conditions are met.
 */

import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import {
  EscalationJob,
  EscalationJobSchema,
  jobIdForEscalation
} from "../types/jobs";

export const Q_ESCALATION = "escalation";

const connection: ConnectionOptions = {
  url: process.env.REDIS_URL as string
};

const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 60 * 60, count: 1000 },   // keep for 1h
  removeOnFail: { age: 24 * 60 * 60, count: 1000 },  // keep for 24h
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 }
};

let _queue: Queue<EscalationJob> | null = null;

/**
 * Lazily construct a singleton queue instance.
 * Keeps tests simple and avoids multiple Redis connections in dev.
 */
export function getEscalationQueue(): Queue<EscalationJob> {
  if (!_queue) {
    if (!connection.url) {
      throw new Error("REDIS_URL is required to initialize escalation queue");
    }
    _queue = new Queue<EscalationJob>(Q_ESCALATION, {
      connection,
      defaultJobOptions
    });
  }
  return _queue;
}

/**
 * Enqueue an escalation to run immediately (no delay).
 *
 * Steps:
 * - Validate payload (throws if invalid).
 * - Compute stable jobId so duplicates collapse naturally.
 * - Enqueue to the escalation queue.
 */
export async function enqueueEscalation(input: EscalationJob): Promise<void> {
  const payload = EscalationJobSchema.parse(input);
  const jobId = jobIdForEscalation(payload);

  await getEscalationQueue().add(Q_ESCALATION, payload, {
    jobId
  });
}

/**
 * Close the underlying queue (useful for tests and graceful shutdown in CLIs).
 */
export async function closeEscalationQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
