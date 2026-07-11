import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import {
  EIP712_TYPES,
  encodeType,
  offerToTypedMessage,
  privateKeyToAddress,
  purchaseIntentToTypedMessage,
  recoverTypedDataSigner,
  signTypedData,
  typedDataDigestHex
} from "../../src/server/license/eip712.js";
import { EIP712_DOMAIN } from "../../src/server/license/vocab.js";
import { BUYER_ADDRESS, BUYER_KEY, CREATOR_ADDRESS, CREATOR_KEY, makeIntent, makeOffer } from "./fixtures.js";

/** viem-compatible type definitions (same field order as EIP712_TYPES). */
const VIEM_TYPES = {
  PolicyV1: EIP712_TYPES.PolicyV1.map((f) => ({ name: f.name, type: f.type })),
  CreatorOffer: EIP712_TYPES.CreatorOffer.map((f) => ({ name: f.name, type: f.type })),
  PurchaseIntent: EIP712_TYPES.PurchaseIntent.map((f) => ({ name: f.name, type: f.type }))
} as const;

const VIEM_DOMAIN = {
  name: EIP712_DOMAIN.name,
  version: EIP712_DOMAIN.version,
  chainId: BigInt(EIP712_DOMAIN.chainId)
} as const;

function toViemMessage(message: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    out[key] =
      value !== null && typeof value === "object" && !(value instanceof Uint8Array)
        ? toViemMessage(value as Record<string, unknown>)
        : value;
  }
  return out;
}

describe("EIP-712 implementation", () => {
  it("derives the canonical address for the well-known private key 0x...01", () => {
    expect(privateKeyToAddress(`0x${"00".repeat(31)}01`)).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });

  it("encodes types with referenced structs appended", () => {
    expect(encodeType("PurchaseIntent").startsWith("PurchaseIntent(")).toBe(true);
    expect(encodeType("CreatorOffer")).toContain(")PolicyV1(");
  });

  it("matches viem hashTypedData for CreatorOffer (differential)", () => {
    const offer = makeOffer();
    const { signature: _sig, ...unsigned } = offer;
    const message = offerToTypedMessage(unsigned);
    const ours = typedDataDigestHex("CreatorOffer", message);
    const theirs = hashTypedData({
      domain: VIEM_DOMAIN,
      types: VIEM_TYPES,
      primaryType: "CreatorOffer",
      message: toViemMessage(message) as never
    });
    expect(ours).toBe(theirs.toLowerCase());
  });

  it("matches viem hashTypedData for PurchaseIntent (differential)", () => {
    const offer = makeOffer();
    const intent = makeIntent(offer);
    const { signature: _sig, ...unsigned } = intent;
    const message = purchaseIntentToTypedMessage(unsigned);
    const ours = typedDataDigestHex("PurchaseIntent", message);
    const theirs = hashTypedData({
      domain: VIEM_DOMAIN,
      types: VIEM_TYPES,
      primaryType: "PurchaseIntent",
      message: toViemMessage(message) as never
    });
    expect(ours).toBe(theirs.toLowerCase());
  });

  it("produces signatures viem can recover (cross-recovery, both domain versions)", async () => {
    // Current domain (v2): an offerVersion-2 offer recovers under version "2".
    const offer = makeOffer({ offer: { offerVersion: 2 } });
    const { signature, ...unsigned } = offer;
    const recovered = await recoverTypedDataAddress({
      domain: VIEM_DOMAIN,
      types: VIEM_TYPES,
      primaryType: "CreatorOffer",
      message: toViemMessage(offerToTypedMessage(unsigned)) as never,
      signature: signature as `0x${string}`
    });
    expect(recovered.toLowerCase()).toBe(CREATOR_ADDRESS);

    // Historical domain (v1): archived offerVersion-1 offers stay recoverable
    // under version "1" forever — the compatibility promise of round-10.
    const offerV1 = makeOffer();
    const { signature: sigV1, ...unsignedV1 } = offerV1;
    const recoveredV1 = await recoverTypedDataAddress({
      domain: { ...VIEM_DOMAIN, version: "1" },
      types: VIEM_TYPES,
      primaryType: "CreatorOffer",
      message: toViemMessage(offerToTypedMessage(unsignedV1)) as never,
      signature: sigV1 as `0x${string}`
    });
    expect(recoveredV1.toLowerCase()).toBe(CREATOR_ADDRESS);
  });

  it("sign/recover roundtrip and tamper detection", () => {
    const offer = makeOffer();
    const intent = makeIntent(offer);
    const { signature, ...unsigned } = intent;
    const message = purchaseIntentToTypedMessage(unsigned);
    expect(recoverTypedDataSigner("PurchaseIntent", message, signature)).toBe(BUYER_ADDRESS);

    const tampered = purchaseIntentToTypedMessage({ ...unsigned, totalPrice: "9.99" });
    expect(recoverTypedDataSigner("PurchaseIntent", tampered, signature)).not.toBe(BUYER_ADDRESS);
    expect(recoverTypedDataSigner("PurchaseIntent", message, `0x${"00".repeat(65)}`)).toBeNull();
  });

  it("different keys yield different signers", () => {
    const offer = makeOffer();
    const { signature: _sig, ...unsigned } = offer;
    const message = offerToTypedMessage(unsigned);
    const forged = signTypedData("CreatorOffer", message, BUYER_KEY);
    expect(recoverTypedDataSigner("CreatorOffer", message, forged)).toBe(BUYER_ADDRESS);
    expect(recoverTypedDataSigner("CreatorOffer", message, forged)).not.toBe(CREATOR_ADDRESS);
  });
});
