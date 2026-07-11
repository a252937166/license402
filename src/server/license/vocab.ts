/**
 * Frozen vocabularies for LICENSE402 v1 (spec v4). Adding vocabulary bumps the
 * policy version — existing signed offers and credentials are never reinterpreted.
 */

export const POLICY_VERSION = 1;
export const TEMPLATE_ID = "social-commercial-v1";
export const CREDENTIAL_VERSION = "1";
export const EIP712_DOMAIN = Object.freeze({ name: "LICENSE402", version: "1", chainId: 196 });

export const CHANNELS = Object.freeze({ x: 1, linkedin: 2, instagram: 4 } as const);
export type Channel = keyof typeof CHANNELS;
export const CHANNEL_NAMES = Object.freeze(Object.keys(CHANNELS) as Channel[]);

export const TRANSFORMATIONS = Object.freeze({ crop: 1, resize: 2, overlay_text: 4 } as const);
export type Transformation = keyof typeof TRANSFORMATIONS;
export const TRANSFORMATION_NAMES = Object.freeze(Object.keys(TRANSFORMATIONS) as Transformation[]);

export const TERRITORIES = Object.freeze({ worldwide: 1 } as const);
export type Territory = keyof typeof TERRITORIES;

/** Actions a scope check can ask about. */
export const ACTIONS = Object.freeze([
  "commercial_social_post",
  "crop",
  "resize",
  "overlay_text",
  "model_training",
  "rag_indexing",
  "resale",
  "sublicense",
  "exclusive_use"
] as const);
export type LicenseAction = (typeof ACTIONS)[number];

export type ScopeDecision =
  | "PERMITTED"
  | "PERMITTED_WITH_DUTIES"
  | "NOT_PERMITTED"
  | "INVALID_CREDENTIAL"
  | "INDETERMINATE";

export type CredentialStatus = "ACTIVE" | "UNKNOWN_OFFLINE" | "SUSPENDED" | "REVOKED";

export const REASONS = Object.freeze([
  // scope outcomes
  "ALL_REQUIRED_TERMS_SATISFIED",
  "COMMERCIAL_USE_PERMITTED",
  "CHANNEL_PERMITTED",
  "DURATION_WITHIN_LIMIT",
  "MODEL_TRAINING_PROHIBITED",
  "RAG_INDEXING_PROHIBITED",
  "RESALE_PROHIBITED",
  "SUBLICENSING_PROHIBITED",
  "EXCLUSIVITY_NOT_OFFERED",
  "ACTION_NOT_PERMITTED",
  "CHANNEL_NOT_LICENSED",
  "LICENSE_NOT_YET_VALID",
  "LICENSE_EXPIRED",
  // offer eligibility (quote-time gates)
  "OFFER_SIGNATURE_INVALID",
  "OFFER_NOT_YET_VALID",
  "OFFER_EXPIRED",
  "ASSET_HASH_MISMATCH",
  "COMMERCIAL_USE_PROHIBITED",
  "TERRITORY_NOT_COVERED",
  "DURATION_EXCEEDS_LIMIT",
  "TRANSFORMATION_NOT_ALLOWED",
  "BUDGET_EXCEEDED",
  // credential validity
  "ISSUER_SIGNATURE_INVALID",
  "LICENSEE_MISMATCH",
  "CREDENTIAL_MALFORMED",
  // indeterminate
  "UNSUPPORTED_VERSION",
  "MISSING_CONTEXT"
] as const);
export type ReasonCode = (typeof REASONS)[number];

export type DutyType = "ATTRIBUTION";
export interface Duty {
  type: DutyType;
  text: string;
}

export function maskOf(names: readonly string[], table: Readonly<Record<string, number>>): number {
  let mask = 0;
  for (const name of names) {
    const bit = table[name];
    if (bit === undefined) throw new TypeError(`Unknown vocabulary entry: ${name}`);
    mask |= bit;
  }
  return mask;
}
