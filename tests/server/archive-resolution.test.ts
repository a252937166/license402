import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/store/db.js";
import { Repo } from "../../src/server/store/repo.js";
import { loadCatalog } from "../../src/server/catalog/loader.js";

/**
 * Round-10 anchor test: the digests below are the REAL ones referenced by
 * settled production/testnet orders (see docs/evidence/*). After ANY future
 * catalog re-sign, legal-text revision, or EIP-712 domain bump, these exact
 * strings must keep resolving to their original signed bytes — otherwise
 * already-sold licenses would dangle.
 */
const MAINNET_ERA_OFFER_DIGEST = "0xdd9a171f7de2f6867ac8e68b6c8e05e2a9762eac84396111fd2fdfa17ce27bdb"; // ord-e76242…, ord-9530e2…
const TESTNET_ERA_OFFER_DIGEST = "0xc65c865723f7f303189ee31de107fd0e28b77029a3b69de50b50cf86836a7feb"; // ord-ca9551…
const LEGAL_HASH_REV1 = "0xf02f8921da7dd0ff412d637bc7796ff18174903701fb750a2399a2561424fb0e"; // mainnet-era orders
const LEGAL_HASH_REV2 = "0xf6185e7518010af013fad79649fd59b3b5a278efe6be204615fa6e1780535f33"; // testnet-era orders

describe("historical materials survive re-signs and version bumps", () => {
  it("every digest a settled order references still resolves to its original signed bytes", () => {
    const repo = new Repo(openDatabase(":memory:"));
    loadCatalog(repo, 1_783_900_800);

    const mainnetEra = repo.getOfferByDigest(MAINNET_ERA_OFFER_DIGEST);
    expect(mainnetEra?.offerId).toBe("off-cyber-dragon");
    expect(mainnetEra?.offerVersion).toBe(1);
    // The archived version carries the legal hash of ITS era (rev1) — exactly
    // what the head-based lookup used to get wrong.
    expect(mainnetEra?.legalTextHash).toBe(LEGAL_HASH_REV1);

    const testnetEra = repo.getOfferByDigest(TESTNET_ERA_OFFER_DIGEST);
    expect(testnetEra?.offerId).toBe("off-cyber-dragon");
    expect(testnetEra?.offerVersion).toBe(1);

    // Current head moved on (offerVersion 2) — with a DIFFERENT digest.
    const head = repo.getOffer("off-cyber-dragon");
    expect(head?.offer.offerVersion).toBe(2);
    expect(head?.offerDigest).not.toBe(MAINNET_ERA_OFFER_DIGEST);
    expect(head?.offerDigest).not.toBe(TESTNET_ERA_OFFER_DIGEST);

    // Every legal-text revision an order ever referenced is byte-pinned.
    expect(repo.getLegalText(LEGAL_HASH_REV1)).toContain("Version: 1");
    expect(repo.getLegalText(LEGAL_HASH_REV2)).toContain("Version: 1");
    expect(repo.getLegalText(head!.offer.legalTextHash)).toContain("Version: 2");
  });
});
