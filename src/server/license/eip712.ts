import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { CHANNELS, EIP712_DOMAIN, TERRITORIES, TRANSFORMATIONS, maskOf } from "./vocab.js";
import { parseUsdtToMicro } from "./money.js";
import { ADDRESS_PATTERN } from "./types.js";
import type { PolicyV1, UnsignedCreatorOffer, UnsignedPurchaseIntent } from "./types.js";

/**
 * Minimal, explicit EIP-712 implementation for the LICENSE402 typed messages.
 * Differential-tested against viem's hashTypedData in tests/license/eip712.test.ts.
 */

type FieldType = "string" | "bytes32" | "address" | "bool" | "uint8" | "uint32" | "uint64" | "uint256" | "PolicyV1";
interface FieldDef {
  name: string;
  type: FieldType;
}

export const EIP712_TYPES: Record<string, readonly FieldDef[]> = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }
  ],
  PolicyV1: [
    { name: "policyVersion", type: "uint32" },
    { name: "commercialUse", type: "bool" },
    { name: "channelsMask", type: "uint32" },
    { name: "territory", type: "uint8" },
    { name: "maxDurationDays", type: "uint32" },
    { name: "transformationsMask", type: "uint32" },
    { name: "modelTraining", type: "bool" },
    { name: "ragIndexing", type: "bool" },
    { name: "exclusive", type: "bool" },
    { name: "resale", type: "bool" },
    { name: "sublicensing", type: "bool" },
    { name: "attributionRequired", type: "bool" }
  ],
  CreatorOffer: [
    { name: "offerId", type: "string" },
    { name: "offerVersion", type: "uint32" },
    { name: "assetId", type: "string" },
    { name: "assetSha256", type: "bytes32" },
    { name: "mimeType", type: "string" },
    { name: "licensorWallet", type: "address" },
    { name: "payoutWallet", type: "address" },
    { name: "templateId", type: "string" },
    { name: "legalTextHash", type: "bytes32" },
    { name: "policy", type: "PolicyV1" },
    { name: "creatorNetPriceMicro", type: "uint256" },
    { name: "currency", type: "string" },
    { name: "rightsAttestationHash", type: "bytes32" },
    { name: "validFrom", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "bytes32" }
  ],
  PurchaseIntent: [
    { name: "quoteId", type: "string" },
    { name: "quoteCommitment", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "licensee", type: "address" },
    { name: "assetSha256", type: "bytes32" },
    { name: "offerDigest", type: "bytes32" },
    { name: "policyAstHash", type: "bytes32" },
    { name: "legalTextHash", type: "bytes32" },
    { name: "totalPriceMicro", type: "uint256" },
    { name: "currency", type: "string" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" }
  ]
};

export type TypedValue = string | number | bigint | boolean | Record<string, unknown>;
export type TypedMessage = Record<string, TypedValue>;

function isStructType(type: FieldType): boolean {
  return type === "PolicyV1";
}

/** EIP-712 encodeType: primary type first, referenced struct types appended sorted by name. */
export function encodeType(typeName: string): string {
  const referenced = new Set<string>();
  const visit = (name: string): void => {
    for (const field of EIP712_TYPES[name] ?? []) {
      if (isStructType(field.type) && field.type !== name && !referenced.has(field.type)) {
        referenced.add(field.type);
        visit(field.type);
      }
    }
  };
  visit(typeName);
  const render = (name: string): string =>
    `${name}(${(EIP712_TYPES[name] ?? []).map((f) => `${f.type} ${f.name}`).join(",")})`;
  return render(typeName) + [...referenced].sort().map(render).join("");
}

export function typeHash(typeName: string): Uint8Array {
  return keccak_256(utf8ToBytes(encodeType(typeName)));
}

function encodeUint(value: string | number | bigint, bits: number): Uint8Array {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n || big >= 1n << BigInt(bits)) throw new TypeError(`uint${bits} out of range: ${big}`);
  const out = new Uint8Array(32);
  let cursor = big;
  for (let index = 31; index >= 0 && cursor > 0n; index -= 1) {
    out[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return out;
}

function encodeAtom(type: FieldType, value: TypedValue): Uint8Array {
  switch (type) {
    case "string":
      if (typeof value !== "string") throw new TypeError("string field requires a string value");
      return keccak_256(utf8ToBytes(value));
    case "bytes32": {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new TypeError("bytes32 field requires a 0x-prefixed 32-byte hex value");
      }
      return hexToBytes(value.slice(2));
    }
    case "address": {
      if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
        throw new TypeError("address field requires a 20-byte hex address");
      }
      const out = new Uint8Array(32);
      out.set(hexToBytes(value.slice(2)), 12);
      return out;
    }
    case "bool":
      if (typeof value !== "boolean") throw new TypeError("bool field requires a boolean value");
      return encodeUint(value ? 1n : 0n, 8);
    case "uint8":
      return encodeUint(value as string | number | bigint, 8);
    case "uint32":
      return encodeUint(value as string | number | bigint, 32);
    case "uint64":
      return encodeUint(value as string | number | bigint, 64);
    case "uint256":
      return encodeUint(value as string | number | bigint, 256);
    case "PolicyV1":
      return hashStruct("PolicyV1", value as TypedMessage);
    default:
      throw new TypeError(`Unsupported field type: ${type satisfies never}`);
  }
}

