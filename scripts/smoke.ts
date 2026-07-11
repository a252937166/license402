/**
 * End-to-end smoke test against a running server (dev payment mode).
 * Drives the real HTTP API: quote → sign PurchaseIntent → acquire → scope checks
 * → order status. Uses node:http to bypass any ambient HTTP_PROXY.
 *
 * Usage: BASE=http://127.0.0.1:8799 tsx scripts/smoke.ts
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { sha256Hex } from "../src/server/domain/index.js";
import { privateKeyToAddress, purchaseIntentToTypedMessage, signTypedData } from "../src/server/license/eip712.js";

const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const BUYER_KEY = process.env.SMOKE_BUYER_KEY ?? `0x${"55".repeat(32)}`;
const BUYER = privateKeyToAddress(BUYER_KEY);

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const u = new URL(BASE + path);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers }
      },
      (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: t });
          }
        });
      }
    );
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

function pass(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) process.exitCode = 1;
}

const health = await call("GET", "/healthz");
pass("health", health.status === 200, `mode=${health.json?.paymentMode}`);

const quote = await call("POST", "/v1/quote", { use: USE, licenseeWallet: BUYER });
if (!quote.json?.serviceable) {
  console.log("  quote reasons:", JSON.stringify(quote.json?.reasons), "rejects:", JSON.stringify(quote.json?.rejectedCandidates?.slice(0, 3)));
}
pass("quote serviceable", quote.status === 200 && quote.json?.serviceable === true, `asset=${quote.json?.asset?.title} rejects=${quote.json?.rejectedCandidates?.length}`);
if (!quote.json?.serviceable) process.exit(1);

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
  expiresAt: f.quoteExpiresAt ?? quote.json.quoteExpiresAt,
  nonce: sha256Hex(`smoke-${BUYER}-${quote.json.quoteId}`)
};
const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(unsigned), BUYER_KEY);
const intent = { ...unsigned, signature };

const paymentId = `smoke-${sha256Hex(quote.json.quoteId).slice(2, 14)}`;
const acquire = await call(
  "POST",
  "/v1/acquire/social-commercial",
  { use: USE, licenseeWallet: BUYER, quoteCommitment: quote.json.quoteCommitment, idempotencyKey: quote.json.idempotencyKey, purchaseIntent: intent },
  { "x-dev-payer": BUYER, "x-dev-payment-id": paymentId }
);
pass("acquire 200 + license", acquire.status === 200 && acquire.json?.license?.licenseId, `order=${acquire.json?.orderId}`);
pass("asset signed url present", typeof acquire.json?.asset?.url === "string" && acquire.json.asset.url.includes("/v1/assets/"));

const permit = await call("POST", "/v1/check-license-scope", { license: acquire.json.license, action: "commercial_social_post", channel: "x", licensee: BUYER });
pass("scope commercial → PERMITTED", permit.json?.decision === "PERMITTED", `status=${permit.json?.currentStatus}`);

const train = await call("POST", "/v1/check-license-scope", { license: acquire.json.license, action: "model_training", licensee: BUYER });
pass("scope training → NOT_PERMITTED", train.json?.decision === "NOT_PERMITTED", train.json?.reasonCodes?.join(","));

const tampered = { ...acquire.json.license, policy: { ...acquire.json.license.policy, modelTraining: true } };
const tamper = await call("POST", "/v1/check-license-scope", { license: tampered, action: "model_training", licensee: BUYER });
pass("tamper → INVALID_CREDENTIAL", tamper.json?.decision === "INVALID_CREDENTIAL", tamper.json?.reasonCodes?.join(","));

const order = await call("GET", `/v1/orders/${acquire.json.orderId}`);
pass("order settled + creator paid", order.json?.status === "CREATOR_PAID" && order.json?.creatorPayout?.state === "PAID", `econ=${JSON.stringify(order.json?.economics)}`);

const idem = await call(
  "POST",
  "/v1/acquire/social-commercial",
  { use: USE, licenseeWallet: BUYER, quoteCommitment: quote.json.quoteCommitment, idempotencyKey: quote.json.idempotencyKey, purchaseIntent: intent },
  { "x-dev-payer": BUYER, "x-dev-payment-id": paymentId }
);
pass("idempotent replay → same order", idem.json?.orderId === acquire.json.orderId);

const ledger = await call("GET", "/v1/ledger");
pass("ledger reflects order", ledger.json?.activeLicenses >= 1 && ledger.json?.creatorPayoutsPaid >= 1, `active=${ledger.json?.activeLicenses} paid=${ledger.json?.creatorPayoutsPaid} buyers=${ledger.json?.distinctBuyers}`);

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
