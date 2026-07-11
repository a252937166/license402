import { canonicalHash } from "../domain/index.js";
import { offerToTypedMessage, purchaseIntentToTypedMessage, typedDataDigestHex } from "./eip712.js";
import type { PolicyV1, UnsignedCreatorOffer, UnsignedPurchaseIntent, UseSpec } from "./types.js";

/** sha256 over canonical PolicyV1 JSON — the AST is the semantic source of truth. */
export function policyAstHash(policy: PolicyV1): string {
  return canonicalHash(policy, "L402:POLICY:v1");
}

export function useSpecHash(use: UseSpec): string {
  return canonicalHash(use, "L402:USESPEC:v1");
}

/** EIP-712 typed-data digest of the CreatorOffer — what the creator signed. */
export function offerDigestHex(offer: UnsignedCreatorOffer): string {
  return typedDataDigestHex("CreatorOffer", offerToTypedMessage(offer));
}

/** EIP-712 typed-data digest of the PurchaseIntent — what the buyer signed. */
export function purchaseIntentDigestHex(intent: UnsignedPurchaseIntent): string {
  return typedDataDigestHex("PurchaseIntent", purchaseIntentToTypedMessage(intent));
}

export interface QuoteCommitmentInput {
  offerDigest: string;
  licenseeWallet: string;
  useSpecHash: string;
  priceMicro: number;
  platformFeeMicro: number;
  creatorPayoutMicro: number;
  // Settlement rail is part of the committed terms (v2): a testnet quote and a
  // mainnet quote for the same use are DIFFERENT commitments — different
  // orders, different credentials, no cross-rail collision.
  settlementNetwork: string;
  paymentAsset: string;
  payTo: string;
  quoteExpiresAt: number;
  idempotencyKey: string;
}

/**
 * Payment-before-use lock: the buyer pins this on acquire; any drift returns
 * 409 TERMS_COMMITMENT_CHANGED before a 402 challenge is generated (spec v4).
 */
export function quoteCommitment(input: QuoteCommitmentInput): string {
  return canonicalHash(input, "L402:QUOTE:v2");
}
