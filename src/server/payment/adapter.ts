import type { Request } from "express";
import { sha256Hex } from "../domain/index.js";
import { normalizeAddress } from "../license/eip712.js";

/**
 * Payment abstraction so the order lifecycle is identical whether payment is a
 * real OKX x402 settlement (live) or a locally-simulated one (dev/off mode).
 * The dev adapter refuses to run in live mode.
 */

export interface VerifiedPayment {
  verifiedPayer: string;
  buyerPaymentId: string;
  paymentAuthorizationDigest: string;
  paymentHeaderRaw: string;
}

export type SettleOutcome =
  | { status: "success"; tx: string | null }
  | { status: "pending"; tx: string | null }
  | { status: "timeout"; detail: string }
  | { status: "failed"; detail: string };

export interface PaymentAdapter {
  readonly mode: "dev" | "live";
  /** Present a challenge (returns a 402 body/headers) when no valid payment is attached. */
  challenge(priceUsd: string, network: string, payTo: string): { status: 402; headers: Record<string, string>; body: unknown };
  /** Extract & verify the attached payment. Returns null when absent → caller issues a challenge. */
  verify(req: Request): VerifiedPayment | null;
  /** Settle the verified payment on-chain. spec v4: only "success" activates the license. */
  settle(payment: VerifiedPayment): Promise<SettleOutcome>;
}

/**
 * Dev adapter: the buyer attaches `X-Dev-Payer: 0x..` (their wallet) and
 * `X-Dev-Payment-Id: ...`. verify() trusts these; settle() always succeeds with
 * a synthetic tx. This exercises the entire lifecycle offline for tests + demo
 * of internal correctness — it is NEVER a real settlement and is refused in live mode.
 */
export class DevPaymentAdapter implements PaymentAdapter {
  readonly mode = "dev" as const;

  challenge(priceUsd: string, network: string, payTo: string): { status: 402; headers: Record<string, string>; body: unknown } {
    const body = {
      x402Version: 1,
      accepts: [{ scheme: "exact", network, payTo, price: priceUsd }],
      note: "DEV MODE — attach X-Dev-Payer and X-Dev-Payment-Id headers to simulate settlement. Not a real payment."
    };
    return { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64") }, body };
  }

  verify(req: Request): VerifiedPayment | null {
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
