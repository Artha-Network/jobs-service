/**
 * Structured Logger for Jobs Service
 *
 * Produces JSON log lines compatible with common log aggregators
 * (Datadog, Loki, CloudWatch). Automatically attaches job metadata
 * when called from within a processor context.
 *
 * Usage:
 *   import { logger } from "./utils/logger";
 *   logger.info("Job processed", { dealId, action: "escalate" });
 *   logger.withJob(job).warn("Retrying", { attempt: job.attemptsMade });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  service: string;
  [key: string]: unknown;
}

interface JobContext {
  jobId?: string;
  jobName?: string;
  queue?: string;
  attempt?: number;
  dealId?: string;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SERVICE_NAME = "jobs-service";

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVEL_PRIORITY) return env as LogLevel;
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getMinLevel()];
}

function emit(entry: LogEntry): void {
  const stream = entry.level === "error" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + "\n");
}

function createEntry(
  level: LogLevel,
  msg: string,
  meta: Record<string, unknown> = {},
  jobCtx?: JobContext
): LogEntry {
  return {
    level,
    msg,
    ts: new Date().toISOString(),
    service: SERVICE_NAME,
    ...(jobCtx && {
      jobId: jobCtx.jobId,
      jobName: jobCtx.jobName,
      queue: jobCtx.queue,
      attempt: jobCtx.attempt,
      ...(jobCtx.dealId && { dealId: jobCtx.dealId }),
    }),
    ...meta,
  };
}

/** Logger with optional job context binding. */
class Logger {
  private jobCtx?: JobContext;

  constructor(jobCtx?: JobContext) {
    this.jobCtx = jobCtx;
  }

  /**
   * Create a child logger bound to a specific job.
   * Extracts relevant fields from BullMQ Job-like objects.
   */
  withJob(job: {
    id?: string;
    name?: string;
    queueName?: string;
    attemptsMade?: number;
    data?: Record<string, unknown>;
  }): Logger {
    return new Logger({
      jobId: job.id ?? undefined,
      jobName: job.name,
      queue: job.queueName,
      attempt: job.attemptsMade,
      dealId: job.data?.dealId as string | undefined,
    });
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("debug")) return;
    emit(createEntry("debug", msg, meta, this.jobCtx));
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("info")) return;
    emit(createEntry("info", msg, meta, this.jobCtx));
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("warn")) return;
    emit(createEntry("warn", msg, meta, this.jobCtx));
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("error")) return;
    emit(createEntry("error", msg, meta, this.jobCtx));
  }

  /**
   * Log the start and result of a timed operation.
   * Returns the operation's result.
   */
  async timed<T>(
    label: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.info(`${label} completed`, {
        ...meta,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      this.error(`${label} failed`, {
        ...meta,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/** Singleton logger instance. */
export const logger = new Logger();

export { Logger, type LogLevel, type LogEntry, type JobContext };
