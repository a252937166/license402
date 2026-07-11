import type { AppDatabase, OrderStatus } from "./db.js";
import type { CreatorOffer, LicenseCredential, PurchaseIntent, UseSpec } from "../license/types.js";

export interface AssetRow {
  assetId: string;
  sha256: string;
  mimeType: string;
  filePath: string;
  previewPath: string;
  title: string;
  creatorDisplay: string;
  tags: string[];
}

export interface OfferRow {
  offerId: string;
  offerDigest: string;
  assetId: string;
  assetSha256: string;
  licensorWallet: string;
  payoutWallet: string;
  creatorNetPriceMicro: number;
  validFrom: number;
  validUntil: number;
  active: boolean;
  offer: CreatorOffer;
}

export interface QuoteRow {
  quoteId: string;
  quoteCommitment: string;
  offerId: string;
  offerDigest: string;
  licenseeWallet: string;
  useSpec: UseSpec;
  useSpecHash: string;
  priceMicro: number;
  platformFeeMicro: number;
  creatorPayoutMicro: number;
  settlementNetwork: string;
  paymentAsset: string;
  payTo: string;
  idempotencyKey: string;
  expiresAt: number;
}

export interface OrderRow {
  orderId: string;
  quoteId: string;
  quoteCommitment: string;
  licenseeWallet: string;
  purchaseIntent: PurchaseIntent;
  purchaseIntentDigest: string;
  paymentAuthorizationDigest: string | null;
  buyerPaymentId: string | null;
  status: OrderStatus;
  buyerSettleTx: string | null;
  settleStatusDetail: string | null;
  environment: "sample" | "production" | "testnet";
  paymentResponseHeader: string | null;
  createdAt: number;
  updatedAt: number;
}

export class Repo {
  constructor(private readonly db: AppDatabase) {}

  /** Run fn atomically (BEGIN/COMMIT, ROLLBACK on throw). */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- assets & offers (catalog) -------------------------------------------

  upsertAsset(row: AssetRow, nowSeconds: number): void {
    this.db
      .prepare(
        `INSERT INTO assets (asset_id, sha256, mime_type, file_path, preview_path, title, creator_display, tags, created_at)
         VALUES (@assetId, @sha256, @mimeType, @filePath, @previewPath, @title, @creatorDisplay, @tags, @createdAt)
         ON CONFLICT(asset_id) DO UPDATE SET
           sha256=excluded.sha256, mime_type=excluded.mime_type, file_path=excluded.file_path,
           preview_path=excluded.preview_path, title=excluded.title, creator_display=excluded.creator_display,
           tags=excluded.tags`
      )
      .run({ ...row, tags: JSON.stringify(row.tags), createdAt: nowSeconds });
  }

  getAsset(assetId: string): AssetRow | undefined {
    const row = this.db.prepare(`SELECT * FROM assets WHERE asset_id = ?`).get(assetId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      assetId: row.asset_id as string,
      sha256: row.sha256 as string,
      mimeType: row.mime_type as string,
      filePath: row.file_path as string,
      previewPath: row.preview_path as string,
      title: row.title as string,
      creatorDisplay: row.creator_display as string,
      tags: JSON.parse(row.tags as string) as string[]
    };
  }

  upsertOffer(row: OfferRow, nowSeconds: number): void {
    this.db
      .prepare(
        `INSERT INTO offers (offer_id, offer_digest, asset_id, asset_sha256, licensor_wallet, payout_wallet,
           creator_net_price_micro, valid_from, valid_until, active, offer_json, created_at)
         VALUES (@offerId, @offerDigest, @assetId, @assetSha256, @licensorWallet, @payoutWallet,
           @creatorNetPriceMicro, @validFrom, @validUntil, @active, @offerJson, @createdAt)
         ON CONFLICT(offer_id) DO UPDATE SET
           offer_digest=excluded.offer_digest, asset_sha256=excluded.asset_sha256,
           payout_wallet=excluded.payout_wallet, creator_net_price_micro=excluded.creator_net_price_micro,
           valid_from=excluded.valid_from, valid_until=excluded.valid_until, active=excluded.active,
           offer_json=excluded.offer_json`
      )
      .run({
        offerId: row.offerId,
        offerDigest: row.offerDigest,
        assetId: row.assetId,
        assetSha256: row.assetSha256,
        licensorWallet: row.licensorWallet,
        payoutWallet: row.payoutWallet,
        creatorNetPriceMicro: row.creatorNetPriceMicro,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        active: row.active ? 1 : 0,
        offerJson: JSON.stringify(row.offer),
        createdAt: nowSeconds
      });
  }

