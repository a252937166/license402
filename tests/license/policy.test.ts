import { describe, expect, it } from "vitest";
import { evaluateScope } from "../../src/server/license/policy.js";
import { NOW, makePolicy } from "./fixtures.js";

const WINDOW = { issuedAt: NOW, expiresAt: NOW + 14 * 86_400 };
const AT = NOW + 3_600;

describe("PolicyV1 scope evaluation", () => {
  it("permits a commercial social post on a licensed channel", () => {
    const result = evaluateScope(makePolicy(), WINDOW, { action: "commercial_social_post", channel: "x", at: AT });
    expect(result.decision).toBe("PERMITTED");
    expect(result.reasonCodes).toContain("ALL_REQUIRED_TERMS_SATISFIED");
    expect(result.reasonCodes).toContain("CHANNEL_PERMITTED");
  });

  it("returns duties when attribution is required", () => {
    const result = evaluateScope(makePolicy({ attributionRequired: true }), WINDOW, {
      action: "commercial_social_post",
      channel: "x",
      at: AT
    });
    expect(result.decision).toBe("PERMITTED_WITH_DUTIES");
    expect(result.duties[0]?.type).toBe("ATTRIBUTION");
  });

  it("denies model training with the precise prohibition code", () => {
    const result = evaluateScope(makePolicy(), WINDOW, { action: "model_training", at: AT });
    expect(result.decision).toBe("NOT_PERMITTED");
    expect(result.reasonCodes).toEqual(["MODEL_TRAINING_PROHIBITED"]);
  });

  it("denies rag/resale/sublicense/exclusive with their codes", () => {
    expect(evaluateScope(makePolicy(), WINDOW, { action: "rag_indexing", at: AT }).reasonCodes).toEqual([
      "RAG_INDEXING_PROHIBITED"
    ]);
    expect(evaluateScope(makePolicy(), WINDOW, { action: "resale", at: AT }).reasonCodes).toEqual(["RESALE_PROHIBITED"]);
    expect(evaluateScope(makePolicy(), WINDOW, { action: "sublicense", at: AT }).reasonCodes).toEqual([
      "SUBLICENSING_PROHIBITED"
    ]);
    expect(evaluateScope(makePolicy(), WINDOW, { action: "exclusive_use", at: AT }).reasonCodes).toEqual([
      "EXCLUSIVITY_NOT_OFFERED"
    ]);
  });

  it("denies outside the validity window", () => {
    expect(
      evaluateScope(makePolicy(), WINDOW, { action: "crop", at: WINDOW.issuedAt - 1 }).reasonCodes
    ).toEqual(["LICENSE_NOT_YET_VALID"]);
    expect(
      evaluateScope(makePolicy(), WINDOW, { action: "crop", at: WINDOW.expiresAt + 1 }).reasonCodes
    ).toEqual(["LICENSE_EXPIRED"]);
  });

  it("denies unlicensed channel and ungranted transformation", () => {
    const narrow = makePolicy({ channels: ["x"], allowedTransformations: ["crop"] });
    expect(
      evaluateScope(narrow, WINDOW, { action: "commercial_social_post", channel: "linkedin", at: AT }).reasonCodes
    ).toEqual(["CHANNEL_NOT_LICENSED"]);
    expect(evaluateScope(narrow, WINDOW, { action: "overlay_text", at: AT }).reasonCodes).toEqual([
      "ACTION_NOT_PERMITTED"
    ]);
  });

  it("is INDETERMINATE (fail closed) on missing context or unsupported version", () => {
    expect(
      evaluateScope(makePolicy(), WINDOW, { action: "commercial_social_post", at: AT }).decision
    ).toBe("INDETERMINATE");
    expect(evaluateScope(makePolicy(), WINDOW, { action: "crop" }).decision).toBe("INDETERMINATE");
    const badVersion = { ...makePolicy(), policyVersion: 2 as unknown as 1 };
    const result = evaluateScope(badVersion, WINDOW, { action: "crop", at: AT });
    expect(result.decision).toBe("INDETERMINATE");
    expect(result.reasonCodes).toEqual(["UNSUPPORTED_VERSION"]);
  });

  it("is deterministic", () => {
    const a = evaluateScope(makePolicy(), WINDOW, { action: "commercial_social_post", channel: "x", at: AT });
    const b = evaluateScope(makePolicy(), WINDOW, { action: "commercial_social_post", channel: "x", at: AT });
    expect(a).toEqual(b);
  });
});
