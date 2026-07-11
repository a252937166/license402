/**
 * FULL live purchase through the real HTTP channel — the exact flow a judge's
 * browser runs, executed with the demo buyer key. Produces the G0 evidence:
 *
 *   POST /v1/quote                        (terms locked)
 *   sign PurchaseIntent                   (EIP-712, buyer key)
 *   POST /v1/acquire… (no payment)        → 402 + standard PaymentRequired
 *   official x402 client builds payload   (EIP-3009, buyer key, zero gas)
 *   POST /v1/acquire… (PAYMENT-SIGNATURE) → 200 + license + PAYMENT-RESPONSE
 *   poll /v1/orders/:id                   → CREATOR_PAID with real payout tx
 *
 * Run ON THE SERVER (live mode): PAYMENT_MODE=live tsx scripts/live-buy-selftest.ts
 * Requires the demo buyer wallet to hold ≥0.10 USDT (fund via the faucet).
 */
import { request } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/server/config.js";
import { sha256Hex } from "../src/server/domain/index.js";
import { privateKeyToAddress, purchaseIntentToTypedMessage, signTypedData } from "../src/server/license/eip712.js";

const config = loadConfig();
const PORT = Number(process.env.PORT ?? 8799);
const buyerKey = process.env.DEMO_BUYER_PRIVATE_KEY;
if (!buyerKey) throw new Error("DEMO_BUYER_PRIVATE_KEY missing");
const BUYER = privateKeyToAddress(buyerKey);
// SELFTEST_NETWORK=testnet runs the identical loop on the free X Layer testnet rail.
const NETWORK = process.env.SELFTEST_NETWORK === "testnet" ? "testnet" : "mainnet";
const EXPLORER = NETWORK === "testnet" ? "https://www.oklink.com/x-layer-test/tx/" : "https://www.oklink.com/x-layer/tx/";

function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port: PORT, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, headers: res.headers }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const USE = {
  brief: "cyberpunk dragon hero image for a commercial X campaign",
  channel: "x",
  commercial: true,
  durationDays: 14,
  territory: "worldwide",
  transformations: ["crop", "overlay_text"],
  maxBudget: "0.10"
};

async function main(): Promise<void> {
  console.log("buyer:", BUYER);

  // 1 · quote
  const quote = await http("POST", "/v1/quote", { use: USE, licenseeWallet: BUYER, ...(NETWORK === "testnet" ? { network: "testnet" } : {}) });
  if (!quote.json?.serviceable) throw new Error("quote not serviceable: " + JSON.stringify(quote.json));
  const f = quote.json.purchaseIntentFields;
  console.log("1 quote:", quote.json.asset.title, "| expires", f.expiresAt);

  // 2 · sign intent (project EIP-712 impl, differential-tested vs viem)
  const nonce = sha256Hex(`live-selftest-${BUYER}-${f.quoteId}`);
  const unsigned = {
    quoteId: f.quoteId,
    quoteCommitment: f.quoteCommitment,
    buyer: BUYER,
    licensee: BUYER,
    assetSha256: f.assetSha256,
    offerDigest: f.offerDigest,
    policyAstHash: f.policyAstHash,
    legalTextHash: f.legalTextHash,
    totalPrice: f.totalPrice,
    currency: "USDT" as const,
    settlementNetwork: f.settlementNetwork,
    paymentAsset: f.paymentAsset,
    payTo: f.payTo,
    creatorPayoutMicro: f.creatorPayoutMicro,
    platformFeeMicro: f.platformFeeMicro,
    expiresAt: f.expiresAt,
    nonce
  };
  const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(unsigned), buyerKey);
  const intent = { ...unsigned, signature };
  console.log("2 intent signed:", signature.slice(0, 18) + "…");

  const body = { use: USE, licenseeWallet: BUYER, quoteCommitment: quote.json.quoteCommitment, idempotencyKey: quote.json.idempotencyKey, purchaseIntent: intent, ...(NETWORK === "testnet" ? { network: "testnet" } : {}) };

  // 3 · 402 challenge
  const challenge = await http("POST", "/v1/acquire/social-commercial", body);
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}: ${JSON.stringify(challenge.json).slice(0, 300)}`);
  console.log("3 challenge: 402, PAYMENT-REQUIRED header:", Boolean(challenge.headers["payment-required"]));

  // 4 · official client builds the payment payload (EIP-3009, zero gas)
  const account = privateKeyToAccount(buyerKey as `0x${string}`);
  const signer = {
    address: account.address,
    signTypedData: (m: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) =>
      account.signTypedData(m as never)
  };
  const { x402Client, x402HTTPClient } = await import("@okxweb3/x402-core/client");
  const { registerExactEvmScheme } = await import("@okxweb3/x402-evm/exact/client");
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: signer as never, networks: ["eip155:196", "eip155:1952"] });
  const httpClient = new x402HTTPClient(client);
  const payload = await httpClient.createPaymentPayload(challenge.json);
  const payHeaders = httpClient.encodePaymentSignatureHeader(payload);
  console.log("4 payment payload signed (headers:", Object.keys(payHeaders).join(","), ")");

  // 5 · settle
  const settled = await http("POST", "/v1/acquire/social-commercial", body, payHeaders as Record<string, string>);
  console.log("5 acquire:", settled.status, "| PAYMENT-RESPONSE:", Boolean(settled.headers["payment-response"]));
  if (settled.status === 200) {
    console.log("   buyerTx:", settled.json.settlement.buyerTx);
    console.log("   licenseId:", settled.json.license.licenseId);
    console.log("   explorer: " + EXPLORER + settled.json.settlement.buyerTx);
  } else if (settled.status === 202) {
    console.log("   pending — deliveryUrl:", settled.json.deliveryUrl);
  } else {
    throw new Error("settle failed: " + JSON.stringify(settled.json));
  }
  const orderId = settled.json.orderId;

  // 6 · wait for creator payout
  for (let i = 0; i < 25; i++) {
    const order = await http("GET", `/v1/orders/${orderId}`);
    const st = order.json?.status;
    const payout = order.json?.creatorPayout;
    console.log(`6 order ${st} · payout ${payout?.state ?? "—"}${payout?.confirmedTx ? " · " + payout.confirmedTx : ""}`);
    if (st === "CREATOR_PAID") {
      console.log("   payout explorer: " + EXPLORER + payout.confirmedTx);
      break;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log("DONE — production order:", orderId);
}

main().catch((e) => {
  console.error("LIVE SELFTEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
