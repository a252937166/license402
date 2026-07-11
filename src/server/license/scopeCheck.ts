import { normalizeAddress } from "./eip712.js";
import { policyAstHash } from "./commitments.js";
import { recoverCredentialIssuer } from "./credential.js";
import { evaluateScope } from "./policy.js";
import type { ScopeCheckEntry } from "./policy.js";
import { LicenseCredentialSchema, UseContextSchema } from "./types.js";
import type { LicenseCredential, PolicyV1 } from "./types.js";
import type { CredentialStatus, Duty, ReasonCode, ScopeDecision } from "./vocab.js";

export interface ScopeCheckRequest {
  credential: unknown;
  use: unknown;
  /** Wallet the caller claims to act for; must equal credential.licenseeWallet. */
  licensee: string;
  /** Expected LICENSE402 issuer address (from service configuration). */
  issuerAddress: string;
  nowSeconds: number;
}

export interface ScopeCheckResult {
  decision: ScopeDecision;
  staticScope: ScopeDecision;
  /** Offline engine never claims current validity — the server overlay upgrades this from order state. */
  currentStatus: CredentialStatus;
  reasonCodes: ReasonCode[];
  duties: Duty[];
  checks: ScopeCheckEntry[];
  licenseId?: string;
}

/**
 * The grant narrows the offer policy to what was actually purchased — scope
 * checks must evaluate the effective (granted) policy, never the wider offer.
 */
export function effectivePolicy(credential: LicenseCredential): PolicyV1 {
  return {
    ...credential.policy,
    channels: [...credential.grant.channels],
    allowedTransformations: [...credential.grant.transformations]
  };
}

/** Offline scope check: credential crypto → licensee binding → policy evaluation. Fail closed. */
export function checkLicenseScope(request: ScopeCheckRequest): ScopeCheckResult {
  const checks: ScopeCheckEntry[] = [];
  const invalid = (reason: ReasonCode): ScopeCheckResult => ({
    decision: "INVALID_CREDENTIAL",
    staticScope: "INVALID_CREDENTIAL",
    currentStatus: "UNKNOWN_OFFLINE",
    reasonCodes: [reason],
    duties: [],
    checks
  });

  const parsedCredential = LicenseCredentialSchema.safeParse(request.credential);
  if (!parsedCredential.success) {
    checks.push({ label: "Credential well-formed", status: "FAIL", detail: "schema validation failed" });
    return invalid("CREDENTIAL_MALFORMED");
  }
  checks.push({ label: "Credential well-formed", status: "PASS", detail: "schema ok" });
  const credential = parsedCredential.data;

  if (policyAstHash(credential.policy) !== credential.policyAstHash) {
    checks.push({ label: "Policy hash consistent", status: "FAIL", detail: "policyAstHash mismatch" });
    return { ...invalid("CREDENTIAL_MALFORMED"), licenseId: credential.licenseId };
  }
  checks.push({ label: "Policy hash consistent", status: "PASS", detail: "policyAstHash matches policy" });

  const issuer = recoverCredentialIssuer(credential);
  if (issuer === null || issuer !== normalizeAddress(request.issuerAddress) || issuer !== credential.issuer) {
    checks.push({ label: "Issuer signature", status: "FAIL", detail: "signature does not recover to expected issuer" });
    return { ...invalid("ISSUER_SIGNATURE_INVALID"), licenseId: credential.licenseId };
  }
  checks.push({ label: "Issuer signature", status: "PASS", detail: `issuer=${issuer}` });

  if (normalizeAddress(request.licensee) !== credential.licenseeWallet) {
    checks.push({ label: "Licensee binding", status: "FAIL", detail: "caller is not the licensee" });
    return { ...invalid("LICENSEE_MISMATCH"), licenseId: credential.licenseId };
  }
  checks.push({ label: "Licensee binding", status: "PASS", detail: "licensee matches" });

  const parsedUse = UseContextSchema.safeParse(request.use);
  if (!parsedUse.success) {
    checks.push({ label: "Use context well-formed", status: "FAIL", detail: "schema validation failed" });
    return {
      decision: "INDETERMINATE",
      staticScope: "INDETERMINATE",
      currentStatus: "UNKNOWN_OFFLINE",
      reasonCodes: ["MISSING_CONTEXT"],
      duties: [],
      checks,
      licenseId: credential.licenseId
    };
  }
  checks.push({ label: "Use context well-formed", status: "PASS", detail: "schema ok" });

  const use = { ...parsedUse.data, at: parsedUse.data.at ?? request.nowSeconds };
  const evaluation = evaluateScope(effectivePolicy(credential), credential.grant, use);
  checks.push(...evaluation.checks);

  return {
    decision: evaluation.decision,
    staticScope: evaluation.decision,
    currentStatus: "UNKNOWN_OFFLINE",
    reasonCodes: evaluation.reasonCodes,
    duties: evaluation.duties,
    checks,
    licenseId: credential.licenseId
  };
}
