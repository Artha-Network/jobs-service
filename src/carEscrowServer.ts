// src/carEscrowServer.ts
//
// HTTP server focused on P2P car-sale escrow:
//
// - /webhooks/helius
//     consumes Helius webhooks & schedules/cancels jobs
//
// - /car-escrow/plan
//     computes risk profile + suggested deadlines for a car sale
//
// - /car-escrow/preview-schedule
//     shows exact reminder/deadline/escalation timestamps (no queue writes)
//
// - /car-escrow/manual-schedule
//     actually writes jobs into BullMQ for a specific escrowPubkey

import express from "express";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { handleHeliusWebhook } from "./infra/heliusWebhookHandler";
import { scheduleEscrowJobs } from "./queues/scheduleEscrowJobs";
import { ChainPort } from "./ports/ChainPort";

const { REDIS_URL, RPC_URL } = process.env;

if (!REDIS_URL) {
  throw new Error("REDIS_URL is required");
}
if (!RPC_URL) {
  throw new Error("RPC_URL is required");
}

// --------- Redis + Queues (producers only; worker service consumes) ---------

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const DEADLINE_QUEUE = "escrow:deadline";
const REMINDER_QUEUE = "escrow:reminder";
const ESCALATION_QUEUE = "escrow:escalation";

const deadlineQueue = new Queue(DEADLINE_QUEUE, { connection });
const reminderQueue = new Queue(REMINDER_QUEUE, { connection });
const escalationQueue = new Queue(ESCALATION_QUEUE, { connection });

const queues = { deadlineQueue, reminderQueue, escalationQueue };

// --------- Ports ---------

const chainPort = new ChainPort({ rpcUrl: RPC_URL });

// --------- Car-escrow types & helpers ---------

type DeliveryType =
  | "local_pickup"
  | "same_city_carrier"
  | "cross_country_carrier";

interface CarSaleInput {
  priceUsd: number;
  deliveryType: DeliveryType;
  hasTitleInHand: boolean;
  odometerMiles: number;
  year: number;
  isSalvageTitle?: boolean;
}

interface CarEscrowPlan {
  riskScore: number; // 1–10
  riskLevel: "low" | "medium" | "high";
  reasons: string[];

  deliveryDeadlineHoursFromNow: number;
  disputeWindowHours: number;
  reminderMinutesBefore: number[];

  deliveryDeadlineAtIso: string;
  disputeWindowEndsAtIso: string;
}

type JobPreviewKind = "reminder" | "deadline" | "escalation";

interface JobPreview {
  kind: JobPreviewKind;
  runAtIso: string;
  meta: Record<string, unknown>;
}

/**
 * Compute a simple risk score for a P2P car sale.
 */
function computeCarRisk(input: CarSaleInput): {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 1;

  const nowYear = new Date().getFullYear();
  const ageYears = Math.max(0, nowYear - input.year);

  if (input.priceUsd >= 20000) {
    score += 3;
    reasons.push("High-value vehicle (>= $20k)");
  } else if (input.priceUsd >= 10000) {
    score += 2;
    reasons.push("Mid-value vehicle (>= $10k)");
  }

  if (input.deliveryType === "cross_country_carrier") {
    score += 3;
    reasons.push("Cross-country / remote delivery");
  } else if (input.deliveryType === "same_city_carrier") {
    score += 2;
    reasons.push("Same-city carrier (no in-person hand-off)");
  } else {
    reasons.push("Local pickup (in-person)");
  }

  if (!input.hasTitleInHand) {
    score += 2;
    reasons.push("Seller does not have clear title in hand");
  }

  if (input.isSalvageTitle) {
    score += 2;
    reasons.push("Salvage / rebuilt title");
  }

  if (ageYears >= 15) {
    score += 1;
    reasons.push("Older vehicle (>= 15 years)");
  }

  if (input.odometerMiles >= 150_000) {
    score += 1;
    reasons.push("High mileage (>= 150k miles)");
  }

  score = Math.max(1, Math.min(score, 10));

  let level: "low" | "medium" | "high";
  if (score <= 3) level = "low";
  else if (score <= 6) level = "medium";
  else level = "high";

  return { score, level, reasons };
}

