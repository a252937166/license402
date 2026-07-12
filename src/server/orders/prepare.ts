import { canonicalHash, sha256Hex } from "../domain/index.js";
import { normalizeAddress, recoverTypedDataSigner, purchaseIntentToTypedMessage } from "../license/eip712.js";
import { issueCredential } from "../license/credential.js";
import type { BuyerAuthorization } from "../license/credential.js";
import { policyAstHash, purchaseIntentDigestHex, quoteCommitment } from "../license/commitments.js";
import { parseUsdtToMicro } from "../license/money.js";
import { PurchaseIntentSchema, UseSpecSchema } from "../license/types.js";
import type { LicenseCredential, PurchaseIntent } from "../license/types.js";
import type { Repo, QuoteRow, OfferRow } from "../store/repo.js";
import type { AppConfig } from "../config.js";

export type PrepareError =
  | { code: "QUOTE_NOT_FOUND"; http: 404 }
  | { code: "TERMS_COMMITMENT_CHANGED"; http: 409 }
  | { code: "QUOTE_EXPIRED"; http: 409 }
  | { code: "INTENT_INVALID"; http: 400; detail: string }
  | { code: "INTENT_SIGNATURE_INVALID"; http: 400 }
  | { code: "PAYER_MISMATCH"; http: 400; detail: string };

export interface PreparedDelivery {
  orderId: string;
  credential: LicenseCredential;
  assetId: string;
  buyerPaymentIdHint: string;
}

export interface AcquireRequestBody {
  use: unknown;
  licenseeWallet: string;
  quoteCommitment: string;
  idempotencyKey: string;
  purchaseIntent: unknown;
}

export type Environment = "sample" | "production" | "testnet";

interface ValidatedSignedAcquire {
  licensee: string;
  quote: QuoteRow;
  offer: OfferRow["offer"];
  intent: PurchaseIntent;
}

/**
 * Pure validation of a signed-intent acquire body — NO side effects, NO payment
 * required. Runs BEFORE the 402 challenge (review §9): an expired quote, a
 * drifted commitment, or a bad intent signature is rejected before the buyer
 * is ever asked to sign a payment authorization.
 */
export function validateSignedAcquire(
  repo: Repo,
  body: AcquireRequestBody,
  nowSeconds: number
): { ok: true; v: ValidatedSignedAcquire } | { ok: false; error: PrepareError } {
  let licensee: string;
  try {
    licensee = normalizeAddress(body.licenseeWallet);
  } catch {
    return { ok: false, error: { code: "INTENT_INVALID", http: 400, detail: "licenseeWallet" } };
  }

  const quote = repo.getQuoteByCommitment(body.quoteCommitment, licensee, body.idempotencyKey);
  if (!quote) return { ok: false, error: { code: "QUOTE_NOT_FOUND", http: 404 } };
  if (quote.expiresAt < nowSeconds) return { ok: false, error: { code: "QUOTE_EXPIRED", http: 409 } };

  // Recompute the commitment (v2 — includes the settlement rail) from stored
  // quote fields; drift ⇒ 409 before any 402 challenge is generated.
  const recomputed = quoteCommitment({
    offerDigest: quote.offerDigest,
    licenseeWallet: licensee,
    useSpecHash: quote.useSpecHash,
    priceMicro: quote.priceMicro,
    platformFeeMicro: quote.platformFeeMicro,
    creatorPayoutMicro: quote.creatorPayoutMicro,
    settlementNetwork: quote.settlementNetwork,
    paymentAsset: quote.paymentAsset,
    payTo: quote.payTo,
    quoteExpiresAt: quote.expiresAt,
    idempotencyKey: quote.idempotencyKey
  });
  if (recomputed !== body.quoteCommitment) {
    return { ok: false, error: { code: "TERMS_COMMITMENT_CHANGED", http: 409 } };
  }

  const parsedIntent = PurchaseIntentSchema.safeParse(body.purchaseIntent);
  if (!parsedIntent.success) return { ok: false, error: { code: "INTENT_INVALID", http: 400, detail: "schema" } };
  const intent: PurchaseIntent = parsedIntent.data;

  // Resolve the EXACT signed offer version this quote referenced — a catalog
  // re-sign between quote and payment must never invalidate or reinterpret it.
  const offer = repo.getOfferByDigest(quote.offerDigest);
  if (!offer) return { ok: false, error: { code: "QUOTE_NOT_FOUND", http: 404 } };
  const astHash = policyAstHash(offer.policy);

  // The intent must reference exactly this quote/offer/policy/legal-text/price
  // AND the exact settlement rail (network, token, payTo, split). Every
  // buyer-visible field is checked verbatim — defense in depth against "the
  // buyer signed a document that says something else".
  const intentMismatch =
    intent.quoteCommitment !== body.quoteCommitment ||
    intent.quoteId !== quote.quoteId ||
    normalizeAddress(intent.buyer) !== licensee ||
    normalizeAddress(intent.licensee) !== licensee ||
    intent.assetSha256 !== offer.assetSha256 ||
    intent.offerDigest !== quote.offerDigest ||
    intent.policyAstHash !== astHash ||
    intent.legalTextHash !== offer.legalTextHash ||
    parseUsdtToMicro(intent.totalPrice) !== quote.priceMicro ||
    intent.currency !== "USDT" ||
    intent.settlementNetwork !== quote.settlementNetwork ||
    normalizeAddress(intent.paymentAsset) !== quote.paymentAsset.toLowerCase() ||
    normalizeAddress(intent.payTo) !== quote.payTo.toLowerCase() ||
    intent.creatorPayoutMicro !== quote.creatorPayoutMicro ||
    intent.platformFeeMicro !== quote.platformFeeMicro ||
    intent.expiresAt !== quote.expiresAt;
  if (intentMismatch) return { ok: false, error: { code: "INTENT_INVALID", http: 400, detail: "binding" } };

  const { signature, ...unsignedIntent } = intent;
  const signer = recoverTypedDataSigner("PurchaseIntent", purchaseIntentToTypedMessage(unsignedIntent), signature);
  if (signer === null || signer !== licensee) {
    return { ok: false, error: { code: "INTENT_SIGNATURE_INVALID", http: 400 } };
  }

  return { ok: true, v: { licensee, quote, offer, intent } };
}

