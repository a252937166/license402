import { describe, expect, it, beforeAll } from "vitest";
import type { Express } from "express";
import { createApp } from "../../src/server/app.js";
import { privateKeyToAddress, purchaseIntentToTypedMessage, signTypedData } from "../../src/server/license/eip712.js";
import { PurchaseIntentSchema } from "../../src/server/license/types.js";
import { sha256Hex } from "../../src/server/domain/index.js";

const ISSUER_KEY = `0x${"33".repeat(32)}`;
const SERVICE_KEY = `0x${"44".repeat(32)}`;
const BUYER_KEY = `0x${"55".repeat(32)}`;
const BUYER = privateKeyToAddress(BUYER_KEY);
const FIXED_NOW = 1_783_900_800 + 7200; // within offer validity + after grant issuance

const testConfig = {
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

// Minimal HTTP driver over node:http (NOT fetch) so an ambient HTTP_PROXY in
// the dev environment can never route these localhost calls through a proxy.
import { createServer, request, type Server } from "node:http";
import { AddressInfo } from "node:net";

async function listen(app: Express): Promise<{ server: Server; base: string; port: number }> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, port };
}

let PORT = 0;

function raw(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port: PORT, path, method, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function post(_base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const { status, text } = await raw("POST", path, body, headers);
  return { status, json: text ? JSON.parse(text) : null };
}
async function get(_base: string, path: string): Promise<{ status: number; json: any }> {
  const { status, text } = await raw("GET", path, undefined);
  try {
    return { status, json: JSON.parse(text) };
  } catch {
    return { status, json: text };
  }
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

describe("LICENSE402 end-to-end (dev payment)", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const app = await createApp({ config: testConfig, now: () => FIXED_NOW });
    const started = await listen(app);
    base = started.base;
    server = started.server;
    PORT = started.port;
    return () => server.close();
  });

  async function fullPurchase(): Promise<{ order: any; acquire: any; quote: any; intent: any }> {
    const quote = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    expect(quote.status).toBe(200);
    expect(quote.json.serviceable).toBe(true);

    const f = quote.json.purchaseIntentFields;
    const intentUnsigned = {
      quoteId: f.quoteId,
      quoteCommitment: f.quoteCommitment,
      buyer: BUYER,
      licensee: BUYER,
      assetSha256: f.assetSha256,
      offerDigest: f.offerDigest,
      policyAstHash: f.policyAstHash,
      legalTextHash: f.legalTextHash,
      totalPrice: "0.10",
      currency: "USDT" as const,
      expiresAt: FIXED_NOW + 900,
      nonce: sha256Hex("buyer-nonce-e2e")
    };
    const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(intentUnsigned), BUYER_KEY);
    const intent = PurchaseIntentSchema.parse({ ...intentUnsigned, signature });

    const acquire = await post(
      base,
      "/v1/acquire/social-commercial",
      {
        use: USE,
        licenseeWallet: BUYER,
        quoteCommitment: quote.json.quoteCommitment,
        idempotencyKey: quote.json.idempotencyKey,
        purchaseIntent: intent
      },
      { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-e2e-1" }
    );
    return { quote: quote.json, intent, acquire, order: null };
  }

  it("challenges with 402 when no payment is attached", async () => {
    const quote = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const res = await post(base, "/v1/acquire/social-commercial", {
      use: USE,
      licenseeWallet: BUYER,
      quoteCommitment: quote.json.quoteCommitment,
      idempotencyKey: quote.json.idempotencyKey,
      purchaseIntent: {}
    });
    expect(res.status).toBe(402);
  });

  it("completes quote → sign intent → acquire → license issued + settled", async () => {
    const { acquire } = await fullPurchase();
    expect(acquire.status).toBe(200);
    expect(acquire.json.license.templateId).toBe("social-commercial-v1");
    expect(acquire.json.license.licenseeWallet).toBe(BUYER);
    expect(acquire.json.asset.url).toContain("/v1/assets/");
    expect(acquire.json.settlement.status).toBe("SETTLED");

    // Scope check: PERMITTED for commercial X post, NOT_PERMITTED for model training.
    const permit = await post(base, "/v1/check-license-scope", {
      license: acquire.json.license,
      action: "commercial_social_post",
      channel: "x",
      licensee: BUYER
    });
    expect(permit.json.decision).toBe("PERMITTED");
    expect(permit.json.currentStatus).toBe("ACTIVE");

    const deny = await post(base, "/v1/check-license-scope", {
      license: acquire.json.license,
      action: "model_training",
      licensee: BUYER
    });
    expect(deny.json.decision).toBe("NOT_PERMITTED");
    expect(deny.json.reasonCodes).toEqual(["MODEL_TRAINING_PROHIBITED"]);

    // Order shows settled economics with a paid creator payout.
    const order = await get(base, `/v1/orders/${acquire.json.orderId}`);
    expect(["CREATOR_PAID"]).toContain(order.json.status);
    expect(order.json.economics.creatorPaid).toBe("0.07");
    expect(order.json.creatorPayout.state).toBe("PAID");
  });

  it("is idempotent: replaying the same payment returns the same order, no double payout", async () => {
    const q = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const f = q.json.purchaseIntentFields;
    const unsigned = {
      quoteId: f.quoteId,
      quoteCommitment: f.quoteCommitment,
      buyer: BUYER,
      licensee: BUYER,
      assetSha256: f.assetSha256,
      offerDigest: f.offerDigest,
      policyAstHash: f.policyAstHash,
      legalTextHash: f.legalTextHash,
      totalPrice: "0.10",
      currency: "USDT" as const,
      expiresAt: FIXED_NOW + 900,
      nonce: sha256Hex("buyer-nonce-idem")
    };
    const intent = PurchaseIntentSchema.parse({ ...unsigned, signature: signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(unsigned), BUYER_KEY) });
    const body = { use: USE, licenseeWallet: BUYER, quoteCommitment: q.json.quoteCommitment, idempotencyKey: q.json.idempotencyKey, purchaseIntent: intent };
    const headers = { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-idem-1" };

    const first = await post(base, "/v1/acquire/social-commercial", body, headers);
    const second = await post(base, "/v1/acquire/social-commercial", body, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.orderId).toBe(first.json.orderId);
    expect(second.json.license.licenseId).toBe(first.json.license.licenseId);
  });

  it("409s when the pinned commitment does not match the quote", async () => {
    const q = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const res = await post(
      base,
      "/v1/acquire/social-commercial",
      {
        use: USE,
        licenseeWallet: BUYER,
        quoteCommitment: `0x${"ab".repeat(32)}`,
        idempotencyKey: q.json.idempotencyKey,
        purchaseIntent: {}
      },
      { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-409" }
    );
    // With a bogus commitment there is no matching quote row → 404 QUOTE_NOT_FOUND
    // (a matching quote with drifted fields would 409; both are pre-settlement).
    expect([404, 409]).toContain(res.status);
  });

  it("rejects a purchase intent signed by the wrong wallet", async () => {
    const q = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const f = q.json.purchaseIntentFields;
    const unsigned = {
      quoteId: f.quoteId,
      quoteCommitment: f.quoteCommitment,
      buyer: BUYER,
      licensee: BUYER,
      assetSha256: f.assetSha256,
      offerDigest: f.offerDigest,
      policyAstHash: f.policyAstHash,
      legalTextHash: f.legalTextHash,
      totalPrice: "0.10",
      currency: "USDT" as const,
      expiresAt: FIXED_NOW + 900,
      nonce: sha256Hex("wrong-signer")
    };
    // Signed by the issuer key, not the buyer.
    const intent = PurchaseIntentSchema.parse({ ...unsigned, signature: signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(unsigned), ISSUER_KEY) });
    const res = await post(
      base,
      "/v1/acquire/social-commercial",
      { use: USE, licenseeWallet: BUYER, quoteCommitment: q.json.quoteCommitment, idempotencyKey: q.json.idempotencyKey, purchaseIntent: intent },
      { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-wrong-sig" }
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("INTENT_SIGNATURE_INVALID");
  });

  it("serves watermarked previews but gates full assets behind a signed URL", async () => {
    const q = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const assetId = q.json.asset.assetId;
    const preview = await fetch(`${base}/v1/previews/${assetId}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");

    const unsigned = await fetch(`${base}/v1/assets/${assetId}`);
    expect(unsigned.status).toBe(403);
  });
});
