import { canonicalHash } from "../domain/index.js";
import { evaluateOfferEligibility } from "./eligibility.js";
import { offerDigestHex, policyAstHash, quoteCommitment, useSpecHash } from "./commitments.js";
import { CREATOR_PAYOUT_MICRO, PLATFORM_FEE_MICRO, SALE_PRICE_MICRO, formatMicroUsdt } from "./money.js";
import type { ReasonCode } from "./vocab.js";
import type { CreatorOffer, PolicyV1, UseSpec } from "./types.js";

export interface CatalogOffer {
  offer: CreatorOffer;
  storedAssetSha256: string;
  previewUrl: string;
  title: string;
  creatorDisplay: string;
}

export interface RejectedCandidate {
  offerId: string;
  title: string;
  reasonCodes: ReasonCode[];
}

export interface QuoteResult {
  serviceable: boolean;
  reasons?: ReasonCode[];
  rejectedCandidates: RejectedCandidate[];
  selected?: {
    quoteId: string;
    offerId: string;
    offerDigest: string;
    assetId: string;
    assetSha256: string;
    previewUrl: string;
    title: string;
    creatorDisplay: string;
    policy: PolicyV1;
    policyAstHash: string;
    effectiveGrant: {
      channels: string[];
      transformations: string[];
      territory: string;
      durationDays: number;
    };
    priceMicro: number;
    platformFeeMicro: number;
    creatorPayoutMicro: number;
    price: string;
    platformFee: string;
    creatorPayout: string;
    currency: "USDT";
    quoteCommitment: string;
    quoteExpiresAt: number;
    idempotencyKey: string;
  };
}

export interface QuoteEngineOptions {
  nowSeconds: number;
  quoteTtlSeconds?: number;
}

/** Derive a deterministic quoteId/idempotencyKey from the request (stable within a TTL bucket). */
function deriveQuoteId(offerDigest: string, licenseeWallet: string, useSpecDigest: string, ttlBucket: number): string {
  return `quote-${canonicalHash({ offerDigest, licenseeWallet, useSpecDigest, ttlBucket }, "L402:QUOTEID:v1").slice(2, 18)}`;
}

/**
 * Two-phase selection over the catalog: Phase 1 hard gates (never weighted),
 * Phase 2 soft ranking of survivors (here: cheapest creator price, then title).
 * The selected offer/asset is pinned exactly — no post-payment selection.
 */
export function buildQuote(catalog: CatalogOffer[], use: UseSpec, licenseeWallet: string, opts: QuoteEngineOptions): QuoteResult {
  const ttl = opts.quoteTtlSeconds ?? 900;
  const rejected: RejectedCandidate[] = [];
  const eligible: CatalogOffer[] = [];

  for (const candidate of catalog) {
    const result = evaluateOfferEligibility(candidate.offer, use, {
      storedAssetSha256: candidate.storedAssetSha256,
      nowSeconds: opts.nowSeconds,
      salePriceMicro: SALE_PRICE_MICRO
    });
    if (result.eligible) {
      eligible.push(candidate);
    } else {
      rejected.push({
        offerId: candidate.offer.offerId,
        title: candidate.title,
        reasonCodes: result.reasons
      });
    }
  }

  if (eligible.length === 0) {
    const allReasons = [...new Set(rejected.flatMap((r) => r.reasonCodes))];
    return { serviceable: false, reasons: allReasons, rejectedCandidates: rejected };
  }

  // Phase 2 soft ranking: cheapest creator price wins, tie-break by offerId for determinism.
  eligible.sort((a, b) => {
    const pa = Number(a.offer.creatorNetPrice);
    const pb = Number(b.offer.creatorNetPrice);
    if (pa !== pb) return pa - pb;
    return a.offer.offerId < b.offer.offerId ? -1 : 1;
  });

  const { offer, previewUrl, title, creatorDisplay } = eligible[0];
  const { signature: _sig, ...unsigned } = offer;
  const offerDigest = offerDigestHex(unsigned);
  const astHash = policyAstHash(offer.policy);
  const specHash = useSpecHash(use);
  const quoteExpiresAt = opts.nowSeconds + ttl;
  const ttlBucket = Math.floor(opts.nowSeconds / ttl);
  const quoteId = deriveQuoteId(offerDigest, licenseeWallet.toLowerCase(), specHash, ttlBucket);
  const idempotencyKey = quoteId;

  const commitment = quoteCommitment({
    offerDigest,
    licenseeWallet: licenseeWallet.toLowerCase(),
    useSpecHash: specHash,
    priceMicro: SALE_PRICE_MICRO,
    platformFeeMicro: PLATFORM_FEE_MICRO,
    creatorPayoutMicro: CREATOR_PAYOUT_MICRO,
    quoteExpiresAt,
    idempotencyKey
  });

  return {
    serviceable: true,
    rejectedCandidates: rejected,
    selected: {
      quoteId,
      offerId: offer.offerId,
      offerDigest,
      assetId: offer.assetId,
      assetSha256: offer.assetSha256,
      previewUrl,
      title,
      creatorDisplay,
      policy: offer.policy,
      policyAstHash: astHash,
      effectiveGrant: {
        channels: [use.channel],
        transformations: [...use.transformations],
        territory: use.territory,
        durationDays: use.durationDays
      },
      priceMicro: SALE_PRICE_MICRO,
      platformFeeMicro: PLATFORM_FEE_MICRO,
      creatorPayoutMicro: CREATOR_PAYOUT_MICRO,
      price: formatMicroUsdt(SALE_PRICE_MICRO),
      platformFee: formatMicroUsdt(PLATFORM_FEE_MICRO),
      creatorPayout: formatMicroUsdt(CREATOR_PAYOUT_MICRO),
      currency: "USDT",
      quoteCommitment: commitment,
      quoteExpiresAt,
      idempotencyKey
    }
  };
}
