/**
 * Reminders queue
 *
 * Purpose
 * - Central place to enqueue reminder jobs ahead of deadlines.
 * - Enforce stable job IDs for natural deduplication.
 * - Convert absolute unix timestamps (notifyAt) to BullMQ delays safely.
 *
 * Job shape (validated upstream):
 *   {
 *     dealId: string;
 *     notifyAt: number; // unix seconds
 *     for: "buyer" | "seller" | "both";
 *     reason: "deadline-upcoming" | "dispute-window-closing";
 *   }
 *
 * Dedup key:
 *   reminder:<dealId>:<notifyAt>:<for>:<reason>
 *
 * Notes
 * - BullMQ uses delays in milliseconds-from-now. We compute delay from notifyAt.
 * - If notifyAt is in the past, the job is enqueued with zero delay and runs ASAP.
 * - Keep remove-on-* windows small so Redis doesn’t balloon.
 */

import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import {
  ReminderJob,
  ReminderJobSchema,
  jobIdForReminder
} from "../types/jobs";

export const Q_REMINDERS = "reminders";

const connection: ConnectionOptions = {
  url: process.env.REDIS_URL as string
};

const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 60 * 60, count: 1000 },   // keep for 1h or last 1000
  removeOnFail: { age: 24 * 60 * 60, count: 1000 },  // keep for 24h
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 }
};

let _queue: Queue<ReminderJob> | null = null;

/**
 * Lazily construct a singleton queue instance.
 * This keeps tests simple and avoids multiple Redis connections in dev.
 */
export function getRemindersQueue(): Queue<ReminderJob> {
  if (!_queue) {
    if (!connection.url) {
      throw new Error("REDIS_URL is required to initialize reminders queue");
    }
    _queue = new Queue<ReminderJob>(Q_REMINDERS, {
      connection,
      defaultJobOptions
    });
  }
  return _queue;
}

/**
 * Schedule a reminder at an absolute unix timestamp (notifyAt).
 *
 * Steps:
 * - Validate payload (throws if invalid).
 * - Compute a safe delay in milliseconds.
 * - Enqueue with a stable jobId so duplicates collapse naturally.
 */
export async function scheduleReminder(input: ReminderJob): Promise<void> {
  const payload = ReminderJobSchema.parse(input);

  const runMs = payload.notifyAt * 1000;
  const delay = Math.max(0, runMs - Date.now());

  const jobId = jobIdForReminder(payload);

  await getRemindersQueue().add(Q_REMINDERS, payload, {
    jobId,
    delay
  });
}

/**
 * Close the underlying queue (useful for tests and graceful shutdown in CLIs).
 */
export async function closeRemindersQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
