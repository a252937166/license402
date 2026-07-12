import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/store/db.js";
import { Repo } from "../../src/server/store/repo.js";
import { runPayoutWorker, type PayoutSender } from "../../src/server/payout/worker.js";
import type { AppConfig } from "../../src/server/config.js";

/**
 * Round-10 P0 invariant: A PAID CREATOR IS NEVER PAID TWICE.
 * These tests drive the worker through the exact crash shapes the review
 * called out and assert the nonce discipline directly on the sender.
 */

const CONFIG = { paymentMode: "live" } as AppConfig;

function seed(repo: Repo, db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO offers (offer_id, offer_digest, asset_id, asset_sha256, licensor_wallet, payout_wallet,
      creator_net_price_micro, valid_from, valid_until, offer_json, created_at)
     VALUES ('off-1','0xd1','asset-1','0xa1','0x01','0xcreator',70000,0,99,'{}',1)`
  ).run();
  db.prepare(
    `INSERT INTO quotes (quote_id, quote_commitment, offer_id, offer_digest, licensee_wallet, use_spec_json,
      use_spec_hash, price_micro, platform_fee_micro, creator_payout_micro, idempotency_key, expires_at, created_at)
     VALUES ('q-1','0xc1','off-1','0xd1','0xbuyer','{}','0xu1',100000,30000,70000,'idem-1',99,1)`
  ).run();
  db.prepare(
    `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
      purchase_intent_digest, buyer_payment_id, status, environment, created_at, updated_at)
     VALUES ('ord-p1','q-1','0xc1','0xbuyer','{}','0xpi1','pay-1','SETTLED','production',1,1)`
  ).run();
  db.prepare(`INSERT INTO creator_payouts (order_id, payout_wallet, amount_micro, updated_at) VALUES ('ord-p1','0xcreator',70000,1)`).run();
  db.prepare(`INSERT INTO outbox_jobs (kind, ref_id, created_at, updated_at) VALUES ('creator_payout','ord-p1',1,1)`).run();
  void repo;
}

/** Scriptable sender that records every nonce interaction. */
class FakeSender implements PayoutSender {
  reserved: number[] = [];
  sends: { nonce: number; wallet: string }[] = [];
  private nextNonce = 5;
  constructor(
    private script: {
      sendResult?: (call: number) => string; // returns tx or throws
      confirmResult?: (tx: string) => "confirmed" | "reverted" | "pending" | "mismatch";
    } = {}
  ) {}
  async reserveNonce(): Promise<number> {
    const n = this.nextNonce++;
    this.reserved.push(n);
    return n;
  }
  async send(_orderId: string, wallet: string, _amountMicro: number, nonce: number): Promise<string> {
    this.sends.push({ nonce, wallet });
    if (this.script.sendResult) return this.script.sendResult(this.sends.length);
    return `0xtx${this.sends.length}`;
  }
  async confirm(tx: string): Promise<"confirmed" | "reverted" | "pending" | "mismatch"> {
    return this.script.confirmResult ? this.script.confirmResult(tx) : "confirmed";
  }
}

function payoutRow(db: ReturnType<typeof openDatabase>): Record<string, unknown> {
  return db.prepare(`SELECT * FROM creator_payouts WHERE order_id='ord-p1'`).get() as Record<string, unknown>;
}
function jobRow(db: ReturnType<typeof openDatabase>): Record<string, unknown> {
  return db.prepare(`SELECT * FROM outbox_jobs WHERE ref_id='ord-p1'`).get() as Record<string, unknown>;
}

describe("payout worker — double-pay impossibility (round-10 P0)", () => {
  it("nonce-too-low parks the payout as NEEDS_RECONCILIATION and it is NEVER auto-retried", async () => {
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    seed(repo, db);
    // Simulate crash recovery: an earlier pass reserved nonce 5 and broadcast,
    // but crashed before persisting the hash. Row: SENDING + chain_nonce=5.
    db.prepare(`UPDATE creator_payouts SET state='SENDING', chain_nonce=5 WHERE order_id='ord-p1'`).run();
    const sender = new FakeSender({
      sendResult: () => {
        throw new Error("nonce too low: address 0x… tx already imported");
      }
    });

    let t = 1000;
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender });

    // Retried with the SAME pinned nonce, no fresh reservation, then parked.
    expect(sender.sends).toEqual([{ nonce: 5, wallet: "0xcreator" }]);
    expect(sender.reserved).toEqual([]);
    expect(payoutRow(db).state).toBe("NEEDS_RECONCILIATION");
    expect(jobRow(db).state).toBe("NEEDS_RECONCILIATION");
    expect((db.prepare(`SELECT status FROM orders WHERE order_id='ord-p1'`).get() as { status: string }).status).toBe("PAYOUT_NEEDS_RECONCILIATION");

    // Hours later, every future pass skips it — no claim, no send, no new nonce.
    t += 100_000;
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender });
    expect(sender.sends).toHaveLength(1);
    expect(sender.reserved).toEqual([]);
  });

  it("a generic send failure (e.g. RPC timeout) retries with the SAME pinned nonce, never a fresh one", async () => {
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    seed(repo, db);
    const sender = new FakeSender({
      sendResult: (call) => {
        if (call === 1) throw new Error("ECONNRESET: socket hang up"); // tx MAY still have broadcast
        return "0xtxretry";
      }
    });

    let t = 1000;
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender });
    expect(sender.reserved).toEqual([5]); // fresh row → one reservation
    expect(payoutRow(db).state).toBe("RETRYING");
    expect(payoutRow(db).chain_nonce).toBe(5); // nonce stays pinned through the failure

    t += 3600; // past the backoff
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender });
    // Second send reused nonce 5 — reserveNonce was NOT called again, so even
    // if the first broadcast secretly landed, the chain accepts at most one.
    expect(sender.reserved).toEqual([5]);
    expect(sender.sends).toEqual([
      { nonce: 5, wallet: "0xcreator" },
      { nonce: 5, wallet: "0xcreator" }
    ]);
    expect(payoutRow(db).state).toBe("PAID");
    expect(payoutRow(db).confirmed_tx).toBe("0xtxretry");
  });

  it("only a receipt-proven revert releases the nonce for a fresh retry", async () => {
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    seed(repo, db);
    let verdict: "reverted" | "confirmed" = "reverted";
    const sender = new FakeSender({ confirmResult: () => verdict });

    let t = 1000;
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender }); // send nonce 5 → BROADCAST (confirm reads pending? no: reverted)
    // First pass: send ok, confirm says reverted is only read in the BROADCAST
    // branch on the NEXT pass — this pass sees "reverted" right after send too.
    // Either way the state machine must land on: nonce cleared, retry fresh.
    t += 120;
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender });
    t += 120;
    verdict = "confirmed";
    await runPayoutWorker(repo, CONFIG, () => t, { production: sender });

    const row = payoutRow(db);
    expect(row.state).toBe("PAID");
    // The fresh retry took a NEW reserved nonce (6) — allowed ONLY because the
    // receipt proved nonce 5 moved no value.
    expect(sender.reserved).toEqual([5, 6]);
    expect(sender.sends.map((s) => s.nonce)).toEqual([5, 6]);
  });

  it("admin attach_tx path: reconciliation resumes via the receipt check, still exactly one payment", async () => {
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    seed(repo, db);
    db.prepare(`UPDATE creator_payouts SET state='SENDING', chain_nonce=5 WHERE order_id='ord-p1'`).run();
    const parkSender = new FakeSender({
      sendResult: () => {
        throw new Error("nonce too low");
      }
    });
    await runPayoutWorker(repo, CONFIG, () => 1000, { production: parkSender });
    expect(payoutRow(db).state).toBe("NEEDS_RECONCILIATION");

    // Admin finds the landed tx on the explorer and attaches it.
    expect(repo.attachReconciledPayoutTx("ord-p1", "0xfound", 2000)).toBe(true);
    expect(repo.attachReconciledPayoutTx("ord-p1", "0xother", 2001)).toBe(false); // one-shot

    const confirmSender = new FakeSender({ confirmResult: () => "confirmed" });
    await runPayoutWorker(repo, CONFIG, () => 3000, { production: confirmSender });
    expect(payoutRow(db).state).toBe("PAID");
    expect(payoutRow(db).confirmed_tx).toBe("0xfound");
    expect(confirmSender.sends).toHaveLength(0); // confirmed WITHOUT any new send
    expect(confirmSender.reserved).toEqual([]);
  });

  it("admin fresh_nonce path: explicit release is the ONLY road back to a new nonce", async () => {
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    seed(repo, db);
    db.prepare(`UPDATE creator_payouts SET state='SENDING', chain_nonce=5 WHERE order_id='ord-p1'`).run();
    await runPayoutWorker(repo, CONFIG, () => 1000, {
      production: new FakeSender({
        sendResult: () => {
          throw new Error("nonce too low");
        }
      })
    });
    expect(payoutRow(db).state).toBe("NEEDS_RECONCILIATION");

    expect(repo.releasePayoutForFreshNonce("ord-p1", 2000)).toBe(true);
    const sender = new FakeSender();
    await runPayoutWorker(repo, CONFIG, () => 3000, { production: sender });
    expect(payoutRow(db).state).toBe("PAID");
    expect(sender.reserved).toEqual([5]); // fresh reservation happened exactly once, post-release
  });
});

describe("round-11: payout binds the HISTORICAL offer wallet", () => {
  it("a head re-sign with a new payoutWallet never redirects an in-flight order's money", async () => {
    const { onSettlementSuccess, SETTLED_STATES } = await import("../../src/server/orders/prepare.js");
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    // v1 signed offer archived with wallet A; quote bound its digest.
    repo.archiveOfferVersion("0xd1", "off-x", { offerId: "off-x", offerVersion: 1, payoutWallet: "0xWALLET_A", licensorWallet: "0xLIC" } as never, 1);
    db.prepare(
      `INSERT INTO offers (offer_id, offer_digest, asset_id, asset_sha256, licensor_wallet, payout_wallet,
        creator_net_price_micro, valid_from, valid_until, offer_json, created_at)
       VALUES ('off-x','0xd2','a','0xa','0xLIC','0xWALLET_B',70000,0,99,'{"offerId":"off-x","payoutWallet":"0xWALLET_B"}',2)`
    ).run(); // head has ALREADY moved to wallet B (re-sign after the quote)
    db.prepare(
      `INSERT INTO quotes (quote_id, quote_commitment, offer_id, offer_digest, licensee_wallet, use_spec_json,
        use_spec_hash, price_micro, platform_fee_micro, creator_payout_micro, payout_wallet, idempotency_key, expires_at, created_at)
       VALUES ('q-9','0xc9','off-x','0xd1','0xbuyer','{}','0xu',100000,30000,70000,'0x00000000000000000000000000000000000000AA','idem-9',99,1)`
    ).run();
    db.prepare(
      `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
        purchase_intent_digest, buyer_payment_id, status, environment, created_at, updated_at)
       VALUES ('ord-h1','q-9','0xc9','0xbuyer','{}','0xpih','pay-h1','DELIVERY_PREPARED','production',1,1)`
    ).run();
    db.prepare(
      `INSERT INTO licenses (license_id, order_id, credential_json, issued_at, expires_at)
       VALUES ('lic-h1','ord-h1','{"buyerPaymentId":"pay-h1","paymentAuthorizationDigest":"0xpad","licensorWallet":"0xLIC"}',1,99)`
    ).run();

    onSettlementSuccess(repo, "ord-h1", "0xsettletx", { nowSeconds: 10 });
    const payout = db.prepare(`SELECT payout_wallet, amount_micro FROM creator_payouts WHERE order_id='ord-h1'`).get() as Record<string, unknown>;
    expect(payout.payout_wallet).toBe("0x00000000000000000000000000000000000000aa"); // the QUOTE SNAPSHOT, not head wallet B
    expect(payout.amount_micro).toBe(70000);
    expect(SETTLED_STATES.has("PAYOUT_NEEDS_RECONCILIATION")).toBe(true); // license never regresses during reconciliation
  });

  it("fail closed: a missing payout snapshot parks the obligation — NOTHING is sent, no wallet is guessed", async () => {
    const { onSettlementSuccess } = await import("../../src/server/orders/prepare.js");
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    // Quote with NO payout snapshot AND an unresolvable digest (no archive row).
    db.prepare(
      `INSERT INTO offers (offer_id, offer_digest, asset_id, asset_sha256, licensor_wallet, payout_wallet,
        creator_net_price_micro, valid_from, valid_until, offer_json, created_at)
       VALUES ('off-y','0xheadY','a','0xa','0xLIC','0xHEADWALLET',70000,0,99,'{}',1)`
    ).run();
    db.prepare(
      `INSERT INTO quotes (quote_id, quote_commitment, offer_id, offer_digest, licensee_wallet, use_spec_json,
        use_spec_hash, price_micro, platform_fee_micro, creator_payout_micro, idempotency_key, expires_at, created_at)
       VALUES ('q-10','0xc10','off-y','0xGONE','0xbuyer','{}','0xu',100000,30000,70000,'idem-10',99,1)`
    ).run();
    db.prepare(
      `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
        purchase_intent_digest, buyer_payment_id, status, environment, created_at, updated_at)
       VALUES ('ord-h2','q-10','0xc10','0xbuyer','{}','0xpih2','pay-h2','DELIVERY_PREPARED','production',1,1)`
    ).run();
    db.prepare(
      `INSERT INTO licenses (license_id, order_id, credential_json, issued_at, expires_at)
       VALUES ('lic-h2','ord-h2','{"buyerPaymentId":"pay-h2","paymentAuthorizationDigest":"0xpad2","licensorWallet":"0xLIC"}',1,99)`
    ).run();

    onSettlementSuccess(repo, "ord-h2", "0xsettletx2", { nowSeconds: 10 });
    const payout = db.prepare(`SELECT * FROM creator_payouts WHERE order_id='ord-h2'`).get() as Record<string, unknown>;
    expect(payout.state).toBe("NEEDS_RECONCILIATION");
    expect(payout.payout_wallet).toBe(""); // NO guessed wallet
    expect(payout.amount_micro).toBe(0); // NO guessed amount
    expect(String(payout.last_error)).toContain("HISTORICAL_OFFER_UNRESOLVED");
    // License remains active-track (buyer already settled).
    const order = db.prepare(`SELECT status FROM orders WHERE order_id='ord-h2'`).get() as { status: string };
    expect(order.status).toBe("PAYOUT_NEEDS_RECONCILIATION");
    // The worker never touches it.
    const sender = new FakeSender();
    await runPayoutWorker(repo, CONFIG, () => 100, { production: sender });
    expect(sender.sends).toHaveLength(0);
  });
});

describe("round-11: semantic confirm — a successful but UNRELATED tx never pays the obligation", () => {
  it("attach_tx with a wrong-recipient tx goes back to NEEDS_RECONCILIATION, not PAID", async () => {
    const db = openDatabase(":memory:");
    const repo = new Repo(db);
    seed(repo, db);
    db.prepare(`UPDATE creator_payouts SET state='SENDING', chain_nonce=5 WHERE order_id='ord-p1'`).run();
    await runPayoutWorker(repo, CONFIG, () => 1000, {
      production: new FakeSender({ sendResult: () => { throw new Error("nonce too low"); } })
    });
    expect(payoutRow(db).state).toBe("NEEDS_RECONCILIATION");

    // Admin attaches a REAL, successful, but unrelated tx (e.g. the faucet top-up).
    expect(repo.attachReconciledPayoutTx("ord-p1", "0xunrelated", 2000)).toBe(true);
    const mismatchSender = new FakeSender();
    mismatchSender.confirm = async () => "mismatch" as const;
    await runPayoutWorker(repo, CONFIG, () => 3000, { production: mismatchSender });

    const row = payoutRow(db);
    expect(row.state).toBe("NEEDS_RECONCILIATION"); // parked again, NOT paid
    expect(String(row.last_error)).toContain("not a 70000");
    expect(row.confirmed_tx).toBeNull();
  });
});
