/**
 * Deadlines queue
 *
 * Purpose
 * - Provide a single place to enqueue and manage deadline jobs.
 * - Enforce stable job IDs for deduplication.
 * - Convert absolute unix timestamps to BullMQ delays safely.
 *
 * Job shape (validated upstream):
 *   {
 *     dealId: string;
 *     deadlineAt: number;     // unix seconds
 *     kind: "delivery"|"dispute";
 *     nonce: number;          // per-deal monotonic
 *   }
 *
 * Dedup key:
 *   deadline:<dealId>:<deadlineAt>:<kind>:<nonce>
 *
 * Notes
 * - BullMQ delays are milliseconds-from-now; we compute delay from `deadlineAt`.
 * - If `deadlineAt` is in the past, the job is enqueued with zero delay and runs ASAP.
 * - Use small remove-on-* windows so Redis doesn’t balloon.
 */

import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import {
  DeadlineJob,
  DeadlineJobSchema,
  jobIdForDeadline
} from "../types/jobs";

export const Q_DEADLINES = "deadlines";

const connection: ConnectionOptions = {
  url: process.env.REDIS_URL as string
};

const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 60 * 60, count: 1000 },   // keep for 1h
  removeOnFail: { age: 24 * 60 * 60, count: 1000 },  // keep for 24h
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 }
};

let _queue: Queue<DeadlineJob> | null = null;

/**
 * Lazily construct a singleton queue instance.
 * This keeps tests simple and avoids multiple Redis connections in dev.
 */
export function getDeadlinesQueue(): Queue<DeadlineJob> {
  if (!_queue) {
    if (!connection.url) {
      throw new Error("REDIS_URL is required to initialize deadlines queue");
    }
    _queue = new Queue<DeadlineJob>(Q_DEADLINES, {
      connection,
      defaultJobOptions
    });
  }
  return _queue;
}

/**
 * Schedule a deadline job at an absolute unix timestamp.
 *
 * - Validates the payload (throws if invalid).
 * - Computes a safe delay (ms).
 * - Enqueues with a stable jobId so it’s naturally idempotent.
 */
export async function scheduleDeadline(input: DeadlineJob): Promise<void> {
  const payload = DeadlineJobSchema.parse(input);

  const runMs = payload.deadlineAt * 1000;
  const delay = Math.max(0, runMs - Date.now());

  const jobId = jobIdForDeadline(payload);

  await getDeadlinesQueue().add(Q_DEADLINES, payload, {
    jobId,
    delay
  });
}

/**
 * Close the underlying queue (useful for tests and graceful shutdown in CLIs).
 */
export async function closeDeadlinesQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