export function hashStruct(typeName: string, message: TypedMessage): Uint8Array {
  const fields = EIP712_TYPES[typeName];
  if (!fields) throw new TypeError(`Unknown struct type: ${typeName}`);
  const chunks: Uint8Array[] = [typeHash(typeName)];
  for (const field of fields) {
    const value = message[field.name];
    if (value === undefined) throw new TypeError(`Missing field ${typeName}.${field.name}`);
    chunks.push(encodeAtom(field.type, value));
  }
  return keccak_256(concatBytes(...chunks));
}

export function domainSeparator(): Uint8Array {
  return hashStruct("EIP712Domain", {
    name: EIP712_DOMAIN.name,
    version: EIP712_DOMAIN.version,
    chainId: BigInt(EIP712_DOMAIN.chainId)
  });
}

export function typedDataDigest(primaryType: string, message: TypedMessage): Uint8Array {
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator(), hashStruct(primaryType, message)));
}

export function typedDataDigestHex(primaryType: string, message: TypedMessage): string {
  return `0x${bytesToHex(typedDataDigest(primaryType, message))}`;
}

// ---------------------------------------------------------------------------
// Message builders (JSON model → typed message)
// ---------------------------------------------------------------------------

export function policyToTypedMessage(policy: PolicyV1): TypedMessage {
  return {
    policyVersion: policy.policyVersion,
    commercialUse: policy.commercialUse,
    channelsMask: maskOf(policy.channels, CHANNELS),
    territory: TERRITORIES[policy.territory],
    maxDurationDays: policy.maxDurationDays,
    transformationsMask: maskOf(policy.allowedTransformations, TRANSFORMATIONS),
    modelTraining: policy.modelTraining,
    ragIndexing: policy.ragIndexing,
    exclusive: policy.exclusive,
    resale: policy.resale,
    sublicensing: policy.sublicensing,
    attributionRequired: policy.attributionRequired
  };
}

export function offerToTypedMessage(offer: UnsignedCreatorOffer): TypedMessage {
  return {
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    assetId: offer.assetId,
    assetSha256: offer.assetSha256,
    mimeType: offer.mimeType,
    licensorWallet: offer.licensorWallet,
    payoutWallet: offer.payoutWallet,
    templateId: offer.templateId,
    legalTextHash: offer.legalTextHash,
    policy: policyToTypedMessage(offer.policy),
    creatorNetPriceMicro: BigInt(parseUsdtToMicro(offer.creatorNetPrice)),
    currency: offer.currency,
    rightsAttestationHash: offer.rightsAttestationHash,
    validFrom: offer.validFrom,
    validUntil: offer.validUntil,
    nonce: offer.nonce
  };
}

export function purchaseIntentToTypedMessage(intent: UnsignedPurchaseIntent): TypedMessage {
  return {
    quoteId: intent.quoteId,
    quoteCommitment: intent.quoteCommitment,
    buyer: intent.buyer,
    licensee: intent.licensee,
    assetSha256: intent.assetSha256,
    offerDigest: intent.offerDigest,
    policyAstHash: intent.policyAstHash,
    legalTextHash: intent.legalTextHash,
    totalPriceMicro: BigInt(parseUsdtToMicro(intent.totalPrice)),
    currency: intent.currency,
    expiresAt: intent.expiresAt,
    nonce: intent.nonce
  };
}

// ---------------------------------------------------------------------------
// Keys, signatures (Ethereum 65-byte r||s||v with v ∈ {27,28})
// ---------------------------------------------------------------------------

export function normalizeAddress(address: string): string {
  if (!ADDRESS_PATTERN.test(address)) throw new TypeError(`Invalid address: ${address}`);
  return address.toLowerCase();
}

function normalizePrivateKey(privateKey: string): Uint8Array {
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new TypeError("Private key must be 32 bytes of hex");
  return hexToBytes(hex);
}

export function privateKeyToAddress(privateKey: string): string {
  const publicKey = secp256k1.getPublicKey(normalizePrivateKey(privateKey), false);
  return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

export function signDigest(digest: Uint8Array, privateKey: string): string {
  const signed = secp256k1.sign(digest, normalizePrivateKey(privateKey), {
    prehash: false,
    format: "recovered"
  }) as unknown as Uint8Array;
  // noble "recovered" layout is [recid, r, s]; Ethereum expects r||s||v with v = recid + 27.
  const recid = signed[0];
  const rs = signed.subarray(1);
  return `0x${bytesToHex(rs)}${(recid + 27).toString(16).padStart(2, "0")}`;
}

export function recoverDigestSigner(digest: Uint8Array, signature: string): string | null {
  try {
    const raw = hexToBytes(signature.startsWith("0x") ? signature.slice(2) : signature);
    if (raw.length !== 65) return null;
    let recid = raw[64];
    if (recid >= 27) recid -= 27;
    if (recid !== 0 && recid !== 1) return null;
    const nobleRecovered = concatBytes(Uint8Array.of(recid), raw.subarray(0, 64));
    const sig = secp256k1.Signature.fromBytes(nobleRecovered, "recovered");
    const publicKey = sig.recoverPublicKey(digest).toBytes(false);
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

export function signTypedData(primaryType: string, message: TypedMessage, privateKey: string): string {
  return signDigest(typedDataDigest(primaryType, message), privateKey);
}

export function recoverTypedDataSigner(
  primaryType: string,
  message: TypedMessage,
  signature: string
): string | null {
  return recoverDigestSigner(typedDataDigest(primaryType, message), signature);
}
