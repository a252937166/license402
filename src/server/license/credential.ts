import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, sha256Hex } from "../domain/index.js";
import { normalizeAddress, privateKeyToAddress, recoverDigestSigner, signDigest } from "./eip712.js";
import { offerDigestHex, policyAstHash, purchaseIntentDigestHex } from "./commitments.js";
import { CREDENTIAL_VERSION, EIP712_DOMAIN, TEMPLATE_ID } from "./vocab.js";
import type {
  CreatorOffer,
  LicenseCredential,
  PurchaseIntent,
  UnsignedLicenseCredential,
  UseSpec
} from "./types.js";

const ISSUER_DIGEST_DOMAIN = `LICENSE402-CREDENTIAL-V1:${EIP712_DOMAIN.chainId}:`;

/** Domain-prefixed keccak digest over canonical credential JSON (issuer signature target). */
export function credentialDigest(unsigned: UnsignedLicenseCredential): Uint8Array {
  return keccak_256(utf8ToBytes(ISSUER_DIGEST_DOMAIN + canonicalJson(unsigned)));
}

export interface IssueCredentialInput {
  offer: CreatorOffer;
  use: UseSpec;
  purchaseIntent: PurchaseIntent;
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
  const { offer, use, purchaseIntent } = input;
  const { signature: _sig, ...unsignedOffer } = offer;
  const offerDigest = offerDigestHex(unsignedOffer);
  const astHash = policyAstHash(offer.policy);

  if (purchaseIntent.offerDigest !== offerDigest) throw new Error("PurchaseIntent.offerDigest mismatch");
  if (purchaseIntent.assetSha256 !== offer.assetSha256) throw new Error("PurchaseIntent.assetSha256 mismatch");
  if (purchaseIntent.policyAstHash !== astHash) throw new Error("PurchaseIntent.policyAstHash mismatch");
  if (purchaseIntent.legalTextHash !== offer.legalTextHash) throw new Error("PurchaseIntent.legalTextHash mismatch");
  if (normalizeAddress(purchaseIntent.buyer) !== normalizeAddress(purchaseIntent.licensee)) {
    throw new Error("MVP requires buyer == licensee");
  }
  if (!use.transformations.every((t) => offer.policy.allowedTransformations.includes(t))) {
    throw new Error("Grant transformations exceed offer policy");
  }
  if (!offer.policy.channels.includes(use.channel)) throw new Error("Grant channel exceeds offer policy");

  const { signature: _intentSig, ...unsignedIntent } = purchaseIntent;
  const intentDigest = purchaseIntentDigestHex(unsignedIntent);
  const issuer = normalizeAddress(privateKeyToAddress(input.issuerPrivateKey));

  const core: Omit<UnsignedLicenseCredential, "licenseId" | "statusUrl"> = {
    credentialVersion: CREDENTIAL_VERSION,
    templateId: TEMPLATE_ID,
    issuer,
    licensorWallet: normalizeAddress(offer.licensorWallet),
    licenseeWallet: normalizeAddress(purchaseIntent.licensee),
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
    buyerPaymentId: input.buyerPaymentId
  };

  const licenseId = `lic-${sha256Hex(canonicalJson({ orderId: input.orderId, offerDigest, intentDigest })).slice(2, 18)}`;
  const unsigned: UnsignedLicenseCredential = {
    ...core,
    licenseId,
    statusUrl: `${input.statusBaseUrl.replace(/\/$/, "")}/v1/orders/${input.orderId}`
  };
  const issuerSignature = signDigest(credentialDigest(unsigned), input.issuerPrivateKey);
  return { ...unsigned, issuerSignature };
}

export function recoverCredentialIssuer(credential: LicenseCredential): string | null {
  const { issuerSignature, ...unsigned } = credential;
  return recoverDigestSigner(credentialDigest(unsigned), issuerSignature);
}
