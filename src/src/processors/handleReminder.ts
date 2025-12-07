import { Job } from "bullmq";
import {
  buildCarEscrowNotification,
  CarSummary,
  EscrowTimelineInfo,
  RiskInfo,
} from "../services/carEscrowNotifications";
import { NotifyPort } from "../ports/NotifyPort";

export async function handleReminder({
  job,
  notifyPort,
}: {
  job: Job;
  notifyPort: NotifyPort;
}) {
  const {
    escrowPubkey,
    buyerAddress,
    sellerAddress,
    car,
    timeline,
    risk,
  }: {
    escrowPubkey: string;
    buyerAddress: string;
    sellerAddress: string;
    car: CarSummary;
    timeline: EscrowTimelineInfo;
    risk?: RiskInfo;
  } = job.data;

  // Buyer notification
  const buyerContent = buildCarEscrowNotification({
    jobKind: "reminder",
    role: "buyer",
    car,
    timeline,
    risk,
  });

  // Seller notification
  const sellerContent = buildCarEscrowNotification({
    jobKind: "reminder",
    role: "seller",
    car,
    timeline,
    risk,
  });

  await Promise.all([
    notifyPort.notify(buyerAddress, buyerContent),
    notifyPort.notify(sellerAddress, sellerContent),
  ]);

  return { ok: true };
}