/**
 * Prepare a delivery (validate commitment + purchase intent, issue credential,
 * create idempotent order) WITHOUT settling. Called inside the x402-protected
 * handler; the credential is only released to the buyer if settlement succeeds.
 * Payment is verified by the adapter before this runs.
 */
export function prepareDelivery(
  repo: Repo,
  config: AppConfig,
  body: AcquireRequestBody,
  ctx: {
    nowSeconds: number;
    verifiedPayer: string;
    buyerPaymentId: string;
    paymentAuthorizationDigest: string;
    environment: Environment;
  }
): { ok: true; delivery: PreparedDelivery } | { ok: false; error: PrepareError } {
  // Idempotent short-circuit: this payment already produced an order.
  const byPayment = repo.getOrderByPaymentId(ctx.buyerPaymentId);
  if (byPayment) {
    const credential = repo.getLicenseByOrder(byPayment.orderId);
    if (credential) {
      return { ok: true, delivery: { orderId: byPayment.orderId, credential, assetId: credentialAssetId(repo, byPayment.orderId), buyerPaymentIdHint: ctx.buyerPaymentId } };
    }
  }

  const validated = validateSignedAcquire(repo, body, ctx.nowSeconds);
  if (!validated.ok) return validated;
  const { licensee, quote, offer, intent } = validated.v;

  // verifiedPayer (from x402) must equal buyer == licensee (MVP: no third-party payment).
  if (normalizeAddress(ctx.verifiedPayer) !== licensee) {
    return { ok: false, error: { code: "PAYER_MISMATCH", http: 400, detail: `payer ${ctx.verifiedPayer} != licensee ${licensee}` } };
  }

  const { signature: _sig, ...unsignedIntent } = intent;
  const intentDigest = purchaseIntentDigestHex(unsignedIntent);
  const orderId = `ord-${canonicalHash({ commitment: body.quoteCommitment, licensee }, "L402:ORDERID:v1").slice(2, 18)}`;

  const order = repo.createOrGetOrder({
    orderId,
    quoteId: quote.quoteId,
    quoteCommitment: body.quoteCommitment,
    licenseeWallet: licensee,
    purchaseIntent: intent,
    purchaseIntentDigest: intentDigest,
    status: "PAYMENT_VERIFIED",
    environment: ctx.environment,
    nowSeconds: ctx.nowSeconds
  });

  let credential = repo.getLicenseByOrder(order.orderId);
  if (!credential) {
    const use = UseSpecSchema.parse(quote.useSpec);
    credential = issueCredential({
      offer,
      use,
      authorization: { mode: "eip712_purchase_intent", purchaseIntent: intent },
      environment: ctx.environment,
      settlementNetwork: quote.settlementNetwork,
      paymentAsset: quote.paymentAsset,
      orderId: order.orderId,
      buyerPaymentId: ctx.buyerPaymentId,
      paymentAuthorizationDigest: ctx.paymentAuthorizationDigest,
      issuedAtSeconds: ctx.nowSeconds,
      issuerPrivateKey: config.issuerPrivateKey,
      statusBaseUrl: config.publicOrigin
    });
    repo.insertLicense(credential, ctx.nowSeconds);
  }
  repo.updateOrderStatus(order.orderId, "DELIVERY_PREPARED", ctx.nowSeconds);

  return { ok: true, delivery: { orderId: order.orderId, credential, assetId: offer.assetId, buyerPaymentIdHint: ctx.buyerPaymentId } };
}

