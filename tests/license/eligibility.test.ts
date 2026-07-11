import { describe, expect, it } from "vitest";
import { canonicalHash, verifyMerkleRoot } from "../../src/server/domain/index.js";
import { useSpecHash } from "../../src/server/license/commitments.js";
import { SALE_PRICE_MICRO } from "../../src/server/license/money.js";
import { evaluateOfferEligibility, verifyOfferSignature } from "../../src/server/license/eligibility.js";
import { ASSET_SHA256, BUYER_KEY, NOW, makeOffer, makeUse } from "./fixtures.js";

const CTX = { storedAssetSha256: ASSET_SHA256, nowSeconds: NOW, salePriceMicro: SALE_PRICE_MICRO };

describe("offer eligibility hard gates", () => {
  it("accepts a fully matching offer and emits a verifiable evidence root", () => {
    const result = evaluateOfferEligibility(makeOffer(), makeUse(), CTX);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.gates.every((g) => g.status === "PASS")).toBe(true);
    expect(result.evidenceRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a tampered offer (signature gate)", () => {
    const offer = makeOffer();
    const tampered = { ...offer, creatorNetPrice: "0.01" };
    expect(verifyOfferSignature(tampered)).toBe(false);
    const result = evaluateOfferEligibility(tampered, makeUse(), CTX);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("OFFER_SIGNATURE_INVALID");
  });

  it("rejects an offer signed by the wrong key", () => {
    const forged = makeOffer({ signingKey: BUYER_KEY });
    expect(evaluateOfferEligibility(forged, makeUse(), CTX).reasons).toContain("OFFER_SIGNATURE_INVALID");
  });

  it("rejects expired and not-yet-valid offers", () => {
    const expired = makeOffer({ offer: { validUntil: NOW - 1 } });
    expect(evaluateOfferEligibility(expired, makeUse(), CTX).reasons).toContain("OFFER_EXPIRED");
    const future = makeOffer({ offer: { validFrom: NOW + 999 } });
    expect(evaluateOfferEligibility(future, makeUse(), CTX).reasons).toContain("OFFER_NOT_YET_VALID");
  });

  it("rejects asset hash mismatch against stored bytes", () => {
    const result = evaluateOfferEligibility(makeOffer(), makeUse(), {
      ...CTX,
      storedAssetSha256: `0x${"ab".repeat(32)}`
    });
    expect(result.reasons).toContain("ASSET_HASH_MISMATCH");
  });

  it("rejects non-commercial offers for this SKU", () => {
    const result = evaluateOfferEligibility(makeOffer({ policy: { commercialUse: false } }), makeUse(), CTX);
    expect(result.reasons).toContain("COMMERCIAL_USE_PROHIBITED");
  });

  it("rejects channel / duration / transformation mismatches with precise codes", () => {
    expect(
      evaluateOfferEligibility(makeOffer({ policy: { channels: ["linkedin"] } }), makeUse(), CTX).reasons
    ).toContain("CHANNEL_NOT_LICENSED");
    expect(evaluateOfferEligibility(makeOffer(), makeUse({ durationDays: 60 }), CTX).reasons).toContain(
      "DURATION_EXCEEDS_LIMIT"
    );
    expect(
      evaluateOfferEligibility(makeOffer({ policy: { allowedTransformations: ["crop"] } }), makeUse(), CTX).reasons
    ).toContain("TRANSFORMATION_NOT_ALLOWED");
  });

  it("never grants training / rag / exclusivity in v1 and enforces budget", () => {
    expect(evaluateOfferEligibility(makeOffer(), makeUse({ modelTraining: true }), CTX).reasons).toContain(
      "MODEL_TRAINING_PROHIBITED"
    );
    expect(evaluateOfferEligibility(makeOffer(), makeUse({ ragIndexing: true }), CTX).reasons).toContain(
      "RAG_INDEXING_PROHIBITED"
    );
    expect(evaluateOfferEligibility(makeOffer(), makeUse({ exclusive: true }), CTX).reasons).toContain(
      "EXCLUSIVITY_NOT_OFFERED"
    );
    expect(evaluateOfferEligibility(makeOffer(), makeUse({ maxBudget: "0.05" }), CTX).reasons).toContain(
      "BUDGET_EXCEEDED"
    );
  });

  it("collects multiple failures in gate order", () => {
    const result = evaluateOfferEligibility(
      makeOffer({ policy: { commercialUse: false } }),
      makeUse({ durationDays: 90 }),
      CTX
    );
    expect(result.reasons).toEqual(["COMMERCIAL_USE_PROHIBITED", "DURATION_EXCEEDS_LIMIT"]);
  });

  it("evidence leaves recompute to the receipt's merkle root", () => {
    const use = makeUse();
    const result = evaluateOfferEligibility(makeOffer(), use, CTX);
    const specHash = useSpecHash(use);
    const leaves = result.gates.map((g) =>
      canonicalHash(
        { offerDigest: result.offerDigest, useSpecHash: specHash, gate: g.gate, status: g.status, detail: g.detail },
        "L402:EVIDENCE:v1"
      )
    );
    expect(verifyMerkleRoot(leaves, result.evidenceRoot)).toBe(true);
  });
});