/**
 * Turn the risk profile into a concrete escrow timing plan.
 */
function computeCarEscrowPlan(input: CarSaleInput): CarEscrowPlan {
  const { score, level, reasons } = computeCarRisk(input);
  const now = Date.now();

  let deliveryDeadlineHours = 24; // default: local pickup
  let disputeWindowHours = 48; // default: 2 days

  if (input.deliveryType === "same_city_carrier") {
    deliveryDeadlineHours = 72; // 3 days
  } else if (input.deliveryType === "cross_country_carrier") {
    deliveryDeadlineHours = 7 * 24; // 7 days
  }

  if (score >= 7) {
    disputeWindowHours = 7 * 24; // high risk: 7 days
  } else if (score >= 4) {
    disputeWindowHours = 3 * 24; // medium risk: 3 days
  }

  const reminderMinutesBefore: number[] = [];

  if (deliveryDeadlineHours >= 48) {
    reminderMinutesBefore.push(24 * 60); // 24h before
  }
  if (deliveryDeadlineHours >= 24) {
    reminderMinutesBefore.push(6 * 60); // 6h before
  }
  reminderMinutesBefore.push(60); // always 1h before

  const deliveryDeadlineMs = now + deliveryDeadlineHours * 60 * 60 * 1000;
  const disputeEndMs =
    deliveryDeadlineMs + disputeWindowHours * 60 * 60 * 1000;

  return {
    riskScore: score,
    riskLevel: level,
    reasons,
    deliveryDeadlineHoursFromNow: deliveryDeadlineHours,
    disputeWindowHours,
    reminderMinutesBefore,
    deliveryDeadlineAtIso: new Date(deliveryDeadlineMs).toISOString(),
    disputeWindowEndsAtIso: new Date(disputeEndMs).toISOString(),
  };
}

/**
 * Build a preview of the jobs that *would* be scheduled, given a plan.
 */
function buildSchedulePreview(nowMs: number, plan: CarEscrowPlan): JobPreview[] {
  const previews: JobPreview[] = [];

  const deliveryAtMs =
    nowMs + plan.deliveryDeadlineHoursFromNow * 60 * 60 * 1000;
  const disputeEndMs =
    deliveryAtMs + plan.disputeWindowHours * 60 * 60 * 1000;

  for (const minutesBefore of plan.reminderMinutesBefore) {
    const runMs = deliveryAtMs - minutesBefore * 60 * 1000;
    if (runMs <= nowMs) continue;
    previews.push({
      kind: "reminder",
      runAtIso: new Date(runMs).toISOString(),
      meta: { minutesBefore },
    });
  }

  previews.push({
    kind: "deadline",
    runAtIso: new Date(deliveryAtMs).toISOString(),
    meta: {},
  });

  previews.push({
    kind: "escalation",
    runAtIso: new Date(disputeEndMs).toISOString(),
    meta: { disputeWindowHours: plan.disputeWindowHours },
  });

  return previews.sort((a, b) => a.runAtIso.localeCompare(b.runAtIso));
}

// --------- Express app + routes ---------

const app = express();
app.use(express.json());

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "car-escrow-jobs-service",
    time: new Date().toISOString(),
  });
});

// Helius webhook → schedule/cancel jobs based on on-chain escrow state
app.post("/webhooks/helius", async (req, res) => {
  const result = await handleHeliusWebhook({
    body: req.body,
    headers: req.headers as any,
    queues,
    chainPort,
    // Fallback reminders (on-chain values can override)
    reminderMinutesBefore: [24 * 60, 60], // 24h & 1h
  });

  res.status(result.status).json(result);
});

