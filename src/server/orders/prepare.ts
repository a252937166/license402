import { canonicalHash, sha256Hex } from "../domain/index.js";
import { normalizeAddress, recoverTypedDataSigner, purchaseIntentToTypedMessage } from "../license/eip712.js";
import { issueCredential } from "../license/credential.js";
import { policyAstHash, purchaseIntentDigestHex, quoteCommitment } from "../license/commitments.js";
import { PurchaseIntentSchema, UseSpecSchema } from "../license/types.js";
import type { LicenseCredential, PurchaseIntent } from "../license/types.js";
import type { Repo } from "../store/repo.js";
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

/**
 * Prepare a delivery (validate commitment + purchase intent, issue credential,
 * create idempotent order) WITHOUT settling. Called inside the x402-protected
 * handler; the credential is only released to the buyer if settlement succeeds.
 * Payment is verified by the middleware before this runs.
 */
export function prepareDelivery(
  repo: Repo,
  config: AppConfig,
  body: AcquireRequestBody,
  ctx: { nowSeconds: number; verifiedPayer: string; buyerPaymentId: string; paymentAuthorizationDigest: string }
): { ok: true; delivery: PreparedDelivery } | { ok: false; error: PrepareError } {
  const licensee = normalizeAddress(body.licenseeWallet);

  // Idempotent short-circuit: this payment already produced an order.
  const byPayment = repo.getOrderByPaymentId(ctx.buyerPaymentId);
  if (byPayment) {
    const credential = repo.getLicenseByOrder(byPayment.orderId);
    if (credential) {
      return { ok: true, delivery: { orderId: byPayment.orderId, credential, assetId: credentialAssetId(repo, byPayment.orderId), buyerPaymentIdHint: ctx.buyerPaymentId } };
    }
  }

  const quote = repo.getQuoteByCommitment(body.quoteCommitment, licensee, body.idempotencyKey);
  if (!quote) return { ok: false, error: { code: "QUOTE_NOT_FOUND", http: 404 } };
  if (quote.expiresAt < ctx.nowSeconds) return { ok: false, error: { code: "QUOTE_EXPIRED", http: 409 } };

  // Recompute the commitment from stored quote fields; drift ⇒ 409 (pre-settlement guaranteed by middleware order).
  const recomputed = quoteCommitment({
    offerDigest: quote.offerDigest,
    licenseeWallet: licensee,
    useSpecHash: quote.useSpecHash,
    priceMicro: quote.priceMicro,
    platformFeeMicro: quote.platformFeeMicro,
    creatorPayoutMicro: quote.creatorPayoutMicro,
    quoteExpiresAt: quote.expiresAt,
    idempotencyKey: quote.idempotencyKey
  });
  if (recomputed !== body.quoteCommitment) {
    return { ok: false, error: { code: "TERMS_COMMITMENT_CHANGED", http: 409 } };
  }

  const parsedIntent = PurchaseIntentSchema.safeParse(body.purchaseIntent);
  if (!parsedIntent.success) return { ok: false, error: { code: "INTENT_INVALID", http: 400, detail: "schema" } };
  const intent: PurchaseIntent = parsedIntent.data;

  const offerRow = repo.getOffer(quote.offerId);
  if (!offerRow) return { ok: false, error: { code: "QUOTE_NOT_FOUND", http: 404 } };
  const offer = offerRow.offer;
  const astHash = policyAstHash(offer.policy);

  // The intent must reference exactly this quote/offer/policy/legal-text/price.
  const intentMismatch =
    intent.quoteCommitment !== body.quoteCommitment ||
    normalizeAddress(intent.buyer) !== licensee ||
    normalizeAddress(intent.licensee) !== licensee ||
    intent.assetSha256 !== offer.assetSha256 ||
    intent.offerDigest !== quote.offerDigest ||
    intent.policyAstHash !== astHash ||
    intent.legalTextHash !== offer.legalTextHash;
  if (intentMismatch) return { ok: false, error: { code: "INTENT_INVALID", http: 400, detail: "binding" } };

  const { signature, ...unsignedIntent } = intent;
  const signer = recoverTypedDataSigner("PurchaseIntent", purchaseIntentToTypedMessage(unsignedIntent), signature);
  if (signer === null || signer !== licensee) {
    return { ok: false, error: { code: "INTENT_SIGNATURE_INVALID", http: 400 } };
  }

  // verifiedPayer (from x402 settlement) must equal buyer == licensee (MVP: no third-party payment).
  if (normalizeAddress(ctx.verifiedPayer) !== licensee) {
    return { ok: false, error: { code: "PAYER_MISMATCH", http: 400, detail: `payer ${ctx.verifiedPayer} != licensee ${licensee}` } };
  }

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
    nowSeconds: ctx.nowSeconds
  });

  let credential = repo.getLicenseByOrder(order.orderId);
  if (!credential) {
    const use = UseSpecSchema.parse(quote.useSpec);
    credential = issueCredential({
      offer,
      use,
      purchaseIntent: intent,
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
  const offer = repo.listActiveOffers().find((o) => o.assetSha256 === credential.assetSha256);
  return offer?.assetId ?? "";
}

/**
 * After-settle transition (spec v4 §5): only status === "success" activates the
 * license and enqueues the creator payout. Callers pass the SDK settle result.
 */
const SETTLED_STATES = new Set([
  "BUYER_SETTLED",
  "LICENSE_ACTIVE",
  "CREATOR_PAYOUT_PENDING",
  "PAYOUT_RETRYING",
  "PAYOUT_FAILED",
  "CREATOR_PAID"
]);

export function onSettlementSuccess(
  repo: Repo,
  orderId: string,
  buyerSettleTx: string | null,
  ctx: { nowSeconds: number }
): void {
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

  const offer = repo.getOffer(orderIdToOfferId(repo, orderId));
  const quote = repo.getQuoteById(order.quoteId);
  const payoutWallet = offer?.payoutWallet ?? credential.licensorWallet;
  const payoutMicro = quote?.creatorPayoutMicro ?? 70_000;
  repo.enqueuePayout(orderId, payoutWallet, payoutMicro, ctx.nowSeconds);
  repo.updateOrderStatus(orderId, "CREATOR_PAYOUT_PENDING", ctx.nowSeconds);
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
  // Do NOT delete: mark failed; a reconciler may later confirm a late success.
  repo.updateOrderStatus(orderId, "SETTLEMENT_FAILED", ctx.nowSeconds, detail);
  repo.setLicenseStatus(orderId, "VOID_SETTLEMENT_FAILED");
}

export function computePaymentAuthorizationDigest(paymentHeader: string): string {
  return sha256Hex(paymentHeader);
}
