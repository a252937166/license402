import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalHash, canonicalJson, sha256Hex } from "../domain/index.js";
import { normalizeAddress, privateKeyToAddress, recoverDigestSigner, signDigest } from "./eip712.js";
import { offerDigestHex, policyAstHash, purchaseIntentDigestHex } from "./commitments.js";
import { CREDENTIAL_VERSION, EIP712_DOMAIN, TEMPLATE_ID } from "./vocab.js";
import type {
  CreatorOffer,
  LicenseCredential,
  PurchaseIntent,
  UnsignedLicenseCredential,
  UnsignedLicenseCredentialV2,
  UseSpec
} from "./types.js";

const ISSUER_DIGEST_DOMAIN_V1 = `LICENSE402-CREDENTIAL-V1:${EIP712_DOMAIN.chainId}:`;
const ISSUER_DIGEST_DOMAIN_V2 = `LICENSE402-CREDENTIAL-V2:${EIP712_DOMAIN.chainId}:`;

/**
 * Domain-prefixed keccak digest over canonical credential JSON (issuer
 * signature target). The prefix matches the credential's OWN version — new v2
 * issues sign under CREDENTIAL-V2; already-issued v2 credentials that predate
 * the prefix bump (signed under the V1 prefix) stay verifiable via the
 * fallback in recoverCredentialIssuer.
 */
export function credentialDigest(unsigned: UnsignedLicenseCredential, domainPrefix?: string): Uint8Array {
  const prefix = domainPrefix ?? (unsigned.credentialVersion === "2" ? ISSUER_DIGEST_DOMAIN_V2 : ISSUER_DIGEST_DOMAIN_V1);
  return keccak_256(utf8ToBytes(prefix + canonicalJson(unsigned)));
}

/**
 * How the buyer authorized this purchase (review §3):
 *  - eip712_purchase_intent — the strong two-signature web flow;
 *  - x402_direct — an OKX.AI/A2MCP single paid call, where the EIP-3009
 *    payment signature IS the authorization. No PurchaseIntent exists and
 *    none is fabricated: the credential records the mode and a digest of the
 *    canonical authorization record instead.
 */
export type BuyerAuthorization =
  | { mode: "eip712_purchase_intent"; purchaseIntent: PurchaseIntent }
  | {
      mode: "x402_direct";
      payer: string;
      requestBodyHash: string;
      paymentAuthorizationDigest: string;
      quoteId: string;
      quoteCommitment: string;
    };

export interface IssueCredentialInput {
  offer: CreatorOffer;
  use: UseSpec;
  authorization: BuyerAuthorization;
  environment: "production" | "testnet" | "sample";
  settlementNetwork: string;
  paymentAsset: string;
  orderId: string;
  buyerPaymentId: string;
  paymentAuthorizationDigest: string;
  issuedAtSeconds: number;
  issuerPrivateKey: string;
  statusBaseUrl: string;
}

/**
 * Issues the three-signature credential (spec v4 §0.3). Throws if the signed
 * purchase intent does not reference exactly this offer/policy/legal text —
 * the credential must never bridge mismatched consents.
 */
