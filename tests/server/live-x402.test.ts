import { describe, expect, it } from "vitest";
import type { Express } from "express";
import type { Request } from "express";
import { createServer, request, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createApp } from "../../src/server/app.js";
import { privateKeyToAddress, purchaseIntentToTypedMessage, signTypedData } from "../../src/server/license/eip712.js";
import { PurchaseIntentSchema } from "../../src/server/license/types.js";
import { sha256Hex } from "../../src/server/domain/index.js";
import type { PaymentAdapter, SettleOutcome, SettleStatus, VerifiedPayment } from "../../src/server/payment/adapter.js";

const ISSUER_KEY = `0x${"33".repeat(32)}`;
const SERVICE_KEY = `0x${"44".repeat(32)}`;
const BUYER_KEY = `0x${"55".repeat(32)}`;
const OTHER_KEY = `0x${"66".repeat(32)}`;
const BUYER = privateKeyToAddress(BUYER_KEY);
const OTHER = privateKeyToAddress(OTHER_KEY);
const FIXED_NOW = 1_783_900_800 + 7200;

const baseConfig = {
  port: 0,
  publicOrigin: "https://license402.test",
  paymentMode: "off" as const,
  network: "eip155:196" as `${string}:${string}`,
  priceUsd: "$0.10",
  dbPath: ":memory:",
  issuerPrivateKey: ISSUER_KEY,
  issuerAddress: privateKeyToAddress(ISSUER_KEY),
  servicePrivateKey: SERVICE_KEY,
  serviceAddress: privateKeyToAddress(SERVICE_KEY),
  payToAddress: privateKeyToAddress(SERVICE_KEY)
};

/**
 * Fake OKX facilitator adapter (mode "live") that exercises the real x402 code
 * path — verify → prepareDelivery → settle → reconcile — with NO network. Its
 * verify() returns a cryptographically-recovered payer just like the live
 * facilitator does, which is exactly the behavior the old empty-payer stub lacked.
 */
class FakeLiveAdapter implements PaymentAdapter {
  readonly mode = "live" as const;
  payer = BUYER;
  settleResult: SettleOutcome = { status: "success", tx: "0xsettledtx" };
  statusResult: SettleStatus = { status: "success", transaction: "0xpendingtx" };

  challenge(priceUsd: string, network: string, payTo: string) {
    return {
      status: 402 as const,
      headers: {},
      body: { x402Version: 1, accepts: [{ scheme: "exact", network, payTo, price: priceUsd }] }
    };
  }
  async verify(req: Request): Promise<VerifiedPayment | null> {
    const header = req.header("x-payment");
    if (!header) return null;
    return {
      verifiedPayer: this.payer.toLowerCase(),
      buyerPaymentId: `fake-${sha256Hex(header).slice(2, 14)}`,
      paymentAuthorizationDigest: sha256Hex(`auth-${header}`),
      paymentHeaderRaw: header
    };
  }
  async settle(_payment: VerifiedPayment): Promise<SettleOutcome> {
    return this.settleResult;
  }
  async settleStatus(_txHash: string): Promise<SettleStatus> {
    return this.statusResult;
  }
}

async function boot(payment: PaymentAdapter): Promise<{ base: string; port: number; server: Server }> {
  const app: Express = await createApp({ config: baseConfig, now: () => FIXED_NOW, payment });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, server };
}

function http(port: number, method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const USE = {
  brief: "cyberpunk dragon on a dark background",
  channel: "x",
  commercial: true,
  durationDays: 14,
  territory: "worldwide",
  transformations: ["crop", "overlay_text"],
  maxBudget: "0.10"
};

/** Quote → sign intent → POST acquire with an x402 payment header (buyer == licensee). */
async function acquire(port: number, buyerKey: string, buyer: string): Promise<{ status: number; json: any; orderId?: string }> {
  const quote = await http(port, "POST", "/v1/quote", { use: USE, licenseeWallet: buyer });
  expect(quote.json.serviceable).toBe(true);
  const f = quote.json.purchaseIntentFields;
  const intentUnsigned = {
    quoteId: f.quoteId,
    quoteCommitment: f.quoteCommitment,
    buyer,
    licensee: buyer,
    assetSha256: f.assetSha256,
    offerDigest: f.offerDigest,
    policyAstHash: f.policyAstHash,
    legalTextHash: f.legalTextHash,
    totalPrice: "0.10",
    currency: "USDT" as const,
    expiresAt: FIXED_NOW + 900,
    nonce: sha256Hex(`nonce-${buyer}`)
  };
  const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(intentUnsigned), buyerKey);
  const intent = PurchaseIntentSchema.parse({ ...intentUnsigned, signature });
  const paymentHeader = Buffer.from(JSON.stringify({ scheme: "exact", payer: buyer })).toString("base64");
  const res = await http(
    port,
    "POST",
    "/v1/acquire/social-commercial",
    { use: USE, licenseeWallet: buyer, quoteCommitment: quote.json.quoteCommitment, idempotencyKey: quote.json.idempotencyKey, purchaseIntent: intent },
    { "x-payment": paymentHeader }
  );
  return { ...res, orderId: res.json?.orderId };
}

