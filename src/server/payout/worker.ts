import { sha256Hex } from "../domain/index.js";
import type { Repo } from "../store/repo.js";
import type { AppConfig } from "../config.js";
import type { XLayerService } from "../chain.js";

/**
 * Creator payout worker (spec v4 §0.8). Anti-duplication discipline, in order:
 *
 *   claim job (expired leases self-recover)
 *   → reserve chain nonce + persist SEND INTENT   (before any broadcast)
 *   → broadcast with that FIXED nonce             (chain accepts one tx per nonce)
 *   → persist broadcast tx
 *   → confirm on-chain receipt                    (only a receipt marks PAID)
 *
 * A crash at any point resumes safely: SENDING+nonce retries the same nonce
 * (a duplicate lands as "nonce too low", never a second payment); BROADCAST
 * re-checks the receipt instead of re-sending; only "confirmed" → PAID.
 */
export interface PayoutSender {
  /** Reserve the next chain nonce (persisted before broadcasting). */
  reserveNonce(): Promise<number>;
  /** Send `amountMicro` USDT to `payoutWallet` with a fixed nonce. Returns the tx hash. */
  send(orderId: string, payoutWallet: string, amountMicro: number, nonce: number): Promise<string>;
  /** Receipt check for a broadcast tx. */
  confirm(tx: string): Promise<"confirmed" | "reverted" | "pending">;
}

class DevPayoutSender implements PayoutSender {
  private n = 0;
  async reserveNonce(): Promise<number> {
    return this.n++;
  }
  async send(orderId: string): Promise<string> {
    return `0xpayout${sha256Hex(`payout:${orderId}`).slice(2, 58)}`;
  }
  async confirm(): Promise<"confirmed"> {
    return "confirmed";
  }
}

/** Real X Layer sender: USDT transfer from the service wallet via viem. */
export class LivePayoutSender implements PayoutSender {
  constructor(private readonly chain: XLayerService) {}
  reserveNonce(): Promise<number> {
    return this.chain.nextNonce();
  }
  send(_orderId: string, payoutWallet: string, amountMicro: number, nonce: number): Promise<string> {
    return this.chain.sendUsdt(payoutWallet, amountMicro, nonce);
  }
  confirm(tx: string): Promise<"confirmed" | "reverted" | "pending"> {
    return this.chain.receiptStatus(tx);
  }
}

export async function runPayoutWorker(
  repo: Repo,
  config: AppConfig,
  now: () => number,
  sender?: PayoutSender
): Promise<{ processed: number }> {
  // Safety: the simulated sender may ONLY run in dev/off mode. In live mode a
  // real on-chain sender must be injected; without one, payouts stay PENDING
  // rather than being marked PAID against a synthetic tx.
  if (!sender) {
    if (config.paymentMode === "live") {
      console.warn("[payout] live mode with no live sender — leaving payouts CREATOR_PAYOUT_PENDING");
      return { processed: 0 };
    }
    sender = new DevPayoutSender();
  }
  const nowSeconds = now();
  const orderIds = repo.claimPayoutJobs(nowSeconds, 300, 10);
  let processed = 0;

  for (const orderId of orderIds) {
    const payout = repo.getPayout(orderId);
    if (!payout || payout.state === "PAID") continue;

    try {
      // Already broadcast → only the receipt decides. Never re-send, never
      // assume: confirmed → PAID; reverted → retry with a fresh nonce;
      // pending → leave for the next pass.
      if (payout.state === "BROADCAST" && payout.broadcast_tx) {
        const status = await sender.confirm(payout.broadcast_tx as string);
        if (status === "confirmed") {
          repo.markPayoutPaid(orderId, payout.broadcast_tx as string, now());
          processed += 1;
        } else if (status === "reverted") {
          repo.markPayoutFailed(orderId, "payout tx reverted", now() + 60, false, now());
        }
        continue;
      }

      const amountMicro = payout.amount_micro as number;
      const wallet = payout.payout_wallet as string;
      // Crash recovery: a SENDING row already reserved its nonce — retry with
      // the SAME nonce so at most one transfer can ever land.
      const nonce =
        payout.state === "SENDING" && payout.chain_nonce != null ? Number(payout.chain_nonce) : await sender.reserveNonce();
      repo.recordPayoutIntent(orderId, nonce, now());
      let tx: string;
      try {
        tx = await sender.send(orderId, wallet, amountMicro, nonce);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // "nonce too low" after a crash-retry means the earlier broadcast DID
        // land — flag for reconciliation rather than paying twice.
        if (/nonce too low|already known|replacement/i.test(msg)) {
          repo.markPayoutFailed(orderId, `nonce ${nonce} already consumed — verify on explorer before manual retry`, now() + 3600, false, now());
          continue;
        }
        throw e;
      }
      repo.recordPayoutBroadcast(orderId, nonce, tx, now());
      const status = await sender.confirm(tx);
      if (status === "confirmed") {
        repo.markPayoutPaid(orderId, tx, now());
        processed += 1;
      }
      // pending → next pass re-checks the receipt (state BROADCAST).
    } catch (error) {
      const attempts = Number(payout.attempts ?? 0);
      const terminal = attempts >= 5;
      const retryAt = now() + Math.min(3600, 30 * 2 ** attempts);
      repo.markPayoutFailed(orderId, error instanceof Error ? error.message : String(error), retryAt, terminal, now());
    }
  }
  return { processed };
}
