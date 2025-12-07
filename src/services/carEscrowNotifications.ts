// src/services/carEscrowNotifications.ts
//
// Car-escrow–specific notification helpers.
//
// This module knows how to talk like a car escrow:
// - different messages for buyer vs seller vs moderator
// - different tone for reminder / deadline / escalation
// - includes simple safety checks (VIN, title, bill of sale)
//
// You can call these helpers from your processors and then send the
// returned text via NotifyPort (Dialect, email, SMS, etc.)

export type UserRole = "buyer" | "seller" | "moderator";

export type JobKind = "reminder" | "deadline" | "escalation";

export interface CarSummary {
  make?: string;
  model?: string;
  year?: number;
  vinLast4?: string; // just last 4 for privacy
  priceUsd: number;
  city?: string;
}

export interface EscrowTimelineInfo {
  deliveryDeadlineIso: string;
  disputeEndIso: string;
  minutesBefore?: number; // for reminder jobs
}

export interface RiskInfo {
  riskScore: number; // 1-10
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
}

export interface NotificationContent {
  title: string;
  body: string;
  // Optional metadata your NotifyPort can use for rich UIs
  meta?: Record<string, unknown>;
}

/**
 * Build a concise label for the car.
 * Example: "2018 Honda Civic (…1234), $12,500"
 */
export function formatCarLabel(car: CarSummary): string {
  const parts: string[] = [];

  if (car.year) parts.push(String(car.year));
  if (car.make) parts.push(car.make);
  if (car.model) parts.push(car.model);

  let label = parts.join(" ");

  if (car.vinLast4) {
    label += ` (…${car.vinLast4})`;
  }

  if (car.priceUsd) {
    const price = car.priceUsd.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
    label += `, ${price}`;
  }

  if (car.city) {
    label += ` · ${car.city}`;
  }

  return label || "Car sale";
}

/**
 * Basic safety checklist to attach to notifications.
 * You can show this to both buyer & seller.
 */
export function buildSafetyChecklist(role: UserRole): string[] {
  const base: string[] = [
    "Verify the VIN on the car matches the title and any photos.",
    "Meet in a public, well-lit place (e.g., bank parking lot or DMV).",
    "Avoid accepting / sending money outside the escrow flow.",
  ];

  if (role === "buyer") {
    base.push(
      "Test drive the car and check basic functions (lights, brakes, AC, dashboard warnings).",
      "Ask for maintenance records if available.",
      "Only approve release once you're satisfied with the condition."
    );
  } else if (role === "seller") {
    base.push(
      "Bring the original title and a government ID.",
      "Remove license plates if required by your state.",
      "Only hand over keys once the escrow shows funds are locked."
    );
  } else {
    // moderator / reviewer
    base.push(
      "Review photo evidence (odometer, VIN, damage) before making a decision.",
      "Document all decisions inside the system for auditability."
    );
  }

  return base;
}

/**
 * Builds a notification payload for a given job & role.
 */
export function buildCarEscrowNotification(args: {
  jobKind: JobKind;
  role: UserRole;
  car: CarSummary;
  timeline: EscrowTimelineInfo;
  risk?: RiskInfo;
}): NotificationContent {
  const { jobKind, role, car, timeline, risk } = args;
  const label = formatCarLabel(car);

  if (jobKind === "reminder") {
    return buildReminderNotification(role, label, timeline, risk);
  }

  if (jobKind === "deadline") {
    return buildDeadlineNotification(role, label, timeline, risk);
  }

  // escalation
  return buildEscalationNotification(role, label, timeline, risk);
}

// -------- internal helpers --------

