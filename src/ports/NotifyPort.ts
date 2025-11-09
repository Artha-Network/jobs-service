/**
 * NotifyPort
 *
 * Purpose
 * - Single boundary for user-facing notifications (reviewers and parties).
 * - Processors call this port; concrete delivery (email, SMS, Dialect, etc.)
 *   is hidden behind this interface.
 *
 * Design
 * - Methods are fire-and-forget (Promise<void>) but MUST be idempotent at the
 *   implementation level. Processors may retry.
 * - Payloads are small, structured, and redactable for logs.
 *
 * Drivers
 * - "noop" (default): logs to console for local and tests.
 * - "dialect": example external provider (implementation optional; see notes).
 *
 * Configuration
 * - NOTIFY_DRIVER = "noop" | "dialect" (default "noop")
 * - NOTIFY_DIALECT_KEY = <api key> (only if using dialect driver)
 *
 * Used by processors
 * - handleReminder.ts : sendReminder()
 * - handleDeadline.ts : notifyReviewer()
 * - handleEscalation.ts: notifyReviewer(), notifyParties()
 */

import type { ReminderAudience, ReminderReason } from "../types/jobs";

/* -----------------------------------------------------------
 * Input shapes
 * --------------------------------------------------------- */

/** Minimal reviewer notification */
export interface NotifyReviewerInput {
  dealId: string;
  reason: string;        // free-form short string like "deadline-expired"
  when: number;          // unix seconds
  context?: Record<string, unknown>; // approvalUrl, blinkUrl, suggested, etc.
}

/** Party-facing notification */
export interface NotifyPartiesInput {
  dealId: string;
  event:
    | "finalize-prepared"
    | "deadline-reminder"
    | "escalated"
    | "dispute-opened"
    | "deadline-missed";
  when: number;          // unix seconds
  audience?: ReminderAudience; // optional narrowing
  context?: Record<string, unknown>;
}

/** Reminder notification */
export interface SendReminderInput {
  dealId: string;
  when: number;                 // unix seconds
  audience: ReminderAudience;   // "buyer" | "seller" | "both"
  reason: ReminderReason;       // "deadline-upcoming" | "dispute-window-closing"
  context?: Record<string, unknown>; // deliveryBy, disputeUntil, etc.
}

/* -----------------------------------------------------------
 * Port interface
 * --------------------------------------------------------- */

export interface NotifyPort {
  notifyReviewer(input: NotifyReviewerInput): Promise<void>;
  notifyParties(input: NotifyPartiesInput): Promise<void>;
  sendReminder(input: SendReminderInput): Promise<void>;
}

/* -----------------------------------------------------------
 * Factory with pluggable drivers
 * --------------------------------------------------------- */

type Driver = "noop" | "dialect";

/**
 * Returns a NotifyPort implementation.
 * Default is "noop" which prints structured JSON to stdout for dev/tests.
 * If NOTIFY_DRIVER=dialect, attempts to load infra/notify.dialect.ts.
 */
export function getNotifyPort(): NotifyPort {
  const driver = (process.env.NOTIFY_DRIVER as Driver) || "noop";

  if (driver === "dialect") {
    // Soft dependency so the worker can boot without optional infra.
    // If the module or its env is missing, we fall back to noop with a warning.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../infra/notify.dialect") as {
        createDialectNotifier: () => NotifyPort;
      };
      return mod.createDialectNotifier();
    } catch (err) {
      log("warn", "notify driver 'dialect' unavailable, falling back to noop", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return createNoopNotifier();
}

/* -----------------------------------------------------------
 * Noop driver (development/test)
 * --------------------------------------------------------- */

/**
 * Logs notifications as structured JSON. Suitable for local runs and tests.
 * Idempotency is naturally satisfied (no external effect).
 */
function createNoopNotifier(): NotifyPort {
  return {
    async notifyReviewer(input: NotifyReviewerInput): Promise<void> {
      log("info", "notifyReviewer(noop)", redact(input));
    },
    async notifyParties(input: NotifyPartiesInput): Promise<void> {
      log("info", "notifyParties(noop)", redact(input));
    },
    async sendReminder(input: SendReminderInput): Promise<void> {
      log("info", "sendReminder(noop)", redact(input));
    }
  };
}

/* -----------------------------------------------------------
 * Helpers
 * --------------------------------------------------------- */

type Level = "debug" | "info" | "warn" | "error";
const LOG_LEVEL: Level = (process.env.LOG_LEVEL as Level) || "info";

function log(level: Level, msg: string, meta: Record<string, unknown> = {}): void {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  if (order[level] < order[LOG_LEVEL]) return;
  const entry = { level, msg, ts: new Date().toISOString(), ...meta };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

/**
 * Redact potentially sensitive fields before logging.
 * This is intentionally conservative. Expand as needed.
 */
function redact<T extends Record<string, unknown>>(obj: T): T {
  const clone: Record<string, unknown> = { ...obj };
  if (clone.context && typeof clone.context === "object") {
    const ctx = { ...(clone.context as Record<string, unknown>) };
    for (const k of Object.keys(ctx)) {
      if (k.toLowerCase().includes("url")) continue; // approvalUrl/blinkUrl are safe
      if (k.toLowerCase().includes("cid")) continue; // content identifiers
      // Blindly redact any value that looks like a token or key
      if (k.toLowerCase().includes("token") || k.toLowerCase().includes("key")) {
        ctx[k] = "<redacted>";
      }
    }
    clone.context = ctx;
  }
  return clone as T;
}

/* -----------------------------------------------------------
 * Dialect driver notes (optional)
 * --------------------------------------------------------- */
/**
 * An example dialect implementation would live at:
 *   src/infra/notify.dialect.ts
 * and export:
 *   export function createDialectNotifier(): NotifyPort { ... }
 *
 * That module would:
 *  - Read NOTIFY_DIALECT_KEY from env
 *  - Map NotifyPort methods to Dialect API calls
 *  - Ensure idempotency (e.g., include an idempotency key in message metadata)
 *  - Handle provider errors and timeouts by throwing a typed error or retryable error
 */
