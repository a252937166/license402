import type { Request } from "express";
import { sha256Hex } from "../domain/index.js";
import { parseUsdtToMicro } from "../license/money.js";
import type { PaymentAdapter, SettleOutcome, SettleStatus, VerifiedPayment } from "./adapter.js";
import type { AppConfig } from "../config.js";

/**
 * Live OKX x402 adapter. Security-critical rule (spec v4 §0.1, verified from SDK
 * source): the middleware treats settle status "pending" as a releasable success,
 * so we set syncSettle:true and additionally gate license activation on
 * status === "success" ourselves. "pending"/"timeout"/errors never activate here;
 * a reconciler polls GET /settle/status.
 *
 * The exact payment-header wire format is finalized against a real buyer request
 * when the buyer wallet is funded; the settlement-status gate below is the part
 * that must be correct regardless, and it is.
 */
export class LivePaymentAdapter implements PaymentAdapter {
  readonly mode = "live" as const;
  private facilitator: unknown;

  constructor(private readonly config: AppConfig) {
    if (!config.okx) throw new Error("Live payment requires OKX credentials");
  }

  private async facilitatorClient(): Promise<{
    verify: (payload: unknown, req: unknown) => Promise<{ isValid: boolean; payer?: string; invalidReason?: string }>;
    settle: (payload: unknown, req: unknown) => Promise<{ success: boolean; status?: string; transaction: string; payer?: string; errorReason?: string }>;
    getSettleStatus: (txHash: string) => Promise<{ success: boolean; status?: string; transaction?: string; errorReason?: string }>;
  }> {
    if (!this.facilitator) {
      const { OKXFacilitatorClient } = await import("@okxweb3/x402-core");
      this.facilitator = new OKXFacilitatorClient({
        apiKey: this.config.okx!.apiKey,
        secretKey: this.config.okx!.secretKey,
        passphrase: this.config.okx!.passphrase,
        syncSettle: true
      });
    }
    return this.facilitator as never;
  }

  private requirements(): Record<string, unknown> {
    const priceMicro = parseUsdtToMicro(this.config.priceUsd.replace(/^\$/, ""));
    return {
      scheme: "exact",
      network: this.config.network,
      asset: process.env.X402_ASSET ?? "",
      amount: String(priceMicro),
      payTo: this.config.payToAddress,
      maxTimeoutSeconds: 120,
      extra: {}
    };
  }

  challenge(priceUsd: string, network: string, payTo: string): { status: 402; headers: Record<string, string>; body: unknown } {
    const body = { x402Version: 1, accepts: [{ scheme: "exact", network, payTo, price: priceUsd }] };
    return { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64") }, body };
  }

  async verify(req: Request): Promise<VerifiedPayment | null> {
    const header = req.header("payment-signature") || req.header("x-payment") || req.header("payment");
    if (!header) return null; // no payment attached → 402 challenge
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      console.warn("[x402] verify: unparseable payment header");
      return null;
    }
    // Facilitator verify recovers the payer WITHOUT moving funds. Doing it here —
    // before prepareDelivery — is what lets the payer==buyer==licensee binding be
    // checked before a credential is issued or settlement is attempted (fixes the
    // former empty-payer bug where prepareDelivery always failed PAYER_MISMATCH).
    try {
      const client = await this.facilitatorClient();
      const v = await client.verify(payload, this.requirements());
      if (!v.isValid || !v.payer) {
        console.warn("[x402] verify rejected:", v.invalidReason ?? "no payer returned");
        return null;
      }
      return {
        verifiedPayer: v.payer.toLowerCase(),
        buyerPaymentId: sha256Hex(header).slice(2, 34),
        paymentAuthorizationDigest: sha256Hex(header),
        paymentHeaderRaw: header
      };
    } catch (e) {
      console.warn("[x402] verify error:", (e as Error).message);
      return null;
    }
  }

  async settle(payment: VerifiedPayment): Promise<SettleOutcome> {
    const client = await this.facilitatorClient();
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(payment.paymentHeaderRaw, "base64").toString("utf8"));
    } catch {
      return { status: "failed", detail: "unparseable payment payload" };
    }

    // The payment was already verified in verify(); settle broadcasts the transfer.
    // syncSettle:true means the facilitator may return status "pending" (it trusts
    // the seller and releases) — we gate activation on status==="success" ourselves
    // and route pending/timeout to the reconciler (getSettleStatus).
    const settled = await client.settle(payload, this.requirements());
    if (settled.payer) payment.verifiedPayer = settled.payer.toLowerCase();

    if (settled.success && settled.status === "success") return { status: "success", tx: settled.transaction };
    if (settled.status === "pending") return { status: "pending", tx: settled.transaction };
    if (settled.status === "timeout") return { status: "timeout", tx: settled.transaction, detail: "settlement timeout" };
    return { status: "failed", detail: settled.errorReason ?? "settle failed" };
  }

  async settleStatus(txHash: string): Promise<SettleStatus> {
    const client = await this.facilitatorClient();
    const r = await client.getSettleStatus(txHash);
    const status =
      r.status === "success" ? "success" : r.status === "failed" ? "failed" : r.status === "pending" ? "pending" : "unknown";
    return { status, transaction: r.transaction, detail: r.errorReason };
  }
}