describe("live x402 correctness (P0-1 payer binding, P0-5 reconciler)", () => {
  it("P0-1: a facilitator-verified payer flows into prepareDelivery and the license issues (immediate success)", async () => {
    const adapter = new FakeLiveAdapter();
    adapter.settleResult = { status: "success", tx: "0xsuccesstx" };
    const { port, server } = await boot(adapter);
    try {
      const res = await acquire(port, BUYER_KEY, BUYER);
      expect(res.status).toBe(200);
      expect(res.json.license.licenseeWallet).toBe(BUYER);
      expect(res.json.settlement).toEqual({ status: "SETTLED", buyerTx: "0xsuccesstx" });
      // The license is active and the scope engine will honor it.
      const order = await http(port, "GET", `/v1/orders/${res.orderId}`, undefined);
      expect(["LICENSE_ACTIVE", "CREATOR_PAYOUT_PENDING", "CREATOR_PAID"]).toContain(order.json.status);
    } finally {
      server.close();
    }
  });

  it("P0-1: a payer that is not the licensee is rejected (binding is enforced, not bypassed)", async () => {
    const adapter = new FakeLiveAdapter();
    adapter.payer = OTHER; // facilitator says a different wallet paid
    const { port, server } = await boot(adapter);
    try {
      const res = await acquire(port, BUYER_KEY, BUYER);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("PAYER_MISMATCH");
    } finally {
      server.close();
    }
  });

  it("P0-5: a pending settlement is held, then the reconciler activates it on success", async () => {
    const adapter = new FakeLiveAdapter();
    adapter.settleResult = { status: "pending", tx: "0xpendingtx" };
    adapter.statusResult = { status: "success", transaction: "0xpendingtx" };
    const { port, server } = await boot(adapter);
    try {
      const res = await acquire(port, BUYER_KEY, BUYER);
      expect(res.status).toBe(202);
      expect(res.json.settlement.status).toBe("PENDING");

      // Held: license issued but NOT yet active before reconciliation.
      const pending = await http(port, "GET", `/v1/orders/${res.orderId}`, undefined);
      expect(pending.json.status).toBe("SETTLEMENT_PENDING");

      // Reconcile → poll returns success → activate + drain payout.
      const rec = await http(port, "POST", "/internal/reconcile", {});
      expect(rec.status).toBe(200);
      expect(rec.json.settled.activated).toBe(1);

      const done = await http(port, "GET", `/v1/orders/${res.orderId}`, undefined);
      expect(["LICENSE_ACTIVE", "CREATOR_PAYOUT_PENDING", "CREATOR_PAID"]).toContain(done.json.status);
    } finally {
      server.close();
    }
  });

  it("P0-5: a pending settlement the facilitator later reports failed is voided, not activated", async () => {
    const adapter = new FakeLiveAdapter();
    adapter.settleResult = { status: "pending", tx: "0xpendingtx2" };
    adapter.statusResult = { status: "failed", detail: "insufficient funds", transaction: "0xpendingtx2" };
    const { port, server } = await boot(adapter);
    try {
      const res = await acquire(port, BUYER_KEY, BUYER);
      expect(res.status).toBe(202);
      const rec = await http(port, "POST", "/internal/reconcile", {});
      expect(rec.json.settled.failed).toBe(1);
      const done = await http(port, "GET", `/v1/orders/${res.orderId}`, undefined);
      expect(done.json.status).toBe("SETTLEMENT_FAILED");
    } finally {
      server.close();
    }
  });
});
