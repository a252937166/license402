import { formatMicroUsdt, CREATOR_PAYOUT_MICRO, PLATFORM_FEE_MICRO, SALE_PRICE_MICRO } from "./license/money.js";
import type { AppDatabase } from "./store/db.js";
import type { AppConfig } from "./config.js";

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Public ledger page. Honesty (spec v4 §10): settled figures only when a payout
 * is PAID; otherwise "payable / PENDING". Internal/dev orders are labeled.
 */
export function renderDashboard(db: AppDatabase, config: AppConfig): string {
  const active = (db.prepare(`SELECT COUNT(*) AS n FROM licenses WHERE status = 'ACTIVE'`).get() as { n: number }).n;
  const paidCount = (db.prepare(`SELECT COUNT(*) AS n FROM creator_payouts WHERE state = 'PAID'`).get() as { n: number }).n;
  const buyers = (db.prepare(`SELECT COUNT(DISTINCT licensee_wallet) AS n FROM orders WHERE status IN ('LICENSE_ACTIVE','CREATOR_PAYOUT_PENDING','CREATOR_PAID','PAYOUT_RETRYING','PAYOUT_FAILED')`).get() as { n: number }).n;
  const creatorPaidMicro = paidCount * CREATOR_PAYOUT_MICRO;
  const platformMicro = paidCount * PLATFORM_FEE_MICRO;

  const orders = db
    .prepare(
      `SELECT o.order_id, o.status, o.buyer_settle_tx, o.licensee_wallet, cp.state AS payout_state, cp.confirmed_tx
       FROM orders o LEFT JOIN creator_payouts cp ON cp.order_id = o.order_id AND cp.payout_type = 'creator_net'
       ORDER BY o.created_at DESC LIMIT 50`
    )
    .all() as Record<string, unknown>[];

  const rows = orders
    .map((o) => {
      const settled = o.payout_state === "PAID";
      const econ = settled
        ? `<span class="ok">revenue ${formatMicroUsdt(SALE_PRICE_MICRO)} · creator ${formatMicroUsdt(CREATOR_PAYOUT_MICRO)} · fee ${formatMicroUsdt(PLATFORM_FEE_MICRO)}</span>`
        : `<span class="pending">payable ${formatMicroUsdt(CREATOR_PAYOUT_MICRO)} · ${esc(o.payout_state ?? "PENDING")}</span>`;
      return `<tr>
        <td class="mono">${esc(o.order_id)}</td>
        <td>${esc(o.status)}</td>
        <td class="mono">${o.buyer_settle_tx ? esc(String(o.buyer_settle_tx).slice(0, 14)) + "…" : "—"}</td>
        <td class="mono">${o.confirmed_tx ? esc(String(o.confirmed_tx).slice(0, 14)) + "…" : "—"}</td>
        <td>${econ}</td>
      </tr>`;
    })
    .join("\n");

  const devBanner =
    config.paymentMode === "off"
      ? `<div class="banner">DEV MODE — settlements below are simulated for local testing and are NOT real payments.</div>`
      : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>LICENSE402 — public ledger</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0b0f;color:#e6e8ee;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
h1{font-size:26px;margin:0 0 4px}
.tag{color:#8b93a7;font-size:14px;margin-bottom:24px}
.banner{background:#3a2a12;border:1px solid #6b4e1f;color:#f3c969;padding:10px 14px;border-radius:8px;margin-bottom:20px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.stat{background:#12141c;border:1px solid #1e2230;border-radius:10px;padding:16px}
.stat .n{font-size:24px;font-weight:600}
.stat .l{color:#8b93a7;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1a1d28}
th{color:#8b93a7;font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ok{color:#7fd88f}.pending{color:#e0b657}
.foot{color:#5b6478;font-size:12px;margin-top:28px}
a{color:#7aa2f7}
</style></head><body><div class="wrap">
<h1>LICENSE402 <span style="color:#7aa2f7">·</span> public ledger</h1>
<div class="tag">Acquire the asset. Verify the scope. Audit the payment. — on OKX.AI (X Layer, chainId 196)</div>
${devBanner}
<div class="grid">
  <div class="stat"><div class="n">${active}</div><div class="l">active licenses</div></div>
  <div class="stat"><div class="n">${buyers}</div><div class="l">distinct buyers</div></div>
  <div class="stat"><div class="n">${formatMicroUsdt(creatorPaidMicro)}</div><div class="l">creators paid (USDT)</div></div>
  <div class="stat"><div class="n">${formatMicroUsdt(platformMicro)}</div><div class="l">platform fee (USDT)</div></div>
</div>
<table>
  <thead><tr><th>order</th><th>status</th><th>buyer tx</th><th>creator tx</th><th>economics</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="5" style="color:#5b6478">no orders yet</td></tr>`}</tbody>
</table>
<div class="foot">
Settled figures shown only after a creator payout is PAID; otherwise "payable / PENDING".
LICENSE402 records signed rights declarations, payments, and scope checks — it does not adjudicate copyright ownership or infringement, and is not DRM.
Issuer <span class="mono">${esc(config.issuerAddress)}</span>.
</div>
</div></body></html>`;
}
