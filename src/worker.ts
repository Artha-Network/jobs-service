/**
 * Jobs Service worker entry point.
 *
 * Purpose
 * - Consume Redis backed queues for deadlines, reminders, and escalations.
 * - Execute pure processors with strong typing and clear side effect boundaries.
 * - Provide predictable lifecycle hooks and graceful shutdown.
 *
 * Queues
 * - deadlines: fires exactly at delivery or dispute deadlines
 * - reminders: fires before a deadline to notify parties
 * - escalation: runs when a deadline passes without resolution
 *
 * Environment
 * - REDIS_URL              redis connection string
 * - RPC_URL                Solana RPC endpoint used by ports when needed
 * - HELIUS_WEBHOOK_SECRET  shared secret to verify webhook payloads (used by infra)
 * - ACTIONS_BASEURL        base URL for Actions endpoints
 * - WORKER_CONCURRENCY     optional integer, default 5
 * - LOG_LEVEL              optional: debug, info, warn, error
 *
 * Design
 * - This file wires queues to processors using dynamic imports so stubs can be
 *   implemented later without changing the worker. Each processor must be a
 *   pure function that accepts a BullMQ Job and returns a result or throws.
 * - All IO and external effects live behind ports in src/ports.
 * - Idempotency is handled inside processors and queue options.
 */

import { Queue, Worker, JobsOptions, QueueEvents, ConnectionOptions } from "bullmq";

// Simple leveled logger without pulling in a logging lib
type Level = "debug" | "info" | "warn" | "error";
const LOG_LEVEL: Level = (process.env.LOG_LEVEL as Level) || "info";
function log(level: Level, msg: string, meta: Record<string, unknown> = {}): void {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  if (order[level] < order[LOG_LEVEL]) return;
  const entry = { level, msg, ts: new Date().toISOString(), ...meta };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

// Environment helpers
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

const REDIS_URL = required("REDIS_URL");
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? "5");

// BullMQ connection
const connection: ConnectionOptions = { url: REDIS_URL };

// Queue names
export const Q_DEADLINES = "deadlines";
export const Q_REMINDERS = "reminders";
export const Q_ESCALATION = "escalation";

// Default job options used when producers enqueue work
export const defaultJobOpts: JobsOptions = {
  removeOnComplete: { age: 60 * 60, count: 1000 }, // keep for an hour or up to 1000
  removeOnFail: { age: 24 * 60 * 60, count: 1000 }, // keep for a day
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 1000
  }
};

// Queues (producers will import these names when enqueueing)
export const deadlinesQueue = new Queue(Q_DEADLINES, { connection, defaultJobOptions: defaultJobOpts });
export const remindersQueue = new Queue(Q_REMINDERS, { connection, defaultJobOptions: defaultJobOpts });
export const escalationQueue = new Queue(Q_ESCALATION, { connection, defaultJobOptions: defaultJobOpts });

// Queue events for metrics and debugging
const deadlinesEvents = new QueueEvents(Q_DEADLINES, { connection });
const remindersEvents = new QueueEvents(Q_REMINDERS, { connection });
const escalationEvents = new QueueEvents(Q_ESCALATION, { connection });

function wireQueueEvents(name: string, events: QueueEvents): void {
  events.on("completed", ({ jobId, returnvalue }) => {
    log("info", "job completed", { queue: name, jobId, returnvalue });
  });
  events.on("failed", ({ jobId, failedReason }) => {
    log("warn", "job failed", { queue: name, jobId, failedReason });
  });
  events.on("waiting", ({ jobId }) => log("debug", "job waiting", { queue: name, jobId }));
  events.on("active", ({ jobId }) => log("debug", "job active", { queue: name, jobId }));
  events.on("stalled", ({ jobId }) => log("warn", "job stalled", { queue: name, jobId }));
}

wireQueueEvents(Q_DEADLINES, deadlinesEvents);
wireQueueEvents(Q_REMINDERS, remindersEvents);
wireQueueEvents(Q_ESCALATION, escalationEvents);

// Workers
// Use dynamic imports so the processors can be added later without changing this file.
// Each processor must export a function named after the file, for example handleDeadline.
type ProcessorModule<T> = { default?: never } & Record<string, (job: T) => Promise<unknown> | unknown>;

function mkWorker<TPayload extends Record<string, unknown>>(
  queueName: string,
  importPath: string,
  exportedFn: keyof ProcessorModule<any>,
  concurrency = CONCURRENCY
): Worker<TPayload, unknown, string> {
  return new Worker<TPayload>(
    queueName,
    async job => {
      const mod = (await import(importPath)) as ProcessorModule<typeof job>;
      const fn = mod[exportedFn];
      if (typeof fn !== "function") {
        throw new Error(`Processor ${String(exportedFn)} not found in ${importPath}`);
      }
      const started = Date.now();
      try {
        const res = await fn(job);
        const ms = Date.now() - started;
        log("info", "processed job", { queue: queueName, jobId: job.id, ms });
        return res;
      } catch (err) {
        const ms = Date.now() - started;
        log("error", "processor threw", {
          queue: queueName,
          jobId: job.id,
          ms,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    },
    { connection, concurrency }
  );
}

// Instantiate workers for each queue
const deadlinesWorker = mkWorker(Q_DEADLINES, "./processors/handleDeadline", "handleDeadline");
const remindersWorker = mkWorker(Q_REMINDERS, "./processors/handleReminder", "handleReminder");
const escalationWorker = mkWorker(Q_ESCALATION, "./processors/handleEscalation", "handleEscalation");

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log("info", "shutdown requested", { signal });
  try {
    await Promise.all([
      deadlinesWorker.close(),
      remindersWorker.close(),
      escalationWorker.close(),
      deadlinesEvents.close(),
      remindersEvents.close(),
      escalationEvents.close(),
      deadlinesQueue.close(),
      remindersQueue.close(),
      escalationQueue.close()
    ]);
    log("info", "shutdown complete");
    process.exit(0);
  } catch (err) {
    log("error", "shutdown error", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Startup banner
log("info", "jobs worker online", {
  redis: new URL(REDIS_URL).host,
  concurrency: CONCURRENCY,
  queues: [Q_DEADLINES, Q_REMINDERS, Q_ESCALATION]
});

// Keep process alive
// This no-op interval prevents premature exit in some hosting environments
setInterval(() => {}, 1 << 30);
