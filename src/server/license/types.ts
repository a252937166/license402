import { z } from "zod";
import {
  ACTIONS,
  CHANNEL_NAMES,
  CREDENTIAL_VERSIONS,
  TEMPLATE_ID,
  TRANSFORMATION_NAMES
} from "./vocab.js";
import { USDT_DECIMAL_PATTERN } from "./money.js";

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const HASH32_PATTERN = /^0x[0-9a-f]{64}$/;
export const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{3,63}$/;

const address = z.string().regex(ADDRESS_PATTERN);
const hash32 = z.string().regex(HASH32_PATTERN);
const signature = z.string().regex(SIGNATURE_PATTERN);
const id = z.string().regex(ID_PATTERN);
const usdt = z.string().regex(USDT_DECIMAL_PATTERN);
const unixSeconds = z.number().int().min(0).max(4_102_444_800); // ≤ 2100-01-01

/**
 * Canonical PolicyV1 AST — the machine-executable projection of the versioned
 * legal text. On conflict the legal text prevails (spec v4 §0.4).
 */
export const PolicyV1Schema = z.strictObject({
  policyVersion: z.literal(1),
  commercialUse: z.boolean(),
  channels: z.array(z.enum(CHANNEL_NAMES)).min(1).max(CHANNEL_NAMES.length),
  territory: z.literal("worldwide"),
  maxDurationDays: z.number().int().min(1).max(3650),
  allowedTransformations: z.array(z.enum(TRANSFORMATION_NAMES)).max(TRANSFORMATION_NAMES.length),
  modelTraining: z.boolean(),
  ragIndexing: z.boolean(),
  exclusive: z.boolean(),
  resale: z.boolean(),
  sublicensing: z.boolean(),
  attributionRequired: z.boolean()
});
export type PolicyV1 = z.infer<typeof PolicyV1Schema>;

/** Buyer's purchase-time intent. An LLM may draft it upstream; only parsed UseSpecs enter the engine. */
export const UseSpecSchema = z.strictObject({
  brief: z.string().min(3).max(500),
  channel: z.enum(CHANNEL_NAMES),
  commercial: z.literal(true),
  durationDays: z.number().int().min(1).max(3650),
  territory: z.literal("worldwide"),
  transformations: z.array(z.enum(TRANSFORMATION_NAMES)).max(TRANSFORMATION_NAMES.length).default([]),
  modelTraining: z.boolean().default(false),
  ragIndexing: z.boolean().default(false),
  exclusive: z.boolean().default(false),
  maxBudget: usdt
});
export type UseSpec = z.infer<typeof UseSpecSchema>;

/** Scope-check-time question: "may I do X (on channel C) at time T?" */
export const UseContextSchema = z.strictObject({
  action: z.enum(ACTIONS),
  channel: z.enum(CHANNEL_NAMES).optional(),
  at: unixSeconds.optional()
});
export type UseContext = z.infer<typeof UseContextSchema>;

/** Creator-signed immutable supply. EIP-712 signature by licensorWallet (spec v4 §0.2/0.3). */
export const CreatorOfferSchema = z.strictObject({
  offerId: id,
  offerVersion: z.number().int().min(1).max(1_000_000),
  assetId: id,
  assetSha256: hash32,
  mimeType: z.enum(["image/png", "image/jpeg"]),
  licensorWallet: address,
  payoutWallet: address,
  templateId: z.literal(TEMPLATE_ID),
  legalTextHash: hash32,
  policy: PolicyV1Schema,
  creatorNetPrice: usdt,
  currency: z.literal("USDT"),
  rightsAttestationHash: hash32,
  validFrom: unixSeconds,
  validUntil: unixSeconds,
  nonce: hash32,
  signature
});
export type CreatorOffer = z.infer<typeof CreatorOfferSchema>;
export type UnsignedCreatorOffer = Omit<CreatorOffer, "signature">;

