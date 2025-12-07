// src/types/reminders.ts

export type ReminderKind =
  | "pre_deadline"
  | "deadline"
  | "overdue"
  | "escalation";

export type ReminderChannel = "email" | "sms" | "push" | "webhook";

export interface EscrowReminderConfig {
  /** Human-readable id for logging / debugging. */
  dealId: string;
  buyerId: string;
  sellerId: string;

  /** Canonical deadline for this deal (ms since epoch, UTC). */
  deadlineAtMs: number;

  /** Optional overrides (hours). */
  preDeadlineHours?: number;   // default: 24h before
  overdueAfterHours?: number;  // default: 24h after
  escalateAfterHours?: number; // default: 72h after overdue

  /** Preferred notification channels. Defaults to ["email"]. */
  channels?: ReminderChannel[];
}

/**
 * Normalised “unit of work” for the jobs worker.
 * This is what we can push onto queues.
 */
export interface ReminderJob {
  kind: ReminderKind;
  dealId: string;
  targetUserId: string;
  channels: ReminderChannel[];
  /** When this job should run (ms since epoch). */
  runAtMs: number;
}
