import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { LivePaymentAdapter } from "../../src/server/payment/live.js";
import type { AppConfig } from "../../src/server/config.js";

/**
 * Regression for the OKX review failure: a payment VERIFIED at a companion-SKU
 * price (0.02 audit) must be SETTLED against the same requirements. The first
 * implementation parametrized challenge/verify but settled with the default
 * sale-price requirements — the facilitator rejected the amount mismatch and
 * every audit call died with SETTLEMENT_FAILED.
 */
const CONFIG = {
  paymentMode: "live",
  network: "eip155:196",
  priceUsd: "$0.10",
  payToAddress: "0x0553355bc8e25f1bcb28a2d1f23f9c9dd9a1d1f0",
  okx: { apiKey: "k", secretKey: "s", passphrase: "p" }
} as unknown as AppConfig;

function fakeReq(headers: Record<string, string>): Request {
  return { header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

describe("per-service x402 pricing — verify and settle use the SAME amount", () => {
  it("settle inherits the verified amount (0.02 audit), not the default sale price", async () => {
    const adapter = new LivePaymentAdapter(CONFIG);
    const seen: { verifyAmount?: string; settleAmount?: string } = {};

    (adapter as never as { codecs: unknown }).codecs = {
      decodePaymentSignatureHeader: () => ({ mock: true }),
      encodePaymentResponseHeader: () => "resp-header"
    };
    (adapter as never as { facilitator: unknown }).facilitator = {
      verify: async (_p: unknown, req: { amount: string }) => {
        seen.verifyAmount = req.amount;
        return { isValid: true, payer: "0xAbCd00000000000000000000000000000000dEaD" };
      },
      settle: async (_p: unknown, req: { amount: string }) => {
        seen.settleAmount = req.amount;
        return { success: true, status: "success", transaction: "0xtx" };
      }
    };

    const verified = await adapter.verify(fakeReq({ "payment-signature": "sig" }), 20_000);
    expect(verified).not.toBeNull();
    expect(verified!.amountMicro).toBe(20_000);
    expect(seen.verifyAmount).toBe("20000");

    const outcome = await adapter.settle(verified!);
    expect(outcome.status).toBe("success");
    expect(seen.settleAmount).toBe("20000"); // ← the bug returned "100000" here

    // Default-priced flow unchanged: no override → sale price on both legs.
    const seen2: { verifyAmount?: string; settleAmount?: string } = {};
    (adapter as never as { facilitator: unknown }).facilitator = {
      verify: async (_p: unknown, req: { amount: string }) => {
        seen2.verifyAmount = req.amount;
        return { isValid: true, payer: "0xAbCd00000000000000000000000000000000dEaD" };
      },
      settle: async (_p: unknown, req: { amount: string }) => {
        seen2.settleAmount = req.amount;
        return { success: true, status: "success", transaction: "0xtx2" };
      }
    };
    const v2 = await adapter.verify(fakeReq({ "payment-signature": "sig2" }));
    const o2 = await adapter.settle(v2!);
    expect(o2.status).toBe("success");
    expect(seen2.verifyAmount).toBe("100000");
    expect(seen2.settleAmount).toBe("100000");
  });
});
