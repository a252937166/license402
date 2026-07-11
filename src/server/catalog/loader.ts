import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "../domain/index.js";
import { CreatorOfferSchema } from "../license/types.js";
import { offerDigestHex } from "../license/commitments.js";
import { verifyOfferSignature } from "../license/eligibility.js";
import { parseUsdtToMicro } from "../license/money.js";
import { PROJECT_ROOT } from "../config.js";
import type { Repo } from "../store/repo.js";
import type { CreatorOffer } from "../license/types.js";

export interface CatalogEntry {
  offer: CreatorOffer;
  assetFile: string;
  previewFile: string;
  title: string;
  creatorDisplay: string;
  tags: string[];
}

/**
 * Load the signed first-party catalog manifest, verify every offer's signature
 * and asset hash, and upsert into the DB. Fails closed: an offer whose signature
 * or asset hash does not check out is skipped with a warning, never served.
 */
export function loadCatalog(repo: Repo, nowSeconds: number, manifestPath?: string): { loaded: number; skipped: string[] } {
  const path = manifestPath ?? resolve(PROJECT_ROOT, "catalog/catalog.json");
  if (!existsSync(path)) return { loaded: 0, skipped: [`manifest not found: ${path}`] };

  const entries = JSON.parse(readFileSync(path, "utf8")) as CatalogEntry[];
  const skipped: string[] = [];
  let loaded = 0;

  for (const entry of entries) {
    const parsed = CreatorOfferSchema.safeParse(entry.offer);
    if (!parsed.success) {
      skipped.push(`${entry.offer?.offerId ?? "?"}: schema invalid`);
      continue;
    }
    const offer = parsed.data;

    const assetPath = resolve(PROJECT_ROOT, entry.assetFile);
    if (!existsSync(assetPath)) {
      skipped.push(`${offer.offerId}: asset file missing (${entry.assetFile})`);
      continue;
    }
    const bytes = readFileSync(assetPath);
    const actualHash = sha256Hex(bytes);
    if (actualHash !== offer.assetSha256) {
      skipped.push(`${offer.offerId}: asset hash mismatch`);
      continue;
    }
    if (!verifyOfferSignature(offer)) {
      skipped.push(`${offer.offerId}: signature invalid`);
      continue;
    }

    const { signature: _s, ...unsigned } = offer;
    repo.upsertAsset(
      {
        assetId: offer.assetId,
        sha256: offer.assetSha256,
        mimeType: offer.mimeType,
        filePath: entry.assetFile,
        previewPath: entry.previewFile,
        title: entry.title,
        creatorDisplay: entry.creatorDisplay,
        tags: entry.tags
      },
      nowSeconds
    );
    repo.upsertOffer(
      {
        offerId: offer.offerId,
        offerDigest: offerDigestHex(unsigned),
        assetId: offer.assetId,
        assetSha256: offer.assetSha256,
        licensorWallet: offer.licensorWallet,
        payoutWallet: offer.payoutWallet,
        creatorNetPriceMicro: parseUsdtToMicro(offer.creatorNetPrice),
        validFrom: offer.validFrom,
        validUntil: offer.validUntil,
        active: true,
        offer
      },
      nowSeconds
    );
    loaded += 1;
  }

  return { loaded, skipped };
}
