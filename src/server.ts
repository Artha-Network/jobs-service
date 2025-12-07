// src/server.ts
//
// HTTP entrypoint for the Jobs Service.
// - /webhooks/helius: consumes Helius webhooks + schedules/cancels jobs
// - /car-escrow/plan: car-sale–specific helper to compute deadlines,
//   dispute window and reminders based on deal details.

import express from "express";
import { handleHeliusWebhook } from "./infra/heliusWebhookHandler";
import { deadlineQueue, reminderQueue, escalationQueue } from "./queues"; // adjust path if needed
import { ChainPort } from "./ports/ChainPort";

const app = express();
app.use(express.json());

const chainPort = new ChainPort({ rpcUrl: process.env.RPC_URL! });
const queues = { deadlineQueue, reminderQueue, escalationQueue };

// ----------------- Car-escrow domain types & helpers -----------------

type DeliveryType = "local_pickup" | "same_city_carrier" | "cross_country_carrier";

interface CarSaleInput {
  priceUsd: number;
  deliveryType: DeliveryType;
  hasTitleInHand: boolean;
  odometerMiles: number;
  year: number;
  isSalvageTitle?: boolean;
}

interface CarEscrowPlan {
  riskScore: number;          // 1–10
  riskLevel: "low" | "medium" | "high";
  reasons: string[];

  deliveryDeadlineHoursFromNow: number;
  disputeWindowHours: number;
  reminderMinutesBefore: number[];

  // Concrete timestamps as ISO strings for convenience (based on "now")
  deliveryDeadlineAtIso: string;
  disputeWindowEndsAtIso: string;
}

/**
 * Compute a simple risk score for a P2P car sale.
 * Higher score ⇒ longer dispute window and more conservative deadlines.
 */
function computeCarRisk(input: CarSaleInput): {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 1; // base

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

  // Clamp score between 1 and 10
  score = Math.max(1, Math.min(score, 10));

  let level: "low" | "medium" | "high";
  if (score <= 3) level = "low";
  else if (score <= 6) level = "medium";
  else level = "high";

  return { score, level, reasons };
}

/**
 * Turn the risk profile into a concrete escrow timing plan:
 * - delivery deadline (how long buyer has to receive & check car)
 * - dispute window (time to raise an issue after delivery)
 * - reminder schedule (minutes before deadline)
 */
function computeCarEscrowPlan(input: CarSaleInput): CarEscrowPlan {
  const { score, level, reasons } = computeCarRisk(input);
  const now = Date.now();

  // Base defaults
  let deliveryDeadlineHours = 24;   // local pickup default
  let disputeWindowHours = 48;      // 2 days

  // Adjust based on delivery type
  if (input.deliveryType === "same_city_carrier") {
    deliveryDeadlineHours = 72; // 3 days
  } else if (input.deliveryType === "cross_country_carrier") {
    deliveryDeadlineHours = 7 * 24; // 7 days
  }

  // Adjust based on risk score
  if (score >= 7) {
    disputeWindowHours = 7 * 24; // 7 days
  } else if (score >= 4) {
    disputeWindowHours = 3 * 24; // 3 days
  }

  const reminderMinutesBefore: number[] = [];

  // Always: 24h before if window >= 48h
  if (deliveryDeadlineHours >= 48) {
    reminderMinutesBefore.push(24 * 60);
  }

  // 6h before for anything >= 24h
  if (deliveryDeadlineHours >= 24) {
    reminderMinutesBefore.push(6 * 60);
  }

  // 1h before final deadline
  reminderMinutesBefore.push(60);

  const deliveryDeadlineMs = now + deliveryDeadlineHours * 60 * 60 * 1000;
  const disputeEndMs = deliveryDeadlineMs + disputeWindowHours * 60 * 60 * 1000;

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

// ----------------- Routes -----------------

// Health check: quick ping to see if server is alive
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jobs-service", time: new Date().toISOString() });
});

// Helius webhook → schedule/cancel jobs based on on-chain state
app.post("/webhooks/helius", async (req, res) => {
  const result = await handleHeliusWebhook({
    body: req.body,
    headers: req.headers as any,
    queues,
    chainPort,
    reminderMinutesBefore: [24 * 60, 60], // default reminders: 24h & 1h before (can be overridden from on-chain fields)
  });

  res.status(result.status).json(result);
});

// Car-escrow planning endpoint
// Frontend / actions service can call this BEFORE creating an escrow
// to propose safe timing parameters based on the car deal.
app.post("/car-escrow/plan", (req, res) => {
  const body = req.body as Partial<CarSaleInput>;

  // basic validation
  if (
    typeof body.priceUsd !== "number" ||
    typeof body.deliveryType !== "string" ||
    typeof body.hasTitleInHand !== "boolean" ||
    typeof body.odometerMiles !== "number" ||
    typeof body.year !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid payload. Required: priceUsd, deliveryType, hasTitleInHand, odometerMiles, year",
    });
  }

  if (
    body.deliveryType !== "local_pickup" &&
    body.deliveryType !== "same_city_carrier" &&
    body.deliveryType !== "cross_country_carrier"
  ) {
    return res.status(400).json({
      ok: false,
      error: "deliveryType must be one of: local_pickup, same_city_carrier, cross_country_carrier",
    });
  }

  const plan = computeCarEscrowPlan(body as CarSaleInput);

  return res.json({
    ok: true,
    plan,
  });
});

// ----------------- Start server -----------------

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      event: "server.started",
      port: PORT,
      service: "jobs-service",
    })
  );
});