  private mapOffer(row: Record<string, unknown>): OfferRow {
    return {
      offerId: row.offer_id as string,
      offerDigest: row.offer_digest as string,
      assetId: row.asset_id as string,
      assetSha256: row.asset_sha256 as string,
      licensorWallet: row.licensor_wallet as string,
      payoutWallet: row.payout_wallet as string,
      creatorNetPriceMicro: row.creator_net_price_micro as number,
      validFrom: row.valid_from as number,
      validUntil: row.valid_until as number,
      active: (row.active as number) === 1,
      offer: JSON.parse(row.offer_json as string) as CreatorOffer
    };
  }

  /** Append a signed offer version (no-op if this exact digest is already archived). */
  archiveOfferVersion(offerDigest: string, offerId: string, offer: CreatorOffer, nowSeconds: number): void {
    this.db
      .prepare(`INSERT INTO offer_versions (offer_digest, offer_id, offer_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(offer_digest) DO NOTHING`)
      .run(offerDigest, offerId, JSON.stringify(offer), nowSeconds);
  }

  /** Fetch the EXACT historical offer a quote/credential referenced. */
  getOfferByDigest(offerDigest: string): CreatorOffer | undefined {
    const row = this.db.prepare(`SELECT offer_json FROM offer_versions WHERE offer_digest = ?`).get(offerDigest) as
      | { offer_json: string }
      | undefined;
    if (row) return JSON.parse(row.offer_json) as CreatorOffer;
    const head = this.db.prepare(`SELECT offer_json FROM offers WHERE offer_digest = ?`).get(offerDigest) as
      | { offer_json: string }
      | undefined;
    return head ? (JSON.parse(head.offer_json) as CreatorOffer) : undefined;
  }

  archiveLegalText(hash: string, body: string, nowSeconds: number): void {
    this.db
      .prepare(`INSERT INTO legal_texts (legal_text_hash, body, created_at) VALUES (?, ?, ?) ON CONFLICT(legal_text_hash) DO NOTHING`)
      .run(hash, body, nowSeconds);
  }

  getLegalText(hash: string): string | undefined {
    const row = this.db.prepare(`SELECT body FROM legal_texts WHERE legal_text_hash = ?`).get(hash) as { body: string } | undefined;
    return row?.body;
  }