export function issueCredential(input: IssueCredentialInput): LicenseCredential {
  const { offer, use, authorization } = input;
  const { signature: _sig, ...unsignedOffer } = offer;
  const offerDigest = offerDigestHex(unsignedOffer);
  const astHash = policyAstHash(offer.policy);

  let licensee: string;
  let intentDigest: string;
  let buyerAuthorizationDigest: string;
  if (authorization.mode === "eip712_purchase_intent") {
    const purchaseIntent = authorization.purchaseIntent;
    if (purchaseIntent.offerDigest !== offerDigest) throw new Error("PurchaseIntent.offerDigest mismatch");
    if (purchaseIntent.assetSha256 !== offer.assetSha256) throw new Error("PurchaseIntent.assetSha256 mismatch");
    if (purchaseIntent.policyAstHash !== astHash) throw new Error("PurchaseIntent.policyAstHash mismatch");
    if (purchaseIntent.legalTextHash !== offer.legalTextHash) throw new Error("PurchaseIntent.legalTextHash mismatch");
    if (normalizeAddress(purchaseIntent.buyer) !== normalizeAddress(purchaseIntent.licensee)) {
      throw new Error("MVP requires buyer == licensee");
    }
    licensee = normalizeAddress(purchaseIntent.licensee);
    const { signature: _intentSig, ...unsignedIntent } = purchaseIntent;
    intentDigest = purchaseIntentDigestHex(unsignedIntent);
    buyerAuthorizationDigest = intentDigest;
  } else {
    licensee = normalizeAddress(authorization.payer);
    buyerAuthorizationDigest = canonicalHash(
      {
        mode: authorization.mode,
        payer: licensee,
        requestBodyHash: authorization.requestBodyHash,
        paymentAuthorizationDigest: authorization.paymentAuthorizationDigest,
        quoteId: authorization.quoteId,
        quoteCommitment: authorization.quoteCommitment
      },
      "L402:BUYERAUTH:v1"
    );
    // No PurchaseIntent exists in direct mode; the intent-digest slot carries
    // the buyer-authorization digest for backward-compatible verifiers, and
    // authorizationMode says exactly what it is.
    intentDigest = buyerAuthorizationDigest;
  }
  if (!use.transformations.every((t) => offer.policy.allowedTransformations.includes(t))) {
    throw new Error("Grant transformations exceed offer policy");
  }
  if (!offer.policy.channels.includes(use.channel)) throw new Error("Grant channel exceeds offer policy");

  const issuer = normalizeAddress(privateKeyToAddress(input.issuerPrivateKey));

  const core: Omit<UnsignedLicenseCredentialV2, "licenseId" | "statusUrl"> = {
    credentialVersion: "2",
    templateId: TEMPLATE_ID,
    issuer,
    licensorWallet: normalizeAddress(offer.licensorWallet),
    licenseeWallet: licensee,
    assetSha256: offer.assetSha256,
    policy: offer.policy,
    grant: {
      channels: [use.channel] as ("x" | "linkedin" | "instagram")[],
      transformations: [...use.transformations],
      territory: use.territory,
      issuedAt: input.issuedAtSeconds,
      expiresAt: input.issuedAtSeconds + use.durationDays * 86_400
    },
    legalTextHash: offer.legalTextHash,
    policyAstHash: astHash,
    offerDigest,
    purchaseIntentDigest: intentDigest,
    paymentAuthorizationDigest: input.paymentAuthorizationDigest,
    orderId: input.orderId,
    buyerPaymentId: input.buyerPaymentId,
    credentialEnvironment: input.environment,
    settlementNetwork: input.settlementNetwork,
    paymentAsset: normalizeAddress(input.paymentAsset),
    authorizationMode: authorization.mode,
    buyerAuthorizationDigest
  };

  const licenseId = `lic-${sha256Hex(canonicalJson({ orderId: input.orderId, offerDigest, intentDigest })).slice(2, 18)}`;
  const unsigned: UnsignedLicenseCredentialV2 = {
    ...core,
    licenseId,
    statusUrl: `${input.statusBaseUrl.replace(/\/$/, "")}/v1/orders/${input.orderId}`
  };
  const issuerSignature = signDigest(credentialDigest(unsigned), input.issuerPrivateKey);
  return { ...unsigned, issuerSignature };
}

export function recoverCredentialIssuer(credential: LicenseCredential): string | null {
  const { issuerSignature, ...unsigned } = credential;
  const primary = recoverDigestSigner(credentialDigest(unsigned as UnsignedLicenseCredential), issuerSignature);
  if (primary && primary === credential.issuer.toLowerCase()) return primary;
  // Transition fallback: v2 credentials issued before the prefix bump were
  // signed under the V1 prefix — still authentic, still recoverable.
  if (unsigned.credentialVersion === "2") {
    const legacy = recoverDigestSigner(credentialDigest(unsigned as UnsignedLicenseCredential, ISSUER_DIGEST_DOMAIN_V1), issuerSignature);
    if (legacy && legacy === credential.issuer.toLowerCase()) return legacy;
  }
  return primary;
}
