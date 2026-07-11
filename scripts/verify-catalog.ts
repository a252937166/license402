/**
 * Catalog integrity check (runs in CI). For every signed offer in
 * catalog/catalog.json this verifies:
 *   - the EIP-712 creator signature recovers to licensorWallet,
 *   - assetSha256 equals the sha256 of the actual asset file bytes,
 *   - legalTextHash equals the sha256 of the actual legal text file.
 * Exits non-zero on any mismatch.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "../src/server/domain/index.js";
import { PROJECT_ROOT } from "../src/server/config.js";
import { verifyOfferSignature } from "../src/server/license/eligibility.js";
import { legalTextHash } from "../src/server/legal.js";
import { CreatorOfferSchema } from "../src/server/license/types.js";

interface Entry {
  offer: unknown;
  assetFile: string;
  title: string;
}

function attestationHash(offerId: string): string {
  const slug = offerId.replace(/^off-/, "");
  return sha256Hex(readFileSync(resolve(PROJECT_ROOT, `catalog/attestations/${slug}.md`)));
}

const catalog = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "catalog/catalog.json"), "utf8")) as Entry[];
const legal = legalTextHash();
let failures = 0;

for (const entry of catalog) {
  const parsed = CreatorOfferSchema.safeParse(entry.offer);
  if (!parsed.success) {
    console.error(`✗ ${entry.title}: offer schema invalid`);
    failures += 1;
    continue;
  }
  const offer = parsed.data;
  const bytes = readFileSync(resolve(PROJECT_ROOT, entry.assetFile));
  const problems: string[] = [];
  if (!verifyOfferSignature(offer)) problems.push("signature does not recover to licensorWallet");
  if (sha256Hex(bytes) !== offer.assetSha256) problems.push("assetSha256 != file bytes");
  if (offer.legalTextHash !== legal) problems.push("legalTextHash != legal file");
  if (offer.rightsAttestationHash !== attestationHash(offer.offerId)) problems.push("rightsAttestationHash != attestation file");
  if (problems.length) {
    console.error(`✗ ${offer.offerId}: ${problems.join("; ")}`);
    failures += problems.length;
  } else {
    console.log(`✓ ${offer.offerId} (${entry.title})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} catalog integrity failure(s)`);
  process.exit(1);
}
console.log(`\nAll ${catalog.length} offers verified.`);
