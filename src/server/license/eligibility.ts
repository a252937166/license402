import { canonicalHash, computeMerkleRoot } from "../domain/index.js";
import { normalizeAddress, offerToTypedMessage, recoverTypedDataSigner } from "./eip712.js";
import { offerDigestHex, useSpecHash } from "./commitments.js";
import { parseUsdtToMicro } from "./money.js";
import type { ReasonCode } from "./vocab.js";
import type { CreatorOffer, UseSpec } from "./types.js";

export interface GateResult {
  gate: string;
  status: "PASS" | "FAIL";
  reason?: ReasonCode;
  detail: string;
}

export interface EligibilityEvaluation {
  eligible: boolean;
  reasons: ReasonCode[];
  gates: GateResult[];
  offerDigest: string;
  evidenceRoot: string;
  receiptHash: string;
}

export interface EligibilityContext {
  /** sha256 of the stored asset bytes, computed by us — never trusted from the offer. */
  storedAssetSha256: string;
  nowSeconds: number;
  salePriceMicro: number;
}

export function verifyOfferSignature(offer: CreatorOffer): boolean {
  const { signature, ...unsigned } = offer;
  const signer = recoverTypedDataSigner("CreatorOffer", offerToTypedMessage(unsigned), signature);
  return signer !== null && signer === normalizeAddress(offer.licensorWallet);
}

/**
 * Quote-time hard gates (spec v4 §3.1). Every gate is required; failures never
 * average against soft scores. Evaluated per (offer, use) pair; all gates run
 * so the evidence receipt is complete, but the first failures drive `reasons`.
 */
export function evaluateOfferEligibility(
  offer: CreatorOffer,
  use: UseSpec,
  ctx: EligibilityContext
): EligibilityEvaluation {
  const gates: GateResult[] = [];
  const add = (gate: string, pass: boolean, reason: ReasonCode, detail: string): void => {
    gates.push(pass ? { gate, status: "PASS", detail } : { gate, status: "FAIL", reason, detail });
  };

  add(
    "offer-signature",
    verifyOfferSignature(offer),
    "OFFER_SIGNATURE_INVALID",
    "EIP-712 signature recovers to licensorWallet"
  );
  add(
    "offer-not-yet-valid",
    ctx.nowSeconds >= offer.validFrom,
    "OFFER_NOT_YET_VALID",
    `now=${ctx.nowSeconds} validFrom=${offer.validFrom}`
  );
  add("offer-expired", ctx.nowSeconds <= offer.validUntil, "OFFER_EXPIRED", `now=${ctx.nowSeconds} validUntil=${offer.validUntil}`);
  add(
    "asset-hash",
    offer.assetSha256 === ctx.storedAssetSha256,
    "ASSET_HASH_MISMATCH",
    "offer.assetSha256 matches stored asset bytes"
  );
  add("commercial-use", offer.policy.commercialUse, "COMMERCIAL_USE_PROHIBITED", "policy.commercialUse");
  add(
    "channel",
    offer.policy.channels.includes(use.channel),
    "CHANNEL_NOT_LICENSED",
    `requested=${use.channel} licensed=${offer.policy.channels.join(",")}`
  );
  add(
    "territory",
    offer.policy.territory === use.territory,
    "TERRITORY_NOT_COVERED",
    `requested=${use.territory} licensed=${offer.policy.territory}`
  );
  add(
    "duration",
    use.durationDays <= offer.policy.maxDurationDays,
    "DURATION_EXCEEDS_LIMIT",
    `requested=${use.durationDays}d max=${offer.policy.maxDurationDays}d`
  );
  const missingTransforms = use.transformations.filter((t) => !offer.policy.allowedTransformations.includes(t));
  add(
    "transformations",
    missingTransforms.length === 0,
    "TRANSFORMATION_NOT_ALLOWED",
    missingTransforms.length === 0 ? "requested ⊆ allowed" : `not allowed: ${missingTransforms.join(",")}`
  );
  add(
    "no-model-training",
    !use.modelTraining && !offer.policy.modelTraining,
    "MODEL_TRAINING_PROHIBITED",
    "v1 never grants model training"
  );
  add("no-rag-indexing", !use.ragIndexing && !offer.policy.ragIndexing, "RAG_INDEXING_PROHIBITED", "v1 never grants RAG indexing");
  add("no-exclusivity", !use.exclusive, "EXCLUSIVITY_NOT_OFFERED", "v1 never grants exclusivity");
  add(
    "budget",
    ctx.salePriceMicro <= parseUsdtToMicro(use.maxBudget),
    "BUDGET_EXCEEDED",
    `price=${ctx.salePriceMicro}µ budget=${parseUsdtToMicro(use.maxBudget)}µ`
  );
  // A creator-signed net price above the sale price can never be honored — the
  // signed offer must be REJECTED, not silently clamped down.
  add(
    "creator-net-price-within-sale-price",
    parseUsdtToMicro(offer.creatorNetPrice) <= ctx.salePriceMicro,
    "CREATOR_PRICE_EXCEEDS_SALE_PRICE",
    `creatorNet=${parseUsdtToMicro(offer.creatorNetPrice)}µ sale=${ctx.salePriceMicro}µ`
  );

  const reasons = gates.filter((g) => g.status === "FAIL").map((g) => g.reason as ReasonCode);
  const offerDigest = offerDigestHex(offer);
  const specHash = useSpecHash(use);
  const leaves = gates.map((g) =>
    canonicalHash({ offerDigest, useSpecHash: specHash, gate: g.gate, status: g.status, detail: g.detail }, "L402:EVIDENCE:v1")
  );
  const evidenceRoot = computeMerkleRoot(leaves);
  const receiptHash = canonicalHash({ offerDigest, useSpecHash: specHash, evidenceRoot, gates }, "L402:RECEIPT:v1");

  return { eligible: reasons.length === 0, reasons, gates, offerDigest, evidenceRoot, receiptHash };
}
