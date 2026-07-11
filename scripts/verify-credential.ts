/**
 * Offline LICENSE CREDENTIAL verifier — no server, no network.
 *
 * Feed it a credential JSON (the `license` object from a purchase response,
 * or `licenseCredential` from /v1/orders/:id/bundle):
 *
 *   tsx scripts/verify-credential.ts path/to/credential.json
 *   tsx scripts/verify-credential.ts path/to/bundle.json      (bundle auto-detected)
 *
 * Checks: issuer signature (keccak over canonical JSON, domain
 * LICENSE402-CREDENTIAL-V1:<chainId>:), schema validity (v1 and v2 accepted),
 * grant expiry, and prints the machine-readable scope so a human can see
 * exactly what was licensed. Exit 0 = authentic + well-formed.
 */
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "../src/server/domain/index.js";
import { recoverDigestSigner } from "../src/server/license/eip712.js";
import { LicenseCredentialSchema } from "../src/server/license/types.js";
import { EIP712_DOMAIN } from "../src/server/license/vocab.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/verify-credential.ts <credential.json | bundle.json>");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const credRaw = (raw.licenseCredential ?? raw.license ?? raw) as Record<string, unknown>;

const parsed = LicenseCredentialSchema.safeParse(credRaw);
if (!parsed.success) {
  console.error("✗ schema: credential does not match LicenseCredential v1/v2");
  console.error(parsed.error.issues.slice(0, 5));
  process.exit(1);
}
const cred = parsed.data;

const { issuerSignature, ...unsigned } = cred;
const digest = keccak_256(utf8ToBytes(`LICENSE402-CREDENTIAL-V1:${EIP712_DOMAIN.chainId}:` + canonicalJson(unsigned)));
const signer = recoverDigestSigner(digest, issuerSignature);
const authentic = signer !== null && signer === cred.issuer.toLowerCase();

const nowSeconds = Math.floor(Date.now() / 1000);
const expired = cred.grant.expiresAt < nowSeconds;

console.log(`credential ${cred.licenseId} (v${cred.credentialVersion})`);
console.log(`  ${authentic ? "✓" : "✗"} issuer signature  signer=${signer} expected=${cred.issuer.toLowerCase()}`);
console.log(`  ${expired ? "✗ EXPIRED" : "✓ within validity"}  grant ${cred.grant.issuedAt} → ${cred.grant.expiresAt} (now ${nowSeconds})`);
console.log(`  licensee   ${cred.licenseeWallet}`);
console.log(`  asset      sha256 ${cred.assetSha256}`);
console.log(`  scope      channels=[${cred.grant.channels.join(",")}] territory=${cred.grant.territory} transforms=[${cred.grant.transformations.join(",")}]`);
console.log(`  authorization ${cred.authorizationMode ?? "eip712_purchase_intent (v1 default)"}`);
if (cred.credentialEnvironment) console.log(`  environment ${cred.credentialEnvironment} · rail ${cred.settlementNetwork ?? "-"}`);
console.log(`  legalText  ${cred.legalTextHash}  (fetch: /v1/legal/${cred.legalTextHash})`);
console.log(`  status     ${cred.statusUrl} (online revocation/settlement check)`);
console.log(authentic && !expired ? "\nAUTHENTIC" : "\nNOT VALID");
process.exit(authentic && !expired ? 0 : 1);
