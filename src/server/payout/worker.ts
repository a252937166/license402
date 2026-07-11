import { sha256Hex } from "../domain/index.js";
import type { Repo } from "../store/repo.js";
import type { AppConfig } from "../config.js";

/**
 * Creator payout worker (spec v4 §0.8). Anti-duplication discipline:
 * lease the job → persist a broadcast intent BEFORE sending → on restart the
 * lease + recorded nonce/tx let us reconcile instead of double-paying. In dev
 * mode the "broadcast" is simulated; in live mode this is where the on-chain
 * USDT transfer via the service wallet goes (funded wallet required).
 */
export interface PayoutSender {
  /** Send `amountMicro` USDT to `payoutWallet`. Returns the broadcast tx hash. Must be nonce-stable per orderId. */
  send(orderId: string, payoutWallet: string, amountMicro: number, nonceSeed: number): Promise<{ tx: string; nonce: number }>;
}

class DevPayoutSender implements PayoutSender {
  async send(orderId: string, _wallet: string, _amount: number, nonceSeed: number): Promise<{ tx: string; nonce: number }> {
    return { tx: `0xpayout${sha256Hex(`payout:${orderId}`).slice(2, 58)}`, nonce: nonceSeed };
  }
}

export async function runPayoutWorker(
  repo: Repo,
  config: AppConfig,
  now: () => number,
  sender: PayoutSender = new DevPayoutSender()
): Promise<{ processed: number }> {
  const nowSeconds = now();
  const orderIds = repo.claimPayoutJobs(nowSeconds, 300, 10);
  let processed = 0;

  for (const orderId of orderIds) {
    const payout = repo.getPayout(orderId);
    if (!payout || payout.state === "PAID") continue;

    // Reconcile: if we already broadcast this order's payout, do not re-broadcast.
    if (payout.state === "BROADCAST" && payout.broadcast_tx) {
      repo.markPayoutPaid(orderId, payout.broadcast_tx as string, now());
      processed += 1;
      continue;
    }

    try {
      const amountMicro = payout.amount_micro as number;
      const wallet = payout.payout_wallet as string;
      const nonceSeed = Number(payout.chain_nonce ?? 0);
      const result = await sender.send(orderId, wallet, amountMicro, nonceSeed);
      // Persist broadcast intent + tx BEFORE marking paid (crash here → reconcile finds the tx).
      repo.recordPayoutBroadcast(orderId, result.nonce, result.tx, now());
      repo.markPayoutPaid(orderId, result.tx, now());
      processed += 1;
    } catch (error) {
      const attempts = Number(payout.attempts ?? 0);
      const terminal = attempts >= 5;
      const retryAt = now() + Math.min(3600, 30 * 2 ** attempts);
      repo.markPayoutFailed(orderId, error instanceof Error ? error.message : String(error), retryAt, terminal, now());
    }
  }
  return { processed };
}
