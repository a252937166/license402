import { sha256Hex } from "../domain/index.js";
import { privateKeyToAddress, purchaseIntentToTypedMessage, signTypedData } from "../license/eip712.js";
import { buildQuote } from "../license/quote.js";
import { issueCredential } from "../license/credential.js";
import { legalTextHash } from "../legal.js";
import type { CatalogOffer } from "../license/quote.js";
import { PurchaseIntentSchema, UseSpecSchema } from "../license/types.js";
import type { LicenseCredential, UseSpec } from "../license/types.js";
import type { AppConfig } from "../config.js";

export interface SampleEnvelope {
  environment: "sample";
  note: string;
  credential: LicenseCredential;
  asset: {
    assetId: string;
    title: string;
    creator: string;
    previewUrl: string;
    sampleUrl: string;
    sha256: string;
  };
  quote: {
    asset: { assetId: string; title: string; creator: string };
    effectiveGrant: unknown;
    rejectedCandidates: unknown[];
    price: string;
    creatorPayout: string;
    platformFee: string;
  };
}

const SAMPLE_USE: UseSpec = UseSpecSchema.parse({
  brief: "cyberpunk dragon hero image for a commercial X campaign",
  channel: "x",
  commercial: true,
  durationDays: 14,
  territory: "worldwide",
  transformations: ["crop", "overlay_text"],
  maxBudget: "0.10"
});

let cached: SampleEnvelope | null = null;

/**
 * The free judge/visitor experience (P0-3 isolation): a fully SIGNED sample —
 * real CreatorOffer, real demo-buyer PurchaseIntent signature, real issuer
 * credential signature — built entirely in memory. It never touches the
 * database: no quote row, no order, no license row, no payout. The sample
 * credential is recognizable by its "sample-" orderId, and the sample art is
 * the badged rendition, never the sha256-bound deliverable.
 */
export function buildSampleEnvelope(config: AppConfig, catalog: CatalogOffer[], nowSeconds: number): SampleEnvelope {
  if (cached) return cached;
  if (!config.demoBuyerPrivateKey) throw new Error("SAMPLE_UNAVAILABLE");

  const buyer = privateKeyToAddress(config.demoBuyerPrivateKey);
  const quote = buildQuote(catalog, SAMPLE_USE, buyer, { nowSeconds });
  if (!quote.serviceable || !quote.selected) throw new Error("SAMPLE_NOT_SERVICEABLE");
  const sel = quote.selected;

  const intentUnsigned = {
    quoteId: sel.quoteId,
    quoteCommitment: sel.quoteCommitment,
    buyer,
    licensee: buyer,
    assetSha256: sel.assetSha256,
    offerDigest: sel.offerDigest,
    policyAstHash: sel.policyAstHash,
    legalTextHash: legalTextHash(),
    totalPrice: sel.price,
    currency: "USDT" as const,
    expiresAt: sel.quoteExpiresAt,
    nonce: sha256Hex(`sample-${buyer}-${sel.quoteId}`)
  };
  const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(intentUnsigned), config.demoBuyerPrivateKey);
  const intent = PurchaseIntentSchema.parse({ ...intentUnsigned, signature });

  const offer = catalog.find((c) => c.offer.offerId === sel.offerId)!.offer;
  const orderId = `sample-${sha256Hex(sel.quoteCommitment).slice(2, 14)}`;
  const credential = issueCredential({
    offer,
    use: SAMPLE_USE,
    purchaseIntent: intent,
    orderId,
    buyerPaymentId: `sample-${sha256Hex(orderId).slice(2, 14)}`,
    paymentAuthorizationDigest: sha256Hex(`sample-no-payment-${orderId}`),
    issuedAtSeconds: nowSeconds,
    issuerPrivateKey: config.issuerPrivateKey,
    statusBaseUrl: config.publicOrigin
  });

  const slug = sel.assetId.replace(/^asset-/, "");
  cached = {
    environment: "sample",
    note: "Signed end-to-end (creator offer, buyer intent, issuer credential) — but NOT a purchase. No payment occurred, nothing was written to the ledger, and the art is the badged sample rendition, not the licensed deliverable.",
    credential,
    asset: {
      assetId: sel.assetId,
      title: sel.title,
      creator: sel.creatorDisplay,
      previewUrl: `${config.publicOrigin}/v1/previews/${sel.assetId}`,
      sampleUrl: `${config.publicOrigin}/v1/samples/art/${slug}`,
      sha256: sel.assetSha256
    },
    quote: {
      asset: { assetId: sel.assetId, title: sel.title, creator: sel.creatorDisplay },
      effectiveGrant: sel.effectiveGrant,
      rejectedCandidates: quote.rejectedCandidates,
      price: sel.price,
      creatorPayout: sel.creatorPayout,
      platformFee: sel.platformFee
    }
  };
  return cached;
}
