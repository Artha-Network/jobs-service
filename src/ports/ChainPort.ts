/**
 * ChainPort (policy)
 *
 * Purpose
 * - Centralize read-only policy checks for whether the worker is allowed
 *   to prepare auto-finalization actions (RELEASE or REFUND).
 * - Keep business policy separate from processors and network clients.
 *
 * Scope
 * - This module does not submit transactions.
 * - It exposes a simple capability interface used by processors.
 *
 * Configuration
 * - AUTO_FINALIZE_RELEASE: "true" | "false" (default false)
 * - AUTO_FINALIZE_REFUND:  "true" | "false" (default false)
 *
 * Rationale
 * - Even if the system can technically build finalize transactions, many
 *   deployments will require human review. Processors call this port to
 *   decide whether they may prepare an approval flow or must route to REVIEW.
 */

export type FinalizeAction = "RELEASE" | "REFUND";

/** Capability interface consumed by processors. */
export interface ChainPolicy {
  /**
   * Returns true if the worker is allowed to prepare an approval flow
   * for the given finalize action. Returning true does NOT imply the
   * worker will auto-execute on chain; it only allows preparing an
   * approval or Blink URL for a human to sign.
   */
  allowsAutoFinalize(action: FinalizeAction): boolean;
}

/** Parse boolean-like env vars safely. Accepts: true, 1, yes, on (case-insensitive). */
function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Factory for a policy instance backed by environment variables.
 * Defaults are strict: both actions disallowed unless explicitly enabled.
 */
export function getChainPolicy(): ChainPolicy {
  const allowRelease = readBoolEnv("AUTO_FINALIZE_RELEASE", false);
  const allowRefund  = readBoolEnv("AUTO_FINALIZE_REFUND", false);

  return {
    allowsAutoFinalize(action: FinalizeAction): boolean {
      if (action === "RELEASE") return allowRelease;
      if (action === "REFUND") return allowRefund;
      // Exhaustiveness for future-proofing
      return false;
    }
  };
}

/**
 * Example:
 *
 *  // .env
 *  // AUTO_FINALIZE_RELEASE=true
 *  // AUTO_FINALIZE_REFUND=false
 *
 *  const policy = getChainPolicy();
 *  policy.allowsAutoFinalize("RELEASE") // true
 *  policy.allowsAutoFinalize("REFUND")  // false
 */
