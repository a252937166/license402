import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite } from "./sqlite.js";
import type { Database } from "./sqlite.js";

/**
 * SQLite (WAL) persistence with the spec v4 §0.8 anti-duplication invariants
 * expressed as UNIQUE constraints. Replaying the same payment N times must
 * converge to the same orderId/licenseId and at most ONE payout job.
 */

export type OrderStatus =
  | "QUOTED"
  | "PAYMENT_VERIFIED"
  | "DELIVERY_PREPARED"
  | "PAYMENT_CLAIMED"
  | "SETTLEMENT_PENDING"
  | "SETTLEMENT_TIMEOUT"
  | "SETTLEMENT_UNKNOWN"
  | "SETTLEMENT_FAILED"
  | "BUYER_SETTLED"
  | "LICENSE_ACTIVE"
  | "CREATOR_PAYOUT_PENDING"
  | "PAYOUT_RETRYING"
  | "PAYOUT_FAILED"
  | "CREATOR_PAID";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS offers (
  offer_id TEXT PRIMARY KEY,
  offer_digest TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL,
  asset_sha256 TEXT NOT NULL,
  licensor_wallet TEXT NOT NULL,
  payout_wallet TEXT NOT NULL,
  creator_net_price_micro INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  offer_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  preview_path TEXT NOT NULL,
  title TEXT NOT NULL,
  creator_display TEXT NOT NULL,
  tags TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- APPEND-ONLY signed-material archive (review round 10 P0-1): a signed offer
-- or legal text is NEVER updated in place. Heads (the mutable current catalog)
-- live in the offers table; every version ever seen lives here forever, so
-- historical proof bundles re-verify byte-for-byte.
CREATE TABLE IF NOT EXISTS offer_versions (
  offer_digest TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legal_texts (
  legal_text_hash TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  quote_id TEXT PRIMARY KEY,
  quote_commitment TEXT NOT NULL,
  offer_id TEXT NOT NULL REFERENCES offers(offer_id),
  offer_digest TEXT NOT NULL,
  licensee_wallet TEXT NOT NULL,
  use_spec_json TEXT NOT NULL,
  use_spec_hash TEXT NOT NULL,
  price_micro INTEGER NOT NULL,
  platform_fee_micro INTEGER NOT NULL,
  creator_payout_micro INTEGER NOT NULL,
  settlement_network TEXT NOT NULL DEFAULT 'eip155:196',
  payment_asset TEXT NOT NULL DEFAULT '',
  pay_to TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(quote_commitment, licensee_wallet, idempotency_key)
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(quote_id),
  quote_commitment TEXT NOT NULL,
  licensee_wallet TEXT NOT NULL,
  purchase_intent_json TEXT NOT NULL,
  purchase_intent_digest TEXT NOT NULL,
  payment_authorization_digest TEXT,
  buyer_payment_id TEXT UNIQUE,
  status TEXT NOT NULL,
  buyer_settle_tx TEXT,
  settle_status_detail TEXT,
  environment TEXT NOT NULL DEFAULT 'sample',
  payment_response_header TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(quote_commitment, licensee_wallet)
);

CREATE TABLE IF NOT EXISTS licenses (
  license_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
  credential_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ISSUED_PENDING_SETTLEMENT'
);

CREATE TABLE IF NOT EXISTS creator_payouts (
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  payout_type TEXT NOT NULL DEFAULT 'creator_net',
  payout_wallet TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING',
  lease_until INTEGER,
  chain_nonce INTEGER,
  intent_persisted_at INTEGER,
  broadcast_tx TEXT,
  confirmed_tx TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (order_id, payout_type)
);

CREATE TABLE IF NOT EXISTS faucet_claims (
  address TEXT NOT NULL,
  ip TEXT,
  tx TEXT,
  amount_micro INTEGER NOT NULL,
  network TEXT NOT NULL DEFAULT 'testnet',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (address, network)
);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING',
  run_after INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_jobs(state, run_after);
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_intent_digest ON orders(purchase_intent_digest);
`;

export type AppDatabase = Database;

/**
 * In-place migrations for databases created before a column existed. Pre-existing
 * rows are all simulated/dev settlements, so environment backfills to 'sample';
 * live orders are written 'production' explicitly.
 */
function migrate(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(orders)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "environment")) {
    db.exec(`ALTER TABLE orders ADD COLUMN environment TEXT NOT NULL DEFAULT 'sample'`);
  }
  if (!cols.some((c) => c.name === "payment_response_header")) {
    // Standard x402 receipt header, persisted so idempotent replays of a settled
    // payment can return the SAME PAYMENT-RESPONSE the first delivery carried.
    db.exec(`ALTER TABLE orders ADD COLUMN payment_response_header TEXT`);
  }
  const qcols = db.prepare(`PRAGMA table_info(quotes)`).all() as { name: string }[];
  if (!qcols.some((c) => c.name === "settlement_network")) {
    // Rail semantics (commitment v2): pre-existing quotes were all mainnet-era.
    db.exec(`ALTER TABLE quotes ADD COLUMN settlement_network TEXT NOT NULL DEFAULT 'eip155:196'`);
    db.exec(`ALTER TABLE quotes ADD COLUMN payment_asset TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE quotes ADD COLUMN pay_to TEXT NOT NULL DEFAULT ''`);
  }
  const fcols = db.prepare(`PRAGMA table_info(faucet_claims)`).all() as { name: string; pk: number }[];
  if (fcols.length > 0 && !fcols.some((c) => c.name === "network")) {
    // The two pre-existing claims were the mainnet-era grants; new claims are
    // testnet-only. Sponsorship joins now match on the SAME rail only.
    db.exec(`ALTER TABLE faucet_claims ADD COLUMN network TEXT NOT NULL DEFAULT 'mainnet'`);
  }
  // One claim per address PER NETWORK: a mainnet-era claim must not block the
  // same wallet's testnet grant. Rebuild the table when the PK is address-only.
  const addrPkOnly = fcols.length > 0 && fcols.some((c) => c.name === "address" && c.pk === 1) && !fcols.some((c) => c.name === "network" && c.pk > 0);
  if (addrPkOnly) {
    db.exec(`
      CREATE TABLE faucet_claims_v2 (
        address TEXT NOT NULL, ip TEXT, tx TEXT, amount_micro INTEGER NOT NULL,
        network TEXT NOT NULL DEFAULT 'testnet', created_at INTEGER NOT NULL,
        PRIMARY KEY (address, network)
      );
      INSERT INTO faucet_claims_v2 (address, ip, tx, amount_micro, network, created_at)
        SELECT address, ip, tx, amount_micro, COALESCE(network,'mainnet'), created_at FROM faucet_claims;
      DROP TABLE faucet_claims;
      ALTER TABLE faucet_claims_v2 RENAME TO faucet_claims;
    `);
  }
}

export function openDatabase(filePath: string): AppDatabase {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const db = openSqlite(filePath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
