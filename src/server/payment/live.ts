import type { Request } from "express";
import { sha256Hex } from "../domain/index.js";
import { parseUsdtToMicro } from "../license/money.js";
import type { PaymentAdapter, SettleOutcome, VerifiedPayment } from "./adapter.js";
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
    getSettleStatus: (txHash: string) => Promise<{ success: boolean; status?: string; transaction?: string }>;
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

  verify(req: Request): VerifiedPayment | null {
    const header = req.header("payment-signature") || req.header("x-payment");
    if (!header) return null;
    // The payment-signature header is base64 JSON (parsed fully at settle time).
    return {
      verifiedPayer: "",
      buyerPaymentId: sha256Hex(header).slice(2, 34),
      paymentAuthorizationDigest: sha256Hex(header),
      paymentHeaderRaw: header
    };
  }

  async settle(payment: VerifiedPayment): Promise<SettleOutcome> {
    const client = await this.facilitatorClient();
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(payment.paymentHeaderRaw, "base64").toString("utf8"));
    } catch {
      return { status: "failed", detail: "unparseable payment payload" };
    }
    const requirements = this.requirements();

    const verified = await client.verify(payload, requirements);
    if (!verified.isValid) return { status: "failed", detail: verified.invalidReason ?? "verify failed" };
    if (verified.payer) payment.verifiedPayer = verified.payer.toLowerCase();

    const settled = await client.settle(payload, requirements);
    if (settled.payer) payment.verifiedPayer = settled.payer.toLowerCase();

    // ONLY success activates. pending/timeout/failure go to reconciliation.
    if (settled.success && settled.status === "success") return { status: "success", tx: settled.transaction };
    if (settled.status === "pending") return { status: "pending", tx: settled.transaction };
    if (settled.status === "timeout") return { status: "timeout", detail: "settlement timeout" };
    return { status: "failed", detail: settled.errorReason ?? "settle failed" };
  }
}
