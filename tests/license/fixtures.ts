import { sha256Hex } from "../../src/server/domain/index.js";
import {
  offerDigestHex,
  policyAstHash,
  purchaseIntentDigestHex
} from "../../src/server/license/commitments.js";
import {
  offerToTypedMessage,
  privateKeyToAddress,
  purchaseIntentToTypedMessage,
  signTypedData
} from "../../src/server/license/eip712.js";
import {
  CreatorOfferSchema,
  PurchaseIntentSchema,
  UseSpecSchema
} from "../../src/server/license/types.js";
import type {
  CreatorOffer,
  PolicyV1,
  PurchaseIntent,
  UseSpec
} from "../../src/server/license/types.js";

export const CREATOR_KEY = `0x${"11".repeat(32)}`;
export const BUYER_KEY = `0x${"22".repeat(32)}`;
export const ISSUER_KEY = `0x${"33".repeat(32)}`;
export const CREATOR_ADDRESS = privateKeyToAddress(CREATOR_KEY);
export const BUYER_ADDRESS = privateKeyToAddress(BUYER_KEY);
export const ISSUER_ADDRESS = privateKeyToAddress(ISSUER_KEY);

/** 2026-07-12T00:00:00Z */
export const NOW = 1_783_900_800;
export const ASSET_BYTES = "cyberpunk-dragon-png-bytes";
export const ASSET_SHA256 = sha256Hex(ASSET_BYTES);
export const LEGAL_TEXT_HASH = sha256Hex("legal/social-commercial-v1.md placeholder");
export const RIGHTS_ATTESTATION_HASH = sha256Hex("rights attestation placeholder");

export function makePolicy(overrides: Partial<PolicyV1> = {}): PolicyV1 {
  return {
    policyVersion: 1,
    commercialUse: true,
    channels: ["x", "linkedin", "instagram"],
    territory: "worldwide",
    maxDurationDays: 30,
    allowedTransformations: ["crop", "resize", "overlay_text"],
    modelTraining: false,
    ragIndexing: false,
    exclusive: false,
    resale: false,
    sublicensing: false,
    attributionRequired: false,
    ...overrides
  };
}

export function makeUse(overrides: Partial<UseSpec> = {}): UseSpec {
  return UseSpecSchema.parse({
    brief: "cyberpunk dragon on a dark background",
    channel: "x",
    commercial: true,
    durationDays: 14,
    territory: "worldwide",
    transformations: ["crop", "overlay_text"],
    maxBudget: "0.10",
    ...overrides
  });
}

export interface MakeOfferOptions {
  policy?: Partial<PolicyV1>;
  offer?: Partial<Omit<CreatorOffer, "signature" | "policy">>;
  signingKey?: string;
}

export function makeOffer(options: MakeOfferOptions = {}): CreatorOffer {
  const unsigned = {
    offerId: "off-dragon-001",
    offerVersion: 1,
    assetId: "asset-dragon-001",
    assetSha256: ASSET_SHA256,
    mimeType: "image/png" as const,
    licensorWallet: CREATOR_ADDRESS,
    payoutWallet: CREATOR_ADDRESS,
    templateId: "social-commercial-v1" as const,
    legalTextHash: LEGAL_TEXT_HASH,
    policy: makePolicy(options.policy),
    creatorNetPrice: "0.07",
    currency: "USDT" as const,
    rightsAttestationHash: RIGHTS_ATTESTATION_HASH,
    validFrom: NOW - 86_400,
    validUntil: NOW + 30 * 86_400,
    nonce: sha256Hex("offer-nonce-1"),
    ...options.offer
  };
  const signature = signTypedData(
    "CreatorOffer",
    offerToTypedMessage(unsigned),
    options.signingKey ?? CREATOR_KEY
  );
  return CreatorOfferSchema.parse({ ...unsigned, signature });
}

export interface MakeIntentOptions {
  intent?: Partial<Omit<PurchaseIntent, "signature">>;
  signingKey?: string;
}

export function makeIntent(offer: CreatorOffer, options: MakeIntentOptions = {}): PurchaseIntent {
  const { signature: _sig, ...unsignedOffer } = offer;
  const unsigned = {
    quoteId: "quote-0001",
    quoteCommitment: sha256Hex("quote-commitment-placeholder"),
    buyer: BUYER_ADDRESS,
    licensee: BUYER_ADDRESS,
    assetSha256: offer.assetSha256,
    offerDigest: offerDigestHex(unsignedOffer),
    policyAstHash: policyAstHash(offer.policy),
    legalTextHash: offer.legalTextHash,
    totalPrice: "0.10",
    currency: "USDT" as const,
    expiresAt: NOW + 900,
    nonce: sha256Hex("intent-nonce-1"),
    ...options.intent
  };
  const signature = signTypedData(
    "PurchaseIntent",
    purchaseIntentToTypedMessage(unsigned),
    options.signingKey ?? BUYER_KEY
  );
  return PurchaseIntentSchema.parse({ ...unsigned, signature });
}

export { purchaseIntentDigestHex };