/** Buyer-signed EIP-712 purchase intent — binds the payment to exactly what it buys. */
export const PurchaseIntentSchema = z.strictObject({
  quoteId: id,
  quoteCommitment: hash32,
  buyer: address,
  licensee: address,
  assetSha256: hash32,
  offerDigest: hash32,
  policyAstHash: hash32,
  legalTextHash: hash32,
  totalPrice: usdt,
  currency: z.literal("USDT"),
  // Payment-rail binding (review §2/§8): the buyer signs WHICH chain, WHICH
  // token, and WHO gets paid — a testnet intent can never settle a mainnet
  // purchase, and a swapped payTo invalidates the signature.
  settlementNetwork: z.string().regex(/^eip155:\d+$/),
  paymentAsset: address,
  payTo: address,
  creatorPayoutMicro: z.number().int().nonnegative(),
  platformFeeMicro: z.number().int().nonnegative(),
  expiresAt: unixSeconds,
  nonce: hash32,
  signature
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;
export type UnsignedPurchaseIntent = Omit<PurchaseIntent, "signature">;

/** How the buyer authorized a purchase — the union the credential records. */
export type AuthorizationMode = "eip712_purchase_intent" | "x402_direct";

/**
 * License credential v2 (spec v4 §0.3): three-signature model — this document
 * carries the ISSUER signature and references the creator-signed offer digest
 * and buyer-signed purchase-intent digest. No settlement tx hashes in here;
 * final settlement truth lives at statusUrl (`GET /v1/orders/:orderId`).
 */
const credentialCommonFields = {
  licenseId: id,
  templateId: z.literal(TEMPLATE_ID),
  issuer: address,
  licensorWallet: address,
  licenseeWallet: address,
  assetSha256: hash32,
  policy: PolicyV1Schema,
  grant: z.strictObject({
    channels: z.array(z.enum(CHANNEL_NAMES)).min(1),
    transformations: z.array(z.enum(TRANSFORMATION_NAMES)),
    territory: z.literal("worldwide"),
    issuedAt: unixSeconds,
    expiresAt: unixSeconds
  }),
  legalTextHash: hash32,
  policyAstHash: hash32,
  offerDigest: hash32,
  purchaseIntentDigest: hash32,
  paymentAuthorizationDigest: hash32,
  orderId: id,
  buyerPaymentId: z.string().min(1).max(128),
  statusUrl: z.string().url().max(512),
  issuerSignature: signature
} as const;

/** v1: pre-rail credentials — environment/rail/authorization fields optional
 *  (some late-v1 credentials carry them, early ones don't; both verify). */
export const LicenseCredentialV1Schema = z.strictObject({
  ...credentialCommonFields,
  credentialVersion: z.literal("1"),
  credentialEnvironment: z.enum(["production", "testnet", "sample"]).optional(),
  settlementNetwork: z.string().regex(/^eip155:\d+$/).optional(),
  paymentAsset: address.optional(),
  authorizationMode: z.enum(["eip712_purchase_intent", "x402_direct"]).optional(),
  buyerAuthorizationDigest: hash32.optional()
});

/** v2: environment, rail and authorization semantics are REQUIRED — a v2
 *  credential that omits them is invalid, not "defaulted" (round-11 §8.3). */
export const LicenseCredentialV2Schema = z.strictObject({
  ...credentialCommonFields,
  credentialVersion: z.literal("2"),
  credentialEnvironment: z.enum(["production", "testnet", "sample"]),
  settlementNetwork: z.string().regex(/^eip155:\d+$/),
  paymentAsset: address,
  authorizationMode: z.enum(["eip712_purchase_intent", "x402_direct"]),
  buyerAuthorizationDigest: hash32
});

export const LicenseCredentialSchema = z.discriminatedUnion("credentialVersion", [
  LicenseCredentialV1Schema,
  LicenseCredentialV2Schema
]);
export type LicenseCredential = z.infer<typeof LicenseCredentialSchema>;
// Distribute Omit over the version union (plain Omit would collapse it).
type OmitSig<T> = T extends unknown ? Omit<T, "issuerSignature"> : never;
export type UnsignedLicenseCredential = OmitSig<LicenseCredential>;
export type LicenseCredentialV2 = z.infer<typeof LicenseCredentialV2Schema>;
export type UnsignedLicenseCredentialV2 = Omit<LicenseCredentialV2, "issuerSignature">;
