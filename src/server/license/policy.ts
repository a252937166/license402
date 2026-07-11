import type { Duty, LicenseAction, ReasonCode, ScopeDecision } from "./vocab.js";
import type { PolicyV1, UseContext } from "./types.js";

export interface ScopeCheckEntry {
  label: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  detail: string;
}

export interface ScopeEvaluation {
  decision: Extract<ScopeDecision, "PERMITTED" | "PERMITTED_WITH_DUTIES" | "NOT_PERMITTED" | "INDETERMINATE">;
  reasonCodes: ReasonCode[];
  duties: Duty[];
  checks: ScopeCheckEntry[];
}

export interface GrantWindow {
  issuedAt: number;
  expiresAt: number;
}

const PROHIBITION_REASONS: Partial<Record<LicenseAction, ReasonCode>> = {
  model_training: "MODEL_TRAINING_PROHIBITED",
  rag_indexing: "RAG_INDEXING_PROHIBITED",
  resale: "RESALE_PROHIBITED",
  sublicense: "SUBLICENSING_PROHIBITED",
  exclusive_use: "EXCLUSIVITY_NOT_OFFERED"
};

function actionPermitted(policy: PolicyV1, action: LicenseAction): boolean {
  switch (action) {
    case "commercial_social_post":
      return policy.commercialUse;
    case "crop":
    case "resize":
    case "overlay_text":
      return policy.allowedTransformations.includes(action);
    case "model_training":
      return policy.modelTraining;
    case "rag_indexing":
      return policy.ragIndexing;
    case "resale":
      return policy.resale;
    case "sublicense":
      return policy.sublicensing;
    case "exclusive_use":
      return policy.exclusive;
    default:
      return false;
  }
}

/**
 * Deterministic scope evaluation of a proposed use against a PolicyV1 within a
 * grant window. Pure function; the LLM has no authority here (spec v4).
 * Order: version → prohibitions → validity window → action permission → channel.
 * Missing required context yields INDETERMINATE (fail closed), never PERMITTED.
 */
export function evaluateScope(
  policy: PolicyV1,
  window: GrantWindow,
  use: UseContext,
  options: { attributionText?: string } = {}
): ScopeEvaluation {
  const checks: ScopeCheckEntry[] = [];
  const finish = (
    decision: ScopeEvaluation["decision"],
    reasonCodes: ReasonCode[],
    duties: Duty[] = []
  ): ScopeEvaluation => ({ decision, reasonCodes, duties, checks });

  if (policy.policyVersion !== 1) {
    checks.push({ label: "Policy version supported", status: "FAIL", detail: `policyVersion=${policy.policyVersion}` });
    return finish("INDETERMINATE", ["UNSUPPORTED_VERSION"]);
  }
  checks.push({ label: "Policy version supported", status: "PASS", detail: "policyVersion=1" });

  const prohibition = PROHIBITION_REASONS[use.action];
  if (prohibition && !actionPermitted(policy, use.action)) {
    checks.push({ label: `Action '${use.action}' not prohibited`, status: "FAIL", detail: prohibition });
    return finish("NOT_PERMITTED", [prohibition]);
  }
  checks.push({ label: `Action '${use.action}' not prohibited`, status: "PASS", detail: "no prohibition applies" });

  if (use.at === undefined) {
    checks.push({ label: "Evaluation time provided", status: "FAIL", detail: "missing 'at'" });
    return finish("INDETERMINATE", ["MISSING_CONTEXT"]);
  }
  if (use.at < window.issuedAt) {
    checks.push({ label: "License validity window", status: "FAIL", detail: `at=${use.at} < issuedAt=${window.issuedAt}` });
    return finish("NOT_PERMITTED", ["LICENSE_NOT_YET_VALID"]);
  }
  if (use.at > window.expiresAt) {
    checks.push({ label: "License validity window", status: "FAIL", detail: `at=${use.at} > expiresAt=${window.expiresAt}` });
    return finish("NOT_PERMITTED", ["LICENSE_EXPIRED"]);
  }
  checks.push({ label: "License validity window", status: "PASS", detail: "within issuedAt..expiresAt" });

  if (!actionPermitted(policy, use.action)) {
    checks.push({ label: `Action '${use.action}' permitted`, status: "FAIL", detail: "not granted by policy" });
    return finish("NOT_PERMITTED", ["ACTION_NOT_PERMITTED"]);
  }
  checks.push({ label: `Action '${use.action}' permitted`, status: "PASS", detail: "granted by policy" });

  const reasonCodes: ReasonCode[] = ["ALL_REQUIRED_TERMS_SATISFIED"];
  if (use.action === "commercial_social_post") {
    if (!use.channel) {
      checks.push({ label: "Channel provided", status: "FAIL", detail: "commercial_social_post requires a channel" });
      return finish("INDETERMINATE", ["MISSING_CONTEXT"]);
    }
    if (!policy.channels.includes(use.channel)) {
      checks.push({ label: `Channel '${use.channel}' licensed`, status: "FAIL", detail: `licensed: ${policy.channels.join(",")}` });
      return finish("NOT_PERMITTED", ["CHANNEL_NOT_LICENSED"]);
    }
    checks.push({ label: `Channel '${use.channel}' licensed`, status: "PASS", detail: "channel within grant" });
    reasonCodes.push("COMMERCIAL_USE_PERMITTED", "CHANNEL_PERMITTED");
  }

  if (policy.attributionRequired) {
    const duty: Duty = {
      type: "ATTRIBUTION",
      text: options.attributionText ?? "Attribution required: credit the licensor when publishing."
    };
    checks.push({ label: "Duties", status: "PASS", detail: "ATTRIBUTION_REQUIRED" });
    return finish("PERMITTED_WITH_DUTIES", reasonCodes, [duty]);
  }

  return finish("PERMITTED", reasonCodes);
}
