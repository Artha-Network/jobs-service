// src/services/reminderPlanner.ts

import type {
  EscrowReminderConfig,
  ReminderChannel,
  ReminderJob,
} from "../types/reminders";

const DEFAULT_PRE_DEADLINE_HOURS = 24; // T-24h
const DEFAULT_OVERDUE_AFTER_HOURS = 24; // T+24h
const DEFAULT_ESCALATE_AFTER_HOURS = 72; // +72h after overdue

function hoursToMs(h: number): number {
  return h * 60 * 60 * 1000;
}

function dedupeChannels(
  channels: ReminderChannel[] | undefined,
): ReminderChannel[] {
  if (!channels || channels.length === 0) {
    return ["email"]; // sensible default
  }
  return Array.from(new Set(channels));
}

/**
 * Plan all reminder + escalation jobs for a single escrow deal.
 * This does NOT enqueue anything – it just returns a deterministic list.
 */
export function planReminderJobs(
  config: EscrowReminderConfig,
): ReminderJob[] {
  const channels = dedupeChannels(config.channels);

  const preDeadlineAtMs =
    config.deadlineAtMs -
    hoursToMs(config.preDeadlineHours ?? DEFAULT_PRE_DEADLINE_HOURS);

  const overdueAtMs =
    config.deadlineAtMs +
    hoursToMs(config.overdueAfterHours ?? DEFAULT_OVERDUE_AFTER_HOURS);

  const escalationAtMs =
    overdueAtMs +
    hoursToMs(config.escalateAfterHours ?? DEFAULT_ESCALATE_AFTER_HOURS);

  const base = {
    dealId: config.dealId,
    channels,
  };

  const jobs: ReminderJob[] = [];

  // Pre-deadline reminder (buyer)
  jobs.push({
    ...base,
    kind: "pre_deadline",
    targetUserId: config.buyerId,
    runAtMs: preDeadlineAtMs,
  });

  // Deadline notifications (buyer + seller)
  jobs.push(
    {
      ...base,
      kind: "deadline",
      targetUserId: config.buyerId,
      runAtMs: config.deadlineAtMs,
    },
    {
      ...base,
      kind: "deadline",
      targetUserId: config.sellerId,
      runAtMs: config.deadlineAtMs,
    },
  );

  // Overdue notifications (buyer + seller)
  jobs.push(
    {
      ...base,
      kind: "overdue",
      targetUserId: config.buyerId,
      runAtMs: overdueAtMs,
    },
    {
      ...base,
      kind: "overdue",
      targetUserId: config.sellerId,
      runAtMs: overdueAtMs,
    },
  );

  // Escalation (to internal ops – for now we reuse sellerId as target)
  jobs.push({
    ...base,
    kind: "escalation",
    targetUserId: config.sellerId,
    runAtMs: escalationAtMs,
  });

  return jobs;
}

/**
 * Given "now", filter which of the planned jobs are due.
 * The worker can use this to decide what to push into the queue.
 */
export function getDueReminderJobs(
  jobs: readonly ReminderJob[],
  nowMs: number,
): ReminderJob[] {
  return jobs.filter((job) => job.runAtMs <= nowMs);
}
