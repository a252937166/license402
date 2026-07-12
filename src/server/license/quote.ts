import { canonicalHash } from "../domain/index.js";
import { evaluateOfferEligibility } from "./eligibility.js";
import { offerDigestHex, policyAstHash, quoteCommitment, useSpecHash } from "./commitments.js";
import { SALE_PRICE_MICRO, formatMicroUsdt, parseUsdtToMicro } from "./money.js";
import type { ReasonCode } from "./vocab.js";
import type { CreatorOffer, PolicyV1, UseSpec } from "./types.js";

export interface CatalogOffer {
  offer: CreatorOffer;
  storedAssetSha256: string;
  previewUrl: string;
  title: string;
  creatorDisplay: string;
  tags?: string[];
}

/** Relevance of a candidate to the buyer's brief: title + tag token overlap. */
function briefRelevance(brief: string, title: string, tags: string[]): number {
  const tokens = new Set(
    brief
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
  );
  if (tokens.size === 0) return 0;
  const hay = (title + " " + tags.join(" ")).toLowerCase();
  let score = 0;
  for (const t of tokens) if (hay.includes(t)) score += 1;
  return score;
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
    legalTextHash: string;
    payoutWallet: string;
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
    settlementNetwork: string;
    paymentAsset: string;
    payTo: string;
    quoteCommitment: string;
    quoteExpiresAt: number;
    idempotencyKey: string;
  };
}

export interface QuoteRail {
  settlementNetwork: string;
  paymentAsset: string;
  payTo: string;
}

export interface QuoteEngineOptions {
  nowSeconds: number;
  quoteTtlSeconds?: number;
  /** Which settlement rail this quote binds to. Part of the commitment (v2). */
  rail: QuoteRail;
  /**
   * Pin the quote to ONE exact offer (e.g. the buyer clicked a specific item in
   * the market). Hard gates still run; if that offer is ineligible the quote is
   * simply not serviceable — the engine never substitutes a different asset.
   */
  pinOfferId?: string;
}

/** Derive a deterministic quoteId/idempotencyKey from the request (stable within a TTL bucket). */
function deriveQuoteId(offerDigest: string, licenseeWallet: string, useSpecDigest: string, ttlBucket: number, network: string): string {
  return `quote-${canonicalHash({ offerDigest, licenseeWallet, useSpecDigest, ttlBucket, network }, "L402:QUOTEID:v2").slice(2, 18)}`;
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
  const candidates = opts.pinOfferId ? catalog.filter((c) => c.offer.offerId === opts.pinOfferId) : catalog;
  if (opts.pinOfferId && candidates.length === 0) {
    return { serviceable: false, reasons: [], rejectedCandidates: [{ offerId: opts.pinOfferId, title: opts.pinOfferId, reasonCodes: [] }] };
  }

  for (const candidate of candidates) {
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

  // Phase 2 soft ranking (survivors only): brief relevance first, then cheaper
  // creator price, then offerId for determinism. Hard gates already ran.
  eligible.sort((a, b) => {
    const ra = briefRelevance(use.brief, a.title, a.tags ?? []);
    const rb = briefRelevance(use.brief, b.title, b.tags ?? []);
    if (ra !== rb) return rb - ra;
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
  const ttlBucket = Math.floor(opts.nowSeconds / ttl);
  // Deterministic within the TTL bucket: re-quoting the same request returns the
  // IDENTICAL quote (same id, same expiry, same commitment) instead of drifting
  // the stored quote out from under a buyer who is mid-payment. Expiry is the
  // bucket end + one full TTL, so a quote is always valid for at least one TTL.
  const quoteExpiresAt = (ttlBucket + 2) * ttl;
  const quoteId = deriveQuoteId(offerDigest, licenseeWallet.toLowerCase(), specHash, ttlBucket, opts.rail.settlementNetwork);
  const idempotencyKey = quoteId;

  // Honor the creator's SIGNED net price; the platform fee is the remainder of
  // the fixed sale price. An offer whose signed net price exceeds the sale
  // price was REJECTED by the eligibility gate (CREATOR_PRICE_EXCEEDS_SALE_PRICE)
  // — a signed price is never silently altered.
  const creatorPayoutMicro = parseUsdtToMicro(offer.creatorNetPrice);
  const platformFeeMicro = SALE_PRICE_MICRO - creatorPayoutMicro;

  const commitment = quoteCommitment({
    offerDigest,
    licenseeWallet: licenseeWallet.toLowerCase(),
    useSpecHash: specHash,
    priceMicro: SALE_PRICE_MICRO,
    platformFeeMicro,
    creatorPayoutMicro,
    settlementNetwork: opts.rail.settlementNetwork,
    paymentAsset: opts.rail.paymentAsset.toLowerCase(),
    payTo: opts.rail.payTo.toLowerCase(),
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
      // The legal hash the buyer signs is the SELECTED OFFER's — never a
      // global file that may drift out of sync with what the creator signed.
      legalTextHash: offer.legalTextHash,
      // Snapshot for the payout obligation: real money only ever follows the
      // SIGNED offer's wallet as of quote time (round-12).
      payoutWallet: offer.payoutWallet.toLowerCase(),
      effectiveGrant: {
        channels: [use.channel],
        transformations: [...use.transformations],
        territory: use.territory,
        durationDays: use.durationDays
      },
      priceMicro: SALE_PRICE_MICRO,
      platformFeeMicro,
      creatorPayoutMicro,
      price: formatMicroUsdt(SALE_PRICE_MICRO),
      platformFee: formatMicroUsdt(platformFeeMicro),
      creatorPayout: formatMicroUsdt(creatorPayoutMicro),
      currency: "USDT",
      settlementNetwork: opts.rail.settlementNetwork,
      paymentAsset: opts.rail.paymentAsset.toLowerCase(),
      payTo: opts.rail.payTo.toLowerCase(),
      quoteCommitment: commitment,
      quoteExpiresAt,
      idempotencyKey
    }
  };
}
