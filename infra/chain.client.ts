/**
 * Minimal Solana JSON-RPC client (no external deps).
 *
 * Purpose
 * - Give processors and ports a tiny, typed wrapper to read chain state
 *   when needed (e.g., correlate webhook slots, sanity-check finality).
 * - Keep it fetch-based and framework-agnostic so it works in any Node 18+ env.
 *
 * Non-goals
 * - No key management, no transaction sending, no subscriptions.
 * - No retries/backoff here; wrap calls if you need robust networking.
 *
 * Environment
 * - RPC_URL (required): e.g., https://api.devnet.solana.com or a provider URL.
 *
 * Methods
 * - getSlot(): current slot number
 * - getBlockTime(slot): unix seconds or null if unavailable
 * - getSignatureStatus(sig): "processed" | "confirmed" | "finalized" | null
 *
 * Safety
 * - Each call has a timeout via AbortController.
 * - Responses validated loosely and narrowed to expected shapes.
 */

type Finality = "processed" | "confirmed" | "finalized";

export interface ChainClient {
  /** Current slot number per RPC node. */
  getSlot(signal?: AbortSignal): Promise<number>;

  /** Block time in unix seconds for a slot, or null if the RPC lacks it. */
  getBlockTime(slot: number, signal?: AbortSignal): Promise<number | null>;

  /**
   * Status for a given transaction signature.
   * Returns the *highest* commitment reported by the node, or null if unknown.
   */
  getSignatureStatus(sig: string, signal?: AbortSignal): Promise<Finality | null>;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function getChainClient(): ChainClient {
  const endpoint = mustGetRpcUrl();
  const defaultTimeoutMs = 7000;

  async function rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), defaultTimeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 1e6),
          method,
          params
        }),
        signal: signal ?? ctrl.signal
      });

      if (!res.ok) {
        throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as {
        jsonrpc?: string;
        id?: number | string;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };

      if (json.error) {
        throw new Error(`RPC ${method} error ${json.error.code}: ${json.error.message}`);
      }
      return json.result as T;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async getSlot(signal) {
      const result = await rpc<number>("getSlot", [], signal);
      if (!Number.isInteger(result) || result < 0) {
        throw new Error("RPC getSlot returned invalid result");
      }
      return result;
    },

    async getBlockTime(slot, signal) {
      if (!Number.isInteger(slot) || slot < 0) {
        throw new Error("getBlockTime: slot must be a non-negative integer");
      }
      // Returns number | null
      const result = await rpc<number | null>("getBlockTime", [slot], signal);
      if (result === null) return null;
      if (!Number.isInteger(result) || result <= 0) {
        // Some RPCs return null instead of throwing for ancient slots. Normalize invalids to null.
        return null;
      }
      return result;
    },

    async getSignatureStatus(sig, signal) {
      if (typeof sig !== "string" || sig.length < 20) {
        throw new Error("getSignatureStatus: invalid signature");
      }
      type StatusResp = {
        value: Array<
          | null
          | {
              confirmations: number | null;
              confirmationStatus?: Finality;
              err: unknown | null;
              slot: number;
            }
        >;
      };
      const result = await rpc<StatusResp>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }], signal);

      const entry = Array.isArray(result?.value) ? result.value[0] : null;
      if (!entry) return null;

      // Prefer confirmationStatus if present. Older nodes may not return it; infer conservatively.
      const status = (entry as any).confirmationStatus as Finality | undefined;
      if (status === "finalized" || status === "confirmed" || status =