function buildReminderNotification(
  role: UserRole,
  carLabel: string,
  timeline: EscrowTimelineInfo,
  risk?: RiskInfo
): NotificationContent {
  const minutesBefore = timeline.minutesBefore ?? 60;
  const when =
    minutesBefore >= 60
      ? `${Math.round(minutesBefore / 60)} hour(s)`
      : `${minutesBefore} minutes`;
  const checklist = buildSafetyChecklist(role);

  let title: string;
  if (role === "buyer") {
    title = `Upcoming car handoff in ${when}`;
  } else if (role === "seller") {
    title = `Prepare for car handoff in ${when}`;
  } else {
    title = `Car escrow event in ${when}`;
  }

  const riskLine = risk
    ? `Risk level for this deal: ${risk.riskLevel.toUpperCase()} (score ${risk.riskScore}/10).`
    : "";

  const bodyLines = [
    `${carLabel}`,
    "",
    `This is a reminder that an escrow event is scheduled in about ${when}.`,
    riskLine,
    "",
    "Quick safety checklist:",
    ...checklist.map((item) => `• ${item}`),
    "",
    `Delivery deadline: ${timeline.deliveryDeadlineIso}`,
    `Dispute window ends: ${timeline.disputeEndIso}`,
  ].filter(Boolean);

  return {
    title,
    body: bodyLines.join("\n"),
    meta: {
      role,
      jobKind: "reminder",
      minutesBefore,
      riskLevel: risk?.riskLevel,
      riskScore: risk?.riskScore,
    },
  };
}

function buildDeadlineNotification(
  role: UserRole,
  carLabel: string,
  timeline: EscrowTimelineInfo,
  risk?: RiskInfo
): NotificationContent {
  let title: string;
  if (role === "buyer") {
    title = "Decision time: accept or dispute the car sale";
  } else if (role === "seller") {
    title = "Buyer decision window is ending";
  } else {
    title = "Escrow decision window reached";
  }

  const riskLine = risk
    ? `Flagged as ${risk.riskLevel.toUpperCase()} risk (score ${risk.riskScore}/10).`
    : "";

  const bodyLines = [
    `${carLabel}`,
    "",
    "The delivery / inspection deadline for this car escrow has been reached.",
    riskLine,
    "",
    role === "buyer"
      ? "If everything looks good, you can approve release. If there are serious issues, open a dispute before the dispute window ends."
      : role === "seller"
      ? "The buyer must now either approve release or open a dispute. You will be notified of their decision."
      : "Please review on-chain + off-chain details if a dispute is opened, and follow the escalation protocol.",
    "",
    `Delivery deadline (now): ${timeline.deliveryDeadlineIso}`,
    `Dispute window ends: ${timeline.disputeEndIso}`,
  ].filter(Boolean);

  return {
    title,
    body: bodyLines.join("\n"),
    meta: {
      role,
      jobKind: "deadline",
      riskLevel: risk?.riskLevel,
      riskScore: risk?.riskScore,
    },
  };
}

function buildEscalationNotification(
  role: UserRole,
  carLabel: string,
  timeline: EscrowTimelineInfo,
  risk?: RiskInfo
): NotificationContent {
  let title: string;
  if (role === "buyer" || role === "seller") {
    title = "Escrow auto-escalated to reviewer";
  } else {
    title = "New car escrow requires a manual decision";
  }

  const riskLine = risk
    ? `This is a ${risk.riskLevel.toUpperCase()} risk deal (score ${risk.riskScore}/10).`
    : "";

  const bodyLines = [
    `${carLabel}`,
    "",
    "The dispute window has expired without a clear resolution. This escrow has been escalated.",
    riskLine,
    "",
    role === "buyer"
      ? "If you have not already, make sure any evidence (photos, videos, messages) is uploaded to the platform for the reviewer."
      : role === "seller"
      ? "The reviewer may request additional documents such as title photos, ID, or repair receipts."
      : "Review buyer and seller evidence, check on-chain events, and follow the decision matrix for car escrows.",
    "",
    `Dispute window ended: ${timeline.disputeEndIso}`,
  ].filter(Boolean);

  return {
    title,
    body: bodyLines.join("\n"),
    meta: {
      role,
      jobKind: "escalation",
      riskLevel: risk?.riskLevel,
      riskScore: risk?.riskScore,
    },
  };
}