/**
 * A2MCP DIRECT purchase (OKX.AI marketplace calls): one paid POST, no pre-flow.
 * The x402 payment signature (EIP-3009: payer, amount, payTo, validity window)
 * IS the buyer's authorization; the facilitator-verified payer becomes the
 * licensee. No PurchaseIntent exists and NONE IS FABRICATED — the stored
 * record and the credential carry authorizationMode "x402_direct" plus a
 * digest of the canonical authorization record. Each distinct payment creates
 * its own order.
 */
export function prepareDirectDelivery(
  repo: Repo,
  config: AppConfig,
  sel: {
    quoteId: string;
    quoteCommitment: string;
    offerId: string;
    offerDigest: string;
    assetId: string;
    assetSha256: string;
    policyAstHash: string;
    price: string;
    settlementNetwork: string;
    paymentAsset: string;
    quoteExpiresAt: number;
  },
  use: unknown,
  ctx: {
    nowSeconds: number;
    verifiedPayer: string;
    buyerPaymentId: string;
    paymentAuthorizationDigest: string;
    requestBodyHash: string;
    environment: Environment;
  }
): { ok: true; delivery: PreparedDelivery } | { ok: false; error: PrepareError } {
  const licensee = normalizeAddress(ctx.verifiedPayer);

  const byPayment = repo.getOrderByPaymentId(ctx.buyerPaymentId);
  if (byPayment) {
    const credential = repo.getLicenseByOrder(byPayment.orderId);
    if (credential) {
      return { ok: true, delivery: { orderId: byPayment.orderId, credential, assetId: credentialAssetId(repo, byPayment.orderId), buyerPaymentIdHint: ctx.buyerPaymentId } };
    }
  }

  // Deliver the EXACT signed version the quote (and the 402 disclosure)
  // named — a head re-sign between challenge and paid replay must never
  // change what the payment buys (round-12 P0).
  const offer = repo.getOfferByDigest(sel.offerDigest) ?? repo.getOffer(sel.offerId)?.offer;
  if (!offer) return { ok: false, error: { code: "QUOTE_NOT_FOUND", http: 404 } };

  const authorization: BuyerAuthorization = {
    mode: "x402_direct",
    payer: licensee,
    requestBodyHash: ctx.requestBodyHash,
    paymentAuthorizationDigest: ctx.paymentAuthorizationDigest,
    quoteId: sel.quoteId,
    quoteCommitment: sel.quoteCommitment
  };
  const authDigest = canonicalHash(
    {
      mode: authorization.mode,
      payer: licensee,
      requestBodyHash: ctx.requestBodyHash,
      paymentAuthorizationDigest: ctx.paymentAuthorizationDigest,
      quoteId: sel.quoteId,
      quoteCommitment: sel.quoteCommitment
    },
    "L402:BUYERAUTH:v1"
  );
  const orderId = `ord-${canonicalHash({ commitment: sel.quoteCommitment, licensee, auth: ctx.paymentAuthorizationDigest }, "L402:ORDERID:v1").slice(2, 18)}`;

  const order = repo.createOrGetOrder({
    orderId,
    quoteId: sel.quoteId,
    quoteCommitment: sel.quoteCommitment,
    licenseeWallet: licensee,
    // The honest record: what authorized this order (NOT a fake intent).
    purchaseIntent: authorization as unknown as PurchaseIntent,
    purchaseIntentDigest: authDigest,
    status: "PAYMENT_VERIFIED",
    environment: ctx.environment,
    nowSeconds: ctx.nowSeconds
  });

  let credential = repo.getLicenseByOrder(order.orderId);
  if (!credential) {
    const parsedUse = UseSpecSchema.parse(use);
    credential = issueCredential({
      offer,
      use: parsedUse,
      authorization,
      environment: ctx.environment,
      settlementNetwork: sel.settlementNetwork,
      paymentAsset: sel.paymentAsset,
      orderId: order.orderId,
      buyerPaymentId: ctx.buyerPaymentId,
      paymentAuthorizationDigest: ctx.paymentAuthorizationDigest,
      issuedAtSeconds: ctx.nowSeconds,
      issuerPrivateKey: config.issuerPrivateKey,
      statusBaseUrl: config.publicOrigin
    });
    repo.insertLicense(credential, ctx.nowSeconds);
  }
  repo.updateOrderStatus(order.orderId, "DELIVERY_PREPARED", ctx.nowSeconds);

  return { ok: true, delivery: { orderId: order.orderId, credential, assetId: offer.assetId, buyerPaymentIdHint: ctx.buyerPaymentId } };
}

