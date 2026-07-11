import { describe, expect, it } from "vitest";
import {
  offerDigestHex,
  policyAstHash,
  quoteCommitment,
  useSpecHash
} from "../../src/server/license/commitments.js";
import { formatMicroUsdt, parseUsdtToMicro } from "../../src/server/license/money.js";
import { NOW, makeOffer, makePolicy, makeUse } from "./fixtures.js";

describe("money micro-units", () => {
  it("parses plain decimal strings", () => {
    expect(parseUsdtToMicro("0.10")).toBe(100_000);
    expect(parseUsdtToMicro("0.07")).toBe(70_000);
    expect(parseUsdtToMicro("8")).toBe(8_000_000);
    expect(parseUsdtToMicro("0.000001")).toBe(1);
  });

  it("rejects units, negatives and over-precision", () => {
    expect(() => parseUsdtToMicro("10 USDT")).toThrow();
    expect(() => parseUsdtToMicro("-1")).toThrow();
    expect(() => parseUsdtToMicro("0.1234567")).toThrow();
    expect(() => parseUsdtToMicro("")).toThrow();
  });

  it("formats back without trailing zeros", () => {
    expect(formatMicroUsdt(100_000)).toBe("0.1");
    expect(formatMicroUsdt(8_000_000)).toBe("8");
    expect(formatMicroUsdt(30_000)).toBe("0.03");
  });
});

describe("commitments", () => {
  it("policyAstHash is stable across key order and sensitive to values", () => {
    const a = policyAstHash(makePolicy());
    const b = policyAstHash(JSON.parse(JSON.stringify(makePolicy())));
    expect(a).toBe(b);
    expect(policyAstHash(makePolicy({ maxDurationDays: 29 }))).not.toBe(a);
  });

  it("offerDigest changes when any signed field changes", () => {
    const offer = makeOffer();
    const { signature: _s, ...unsigned } = offer;
    const base = offerDigestHex(unsigned);
    expect(offerDigestHex({ ...unsigned, creatorNetPrice: "0.06" })).not.toBe(base);
    expect(offerDigestHex({ ...unsigned, payoutWallet: unsigned.licensorWallet })).toBe(
      offerDigestHex({ ...unsigned, payoutWallet: unsigned.licensorWallet })
    );
  });

  it("quoteCommitment binds every economic field", () => {
    const base = {
      offerDigest: offerDigestHex((({ signature: _s, ...u }) => u)(makeOffer())),
      licenseeWallet: "0x1111111111111111111111111111111111111111",
      useSpecHash: useSpecHash(makeUse()),
      priceMicro: 100_000,
      platformFeeMicro: 30_000,
      creatorPayoutMicro: 70_000,
      settlementNetwork: "eip155:196",
      paymentAsset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      payTo: "0x0000000000000000000000000000000000000402",
      quoteExpiresAt: NOW + 900,
      idempotencyKey: "idem-1"
    };
    const commitment = quoteCommitment(base);
    expect(commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(quoteCommitment({ ...base })).toBe(commitment);
    expect(quoteCommitment({ ...base, priceMicro: 100_001 })).not.toBe(commitment);
    expect(quoteCommitment({ ...base, idempotencyKey: "idem-2" })).not.toBe(commitment);
    expect(quoteCommitment({ ...base, licenseeWallet: "0x2222222222222222222222222222222222222222" })).not.toBe(
      commitment
    );
    // The settlement rail is part of the commitment: a testnet quote is a
    // DIFFERENT commitment than a mainnet quote for the same terms.
    expect(quoteCommitment({ ...base, settlementNetwork: "eip155:1952" })).not.toBe(commitment);
    expect(quoteCommitment({ ...base, payTo: "0x0000000000000000000000000000000000000403" })).not.toBe(commitment);
  });

  it("useSpecHash reflects buyer intent changes", () => {
    expect(useSpecHash(makeUse())).toBe(useSpecHash(makeUse()));
    expect(useSpecHash(makeUse({ durationDays: 15 }))).not.toBe(useSpecHash(makeUse()));
  });
});
