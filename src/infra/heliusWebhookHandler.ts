// src/infra/heliusWebhookHandler.ts
//
// High-level handler for Helius webhooks.
// - Verifies webhook secret
// - Looks up on-chain escrow state via ChainPort
// - Schedules or cancels jobs depending on escrow status
//
// This is framework-agnostic: you call handleHeliusWebhook() from
// your HTTP route (Express/Fastify/etc) and map its result to a response.

import { EscrowQueues, scheduleEscrowJobs, cancelEscrowJobs } from "../queues/scheduleEscrowJobs";
import { ChainPort } from "../ports/ChainPort";

export type HeliusHeaders = Record<string, string | string[] | undefined>;

export interface HeliusAccountUpdate {
  account: string;      // escrow PDA
  slot: number;
  timestamp?: number;   // unix sec
  // ...other fields from Helius if you need them
}

export interface HeliusWebhookBody {
  // Simplified version of Helius ACCOUNT_UPDATE webhook payload
  type: string;                 // e.g. "ACCOUNT_UPDATE"
  data?: HeliusAccountUpdate[]; // batched updates
  // ...other fields ignored for now
}

/**
 * Shape of the escrow state we care about.
 * Adapt this to your actual on-chain struct returned by ChainPort.
 */
export type EscrowState = {
  status:
    | "PENDING"
    | "FUNDED"
    | "SHIPPED"
    | "DISPUTED"
    | "RELEASED"
    | "CANCELLED"
    | "REFUNDED";
  deliveryAtMs: number;        // when buyer must confirm by
  disputeWindowSeconds: number; // how long after delivery to allow disputes
};

export interface HeliusHandlerDeps {
  queues: EscrowQueues;
  chainPort: ChainPort;
  /**
   * Optional override for reminder schedule.
   * Defaults to [1440, 60] → 24h before & 1h before.
   */
  reminderMinutesBefore?: number[];
}

/**
 * High-level return type so your HTTP layer can convert it to a response.
 */
export interface HeliusHandleResult {
  ok: boolean;
  status: number;
  processed: number;
  skipped: number;
  errors: number;
  reason?: string;
}

/**
 * Main entrypoint to call from your HTTP route.
 *
 * Example (Express):
 *
 *  app.post("/webhooks/helius", async (req, res) => {
 *    const result = await handleHeliusWebhook({
 *      body: req.body,
 *      headers: req.headers as HeliusHeaders,
 *      queues,
 *      chainPort,
 *    });
 *    res.status(result.status).json(result);
 *  });
 */
export async function handleHeliusWebhook(args: {
  body: HeliusWebhookBody;
  headers: HeliusHeaders;
} & HeliusHandlerDeps): Promise<HeliusHandleResult> {
  const { body, headers, queues, chainPort } = args;
  const reminderMinutesBefore = args.reminderMinutesBefore ?? [1440, 60]; // 24h, 1h

  // --- 1) Verify secret (simple project-friendly version) ---

  const expectedSecret = process.env.HELIUS_WEBHOOK_SECRET;
  const headerSecret = getHeader(headers, "x-helius-webhook-secret");

  if (expectedSecret && headerSecret !== expectedSecret) {
    console.warn(
      JSON.stringify({
        event: "heliusWebhook.unauthorized",
        got: headerSecret ? "present" : "missing",
      })
    );
    return {
      ok: false,
      status: 401,
      processed: 0,
      skipped: 0,
      errors: 0,
      reason: "invalid webhook secret",
    };
  }

  // --- 2) Basic payload validation ---

  if (!body || body.type !== "ACCOUNT_UPDATE" || !Array.isArray(body.data)) {
    console.warn(
      JSON.stringify({
        event: "heliusWebhook.ignored",
        reason: "unsupported_type_or_no_data",
        type: body?.type,
      })
    );
    return {
      ok: true,
      status: 200,
      processed: 0,
      skipped: 0,
      errors: 0,
      reason: "ignored payload",
    };
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // --- 3) Process each account update ---

  for (const update of body.data) {
    const escrowPubkey = update.account;

    try {
      const escrow = await fetchEscrowState(chainPort, escrowPubkey);
      if (!escrow) {
        skipped++;
        continue;
      }

      // Decide what to do based on escrow status
      if (isTerminalStatus(escrow.status)) {
        // Escrow is done → cancel outstanding timers
        await cancelEscrowJobs(queues, escrowPubkey);
        logEvent("escrow.jobs_cancelled", {
          escrowPubkey,
          status: escrow.status,
        });
      } else {
        // Escrow is active → (re)schedule timers
        await scheduleEscrowJobs(
          queues,
          {
            escrowPubkey,
            deliveryAtMs: escrow.deliveryAtMs,
            disputeWindowSeconds: escrow.disputeWindowSeconds,
            reminderMinutesBefore,
          },
          {
            // base job options; retry config lives here if you want
            attempts: 5,
          }
        );
        logEvent("escrow.jobs_scheduled", {
          escrowPubkey,
          status: escrow.status,
          deliveryAtMs: escrow.deliveryAtMs,
        });
      }

      processed++;
    } catch (err: any) {
      errors++;
      console.error(
        JSON.stringify({
          event: "heliusWebhook.error",
          escrowPubkey,
          error: err?.message,
          stack: err?.stack,
        })
      );
    }
  }

  return {
    ok: errors === 0,
    status: 200,
    processed,
    skipped,
    errors,
  };
}

// ----------------- helpers -----------------

function getHeader(
  headers: HeliusHeaders,
  name: string
): string | undefined {
  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  if (!key) return undefined;
  const val = headers[key];
  if (Array.isArray(val)) return val[0];
  return val;
}

/**
 * Thin wrapper to get escrow state from ChainPort.
 * You can implement this using your existing Solana client.
 */
async function fetchEscrowState(
  chainPort: ChainPort,
  escrowPubkey: string
): Promise<EscrowState | null> {
  // TODO: Replace this with your real on-chain fetch.
  // Example:
  //
  // const account = await chainPort.getEscrowAccount(escrowPubkey);
  // if (!account) return null;
  // return {
  //   status: account.status,
  //   deliveryAtMs: account.deliveryTs * 1000,
  //   disputeWindowSeconds: account.disputeWindowSecs,
  // };

  const mock = await chainPort.getEscrowState?.(escrowPubkey);
  if (!mock) return null;
  return mock as EscrowState;
}

function isTerminalStatus(status: EscrowState["status"]): boolean {
  return (
    status === "RELEASED" ||
    status === "CANCELLED" ||
    status === "REFUNDED"
  );
}

function logEvent(event: string, extra: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      event,
      ...extra,
    })
  );
}
