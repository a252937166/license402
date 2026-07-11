import { onSettlementFailure, onSettlementSuccess } from "../orders/prepare.js";
import type { PaymentAdapter } from "./adapter.js";
import type { Repo } from "../store/repo.js";

export interface ReconcileResult {
  /** Orders inspected this pass (had a tx to poll). */
  checked: number;
  /** Pending/timeout orders that finalized as success and were activated. */
  activated: number;
  /** Pending/timeout orders the facilitator reported as failed. */
  failed: number;
  /** Still non-final; left for a later pass. */
  stillPending: number;
  /** Orders skipped (no tx hash, or a transient status-poll error). */
  skipped: number;
}

/**
 * Settlement reconciler (spec v4 §0.1 / §5). syncSettle:true means the facilitator
 * can return "pending" (it trusts the seller and releases) or "timeout"; neither
 * activates the license inline. This drains those orders: for each unsettled order
 * with a broadcast tx it polls GET /settle/status and, on a terminal result,
 * activates (→ enqueues the creator payout) or fails it. "pending"/"unknown" are
 * left for the next pass. Idempotent: onSettlementSuccess guards already-settled
 * orders, so re-running never double-activates or double-pays.
 */
export async function reconcileSettlements(
  repo: Repo,
  payment: Pick<PaymentAdapter, "settleStatus">,
  now: () => number
): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, activated: 0, failed: 0, stillPending: 0, skipped: 0 };
  if (!payment.settleStatus) return result; // dev mode never leaves an order pending

  for (const order of repo.listUnsettledOrders()) {
    if (!order.buyerSettleTx) {
      result.skipped += 1;
      continue;
    }
    result.checked += 1;
    let status;
    try {
      status = await payment.settleStatus(order.buyerSettleTx);
    } catch (e) {
      console.warn("[reconcile] status poll failed", order.orderId, (e as Error).message);
      result.skipped += 1;
      continue;
    }
    if (status.status === "success") {
      onSettlementSuccess(repo, order.orderId, order.buyerSettleTx, { nowSeconds: now() });
      result.activated += 1;
    } else if (status.status === "failed") {
      onSettlementFailure(repo, order.orderId, status.detail ?? "settlement failed on reconcile", { nowSeconds: now() });
      result.failed += 1;
    } else {
      result.stillPending += 1;
    }
  }
  return result;
}