  listActiveOffers(): OfferRow[] {
    const rows = this.db.prepare(`SELECT * FROM offers WHERE active = 1`).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapOffer(r));
  }

  getOffer(offerId: string): OfferRow | undefined {
    const row = this.db.prepare(`SELECT * FROM offers WHERE offer_id = ?`).get(offerId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapOffer(row) : undefined;
  }

  // --- quotes ---------------------------------------------------------------

  insertQuote(row: QuoteRow, nowSeconds: number): void {
    // Quotes are IMMUTABLE once written. The quote engine derives identical
    // ids/expiries/commitments within a TTL bucket, so a re-quote is a no-op —
    // never an update that could drift a stored quote out from under a buyer
    // who is mid-payment against the earlier terms.
    this.db
      .prepare(
        `INSERT INTO quotes (quote_id, quote_commitment, offer_id, offer_digest, licensee_wallet, use_spec_json,
           use_spec_hash, price_micro, platform_fee_micro, creator_payout_micro,
           settlement_network, payment_asset, pay_to, idempotency_key, expires_at, created_at)
         VALUES (@quoteId, @quoteCommitment, @offerId, @offerDigest, @licenseeWallet, @useSpecJson,
           @useSpecHash, @priceMicro, @platformFeeMicro, @creatorPayoutMicro,
           @settlementNetwork, @paymentAsset, @payTo, @idempotencyKey, @expiresAt, @createdAt)
         ON CONFLICT(quote_id) DO NOTHING`
      )
      .run({
        quoteId: row.quoteId,
        quoteCommitment: row.quoteCommitment,
        offerId: row.offerId,
        offerDigest: row.offerDigest,
        licenseeWallet: row.licenseeWallet,
        useSpecJson: JSON.stringify(row.useSpec),
        useSpecHash: row.useSpecHash,
        priceMicro: row.priceMicro,
        platformFeeMicro: row.platformFeeMicro,
        creatorPayoutMicro: row.creatorPayoutMicro,
        settlementNetwork: row.settlementNetwork,
        paymentAsset: row.paymentAsset,
        payTo: row.payTo,
        idempotencyKey: row.idempotencyKey,
        expiresAt: row.expiresAt,
        createdAt: nowSeconds
      });
  }

  private mapQuote(row: Record<string, unknown>): QuoteRow {
    return {
      quoteId: row.quote_id as string,
      quoteCommitment: row.quote_commitment as string,
      offerId: row.offer_id as string,
      offerDigest: row.offer_digest as string,
      licenseeWallet: row.licensee_wallet as string,
      useSpec: JSON.parse(row.use_spec_json as string) as UseSpec,
      useSpecHash: row.use_spec_hash as string,
      priceMicro: row.price_micro as number,
      platformFeeMicro: row.platform_fee_micro as number,
      creatorPayoutMicro: row.creator_payout_micro as number,
      settlementNetwork: (row.settlement_network as string) ?? "eip155:196",
      paymentAsset: (row.payment_asset as string) ?? "",
      payTo: (row.pay_to as string) ?? "",
      idempotencyKey: row.idempotency_key as string,
      expiresAt: row.expires_at as number
    };
  }

  getQuoteByCommitment(quoteCommitment: string, licenseeWallet: string, idempotencyKey: string): QuoteRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM quotes WHERE quote_commitment = ? AND licensee_wallet = ? AND idempotency_key = ?`)
      .get(quoteCommitment, licenseeWallet, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? this.mapQuote(row) : undefined;
  }

  getQuoteById(quoteId: string): QuoteRow | undefined {
    const row = this.db.prepare(`SELECT * FROM quotes WHERE quote_id = ?`).get(quoteId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapQuote(row) : undefined;
  }

  // --- orders ---------------------------------------------------------------

  private mapOrder(row: Record<string, unknown>): OrderRow {
    return {
      orderId: row.order_id as string,
      quoteId: row.quote_id as string,
      quoteCommitment: row.quote_commitment as string,
      licenseeWallet: row.licensee_wallet as string,
      purchaseIntent: JSON.parse(row.purchase_intent_json as string) as PurchaseIntent,
      purchaseIntentDigest: row.purchase_intent_digest as string,
      paymentAuthorizationDigest: (row.payment_authorization_digest as string) ?? null,
      buyerPaymentId: (row.buyer_payment_id as string) ?? null,
      status: row.status as OrderStatus,
      buyerSettleTx: (row.buyer_settle_tx as string) ?? null,
      settleStatusDetail: (row.settle_status_detail as string) ?? null,
      environment: ((row.environment as string) ?? "sample") as "sample" | "production" | "testnet",
      paymentResponseHeader: (row.payment_response_header as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  getOrder(orderId: string): OrderRow | undefined {
    const row = this.db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapOrder(row) : undefined;
  }

  getOrderByCommitment(quoteCommitment: string, licenseeWallet: string): OrderRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM orders WHERE quote_commitment = ? AND licensee_wallet = ?`)
      .get(quoteCommitment, licenseeWallet) as Record<string, unknown> | undefined;
    return row ? this.mapOrder(row) : undefined;
  }

  getOrderByPaymentId(buyerPaymentId: string): OrderRow | undefined {
    const row = this.db.prepare(`SELECT * FROM orders WHERE buyer_payment_id = ?`).get(buyerPaymentId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapOrder(row) : undefined;
  }

  /** Idempotent order creation keyed on (quote_commitment, licensee). Returns the order (new or existing). */
  createOrGetOrder(input: {
    orderId: string;
    quoteId: string;
    quoteCommitment: string;
    licenseeWallet: string;
    purchaseIntent: PurchaseIntent;
    purchaseIntentDigest: string;
    status: OrderStatus;
    environment: "sample" | "production" | "testnet";
    nowSeconds: number;
  }): OrderRow {
    const existing = this.getOrderByCommitment(input.quoteCommitment, input.licenseeWallet);
    if (existing) return existing;
    try {
      this.db
        .prepare(
          `INSERT INTO orders (order_id, quote_id, quote_commitment, licensee_wallet, purchase_intent_json,
             purchase_intent_digest, status, environment, created_at, updated_at)
           VALUES (@orderId, @quoteId, @quoteCommitment, @licenseeWallet, @purchaseIntentJson,
             @purchaseIntentDigest, @status, @environment, @now, @now)`
        )
        .run({
          orderId: input.orderId,
          quoteId: input.quoteId,
          quoteCommitment: input.quoteCommitment,
          licenseeWallet: input.licenseeWallet,
          purchaseIntentJson: JSON.stringify(input.purchaseIntent),
          purchaseIntentDigest: input.purchaseIntentDigest,
          status: input.status,
          environment: input.environment,
          now: input.nowSeconds
        });
    } catch (error) {
      // Concurrent insert lost the race — return the winner.
      const race = this.getOrderByCommitment(input.quoteCommitment, input.licenseeWallet);
      if (race) return race;
      throw error;
    }
    return this.getOrderByCommitment(input.quoteCommitment, input.licenseeWallet)!;
  }

  updateOrderStatus(orderId: string, status: OrderStatus, nowSeconds: number, detail?: string): void {
    this.db
      .prepare(`UPDATE orders SET status = ?, settle_status_detail = COALESCE(?, settle_status_detail), updated_at = ? WHERE order_id = ?`)
      .run(status, detail ?? null, nowSeconds, orderId);
  }

  markBuyerSettled(orderId: string, buyerPaymentId: string, buyerSettleTx: string | null, paymentAuthDigest: string, nowSeconds: number): void {
    this.db
      .prepare(
        `UPDATE orders SET status = 'BUYER_SETTLED', buyer_payment_id = ?, buyer_settle_tx = ?,
           payment_authorization_digest = ?, updated_at = ? WHERE order_id = ?`
      )
      .run(buyerPaymentId, buyerSettleTx, paymentAuthDigest, nowSeconds, orderId);
  }

  /** Persist the standard x402 receipt header so idempotent replays return it too. */
  setPaymentResponseHeader(orderId: string, header: string, nowSeconds: number): void {
    this.db
      .prepare(`UPDATE orders SET payment_response_header = ?, updated_at = ? WHERE order_id = ?`)
      .run(header, nowSeconds, orderId);
  }

  /**
   * Atomically claim an order for settlement with ONE payment authorization.
   * Exactly one authorization can hold the claim: a concurrent request carrying
   * a DIFFERENT authorization for the same order gets false (409 upstream) and
   * never reaches the facilitator. Retrying with the SAME authorization (e.g.
   * after a crash mid-settle or a failed settlement) re-acquires the claim.
   */
  claimForSettlement(orderId: string, paymentAuthorizationDigest: string, nowSeconds: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE orders SET status = 'PAYMENT_CLAIMED', payment_authorization_digest = @digest, updated_at = @now
           WHERE order_id = @orderId AND (
             status IN ('PAYMENT_VERIFIED','DELIVERY_PREPARED')
             OR (status IN ('PAYMENT_CLAIMED','SETTLEMENT_FAILED') AND payment_authorization_digest = @digest)
           )`
      )
      .run({ orderId, digest: paymentAuthorizationDigest, now: nowSeconds });
    return Number(result.changes) === 1;
  }

  /**
   * Record a settlement that the facilitator left non-final (pending/timeout).
   * The tx hash is persisted so the reconciler can poll GET /settle/status and
   * later activate or fail the order. Never called for a "success" settle.
   */
  markSettlementPending(orderId: string, txHash: string | null, status: OrderStatus, detail: string | null, nowSeconds: number): void {
    this.db
      .prepare(`UPDATE orders SET status = ?, buyer_settle_tx = ?, settle_status_detail = ?, updated_at = ? WHERE order_id = ?`)
      .run(status, txHash, detail, nowSeconds, orderId);
  }

  /** Orders awaiting reconciliation: broadcast but not yet finalized on-chain. */
  listUnsettledOrders(): OrderRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
           WHERE status IN ('SETTLEMENT_PENDING','SETTLEMENT_TIMEOUT','SETTLEMENT_UNKNOWN')
             AND buyer_settle_tx IS NOT NULL
           ORDER BY created_at ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapOrder(r));
  }

  // --- licenses -------------------------------------------------------------

  insertLicense(credential: LicenseCredential, nowSeconds: number): void {
    this.db
      .prepare(
        `INSERT INTO licenses (license_id, order_id, credential_json, issued_at, expires_at, status)
         VALUES (@licenseId, @orderId, @credentialJson, @issuedAt, @expiresAt, 'ISSUED_PENDING_SETTLEMENT')
         ON CONFLICT(order_id) DO NOTHING`
      )
      .run({
        licenseId: credential.licenseId,
        orderId: credential.orderId,
        credentialJson: JSON.stringify(credential),
        issuedAt: credential.grant.issuedAt,
        expiresAt: credential.grant.expiresAt
      });
  }

  getLicenseByOrder(orderId: string): LicenseCredential | undefined {
    const row = this.db.prepare(`SELECT credential_json FROM licenses WHERE order_id = ?`).get(orderId) as
      | { credential_json: string }
      | undefined;
    return row ? (JSON.parse(row.credential_json) as LicenseCredential) : undefined;
  }

  setLicenseStatus(orderId: string, status: string): void {
    this.db.prepare(`UPDATE licenses SET status = ? WHERE order_id = ?`).run(status, orderId);
  }

  getLicenseStatus(orderId: string): string | undefined {
    const row = this.db.prepare(`SELECT status FROM licenses WHERE order_id = ?`).get(orderId) as
      | { status: string }
      | undefined;
    return row?.status;
  }

  getOrderIdByLicenseId(licenseId: string): string | undefined {
    const row = this.db.prepare(`SELECT order_id FROM licenses WHERE license_id = ?`).get(licenseId) as
      | { order_id: string }
      | undefined;
    return row?.order_id;
  }

  // --- payouts (outbox) -----------------------------------------------------

  enqueuePayout(orderId: string, payoutWallet: string, amountMicro: number, nowSeconds: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO creator_payouts (order_id, payout_wallet, amount_micro, state, updated_at)
           VALUES (?, ?, ?, 'PENDING', ?) ON CONFLICT(order_id, payout_type) DO NOTHING`
        )
        .run(orderId, payoutWallet, amountMicro, nowSeconds);
      this.db
        .prepare(
          `INSERT INTO outbox_jobs (kind, ref_id, state, run_after, created_at, updated_at)
           VALUES ('creator_payout', ?, 'PENDING', 0, ?, ?) ON CONFLICT(kind, ref_id) DO NOTHING`
        )
        .run(orderId, nowSeconds, nowSeconds);
    });
    tx();
  }

  getPayout(orderId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM creator_payouts WHERE order_id = ? AND payout_type = 'creator_net'`).get(orderId) as
      | Record<string, unknown>
      | undefined;
  }

  claimPayoutJobs(nowSeconds: number, leaseSeconds: number, limit: number): string[] {
    const claim = this.db.transaction(() => {
      // PENDING jobs, plus LEASED jobs whose lease expired (worker crashed while
      // holding them) — expired leases return to work automatically.
      const rows = this.db
        .prepare(
          `SELECT ref_id FROM outbox_jobs WHERE kind = 'creator_payout' AND run_after <= ?
             AND state IN ('PENDING','LEASED')
           ORDER BY job_id LIMIT ?`
        )
        .all(nowSeconds, limit) as { ref_id: string }[];
      for (const row of rows) {
        this.db
          .prepare(`UPDATE outbox_jobs SET state = 'LEASED', run_after = ?, updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ?`)
          .run(nowSeconds + leaseSeconds, nowSeconds, row.ref_id);
      }
      return rows.map((r) => r.ref_id);
    });
    return claim();
  }

  /**
   * Persist the send INTENT (reserved chain nonce) BEFORE broadcasting. After a
   * crash mid-send, the worker finds state=SENDING with a nonce and retries with
   * the SAME nonce — the chain accepts at most one transaction per nonce, so a
   * double-spend is structurally impossible.
   */
  recordPayoutIntent(orderId: string, chainNonce: number, nowSeconds: number): void {
    this.db
      .prepare(
        `UPDATE creator_payouts SET state = 'SENDING', chain_nonce = ?, intent_persisted_at = ?,
           attempts = attempts + 1, updated_at = ? WHERE order_id = ? AND payout_type = 'creator_net'`
      )
      .run(chainNonce, nowSeconds, nowSeconds, orderId);
  }

  recordPayoutBroadcast(orderId: string, chainNonce: number, broadcastTx: string, nowSeconds: number): void {
    this.db
      .prepare(
        `UPDATE creator_payouts SET state = 'BROADCAST', chain_nonce = ?, broadcast_tx = ?, intent_persisted_at = COALESCE(intent_persisted_at, ?),
           updated_at = ? WHERE order_id = ? AND payout_type = 'creator_net'`
      )
      .run(chainNonce, broadcastTx, nowSeconds, nowSeconds, orderId);
  }

  // --- faucet (judge onboarding, live mode) ---------------------------------

  faucetClaimCount(network: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM faucet_claims WHERE network = ?`).get(network) as { n: number }).n;
  }

  getFaucetClaim(address: string, network: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM faucet_claims WHERE address = ? AND network = ?`).get(address.toLowerCase(), network) as
      | Record<string, unknown>
      | undefined;
  }

  /** Record/refresh a claim (unlimited testnet claims; created_at drives the cooldown). */
  upsertFaucetClaim(address: string, ip: string, amountMicro: number, network: string, nowSeconds: number): void {
    this.db
      .prepare(
        `INSERT INTO faucet_claims (address, ip, amount_micro, network, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(address, network) DO UPDATE SET ip=excluded.ip, amount_micro=excluded.amount_micro, created_at=excluded.created_at`
      )
      .run(address.toLowerCase(), ip, amountMicro, network, nowSeconds);
  }

  /**
   * ATOMIC cooldown take (round-10): one statement either inserts the first
   * claim or refreshes an existing one — the refresh succeeding ONLY when the
   * previous claim is at least `cooldownSeconds` old. Two concurrent requests
   * can never both win; the check and the write are the same SQL step.
   */
  tryTakeFaucetSlot(address: string, ip: string, amountMicro: number, network: string, nowSeconds: number, cooldownSeconds: number): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO faucet_claims (address, ip, amount_micro, network, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(address, network) DO UPDATE SET
             ip=excluded.ip, amount_micro=excluded.amount_micro, created_at=excluded.created_at, tx=NULL
           WHERE excluded.created_at - faucet_claims.created_at >= ?`
      )
      .run(address.toLowerCase(), ip, amountMicro, network, nowSeconds, cooldownSeconds);
    return Number(r.changes) === 1;
  }

  /**
   * A failed send must not burn the cooldown: reopen the slot (tx IS NULL ⇒
   * nothing was delivered this round). The row itself stays — the sponsored
   * marker only ever errs toward UNDER-counting qualified revenue.
   */
  reopenFaucetSlot(address: string, network: string): void {
    this.db.prepare(`UPDATE faucet_claims SET created_at = 0 WHERE address = ? AND network = ? AND tx IS NULL`).run(address.toLowerCase(), network);
  }

  /** Atomically reserve a claim (one per address PER NETWORK). Returns false if already claimed. */
  reserveFaucetClaim(address: string, ip: string, amountMicro: number, network: string, nowSeconds: number): boolean {
    const result = this.db
      .prepare(`INSERT INTO faucet_claims (address, ip, amount_micro, network, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address, network) DO NOTHING`)
      .run(address.toLowerCase(), ip, amountMicro, network, nowSeconds);
    return Number(result.changes) === 1;
  }

  recordFaucetTx(address: string, network: string, tx: string): void {
    this.db.prepare(`UPDATE faucet_claims SET tx = ? WHERE address = ? AND network = ?`).run(tx, address.toLowerCase(), network);
  }

  releaseFaucetClaim(address: string, network: string): void {
    this.db.prepare(`DELETE FROM faucet_claims WHERE address = ? AND network = ? AND tx IS NULL`).run(address.toLowerCase(), network);
  }

  markPayoutPaid(orderId: string, confirmedTx: string, nowSeconds: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE creator_payouts SET state = 'PAID', confirmed_tx = ?, updated_at = ? WHERE order_id = ? AND payout_type = 'creator_net'`)
        .run(confirmedTx, nowSeconds, orderId);
      this.db.prepare(`UPDATE outbox_jobs SET state = 'DONE', updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ?`).run(nowSeconds, orderId);
      this.db.prepare(`UPDATE orders SET status = 'CREATOR_PAID', updated_at = ? WHERE order_id = ?`).run(nowSeconds, orderId);
    });
    tx();
  }

  /**
   * Round-10 P0: the send failed with "nonce already consumed" and we hold no
   * broadcast tx hash to check — an earlier broadcast may have landed untracked.
   * The only safe automatic action is NONE: park the payout outside the
   * claimable pool until the admin checks the explorer and either attaches the
   * found tx or releases a fresh nonce. Auto-retrying with a new nonce here is
   * exactly the double-pay bug this state exists to prevent.
   */
  markPayoutNeedsReconciliation(orderId: string, error: string, nowSeconds: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE creator_payouts SET state = 'NEEDS_RECONCILIATION', last_error = ?, updated_at = ? WHERE order_id = ? AND payout_type = 'creator_net'`)
        .run(error, nowSeconds, orderId);
      // outbox state outside PENDING/LEASED ⇒ claimPayoutJobs can never pick it up again.
      this.db
        .prepare(`UPDATE outbox_jobs SET state = 'NEEDS_RECONCILIATION', last_error = ?, updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ?`)
        .run(error, nowSeconds, orderId);
      this.db.prepare(`UPDATE orders SET status = 'PAYOUT_NEEDS_RECONCILIATION', updated_at = ? WHERE order_id = ?`).run(nowSeconds, orderId);
    });
    tx();
  }

  /**
   * Receipt-proven revert: the nonce WAS consumed but no value moved, so — and
   * only because a receipt proves that — the pinned nonce may be released for
   * a fresh retry.
   */
  clearPayoutNonceAfterRevert(orderId: string, nowSeconds: number): void {
    this.db
      .prepare(`UPDATE creator_payouts SET chain_nonce = NULL, broadcast_tx = NULL, updated_at = ? WHERE order_id = ? AND payout_type = 'creator_net'`)
      .run(nowSeconds, orderId);
  }

  /** Admin reconcile: attach the explorer-found tx; the worker's receipt check finishes the job. */
  attachReconciledPayoutTx(orderId: string, broadcastTx: string, nowSeconds: number): boolean {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE creator_payouts SET state = 'BROADCAST', broadcast_tx = ?, last_error = NULL, updated_at = ?
             WHERE order_id = ? AND payout_type = 'creator_net' AND state = 'NEEDS_RECONCILIATION'`
        )
        .run(broadcastTx, nowSeconds, orderId);
      if (Number(r.changes) !== 1) return false;
      this.db
        .prepare(`UPDATE outbox_jobs SET state = 'PENDING', run_after = ?, updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ?`)
        .run(nowSeconds, nowSeconds, orderId);
      return true;
    });
    return tx();
  }

  /** Admin reconcile: explorer verified the nonce went to an UNRELATED tx → release for a fresh nonce. */
  releasePayoutForFreshNonce(orderId: string, nowSeconds: number): boolean {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE creator_payouts SET state = 'PENDING', chain_nonce = NULL, broadcast_tx = NULL, last_error = NULL, updated_at = ?
             WHERE order_id = ? AND payout_type = 'creator_net' AND state = 'NEEDS_RECONCILIATION'`
        )
        .run(nowSeconds, orderId);
      if (Number(r.changes) !== 1) return false;
      this.db
        .prepare(`UPDATE outbox_jobs SET state = 'PENDING', run_after = ?, updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ?`)
        .run(nowSeconds, nowSeconds, orderId);
      return true;
    });
    return tx();
  }

  /** Fast requeue while a broadcast awaits its receipt (~seconds, not the full lease). */
  requeuePayoutJob(orderId: string, runAfter: number, nowSeconds: number): void {
    this.db
      .prepare(`UPDATE outbox_jobs SET state = 'PENDING', run_after = ?, updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ? AND state = 'LEASED'`)
      .run(runAfter, nowSeconds, orderId);
  }

  markPayoutFailed(orderId: string, error: string, retryAt: number, terminal: boolean, nowSeconds: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE creator_payouts SET state = ?, last_error = ?, updated_at = ? WHERE order_id = ? AND payout_type = 'creator_net'`)
        .run(terminal ? "FAILED" : "RETRYING", error, nowSeconds, orderId);
      this.db
        .prepare(`UPDATE outbox_jobs SET state = ?, run_after = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE kind = 'creator_payout' AND ref_id = ?`)
        .run(terminal ? "FAILED" : "PENDING", retryAt, error, nowSeconds, orderId);
      this.db
        .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`)
        .run(terminal ? "PAYOUT_FAILED" : "PAYOUT_RETRYING", nowSeconds, orderId);
    });
    tx();
  }
}
