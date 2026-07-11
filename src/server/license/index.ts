export * from "./vocab.js";
export * from "./money.js";
export * from "./types.js";
export {
  EIP712_TYPES,
  encodeType,
  typedDataDigest,
  typedDataDigestHex,
  policyToTypedMessage,
  offerToTypedMessage,
  purchaseIntentToTypedMessage,
  normalizeAddress,
  privateKeyToAddress,
  signDigest,
  recoverDigestSigner,
  signTypedData,
  recoverTypedDataSigner
} from "./eip712.js";
export { evaluateScope } from "./policy.js";
export type { GrantWindow, ScopeCheckEntry, ScopeEvaluation } from "./policy.js";
export {
  offerDigestHex,
  policyAstHash,
  purchaseIntentDigestHex,
  quoteCommitment,
  useSpecHash
} from "./commitments.js";
export type { QuoteCommitmentInput } from "./commitments.js";
export { evaluateOfferEligibility, verifyOfferSignature } from "./eligibility.js";
export type { EligibilityContext, EligibilityEvaluation, GateResult } from "./eligibility.js";
export { credentialDigest, issueCredential, recoverCredentialIssuer } from "./credential.js";
export type { IssueCredentialInput } from "./credential.js";
export { checkLicenseScope, effectivePolicy } from "./scopeCheck.js";
export type { ScopeCheckRequest, ScopeCheckResult } from "./scopeCheck.js";
