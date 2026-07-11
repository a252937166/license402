import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/server/domain/index.js";
import { issueCredential, recoverCredentialIssuer } from "../../src/server/license/credential.js";
import { checkLicenseScope } from "../../src/server/license/scopeCheck.js";
import type { LicenseCredential } from "../../src/server/license/types.js";
import {
  BUYER_ADDRESS,
  CREATOR_KEY,
  ISSUER_ADDRESS,
  ISSUER_KEY,
  NOW,
  makeIntent,
  makeOffer,
  makeUse
} from "./fixtures.js";

function issue(overrides: { attributionRequired?: boolean } = {}): LicenseCredential {
  const offer = makeOffer({ policy: { attributionRequired: overrides.attributionRequired ?? false } });
  const use = makeUse();
  const intent = makeIntent(offer);
  return issueCredential({
    offer,
    use,
    authorization: { mode: "eip712_purchase_intent" as const, purchaseIntent: intent },
    environment: "production" as const,
    settlementNetwork: "eip155:196",
    paymentAsset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    orderId: "ord-0001",
    buyerPaymentId: "pay_abc123",
    paymentAuthorizationDigest: sha256Hex("payment-authorization-placeholder"),
    issuedAtSeconds: NOW,
    issuerPrivateKey: ISSUER_KEY,
    statusBaseUrl: "https://license402.axiqo.xyz"
  });
}

function check(
  credential: unknown,
  use: Record<string, unknown>,
  licensee: string = BUYER_ADDRESS
): ReturnType<typeof checkLicenseScope> {
  return checkLicenseScope({
    credential,
    use,
    licensee,
    issuerAddress: ISSUER_ADDRESS,
    nowSeconds: NOW + 3_600
  });
}

