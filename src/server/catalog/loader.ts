import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
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
    // Append-only archives FIRST: the signed offer version AND the exact asset
    // bytes are preserved forever, even after later re-signs/re-uploads move
    // the head. Assets are content-addressed on disk (by-hash/<sha256>.<ext>)
    // so replacing catalog/assets/<slug>.png can never orphan a sold license.
    repo.archiveOfferVersion(offerDigestHex(unsigned), offer.offerId, offer, nowSeconds);
    try {
      const ext = offer.mimeType === "image/png" ? "png" : offer.mimeType.split("/")[1] ?? "bin";
      const byHashRel = `catalog/assets/by-hash/${offer.assetSha256.replace(/^0x/, "")}.${ext}`;
      const byHashAbs = resolve(PROJECT_ROOT, byHashRel);
      if (!existsSync(byHashAbs)) {
        mkdirSync(resolve(PROJECT_ROOT, "catalog/assets/by-hash"), { recursive: true });
        copyFileSync(assetPath, byHashAbs);
      }
      repo.archiveAssetVersion(offer.assetSha256, offer.assetId, byHashRel, offer.mimeType, nowSeconds);
    } catch (e) {
      skipped.push(`${offer.offerId}: asset archive failed (${e instanceof Error ? e.message : "?"})`);
    }
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

  // Historical archives: previously-signed catalogs and every legal-text
  // revision are appended so old quotes/credentials stay fully verifiable.
  try {
    const archiveDir = resolve(PROJECT_ROOT, "catalog/archive");
    if (existsSync(archiveDir)) {
      for (const f of readdirSync(archiveDir).filter((n) => n.endsWith(".json"))) {
        const old = JSON.parse(readFileSync(resolve(archiveDir, f), "utf8")) as CatalogEntry[];
        for (const entry of old) {
          const parsed = CreatorOfferSchema.safeParse(entry.offer);
          if (!parsed.success || !verifyOfferSignature(parsed.data)) continue;
          const { signature: _s2, ...unsigned2 } = parsed.data;
          repo.archiveOfferVersion(offerDigestHex(unsigned2), parsed.data.offerId, parsed.data, nowSeconds);
        }
      }
    }
    for (const dir of ["legal", "legal/archive"]) {
      const abs = resolve(PROJECT_ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs).filter((n) => n.endsWith(".md"))) {
        const body = readFileSync(resolve(abs, f));
        repo.archiveLegalText(sha256Hex(body), body.toString("utf8"), nowSeconds);
      }
    }
  } catch (e) {
    skipped.push(`archive load: ${e instanceof Error ? e.message : "failed"}`);
  }

  return { loaded, skipped };
}
