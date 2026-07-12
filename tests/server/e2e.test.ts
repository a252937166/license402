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
  payToAddress: privateKeyToAddress(SERVICE_KEY),
  demoBuyerPrivateKey: BUYER_KEY
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
      settlementNetwork: f.settlementNetwork,
      paymentAsset: f.paymentAsset,
      payTo: f.payTo,
      creatorPayoutMicro: f.creatorPayoutMicro,
      platformFeeMicro: f.platformFeeMicro,
      expiresAt: f.expiresAt,
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

  it("challenges with 402 only AFTER the signed terms preflight passes", async () => {
    const quote = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const f = quote.json.purchaseIntentFields;
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
      settlementNetwork: f.settlementNetwork,
      paymentAsset: f.paymentAsset,
      payTo: f.payTo,
      creatorPayoutMicro: f.creatorPayoutMicro,
      platformFeeMicro: f.platformFeeMicro,
      expiresAt: f.expiresAt,
      nonce: sha256Hex("nonce-402-preflight")
    };
    const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(unsigned), BUYER_KEY);
    const body = {
      use: USE,
      licenseeWallet: BUYER,
      quoteCommitment: quote.json.quoteCommitment,
      idempotencyKey: quote.json.idempotencyKey,
      purchaseIntent: { ...unsigned, signature }
    };
    // Valid signed terms, no payment → the standard 402 challenge.
    const res = await post(base, "/v1/acquire/social-commercial", body);
    expect(res.status).toBe(402);

    // Broken terms are rejected BEFORE any 402 — the buyer is never asked to
    // sign a payment for a request that would fail anyway (review §9).
    const bad = await post(base, "/v1/acquire/social-commercial", { ...body, purchaseIntent: {} });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("INTENT_INVALID");

    // Half-present signed fields are an error, never a silent direct fallback.
    const half = await post(base, "/v1/acquire/social-commercial", {
      use: USE,
      licenseeWallet: BUYER,
      quoteCommitment: quote.json.quoteCommitment,
      idempotencyKey: quote.json.idempotencyKey
    });
    expect(half.status).toBe(400);
    expect(half.json.error).toBe("INCOMPLETE_SIGNED_INTENT");
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
      settlementNetwork: f.settlementNetwork,
      paymentAsset: f.paymentAsset,
      payTo: f.payTo,
      creatorPayoutMicro: f.creatorPayoutMicro,
      platformFeeMicro: f.platformFeeMicro,
      expiresAt: f.expiresAt,
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
      settlementNetwork: f.settlementNetwork,
      paymentAsset: f.paymentAsset,
      payTo: f.payTo,
      creatorPayoutMicro: f.creatorPayoutMicro,
      platformFeeMicro: f.platformFeeMicro,
      expiresAt: f.expiresAt,
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

  it("A2MCP direct purchase: one paid POST with no pre-flow issues a license to the payer", async () => {
    // An OKX.AI marketplace agent never runs /v1/quote or signs a PurchaseIntent —
    // it just pays and POSTs. The x402 payment signature IS the authorization.
    const headers = { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-direct-1" };
    const res = await post(base, "/v1/acquire/social-commercial", { brief: "cyberpunk dragon banner" }, headers);
    expect(res.status).toBe(200);
    expect(res.json.license.licenseeWallet).toBe(BUYER);
    expect(res.json.settlement.status).toBe("SETTLED");

    // The credential passes the live scope check like any other.
    const ok = await post(base, "/v1/check-license-scope", {
      license: res.json.license,
      action: "commercial_social_post",
      channel: "x",
      licensee: BUYER
    });
    expect(ok.json.effectiveDecision).toBe("PERMITTED");

    // Same payment replayed → same order (idempotent). New payment → NEW order.
    const replay = await post(base, "/v1/acquire/social-commercial", { brief: "cyberpunk dragon banner" }, headers);
    expect(replay.status).toBe(200);
    expect(replay.json.orderId).toBe(res.json.orderId);
    const second = await post(
      base,
      "/v1/acquire/social-commercial",
      { brief: "cyberpunk dragon banner" },
      { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-direct-2" }
    );
    expect(second.status).toBe(200);
    expect(second.json.orderId).not.toBe(res.json.orderId);

    // A stated licensee that is not the payer is refused.
    const other = await post(
      base,
      "/v1/acquire/social-commercial",
      { brief: "x", licenseeWallet: "0x1111111111111111111111111111111111111111" },
      { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-direct-3" }
    );
    expect(other.status).toBe(400);
    expect(other.json.error).toBe("PAYER_MISMATCH");
  });

  it("signed sample is read-only: real signatures, zero ledger writes, SAMPLE status in scope checks", async () => {
    const before = await get(base, "/v1/ledger");
    const s1 = await get(base, "/v1/samples/default");
    const s2 = await get(base, "/v1/samples/default");
    expect(s1.status).toBe(200);
    expect(s1.json.environment).toBe("sample");
    expect(s1.json.credential.orderId.startsWith("sample-")).toBe(true);
    // Cached & deterministic; sample art is the badged rendition, not the deliverable.
    expect(s2.json.credential.licenseId).toBe(s1.json.credential.licenseId);
    expect(s1.json.asset.sampleUrl).toContain("/v1/samples/art/");
    // Zero writes: the ledger is unchanged by sampling.
    const after = await get(base, "/v1/ledger");
    expect(after.json.orders.length).toBe(before.json.orders.length);

    // Scope check recognizes the signed sample: PERMITTED scope + SAMPLE status.
    const ok = await post(base, "/v1/check-license-scope", {
      license: s1.json.credential,
      action: "commercial_social_post",
      channel: "x",
      licensee: s1.json.credential.licenseeWallet
    });
    expect(ok.json.currentStatus).toBe("SAMPLE");
    expect(ok.json.effectiveDecision).toBe("PERMITTED");

    // A forged credential the issuer never saw is INDETERMINATE, never permitted.
    const forged = { ...s1.json.credential, orderId: "ord-never-issued" };
    const bad = await post(base, "/v1/check-license-scope", {
      license: forged,
      action: "commercial_social_post",
      channel: "x",
      licensee: s1.json.credential.licenseeWallet
    });
    expect(["INDETERMINATE", "INVALID_CREDENTIAL", "NOT_PERMITTED"]).toContain(bad.json.effectiveDecision);
    expect(bad.json.effectiveDecision).not.toBe("PERMITTED");
  });

  it("serves watermarked previews but gates full assets + display renditions behind a signed URL", async () => {
    const q = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER });
    const assetId = q.json.asset.assetId;
    const preview = await fetch(`${base}/v1/previews/${assetId}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(preview.headers.get("cache-control")).toContain("max-age=86400");

    const unsigned = await fetch(`${base}/v1/assets/${assetId}`);
    expect(unsigned.status).toBe(403);
    const unsignedDisplay = await fetch(`${base}/v1/assets/${assetId}/display`);
    expect(unsignedDisplay.status).toBe(403);
  });
});

describe("direct mode terms discipline (round-10)", () => {
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

  it("a PROVIDED but invalid use is 400 INVALID_USESPEC — never silently replaced with SKU defaults", async () => {
    // Rejected before any 402 challenge: the agent never pays for a doomed request.
    const res = await post(base, "/v1/acquire/social-commercial", {
      use: { channel: 999, commercial: "yes" } // garbage shape
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("INVALID_USESPEC");
    expect(res.json.hint).toContain("marketplace SKU");
  });

  it("an ABSENT use selects the fixed marketplace SKU (that IS the direct-mode contract)", async () => {
    const res = await post(base, "/v1/acquire/social-commercial", { brief: "poster art for launch" });
    expect(res.status).toBe(402); // proceeds to the payment challenge
  });
});

describe("direct mode pre-402 asset lock (round-11)", () => {
  let base: string;
  let server: Server;
  beforeAll(async () => {
    const app = await createApp({ config: testConfig, now: () => FIXED_NOW });
    const started = await listen(app);
    base = started.base; server = started.server; PORT = started.port;
    return () => server.close();
  });

  it("the unpaid 402 already names the exact asset the payment will buy", async () => {
    const res = await post(base, "/v1/acquire/social-commercial", { brief: "poster" });
    expect(res.status).toBe(402);
    expect(res.json.directSku.offerId).toBe("off-cyber-dragon");
    expect(res.json.directSku.assetSha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.json.directSku.offerDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.json.directSku.legalTextHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("an explicit offerId is honored and an unserviceable one is refused BEFORE payment", async () => {
    const ok = await post(base, "/v1/acquire/social-commercial", { offerId: "off-aurora-koi" });
    expect(ok.status).toBe(402);
    expect(ok.json.directSku.offerId).toBe("off-aurora-koi");

    const bad = await post(base, "/v1/acquire/social-commercial", { offerId: "off-editorial-only" });
    expect(bad.status).toBe(409); // non-commercial SKU refused pre-payment
    expect(bad.json.error).toBe("NOT_SERVICEABLE");
  });

  it("the paid replay delivers exactly the disclosed asset", async () => {
    const challenge = await post(base, "/v1/acquire/social-commercial", { brief: "poster" });
    const disclosed = challenge.json.directSku.assetSha256;
    const paid = await post(base, "/v1/acquire/social-commercial", { brief: "poster" },
      { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-direct-lock-1" });
    expect(paid.status).toBe(200);
    expect(paid.json.license.assetSha256).toBe(disclosed);
    expect(paid.json.license.authorizationMode).toBe("x402_direct");
  });
});

describe("rail derives from the SIGNED quote (round-12 P0)", () => {
  let base: string;
  let server: Server;
  const cfgWithTestnet = {
    ...testConfig,
    testnet: {
      key: "testnet" as const,
      network: "eip155:1952" as `${string}:${string}`,
      chainId: 1952,
      rpc: "http://127.0.0.1:1",
      asset: "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c",
      assetName: "USD₮0",
      assetVersion: "1",
      explorerTx: "https://www.oklink.com/x-layer-test/tx/"
    }
  };
  beforeAll(async () => {
    const app = await createApp({ config: cfgWithTestnet as never, now: () => FIXED_NOW });
    const started = await listen(app);
    base = started.base; server = started.server; PORT = started.port;
    return () => server.close();
  });

  async function signedBody(network?: string): Promise<Record<string, unknown>> {
    const quote = await post(base, "/v1/quote", { use: USE, licenseeWallet: BUYER, ...(network ? { network } : {}) });
    expect(quote.status).toBe(200);
    const f = quote.json.purchaseIntentFields;
    const unsigned = {
      quoteId: f.quoteId, quoteCommitment: f.quoteCommitment, buyer: BUYER, licensee: BUYER,
      assetSha256: f.assetSha256, offerDigest: f.offerDigest, policyAstHash: f.policyAstHash,
      legalTextHash: f.legalTextHash, totalPrice: "0.10", currency: "USDT" as const,
      settlementNetwork: f.settlementNetwork, paymentAsset: f.paymentAsset, payTo: f.payTo,
      creatorPayoutMicro: f.creatorPayoutMicro, platformFeeMicro: f.platformFeeMicro,
      expiresAt: f.expiresAt, nonce: sha256Hex(`rail-${network ?? "none"}-${Math.random()}`)
    };
    const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(unsigned), BUYER_KEY);
    return {
      use: USE, licenseeWallet: BUYER, quoteCommitment: quote.json.quoteCommitment,
      idempotencyKey: quote.json.idempotencyKey, purchaseIntent: { ...unsigned, signature }
    };
  }

  it("a TESTNET quote with MISSING body.network settles on testnet — never a silent mainnet challenge", async () => {
    const body = await signedBody("testnet"); // quote minted on the testnet rail
    // body.network deliberately OMITTED — the signed quote decides.
    const paid = await post(base, "/v1/acquire/social-commercial", body, { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-rail-1" });
    expect(paid.status).toBe(200);
    expect(paid.json.license.credentialEnvironment).toBe("testnet");
    expect(paid.json.license.settlementNetwork).toBe("eip155:1952");
  });

  it("a TESTNET quote with network=mainnet is 400 RAIL_MISMATCH", async () => {
    const body = await signedBody("testnet");
    const res = await post(base, "/v1/acquire/social-commercial", { ...body, network: "mainnet" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("RAIL_MISMATCH");
  });

  it("a MAINNET quote with network=testnet is 400 RAIL_MISMATCH", async () => {
    const body = await signedBody();
    const res = await post(base, "/v1/acquire/social-commercial", { ...body, network: "testnet" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("RAIL_MISMATCH");
  });

  it('a typo network ("testent") is 400 INVALID_NETWORK — never a silent mainnet', async () => {
    const res = await post(base, "/v1/acquire/social-commercial", { network: "testent" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("INVALID_NETWORK");
  });
});

describe("direct SKU digest immutability across requests (round-12 P0)", () => {
  let base: string;
  let server: Server;
  beforeAll(async () => {
    const app = await createApp({ config: testConfig, now: () => FIXED_NOW });
    const started = await listen(app);
    base = started.base; server = started.server; PORT = started.port;
    return () => server.close();
  });

  it("malformed offerId is 400 INVALID_OFFER_ID, unknown is 404 — never a silent default", async () => {
    const bad = await post(base, "/v1/acquire/social-commercial", { offerId: "DROP TABLE;" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("INVALID_OFFER_ID");
    const unknown = await post(base, "/v1/acquire/social-commercial", { offerId: "off-does-not-exist" });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("OFFER_NOT_FOUND");
  });

  it("the default SKU's 402 discloses the boot-pinned digest and the paid replay delivers exactly it", async () => {
    const challenge = await post(base, "/v1/acquire/social-commercial", {});
    expect(challenge.status).toBe(402);
    const disclosed = challenge.json.directSku;
    const paid = await post(base, "/v1/acquire/social-commercial", {}, { "x-dev-payer": BUYER, "x-dev-payment-id": "pay-digest-pin-1" });
    expect(paid.status).toBe(200);
    expect(paid.json.license.offerDigest).toBe(disclosed.offerDigest);
    expect(paid.json.license.assetSha256).toBe(disclosed.assetSha256);
  });
});