describe("credential issuance and scope check", () => {
  it("issues a credential whose issuer signature recovers", () => {
    const credential = issue();
    expect(recoverCredentialIssuer(credential)).toBe(ISSUER_ADDRESS);
    expect(credential.licenseeWallet).toBe(BUYER_ADDRESS);
    expect(credential.grant.expiresAt - credential.grant.issuedAt).toBe(14 * 86_400);
    expect(credential.statusUrl).toBe("https://license402.axiqo.xyz/v1/orders/ord-0001");
    expect(credential.licenseId).toMatch(/^lic-[0-9a-f]{16}$/);
  });

  it("issuance is deterministic for the same inputs", () => {
    expect(issue()).toEqual(issue());
  });

  it("refuses to bridge mismatched consents", () => {
    const offer = makeOffer();
    const other = makeOffer({ offer: { offerId: "off-other-002", nonce: sha256Hex("other-nonce") } });
    const intentForOther = makeIntent(other);
    expect(() =>
      issueCredential({
        offer,
        use: makeUse(),
        authorization: { mode: "eip712_purchase_intent" as const, purchaseIntent: intentForOther },
        environment: "production" as const,
        settlementNetwork: "eip155:196",
        paymentAsset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        orderId: "ord-0002",
        buyerPaymentId: "pay_x",
        paymentAuthorizationDigest: sha256Hex("auth"),
        issuedAtSeconds: NOW,
        issuerPrivateKey: ISSUER_KEY,
        statusBaseUrl: "https://license402.axiqo.xyz"
      })
    ).toThrow(/offerDigest mismatch/);
  });

  it("PERMITTED for a commercial X post within the grant", () => {
    const result = check(issue(), { action: "commercial_social_post", channel: "x" });
    expect(result.decision).toBe("PERMITTED");
    expect(result.currentStatus).toBe("UNKNOWN_OFFLINE");
  });

  it("PERMITTED_WITH_DUTIES when attribution is required", () => {
    const result = check(issue({ attributionRequired: true }), { action: "commercial_social_post", channel: "x" });
    expect(result.decision).toBe("PERMITTED_WITH_DUTIES");
    expect(result.duties[0]?.type).toBe("ATTRIBUTION");
  });

  it("NOT_PERMITTED for model training — the demo beat", () => {
    const result = check(issue(), { action: "model_training" });
    expect(result.decision).toBe("NOT_PERMITTED");
    expect(result.reasonCodes).toEqual(["MODEL_TRAINING_PROHIBITED"]);
  });

  it("grant narrows the offer: unbought channel is NOT_PERMITTED even though the offer allowed it", () => {
    // Offer allows x+linkedin+instagram; the buyer only bought channel x.
    const result = check(issue(), { action: "commercial_social_post", channel: "linkedin" });
    expect(result.decision).toBe("NOT_PERMITTED");
    expect(result.reasonCodes).toEqual(["CHANNEL_NOT_LICENSED"]);
  });

  it("grant narrows transformations: resize was not bought", () => {
    // makeUse buys crop + overlay_text only.
    const result = check(issue(), { action: "resize" });
    expect(result.decision).toBe("NOT_PERMITTED");
    expect(result.reasonCodes).toEqual(["ACTION_NOT_PERMITTED"]);
  });

  it("NOT_PERMITTED after expiry", () => {
    const credential = issue();
    const result = checkLicenseScope({
      credential,
      use: { action: "crop", at: credential.grant.expiresAt + 10 },
      licensee: BUYER_ADDRESS,
      issuerAddress: ISSUER_ADDRESS,
      nowSeconds: NOW
    });
    expect(result.reasonCodes).toEqual(["LICENSE_EXPIRED"]);
  });

  it("INVALID_CREDENTIAL on tamper (policy mutated after issuance)", () => {
    const credential = issue();
    const tampered = { ...credential, policy: { ...credential.policy, modelTraining: true } };
    const result = check(tampered, { action: "model_training" });
    expect(result.decision).toBe("INVALID_CREDENTIAL");
    expect(result.reasonCodes).toEqual(["CREDENTIAL_MALFORMED"]);
  });

  it("INVALID_CREDENTIAL on grant tamper (issuer signature breaks)", () => {
    const credential = issue();
    const tampered = { ...credential, grant: { ...credential.grant, expiresAt: credential.grant.expiresAt + 999 } };
    const result = check(tampered, { action: "crop" });
    expect(result.decision).toBe("INVALID_CREDENTIAL");
    expect(result.reasonCodes).toEqual(["ISSUER_SIGNATURE_INVALID"]);
  });

  it("INVALID_CREDENTIAL when the caller is not the licensee", () => {
    const result = check(issue(), { action: "crop" }, ISSUER_ADDRESS);
    expect(result.decision).toBe("INVALID_CREDENTIAL");
    expect(result.reasonCodes).toEqual(["LICENSEE_MISMATCH"]);
  });

  it("INVALID_CREDENTIAL / INDETERMINATE on malformed inputs (fail closed)", () => {
    expect(check({ nonsense: true }, { action: "crop" }).decision).toBe("INVALID_CREDENTIAL");
    const result = check(issue(), { action: "definitely_not_an_action" });
    expect(result.decision).toBe("INDETERMINATE");
    expect(result.reasonCodes).toEqual(["MISSING_CONTEXT"]);
  });

  it("wrong issuer key yields ISSUER_SIGNATURE_INVALID against expected issuer", () => {
    const offer = makeOffer();
    const credential = issueCredential({
      offer,
      use: makeUse(),
      authorization: { mode: "eip712_purchase_intent" as const, purchaseIntent: makeIntent(offer) },
      environment: "production" as const,
      settlementNetwork: "eip155:196",
      paymentAsset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      orderId: "ord-0003",
      buyerPaymentId: "pay_y",
      paymentAuthorizationDigest: sha256Hex("auth2"),
      issuedAtSeconds: NOW,
      issuerPrivateKey: CREATOR_KEY, // not the expected issuer
      statusBaseUrl: "https://license402.axiqo.xyz"
    });
    const result = check(credential, { action: "crop" });
    expect(result.decision).toBe("INVALID_CREDENTIAL");
    expect(result.reasonCodes).toEqual(["ISSUER_SIGNATURE_INVALID"]);
  });
});
