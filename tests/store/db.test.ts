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
