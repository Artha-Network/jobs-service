/**
 * ApiPort
 *
 * Purpose
 * - Single boundary for talking to the app/API that knows about deals.
 * - Processors call this port instead of sprinkling fetch logic everywhere.
 * - Shapes are validated with Zod so callers get typed data or a clear error.
 *
 * Non-goals
 * - No retries, backoff, or metrics here. Wrap this port if you need them.
 * - No guessing endpoints. This file defines types and a stub.
 *
 * Wiring notes
 * - Point this port at ACTIONS_BASEURL (env) or another internal API.
 * - Implement the two methods below with real HTTP calls and Zod validation.
 *
 * Used by processors
 * - handleDeadline.ts: getDealSnapshot()
 * - handleEscalation.ts: prepareFinalize()
 */

import { z } from "zod";

/* -----------------------------------------------------------
 * Domain shapes (narrow subset used by processors)
 * --------------------------------------------------------- */

export const DealState = z.enum([
  "INIT",
  "FUNDED",
  "DELIVERED",
  "DISPUTED",
  "RESOLVED",
  "RELEASED",
  "REFUNDED"
]);
export type DealState = z.infer<typeof DealState>;

export const DealSnapshotSchema = z.object({
  id: z.string().min(1),
  state: DealState,
  // Optional unix-second timestamps
  deliveryBy: z.number().int().positive().optional(),
  disputeUntil: z.number().int().positive().optional()
});
export type DealSnapshot = z.infer<typeof DealSnapshotSchema>;

export const PrepareFinalizeInputSchema = z.object({
  dealId: z.string().min(1),
  action: z.enum(["RELEASE", "REFUND"])
});
export type PrepareFinalizeInput = z.infer<typeof PrepareFinalizeInputSchema>;

export const PrepareFinalizeResultSchema = z.object({
  approvalUrl: z.string().url().optional(),
  // Optional Blink/Actions link for convenience
  blinkUrl: z.string().url().optional()
});
export type PrepareFinalizeResult = z.infer<typeof PrepareFinalizeResultSchema>;

/* -----------------------------------------------------------
 * Port interface
 * --------------------------------------------------------- */

export interface ApiPort {
  /**
   * Fetch a minimal snapshot of a deal for decision making.
   * Must be fast and cheap. Only fields defined in DealSnapshotSchema
   * are required by processors.
   */
  getDealSnapshot(dealId: string): Promise<DealSnapshot>;

  /**
   * Prepare a safe finalize action and return an approval URL and/or Blink URL
   * that a reviewer can open to approve a ready-to-sign transaction.
   * This method must be idempotent for the same (dealId, action).
   */
  prepareFinalize(input: PrepareFinalizeInput): Promise<PrepareFinalizeResult>;
}

/* -----------------------------------------------------------
 * Factory (stub by default)
 * --------------------------------------------------------- */

/**
 * Default factory returns a stub that throws. This keeps the worker
 * shippable without accidentally calling a random endpoint.
 *
 * To wire a real implementation:
 *  1) Replace the stub with a fetch-based client,
 *  2) Validate responses with the Zod schemas above,
 *  3) Consider timeouts and retries in a wrapper module (not here).
 */
export function getApiPort(): ApiPort {
  const base = process.env.ACTIONS_BASEURL;
  return {
    async getDealSnapshot(dealId: string): Promise<DealSnapshot> {
      // Basic input guard even in the stub
      if (!dealId || typeof dealId !== "string") {
        throw new Error("ApiPort.getDealSnapshot: invalid dealId");
      }
      throw new Error(
        `ApiPort.getDealSnapshot not implemented. Provide an implementation against ACTIONS_BASEURL=${base ?? "<unset>"}`
      );
    },

    async prepareFinalize(input: PrepareFinalizeInput): Promise<PrepareFinalizeResult> {
      PrepareFinalizeInputSchema.parse(input);
      throw new Error(
        `ApiPort.prepareFinalize not implemented. Provide an implementation against ACTIONS_BASEURL=${base ?? "<unset>"}`
      );
    }
  };
}

/* -----------------------------------------------------------
 * Example real implementation (commented)
 * --------------------------------------------------------- */
/*
import { setTimeout as delay } from "timers/promises";

export function getApiPort(): ApiPort {
  const base = process.env.ACTIONS_BASEURL;
  if (!base) throw new Error("ACTIONS_BASEURL is required for ApiPort");

  const timeoutMs = 5000;

  async function http<T>(path: string, init?: RequestInit, schema?: z.ZodSchema<T>): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(new URL(path, base), { ...init, signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as unknown;
      return schema ? schema.parse(json) : (json as T);
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async getDealSnapshot(dealId) {
      return http(`/deals/${encodeURIComponent(dealId)}/snapshot`, undefined, DealSnapshotSchema);
    },
    async prepareFinalize(input) {
      return http(
        `/deals/${encodeURIComponent(input.dealId)}/finalize/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: input.action })
        },
        PrepareFinalizeResultSchema
      );
    }
  };
}
*/