function credentialAssetId(repo: Repo, orderId: string): string {
  const credential = repo.getLicenseByOrder(orderId);
  if (!credential) return "";
  // Archive-first: the credential's exact bytes always resolve, even after
  // the head asset was replaced (round-11 immutable assets).
  const archived = repo.getAssetVersionBySha(credential.assetSha256);
  if (archived) return archived.assetId;
  const offer = repo.listActiveOffers().find((o) => o.assetSha256 === credential.assetSha256);
  return offer?.assetId ?? "";
}

/**
 * After-settle transition (spec v4 §5): only status === "success" activates the
 * license and enqueues the creator payout. Callers pass the SDK settle result.
 */
export const SETTLED_STATES = new Set([
  "BUYER_SETTLED",
  "LICENSE_ACTIVE",
  "CREATOR_PAYOUT_PENDING",
  "PAYOUT_RETRYING",
  "PAYOUT_FAILED",
  // Buyer settled + license active; only the CREATOR side is in manual
  // reconciliation. The buyer's delivery must never regress because of it.
  "PAYOUT_NEEDS_RECONCILIATION",
  "CREATOR_PAID"
]);

export function onSettlementSuccess(
  repo: Repo,
  orderId: string,
  buyerSettleTx: string | null,
  ctx: { nowSeconds: number }
): void {
  // Single transaction: buyer-settled, license activation, and the payout
  // obligation commit together. A crash can no longer leave "buyer settled but
  // license inactive" or "license active but no payout owed".
  repo.atomically(() => {
    const order = repo.getOrder(orderId);
    if (!order) return;
    // Idempotent: never re-settle an order that already passed settlement, or a
    // replay/re-run would reset a paid order back to CREATOR_PAYOUT_PENDING.
    if (SETTLED_STATES.has(order.status)) return;
    const credential = repo.getLicenseByOrder(orderId);
    if (!credential) return;

    repo.markBuyerSettled(orderId, credential.buyerPaymentId, buyerSettleTx, credential.paymentAuthorizationDigest, ctx.nowSeconds);
    repo.updateOrderStatus(orderId, "LICENSE_ACTIVE", ctx.nowSeconds);
    repo.setLicenseStatus(orderId, "ACTIVE");

    // REAL MONEY follows the quote's SNAPSHOT of the signed offer's wallet —
    // frozen at mint, immutable since. NO fallback (round-12): if the snapshot
    // is missing or malformed, the obligation is recorded fail-closed in
    // NEEDS_RECONCILIATION and NOTHING is sent. The buyer's license stays
    // active either way (it already settled).
    const quote = repo.getQuoteById(order.quoteId);
    // Legacy rows (pre-snapshot migration) resolve once from the archived
    // signed offer their digest names — still never the current head.
    const snapshotWallet = quote?.payoutWallet || (quote ? repo.getOfferByDigest(quote.offerDigest)?.payoutWallet ?? "" : "");
    const payoutMicro = quote?.creatorPayoutMicro;
    if (!quote || !/^0x[0-9a-fA-F]{40}$/.test(snapshotWallet) || !Number.isInteger(payoutMicro) || (payoutMicro as number) <= 0) {
      repo.enqueuePayoutNeedsReconciliation(
        orderId,
        "HISTORICAL_OFFER_UNRESOLVED — payout snapshot missing/invalid; no funds moved, resolve manually",
        ctx.nowSeconds
      );
      return;
    }
    repo.enqueuePayout(orderId, snapshotWallet.toLowerCase(), payoutMicro as number, ctx.nowSeconds);
    repo.updateOrderStatus(orderId, "CREATOR_PAYOUT_PENDING", ctx.nowSeconds);
  });
}

function orderIdToOfferId(repo: Repo, orderId: string): string {
  const order = repo.getOrder(orderId);
  if (!order) return "";
  const quote = repo.getQuoteById(order.quoteId);
  return quote?.offerId ?? "";
}

export function onSettlementFailure(repo: Repo, orderId: string, detail: string, ctx: { nowSeconds: number }): void {
  const order = repo.getOrder(orderId);
  if (!order) return;
  // Never void an order that already settled — a replayed authorization whose
  // second settle fails (nonce spent) must not revoke the license it bought.
  if (SETTLED_STATES.has(order.status)) return;
  // Do NOT delete: mark failed; a reconciler may later confirm a late success.
  repo.updateOrderStatus(orderId, "SETTLEMENT_FAILED", ctx.nowSeconds, detail);
  repo.setLicenseStatus(orderId, "VOID_SETTLEMENT_FAILED");
}

export function computePaymentAuthorizationDigest(paymentHeader: string): string {
  return sha256Hex(paymentHeader);
}
