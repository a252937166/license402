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
}

export function openDatabase(filePath: string): AppDatabase {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const db = openSqlite(filePath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
