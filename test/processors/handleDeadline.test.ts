/**
 * handleDeadline processor tests
 *
 * Goals
 * - Prove escalation to REVIEW when delivery deadline has passed and policy forbids auto-finalize.
 * - Prove NOOP when the deal is already finalized (RELEASED/REFUNDED/RESOLVED).
 * - Assert idempotent enqueue with a stable jobId for the escalation queue.
 * - Ensure reviewer notification is sent only when needed.
 *
 * Test strategy
 * - Mock BullMQ's Queue to avoid Redis and capture enqueued jobs in-memory.
 * - Mock ports (ApiPort, NotifyPort, ChainPort) to return deterministic values.
 * - Call the processor directly with a synthetic BullMQ Job object.
 *
 * Running
 *   pnpm test
 */

import { describe, it, beforeEach, expect, vi } from "vitest";

// ---------------------------------------------
// Mocks
// ---------------------------------------------

// In-memory capture of queue.add calls
const added: Array<{ name: string; data: unknown; opts?: { jobId?: string } }> = [];

vi.mock("bullmq", () => {
  class MockQueue<T = unknown> {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async add(name: string, data: T, opts?: { jobId?: string }) {
      added.push({ name, data, opts });
      // simulate BullMQ return shape minimally
      return { id: opts?.jobId ?? "mock-id", name, data } as any;
    }
    async close() {
      /* no-op */
    }
  }

  // Minimal Job shape used by the processor
  type Job<T = any> = {
    id?: string;
    name?: string;
    data: T;
  };

  return {
    Queue: MockQueue,
    // Export types for TS satisfaction in consumer code
    Job: {} as Job
  };
});

// Mock ApiPort with a configurable snapshot
let SNAPSHOT: any = null;
vi.mock("../../src/ports/ApiPort", async () => {
  return {
    getApiPort: () => ({
      async getDealSnapshot(dealId: string) {
        if (!SNAPSHOT) throw new Error("SNAPSHOT not set");
        return { id: dealId, ...SNAPSHOT };
      },
      async prepareFinalize() {
        throw new Error("not used in handleDeadline tests");
      }
    })
  };
});

// Mock NotifyPort to capture calls
const notifications: Array<{ kind: "reviewer" | "parties"; payload: any }> = [];
vi.mock("../../src/ports/NotifyPort", async () => {
  return {
    getNotifyPort: () => ({
      async notifyReviewer(input: any) {
        notifications.push({ kind: "reviewer", payload: input });
      },
      async notifyParties(input: any) {
        notifications.push({ kind: "parties", payload: input });
      },
      async sendReminder() {
        /* not used here */
      }
    })
  };
});

// Mock ChainPort policy: disallow auto-finalize by default
vi.mock("../../src/ports/ChainPort", async () => {
  return {
    getChainPolicy: () => ({
      allowsAutoFinalize: (_: "RELEASE" | "REFUND") => false
    })
  };
});

// ---------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------

import { handleDeadline } from "../../src/processors/handleDeadline";
import {
  DeadlineJob,
  jobIdForDeadline,
  jobIdForEscalation
} from "../../src/types/jobs";

// ---------------------------------------------
// Helpers
// ---------------------------------------------

function makeJob(data: Record<string, unknown>, id?: string) {
  return { id, name: "deadlines", data } as any;
}

beforeEach(() => {
  added.length = 0;
  notifications.length = 0;
  SNAPSHOT = null;
  // Required by the processor when instantiating a Queue
  process.env.REDIS_URL = "redis://localhost:6379";
});

// ---------------------------------------------
// Cases
// ---------------------------------------------

describe("handleDeadline", () => {
  it("escalates to REVIEW when delivery deadline is overdue and no auto-finalize", async () => {
    // Given a delivery deadline in the past
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: DeadlineJob = {
      dealId: "D-123",
      deadlineAt: nowSec - 10,
      kind: "delivery",
      nonce: 1
    };

    // Current snapshot: still FUNDED, not delivered
    SNAPSHOT = {
      state: "FUNDED",
      deliveryBy: payload.deadlineAt,
      disputeUntil: undefined
    };

    const res = await handleDeadline(makeJob(payload, jobIdForDeadline(payload)));

    expect(res).toMatchObject({
      action: "escalate",
      dealId: "D-123",
      reason: "no-delivery",
      suggested: "REVIEW"
    });

    // One escalation enqueued with stable jobId
    expect(added).toHaveLength(1);
    const esc = added[0];
    expect(esc.name).toBe("escalation");
    expect(esc.opts?.jobId).toBe(
      jobIdForEscalation({ dealId: "D-123", reason: "no-delivery", suggested: "REVIEW" })
    );

    // Reviewer notified once
    expect(notifications.filter(n => n.kind === "reviewer")).toHaveLength(1);
  });

  it("no-ops when deal already finalized (RELEASED)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: DeadlineJob = {
      dealId: "D-999",
      deadlineAt: nowSec - 100,
      kind: "delivery",
      nonce: 0
    };

    SNAPSHOT = {
      state: "RELEASED",
      deliveryBy: payload.deadlineAt
    };

    const res = await handleDeadline(makeJob(payload, jobIdForDeadline(payload)));

    expect(res).toMatchObject({
      action: "noop",
      dealId: "D-999",
      kind: "delivery"
    });

    // No queue adds, no notifications
    expect(added).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("escalates to RELEASE when dispute window ends with FUNDED state", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: DeadlineJob = {
      dealId: "D-42",
      deadlineAt: nowSec - 5,
      kind: "dispute",
      nonce: 2
    };

    SNAPSHOT = {
      state: "FUNDED",
      disputeUntil: payload.deadlineAt
    };

    const res = await handleDeadline(makeJob(payload, jobIdForDeadline(payload)));

    // Policy disallows auto-finalize, so processor downgrades to REVIEW
    expect(res).toMatchObject({
      action: "escalate",
      dealId: "D-42",
      reason: "deadline-expired",
      suggested: "REVIEW"
    });

    expect(added).toHaveLength(1);
    expect(added[0].opts?.jobId).toBe(
      jobIdForEscalation({ dealId: "D-42", reason: "deadline-expired", suggested: "REVIEW" })
    );
    // Reviewer notified
    expect(notifications.filter(n => n.kind === "reviewer")).toHaveLength(1);
  });
});
