import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/store/db.js";

function seedQuoteAndOrder(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO offers (offer_id, offer_digest, asset_id, asset_sha256, licensor_wallet, payout_wallet,
      creator_net_price_micro, valid_from, valid_until, offer_json, created_at)
     VALUES ('off-1','0xd1','asset-1','0xa1','0x01','0x02',70000,0,99,'{}',1)`
  ).run();
  db.prepare(
    `INSERT INTO quotes (quote_id, quote_commitment, offer_id, offer_digest, licensee_wallet, use_spec_json,
      use_spec_hash, price_micro, platform_fee_micro, creator_payout_micro, idempotency_key, expires_at, created_at)
     VALUES ('q-1','0xc1','off-1','0xd1','0xbuyer','{}','0xu1',100000,30000,70000,'idem-1',99,1)`
  ).run();
  db.prepare(
    `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
      purchase_intent_digest, buyer_payment_id, status, created_at, updated_at)
     VALUES ('ord-1','q-1','0xc1','0xbuyer','{}','0xp1','pay-1','DELIVERY_PREPARED',1,1)`
  ).run();
}

describe("sqlite anti-duplication invariants", () => {
  it("rejects a second order with the same buyer_payment_id", () => {
    const db = openDatabase(":memory:");
    seedQuoteAndOrder(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
            purchase_intent_digest, buyer_payment_id, status, created_at, updated_at)
           VALUES ('ord-2','q-1','0xc2','0xbuyer','{}','0xp2','pay-1','DELIVERY_PREPARED',1,1)`
        )
        .run()
    ).toThrow(/UNIQUE/);
  });

  it("rejects a second order for the same (quote_commitment, licensee)", () => {
    const db = openDatabase(":memory:");
    seedQuoteAndOrder(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
            purchase_intent_digest, buyer_payment_id, status, created_at, updated_at)
           VALUES ('ord-3','q-1','0xc1','0xbuyer','{}','0xp3','pay-3','DELIVERY_PREPARED',1,1)`
        )
        .run()
    ).toThrow(/UNIQUE/);
  });

  it("allows at most one payout per (order, type) and one outbox job per (kind, ref)", () => {
    const db = openDatabase(":memory:");
    seedQuoteAndOrder(db);
    db.prepare(
      `INSERT INTO creator_payouts (order_id, payout_wallet, amount_micro, updated_at) VALUES ('ord-1','0x02',70000,1)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO creator_payouts (order_id, payout_wallet, amount_micro, updated_at) VALUES ('ord-1','0x02',70000,2)`
        )
        .run()
    ).toThrow(/UNIQUE|PRIMARY/);

    db.prepare(
      `INSERT INTO outbox_jobs (kind, ref_id, created_at, updated_at) VALUES ('creator_payout','ord-1',1,1)`
    ).run();
    expect(() =>
      db
        .prepare(`INSERT INTO outbox_jobs (kind, ref_id, created_at, updated_at) VALUES ('creator_payout','ord-1',2,2)`)
        .run()
    ).toThrow(/UNIQUE/);
  });

  it("one license per order", () => {
    const db = openDatabase(":memory:");
    seedQuoteAndOrder(db);
    db.prepare(
      `INSERT INTO licenses (license_id, order_id, credential_json, issued_at, expires_at) VALUES ('lic-1','ord-1','{}',1,99)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO licenses (license_id, order_id, credential_json, issued_at, expires_at) VALUES ('lic-2','ord-1','{}',1,99)`
        )
        .run()
    ).toThrow(/UNIQUE/);
  });
});

// Round-10 invariant: signed materials are append-only. A catalog re-sign must
// never change what an already-issued quote/credential digest resolves to.
describe("immutable signed materials (offer_versions / legal_texts)", () => {
  it("a head re-sign never changes what an archived offer digest resolves to", async () => {
    const { Repo } = await import("../../src/server/store/repo.js");
    const repo = new Repo(openDatabase(":memory:"));
    const v1 = { offerId: "off-x", offerVersion: 1, creatorNetPrice: "0.07" } as any;
    const v2 = { offerId: "off-x", offerVersion: 2, creatorNetPrice: "0.09" } as any;
    const head = (offer: any, digest: string) => ({
      offerId: "off-x", offerDigest: digest, assetId: "a", assetSha256: "0xa",
      licensorWallet: "0x01", payoutWallet: "0x02", creatorNetPriceMicro: 70000,
      validFrom: 0, validUntil: 99, active: true, offer
    });

    repo.archiveOfferVersion("0xd1", "off-x", v1, 1);
    repo.upsertOffer(head(v1, "0xd1"), 1);
    // Re-sign: head moves to v2, v2 gets archived too.
    repo.archiveOfferVersion("0xd2", "off-x", v2, 2);
    repo.upsertOffer(head(v2, "0xd2"), 2);

    expect(repo.getOfferByDigest("0xd1")).toEqual(v1); // old quote still resolves
    expect(repo.getOfferByDigest("0xd2")).toEqual(v2);
    expect(repo.getOffer("off-x")?.offerDigest).toBe("0xd2"); // head is new

    // Append-only: re-archiving the same digest with different bytes is a no-op.
    repo.archiveOfferVersion("0xd1", "off-x", v2, 3);
    expect(repo.getOfferByDigest("0xd1")).toEqual(v1);
  });

  it("legal text bytes are pinned by hash forever", async () => {
    const { Repo } = await import("../../src/server/store/repo.js");
    const repo = new Repo(openDatabase(":memory:"));
    repo.archiveLegalText("0xaaa", "original terms", 1);
    repo.archiveLegalText("0xaaa", "REWRITTEN terms", 2); // must not overwrite
    expect(repo.getLegalText("0xaaa")).toBe("original terms");
    expect(repo.getLegalText("0xmissing")).toBeUndefined();
  });
});

describe("faucet atomic cooldown (round-10)", () => {
  it("check-and-take is one statement — a second claim inside the window loses, after it wins", async () => {
    const { Repo } = await import("../../src/server/store/repo.js");
    const repo = new Repo(openDatabase(":memory:"));
    expect(repo.tryTakeFaucetSlot("0xAB", "ip1", 500000, "testnet", 1000, 60)).toBe(true);   // first claim
    expect(repo.tryTakeFaucetSlot("0xAB", "ip1", 500000, "testnet", 1030, 60)).toBe(false);  // 30s later: blocked
    expect(repo.tryTakeFaucetSlot("0xAB", "ip1", 500000, "testnet", 1060, 60)).toBe(true);   // 60s later: wins
    // Per-network isolation: the mainnet-era claim never blocks testnet.
    expect(repo.tryTakeFaucetSlot("0xAB", "ip1", 100000, "mainnet", 1061, 60)).toBe(true);
  });

  it("a failed send reopens the slot instead of burning the cooldown", async () => {
    const { Repo } = await import("../../src/server/store/repo.js");
    const repo = new Repo(openDatabase(":memory:"));
    expect(repo.tryTakeFaucetSlot("0xCD", "ip", 500000, "testnet", 1000, 60)).toBe(true);
    repo.reopenFaucetSlot("0xCD", "testnet"); // send failed, nothing delivered
    expect(repo.tryTakeFaucetSlot("0xCD", "ip", 500000, "testnet", 1001, 60)).toBe(true); // retry allowed
    repo.recordFaucetTx("0xCD", "testnet", "0xtx1");
    repo.reopenFaucetSlot("0xCD", "testnet"); // tx recorded ⇒ no-op (guarded by tx IS NULL)
    expect(repo.tryTakeFaucetSlot("0xCD", "ip", 500000, "testnet", 1002, 60)).toBe(false);
  });
});
