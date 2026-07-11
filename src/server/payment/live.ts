import type { Request } from "express";
import { sha256Hex } from "../domain/index.js";
import { parseUsdtToMicro } from "../license/money.js";
import type { Challenge, PaymentAdapter, SettleOutcome, SettleStatus, VerifiedPayment } from "./adapter.js";
import type { AppConfig, NetworkProfile } from "../config.js";
import { mainnetProfile } from "../config.js";

/**
 * Live OKX x402 adapter — standard x402 v2 wire format end-to-end:
 *
 *   402 challenge   = official PaymentRequired shape + PAYMENT-REQUIRED header
 *                     (encodePaymentRequiredHeader)
 *   payment header  = PAYMENT-SIGNATURE, decoded with decodePaymentSignatureHeader
 *   verify          = facilitator /verify — recovers the payer WITHOUT moving funds,
 *                     before prepareDelivery (payer==buyer==licensee binding)
 *   settle          = facilitator /settle with syncSettle:true; ONLY status==="success"
 *                     activates; pending/timeout carry the tx to the reconciler
 *   success reply   = PAYMENT-RESPONSE header (encodePaymentResponseHeader)
 *
 * Wire format proven against the real facilitator on 2026-07-11:
 * getSupported lists (exact, eip155:196, v2); a real EIP-3009 authorization for
 * USDT0 (domain name "USD₮0", version "1") verified with isValid:true and the
 * exact payer recovered (scripts/x402-selftest.ts).
 */
export class LivePaymentAdapter implements PaymentAdapter {
  readonly mode = "live" as const;
  private facilitator: unknown;
  private codecs:
    | {
        decodePaymentSignatureHeader: (h: string) => Record<string, unknown>;
        encodePaymentRequiredHeader: (pr: unknown) => string;
        encodePaymentResponseHeader: (sr: unknown) => string;
      }
    | undefined;
  private readonly profile: NetworkProfile;

  constructor(
    private readonly config: AppConfig,
    profile?: NetworkProfile
  ) {
    if (!config.okx) throw new Error("Live payment requires OKX credentials");
    this.profile = profile ?? mainnetProfile(config);
    // Refuse to boot live without the settlement asset — an empty asset string
    // would produce challenges no wallet could pay against. The asset's EIP-712
    // domain (name/version) is verified on-chain for both rails:
    //   mainnet 196:  USD₮0/1 @ 0x779d…3736
    //   testnet 1952: USD₮0/1 @ 0x9e29…4fb0c (official SDK default asset)
    if (!this.profile.asset) throw new Error("settlement token contract is required in live mode");
  }

  private async facilitatorClient(): Promise<{
    verify: (payload: unknown, req: unknown) => Promise<{ isValid: boolean; payer?: string; invalidReason?: string }>;
    settle: (payload: unknown, req: unknown) => Promise<{ success: boolean; status?: string; transaction: string; payer?: string; errorReason?: string; network?: string }>;
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

  private async httpCodecs() {
    if (!this.codecs) {
      this.codecs = (await import("@okxweb3/x402-core/http")) as never;
    }
    return this.codecs!;
  }

  requirements(): Record<string, unknown> {
    const priceMicro = parseUsdtToMicro(this.config.priceUsd.replace(/^\$/, ""));
    return {
      scheme: "exact",
      network: this.profile.network,
      asset: this.profile.asset,
      amount: String(priceMicro),
      payTo: this.config.payToAddress,
      maxTimeoutSeconds: 120,
      // Required by the official exact-EVM client: EIP-712 domain of the token.
      // Without name/version the wallet-side createPaymentPayload throws.
      extra: { name: this.profile.assetName, version: this.profile.assetVersion }
    };
  }

  async challenge(resourceUrl: string): Promise<Challenge> {
    const { encodePaymentRequiredHeader } = await this.httpCodecs();
    const body = {
      x402Version: 2,
      resource: {
        url: resourceUrl,
        description: "LICENSE402 · social-commercial content license (signed scope credential included)",
        mimeType: "application/json"
      },
      accepts: [this.requirements()],
      error: "payment required"
    };
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) }, body };
  }

  async verify(req: Request): Promise<VerifiedPayment | null> {
    const header = req.header("payment-signature") || req.header("x-payment") || req.header("payment");
    if (!header) return null; // no payment attached → 402 challenge
    let payload: Record<string, unknown>;
    try {
      const { decodePaymentSignatureHeader } = await this.httpCodecs();
      payload = decodePaymentSignatureHeader(header);
    } catch {
      console.warn("[x402] verify: undecodable PAYMENT-SIGNATURE header");
      return null;
    }
    // Facilitator verify recovers the payer WITHOUT moving funds. Doing it here —
    // before prepareDelivery — lets the payer==buyer==licensee binding be checked
    // before a credential is issued or settlement is attempted.
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
    const { decodePaymentSignatureHeader, encodePaymentResponseHeader } = await this.httpCodecs();
    let payload: Record<string, unknown>;
    try {
      payload = decodePaymentSignatureHeader(payment.paymentHeaderRaw);
    } catch {
      return { status: "failed", detail: "undecodable payment payload" };
    }

    // syncSettle:true — the facilitator may still return "pending"/"timeout";
    // we gate activation on status==="success" and reconcile the rest.
    const settled = await client.settle(payload, this.requirements());
    if (settled.payer) payment.verifiedPayer = settled.payer.toLowerCase();

    if (settled.success && settled.status === "success") {
      return { status: "success", tx: settled.transaction, responseHeader: encodePaymentResponseHeader(settled) };
    }
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
