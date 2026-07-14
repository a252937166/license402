import type { Request } from "express";
import { sha256Hex } from "../domain/index.js";
import { normalizeAddress } from "../license/eip712.js";

/**
 * Payment abstraction so the order lifecycle is identical whether payment is a
 * real OKX x402 settlement (live) or a locally-simulated one (dev/off mode).
 * The dev adapter refuses to run in live mode.
 */

export interface VerifiedPayment {
  /** The amount (micro-USDT) this payment was VERIFIED against — settle must
   *  use the SAME requirements or the facilitator rejects the mismatch. */
  amountMicro?: number;
  verifiedPayer: string;
  buyerPaymentId: string;
  paymentAuthorizationDigest: string;
  paymentHeaderRaw: string;
}

export interface Challenge {
  status: 402;
  headers: Record<string, string>;
  body: unknown;
}

export type SettleOutcome =
  | { status: "success"; tx: string | null; responseHeader?: string }
  | { status: "pending"; tx: string | null }
  | { status: "timeout"; tx: string | null; detail: string }
  | { status: "failed"; detail: string };

/** Result of polling GET /settle/status for a previously-broadcast settlement. */
export interface SettleStatus {
  status: "pending" | "success" | "failed" | "unknown";
  transaction?: string;
  detail?: string;
}

export interface PaymentAdapter {
  readonly mode: "dev" | "live";
  /**
   * Present a standard x402 v2 challenge (PaymentRequired body + PAYMENT-REQUIRED
   * header) when no valid payment is attached. resourceUrl identifies the
   * protected resource in the challenge.
   */
  challenge(resourceUrl: string, opts?: { amountMicro?: number; description?: string }): Promise<Challenge>;
  /**
   * Extract & verify the attached payment WITHOUT moving funds. Returns null when
   * absent or invalid → caller issues a 402 challenge. For live x402 this calls the
   * facilitator's verify endpoint, which returns the cryptographically-recovered
   * payer; the payer is known here, before any credential is issued or funds move.
   */
  verify(req: Request, amountMicro?: number): Promise<VerifiedPayment | null>;
  /**
   * Settle the verified payment on-chain. spec v4: only "success" activates the
   * license. On success the outcome carries the encoded PAYMENT-RESPONSE header.
   */
  settle(payment: VerifiedPayment): Promise<SettleOutcome>;
  /**
   * Poll settlement status by tx hash (live only). Used by the reconciler to
   * finalize orders that settle() left "pending"/"timeout". Absent in dev mode.
   */
  settleStatus?(txHash: string): Promise<SettleStatus>;
}

/**
 * Dev adapter: the buyer attaches `X-Dev-Payer: 0x..` (their wallet) and
 * `X-Dev-Payment-Id: ...`. verify() trusts these; settle() always succeeds with
 * a synthetic tx. This exercises the entire lifecycle offline for tests + demo
 * of internal correctness — it is NEVER a real settlement and is refused in live mode.
 */
export class DevPaymentAdapter implements PaymentAdapter {
  readonly mode = "dev" as const;

  async challenge(resourceUrl: string, opts?: { amountMicro?: number; description?: string }): Promise<Challenge> {
    // Same v2 PaymentRequired shape as live so clients exercise one format; the
    // note makes the simulation explicit.
    const body = {
      x402Version: 2,
      resource: { url: resourceUrl, description: opts?.description ?? "LICENSE402 (dev mode — simulated settlement)", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:196",
          asset: process.env.X402_ASSET ?? "0x0000000000000000000000000000000000000000",
          amount: String(opts?.amountMicro ?? 100000),
          payTo: "0x0000000000000000000000000000000000000000",
          maxTimeoutSeconds: 120,
          extra: { note: "DEV MODE — attach X-Dev-Payer and X-Dev-Payment-Id headers to simulate settlement. Not a real payment." }
        }
      ],
      error: "payment required"
    };
    return { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64") }, body };
  }

  async verify(req: Request): Promise<VerifiedPayment | null> {
    const payer = req.header("x-dev-payer");
    const paymentId = req.header("x-dev-payment-id");
    if (!payer || !paymentId) return null;
    let normalized: string;
    try {
      normalized = normalizeAddress(payer);
    } catch {
      return null;
    }
    const raw = `dev:${normalized}:${paymentId}`;
    return {
      verifiedPayer: normalized,
      buyerPaymentId: paymentId,
      paymentAuthorizationDigest: sha256Hex(raw),
      paymentHeaderRaw: raw
    };
  }

  async settle(payment: VerifiedPayment): Promise<SettleOutcome> {
    return { status: "success", tx: `0xdev${payment.buyerPaymentId.replace(/[^0-9a-fA-F]/g, "").slice(0, 60).padEnd(60, "0")}` };
  }
}