// Compute car escrow plan (risk + timing) without touching queues
app.post("/car-escrow/plan", (req, res) => {
  const body = req.body as Partial<CarSaleInput>;

  if (
    typeof body.priceUsd !== "number" ||
    typeof body.deliveryType !== "string" ||
    typeof body.hasTitleInHand !== "boolean" ||
    typeof body.odometerMiles !== "number" ||
    typeof body.year !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "Invalid payload. Required: priceUsd, deliveryType, hasTitleInHand, odometerMiles, year",
    });
  }

  if (
    body.deliveryType !== "local_pickup" &&
    body.deliveryType !== "same_city_carrier" &&
    body.deliveryType !== "cross_country_carrier"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "deliveryType must be one of: local_pickup, same_city_carrier, cross_country_carrier",
    });
  }

  const plan = computeCarEscrowPlan(body as CarSaleInput);

  return res.json({ ok: true, plan });
});

// Preview exact reminder / deadline / escalation timestamps
app.post("/car-escrow/preview-schedule", (req, res) => {
  const body = req.body as Partial<CarSaleInput>;

  if (
    typeof body.priceUsd !== "number" ||
    typeof body.deliveryType !== "string" ||
    typeof body.hasTitleInHand !== "boolean" ||
    typeof body.odometerMiles !== "number" ||
    typeof body.year !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "Invalid payload. Required: priceUsd, deliveryType, hasTitleInHand, odometerMiles, year",
    });
  }

  if (
    body.deliveryType !== "local_pickup" &&
    body.deliveryType !== "same_city_carrier" &&
    body.deliveryType !== "cross_country_carrier"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "deliveryType must be one of: local_pickup, same_city_carrier, cross_country_carrier",
    });
  }

  const plan = computeCarEscrowPlan(body as CarSaleInput);
  const now = Date.now();
  const jobs = buildSchedulePreview(now, plan);

  return res.json({ ok: true, plan, jobs });
});

// Actually enqueue jobs for a given escrowPubkey using car-sale inputs
app.post("/car-escrow/manual-schedule", async (req, res) => {
  const { escrowPubkey, sale } = req.body as {
    escrowPubkey?: string;
    sale?: Partial<CarSaleInput>;
  };

  if (!escrowPubkey || typeof escrowPubkey !== "string") {
    return res.status(400).json({
      ok: false,
      error: "escrowPubkey (string) is required",
    });
  }

  if (!sale) {
    return res.status(400).json({
      ok: false,
      error:
        "sale object is required (priceUsd, deliveryType, hasTitleInHand, odometerMiles, year)",
    });
  }

  if (
    typeof sale.priceUsd !== "number" ||
    typeof sale.deliveryType !== "string" ||
    typeof sale.hasTitleInHand !== "boolean" ||
    typeof sale.odometerMiles !== "number" ||
    typeof sale.year !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "Invalid sale payload. Required: priceUsd, deliveryType, hasTitleInHand, odometerMiles, year",
    });
  }

  if (
    sale.deliveryType !== "local_pickup" &&
    sale.deliveryType !== "same_city_carrier" &&
    sale.deliveryType !== "cross_country_carrier"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "deliveryType must be one of: local_pickup, same_city_carrier, cross_country_carrier",
    });
  }

  const plan = computeCarEscrowPlan(sale as CarSaleInput);
  const now = Date.now();

  const deliveryAtMs =
    now + plan.deliveryDeadlineHoursFromNow * 60 * 60 * 1000;
  const disputeWindowSeconds = plan.disputeWindowHours * 60 * 60;

  await scheduleEscrowJobs(
    queues,
    {
      escrowPubkey,
      deliveryAtMs,
      disputeWindowSeconds,
      reminderMinutesBefore: plan.reminderMinutesBefore,
    },
    { attempts: 5 }
  );

  const jobs = buildSchedulePreview(now, plan);

  return res.json({
    ok: true,
    escrowPubkey,
    plan,
    jobs,
  });
});

// --------- Start server ---------

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      event: "carEscrowServer.started",
      port: PORT,
      service: "car-escrow-jobs-service",
    })
  );
});
