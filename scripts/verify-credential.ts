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
import { LicenseCredentialSchema } from "../src/server/license/types.js";
import { recoverCredentialIssuer } from "../src/server/license/credential.js";

const argv = process.argv.slice(2);
const envFlagIdx = argv.indexOf("--require-environment");
const requiredEnv = envFlagIdx >= 0 ? argv[envFlagIdx + 1] : undefined;
const path = argv.filter((a, i) => i !== envFlagIdx && (envFlagIdx < 0 || i !== envFlagIdx + 1))[0];
if (!path) {
  console.error("usage: tsx scripts/verify-credential.ts <credential.json | bundle.json> [--require-environment production|testnet]");
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

const signer = recoverCredentialIssuer(cred);
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
// Graded verdict (round-11): authenticity ≠ production usability. A testnet
// credential is genuinely issued by this system — and still not a production
// license. Revocation/settlement is an ONLINE property (statusUrl).
const env = cred.credentialEnvironment ?? "production";
const envOk = !requiredEnv || env === requiredEnv;
const label = !authentic || expired ? "NOT VALID" : `AUTHENTIC ${env.toUpperCase()} CREDENTIAL`;
console.log(`\n${label}`);
console.log("  static scope: evaluate offline via check-license-scope semantics");
console.log("  current status: UNKNOWN OFFLINE — poll statusUrl for revocation/settlement truth");
if (requiredEnv && !envOk) console.log(`  ✗ REQUIREMENT FAILED: environment is '${env}', required '${requiredEnv}'`);
process.exit(authentic && !expired && envOk ? 0 : 1);
