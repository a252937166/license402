/**
 * R4 compatibility probe: can the OKX Agentic Wallet sign our PurchaseIntent
 * EIP-712 typed data, and does the signature recover to the wallet address
 * under OUR implementation?
 *
 * Usage:
 *   tsx scripts/test-eip712-wallet.ts payload   # print eth_signTypedData_v4 JSON
 *   tsx scripts/test-eip712-wallet.ts recover <signature>
 */
import { sha256Hex } from "../src/server/domain/index.js";
import {
  EIP712_TYPES,
  purchaseIntentToTypedMessage,
  recoverTypedDataSigner
} from "../src/server/license/eip712.js";
import { EIP712_DOMAIN } from "../src/server/license/vocab.js";
import type { UnsignedPurchaseIntent } from "../src/server/license/types.js";

const AGENTIC_WALLET = "0x2e9c240e80acef59c304eb6b3854fcb357b0ecde";

const intent: UnsignedPurchaseIntent = {
  quoteId: "quote-r4-probe",
  quoteCommitment: sha256Hex("r4-probe-quote"),
  buyer: AGENTIC_WALLET,
  licensee: AGENTIC_WALLET,
  assetSha256: sha256Hex("r4-probe-asset"),
  offerDigest: sha256Hex("r4-probe-offer"),
  policyAstHash: sha256Hex("r4-probe-policy"),
  legalTextHash: sha256Hex("r4-probe-legal"),
  totalPrice: "0.10",
  currency: "USDT",
  expiresAt: 1_784_000_000,
  nonce: sha256Hex("r4-probe-nonce")
};

const message = purchaseIntentToTypedMessage(intent);
const jsonSafeMessage = Object.fromEntries(
  Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
);

const payload = {
  types: {
    EIP712Domain: EIP712_TYPES.EIP712Domain.map((f) => ({ name: f.name, type: f.type })),
    PurchaseIntent: EIP712_TYPES.PurchaseIntent.map((f) => ({ name: f.name, type: f.type }))
  },
  primaryType: "PurchaseIntent",
  domain: { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version, chainId: EIP712_DOMAIN.chainId },
  message: jsonSafeMessage
};

const mode = process.argv[2];
if (mode === "payload") {
  console.log(JSON.stringify(payload));
} else if (mode === "recover") {
  const signature = process.argv[3];
  if (!signature) throw new Error("usage: recover <signature>");
  const signer = recoverTypedDataSigner("PurchaseIntent", message, signature);
  console.log(JSON.stringify({ signer, expected: AGENTIC_WALLET, match: signer === AGENTIC_WALLET }));
} else {
  throw new Error("usage: payload | recover <signature>");
}
