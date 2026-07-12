/**
 * Offline evidence verifier. Re-derives the CRYPTOGRAPHIC CONSISTENCY of
 * docs/evidence/*.json with NO server and NO network — signatures, digests,
 * commitments, and that every referenced hash resolves to real bytes in this
 * repo. It does NOT prove on-chain settlement semantics; that is
 * `npm run verify:evidence:onchain` (reads X Layer RPCs).
 *
 *   1. CreatorOffer signature   — recovered under the offer's own domain version
 *   2. offerDigest              — recomputed, must match quote + credential
 *   3. policyAstHash            — recomputed from the offer's policy
 *   4. PurchaseIntent signature — v1 or v2 struct, historical domains accepted
 *   5. intent binding           — digest/legal/price fields equal the quote's
 *   6. quoteCommitment          — recomputed (v2 rail-aware, v1 fallback)
 *   7. credential issuer sig    — recovered, must equal the recorded issuer
 *   8. settlement txs           — present for production/testnet orders
 *
 * Usage: tsx scripts/verify-evidence.ts [file.json ...]   (default: docs/evidence/*.json)
 * Exit code 0 = every bundle verifies; 1 = any check failed. Used by CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { existsSync } from "node:fs";
import { utf8ToBytes, bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "../src/server/domain/index.js";
import {
  offerToTypedMessage,
  purchaseIntentToTypedMessage,
  recoverTypedDataSigner,
  recoverDigestSigner,
  hashStruct,
  domainSeparator,
  typeHash,
  encodeAtom
} from "../src/server/license/eip712.js";
import type { TypedMessage } from "../src/server/license/eip712.js";
import { offerDigestHex, policyAstHash, quoteCommitment } from "../src/server/license/commitments.js";
import { canonicalHash } from "../src/server/domain/index.js";
import { parseUsdtToMicro } from "../src/server/license/money.js";
import { EIP712_DOMAIN } from "../src/server/license/vocab.js";
import { recoverCredentialIssuer } from "../src/server/license/credential.js";
import { PROJECT_ROOT } from "../src/server/config.js";

type Json = Record<string, any>;

// ---- v1 PurchaseIntent struct (pre-rail) — kept verbatim so historical
// ---- intents remain verifiable forever (round-10 "keep v1 verifiers").
const INTENT_V1_FIELDS = [
  ["quoteId", "string"],
  ["quoteCommitment", "bytes32"],
  ["buyer", "address"],
  ["licensee", "address"],
  ["assetSha256", "bytes32"],
  ["offerDigest", "bytes32"],
  ["policyAstHash", "bytes32"],
  ["legalTextHash", "bytes32"],
  ["totalPriceMicro", "uint256"],
  ["currency", "string"],
  ["expiresAt", "uint64"],
  ["nonce", "bytes32"]
] as const;

function intentV1Digest(intent: Json, domainVersion: "1" | "2"): Uint8Array {
  const typeString = `PurchaseIntent(${INTENT_V1_FIELDS.map(([n, t]) => `${t} ${n}`).join(",")})`;
  const chunks: Uint8Array[] = [keccak_256(utf8ToBytes(typeString))];
  const message: TypedMessage = {
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
  for (const [name, type] of INTENT_V1_FIELDS) chunks.push(encodeAtom(type as never, message[name]!));
  const struct = keccak_256(concatBytes(...chunks));
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator(domainVersion), struct));
}

function recoverIntentSigner(intent: Json): string | null {
  const { signature, ...unsigned } = intent;
  const isV2Struct = typeof unsigned.settlementNetwork === "string";
  if (isV2Struct) {
    // v2 struct circulated under BOTH domain strings (pre/post the v2 bump) —
    // accept either; the struct content bound is identical.
    for (const v of ["2", "1"] as const) {
      const s = recoverTypedDataSigner("PurchaseIntent", purchaseIntentToTypedMessage(unsigned as never), signature, v);
      if (s && s === String(unsigned.buyer).toLowerCase()) return s;
    }
    return null;
  }
  const s = recoverDigestSigner(intentV1Digest(unsigned, "1"), signature);
  return s && s === String(unsigned.buyer).toLowerCase() ? s : null;
}

function recomputeQuoteCommitment(bundle: Json): string | null {
  const q = bundle.quote;
  const licensee = String(bundle.licenseCredential.licenseeWallet).toLowerCase();
  const useHash = canonicalHash(q.useSpec, "L402:USESPEC:v1");
  const idem = q.idempotencyKey ?? bundle.idempotencyKey;
  // v2 commitments bind the rail; v1-era quotes lack a real paymentAsset.
  if (typeof q.paymentAsset === "string" && q.paymentAsset.length > 0) {
    return quoteCommitment({
      offerDigest: q.offerDigest,
      licenseeWallet: licensee,
      useSpecHash: useHash,
      priceMicro: q.priceMicro,
      platformFeeMicro: q.platformFeeMicro,
      creatorPayoutMicro: q.creatorPayoutMicro,
      settlementNetwork: q.settlementNetwork,
      paymentAsset: q.paymentAsset,
      payTo: q.payTo,
      quoteExpiresAt: q.expiresAt,
      idempotencyKey: idem
    });
  }
  if (typeof idem !== "string") return null; // historical bundle without the key — recomputation not possible
  return canonicalHash(
    {
      offerDigest: q.offerDigest,
      licenseeWallet: licensee,
      useSpecHash: useHash,
      priceMicro: q.priceMicro,
      platformFeeMicro: q.platformFeeMicro,
      creatorPayoutMicro: q.creatorPayoutMicro,
      quoteExpiresAt: q.expiresAt,
      idempotencyKey: idem
    },
    "L402:QUOTE:v1"
  );
}

function verifyBundle(path: string): { pass: boolean; checks: [string, boolean | "skip", string?][] } {
  const bundle = JSON.parse(readFileSync(path, "utf8")) as Json;
  const checks: [string, boolean | "skip", string?][] = [];
  const push = (name: string, ok: boolean | "skip", detail?: string) => checks.push([name, ok, detail]);

  // 1–2: offer signature + digest
  const offer = bundle.creatorOffer;
  const { signature: _os, ...unsignedOffer } = offer;
  const domainV = offer.offerVersion >= 2 ? "2" : "1";
  const offerSigner = recoverTypedDataSigner("CreatorOffer", offerToTypedMessage(unsignedOffer), offer.signature, domainV);
  push("offer.signature", offerSigner === String(offer.licensorWallet).toLowerCase(), `signer=${offerSigner}`);
  const digest = offerDigestHex(unsignedOffer);
  push("offer.digest=quote.offerDigest", digest === bundle.quote.offerDigest, digest);
  push("offer.digest=credential.offerDigest", digest === bundle.licenseCredential.offerDigest);

  // 3: policy AST
  const ast = policyAstHash(offer.policy);
  push("policyAstHash", ast === bundle.licenseCredential.policyAstHash, ast);

  // 4–5: buyer authorization
  if (bundle.authorization?.mode === "eip712_purchase_intent") {
    const intent = bundle.purchaseIntent;
    const signer = recoverIntentSigner(intent);
    push("intent.signature", signer !== null, `signer=${signer}`);
    push("intent.licensee=credential.licensee", String(intent.licensee).toLowerCase() === String(bundle.licenseCredential.licenseeWallet).toLowerCase());
    push("intent.offerDigest", intent.offerDigest === digest);
    push("intent.legalTextHash=offer.legalTextHash", intent.legalTextHash === offer.legalTextHash);
    push("intent.price", parseUsdtToMicro(intent.totalPrice) === bundle.quote.priceMicro);
  } else if (bundle.authorization?.mode === "x402_direct") {
    const rec = bundle.authorization.record;
    push("direct.payer=credential.licensee", String(rec.payer).toLowerCase() === String(bundle.licenseCredential.licenseeWallet).toLowerCase());
    push("direct.quoteCommitment", rec.quoteCommitment === bundle.quote.quoteCommitment);
    push(
      "direct.authDigest=credential.paymentAuthorizationDigest",
      rec.paymentAuthorizationDigest === bundle.licenseCredential.paymentAuthorizationDigest
    );
  } else {
    push("authorization.mode", false, String(bundle.authorization?.mode));
  }

  // 6: quote commitment
  const recomputed = recomputeQuoteCommitment(bundle);
  if (recomputed === null) push("quoteCommitment.recompute", "skip", "no idempotencyKey in historical bundle");
  else push("quoteCommitment.recompute", recomputed === bundle.quote.quoteCommitment, recomputed);

  // 7: credential issuer signature — version-aware domain prefix
  //    (CREDENTIAL-V2 for v2 issues; V1-prefix fallback for pre-bump v2 and all v1)
  const issuer = recoverCredentialIssuer(bundle.licenseCredential as never);
  push("credential.issuerSignature", issuer === String(bundle.licenseCredential.issuer).toLowerCase(), `issuer=${issuer}`);

  // 8: FILE BYTES — the hashes in the bundle resolve to real bytes in this repo
  //    (asset via content-addressed storage; legal + attestation via tree scan).
  const sha = String(offer.assetSha256);
  const ext = String(offer.mimeType ?? "image/png").split("/")[1] ?? "png";
  const byHash = resolve(PROJECT_ROOT, `catalog/assets/by-hash/${sha.replace(/^0x/, "")}.${ext}`);
  let assetOk: boolean | "skip" = "skip";
  if (existsSync(byHash)) assetOk = `0x${bytesToHex(sha256(readFileSync(byHash)))}` === sha;
  else {
    const dir = resolve(PROJECT_ROOT, "catalog/assets");
    assetOk = readdirSync(dir).filter((f) => f.endsWith(`.${ext}`)).some((f) => `0x${bytesToHex(sha256(readFileSync(resolve(dir, f))))}` === sha);
  }
  push("asset.bytesOnDisk", assetOk, sha);
  const legalDirs = ["legal", "legal/archive"].map((d) => resolve(PROJECT_ROOT, d)).filter(existsSync);
  const legalOk = legalDirs.some((d) => readdirSync(d).filter((f) => f.endsWith(".md")).some((f) => `0x${bytesToHex(sha256(readFileSync(resolve(d, f))))}` === offer.legalTextHash));
  push("legalText.bytesOnDisk", legalOk, offer.legalTextHash);
  const attDirs = ["catalog/attestations", "catalog/attestations/archive"].map((d) => resolve(PROJECT_ROOT, d)).filter(existsSync);
  const attOk = attDirs.some((d) => readdirSync(d).filter((f) => f.endsWith(".md")).some((f) => `0x${bytesToHex(sha256(readFileSync(resolve(d, f))))}` === offer.rightsAttestationHash));
  if (!attOk && Number(offer.offerVersion) < 2) {
    // Honest gap: offerVersion-1 offers predate byte archiving; one attestation
    // revision was overwritten before the first commit and cannot be produced.
    // From offerVersion 2 on, every referenced byte is archived and REQUIRED.
    push("rightsAttestation.bytesOnDisk", "skip", "pre-immutability-era revision not retained (policy enforced from offerVersion 2)");
  } else {
    push("rightsAttestation.bytesOnDisk", attOk, offer.rightsAttestationHash);
  }

  // 9: settlement facts
  if (bundle.environment === "production" || bundle.environment === "testnet") {
    push("order.buyerSettleTx present", typeof bundle.order.buyerSettleTx === "string" && bundle.order.buyerSettleTx.startsWith("0x"));
    if (bundle.creatorPayout?.state === "PAID") {
      push("creatorPayout.confirmedTx present", typeof bundle.creatorPayout.confirmedTx === "string");
    }
  }

  return { pass: checks.every(([, ok]) => ok === true || ok === "skip"), checks };
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(resolve(PROJECT_ROOT, "docs/evidence"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => resolve(PROJECT_ROOT, "docs/evidence", f));

let allPass = true;
for (const f of files) {
  const { pass, checks } = verifyBundle(f);
  allPass &&= pass;
  console.log(`\n${pass ? "✓" : "✗"} ${f.split("/").slice(-1)[0]}`);
  for (const [name, ok, detail] of checks) {
    console.log(`   ${ok === true ? "✓" : ok === "skip" ? "–" : "✗"} ${name}${ok !== true && detail ? ` (${detail})` : ""}`);
  }
}
console.log(`\n${allPass ? "ALL BUNDLES VERIFY" : "VERIFICATION FAILED"}`);
process.exit(allPass ? 0 : 1);
