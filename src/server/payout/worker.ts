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

/** One sender per settlement rail — orders route by their environment stamp. */
export interface PayoutSenders {
  production?: PayoutSender;
  testnet?: PayoutSender;
}

export async function runPayoutWorker(
  repo: Repo,
  config: AppConfig,
  now: () => number,
  senders?: PayoutSender | PayoutSenders
): Promise<{ processed: number }> {
  const map: PayoutSenders =
    senders && typeof (senders as PayoutSender).send === "function" ? { production: senders as PayoutSender } : ((senders as PayoutSenders) ?? {});
  const devSender = new DevPayoutSender();
  const senderFor = (environment: string): PayoutSender | undefined => {
    // Safety: simulated payouts may ONLY back simulated orders. A live order
    // without a real on-chain sender stays CREATOR_PAYOUT_PENDING rather than
    // being marked PAID against a synthetic tx.
    if (environment === "production") {
      if (map.production) return map.production;
      if (config.paymentMode === "live") return undefined;
      return devSender;
    }
    if (environment === "testnet") return map.testnet;
    return devSender; // sample/dev
  };
  const nowSeconds = now();
  const orderIds = repo.claimPayoutJobs(nowSeconds, 300, 10);
  let processed = 0;

  for (const orderId of orderIds) {
    const payout = repo.getPayout(orderId);
    if (!payout || payout.state === "PAID" || payout.state === "NEEDS_RECONCILIATION") continue;
    const order = repo.getOrder(orderId);
    const sender = senderFor(order?.environment ?? "sample");
    if (!sender) {
      console.warn(`[payout] no sender for ${orderId} (${order?.environment}) — leaving PENDING`);
      continue;
    }

    try {
      // Already broadcast → only the receipt decides. Never re-send, never
      // assume: confirmed → PAID; reverted → receipt proves no value moved, so
      // (and only then) the nonce is released for a fresh retry; pending →
      // fast-requeue so the receipt is re-checked in seconds, not a full lease.
      if (payout.state === "BROADCAST" && payout.broadcast_tx) {
        const status = await sender.confirm(payout.broadcast_tx as string);
        if (status === "confirmed") {
          repo.markPayoutPaid(orderId, payout.broadcast_tx as string, now());
          processed += 1;
        } else if (status === "reverted") {
          repo.clearPayoutNonceAfterRevert(orderId, now());
          repo.markPayoutFailed(orderId, "payout tx reverted", now() + 60, false, now());
        } else {
          repo.requeuePayoutJob(orderId, now() + 8, now());
        }
        continue;
      }

      const amountMicro = payout.amount_micro as number;
      const wallet = payout.payout_wallet as string;
      // NONCE DISCIPLINE (round-10 P0): a payout that has EVER persisted a
      // nonce may only ever retry with that same nonce — whatever intermediate
      // state a crash or error left it in. The chain accepts one tx per nonce,
      // so the same-nonce retry can never produce a second transfer. Reserving
      // a fresh nonce for a row that already holds one is the only way this
      // system could pay a creator twice; it never does.
      const nonce = payout.chain_nonce != null ? Number(payout.chain_nonce) : await sender.reserveNonce();
      repo.recordPayoutIntent(orderId, nonce, now());
      let tx: string;
      try {
        tx = await sender.send(orderId, wallet, amountMicro, nonce);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // "nonce too low / already known" on a pinned-nonce retry means an
        // earlier broadcast DID land but we never learned its hash. That money
        // may already be with the creator — so this is parked for explicit
        // reconciliation (admin attaches the explorer-found tx, or releases a
        // fresh nonce after verifying the nonce went elsewhere). NEVER retried
        // automatically, NEVER given a new nonce.
        if (/nonce too low|already known|replacement/i.test(msg)) {
          repo.markPayoutNeedsReconciliation(orderId, `nonce ${nonce} already consumed — verify on explorer, then attach tx or release`, now());
          continue;
        }
        throw e;
      }
      repo.recordPayoutBroadcast(orderId, nonce, tx, now());
      const status = await sender.confirm(tx);
      if (status === "confirmed") {
        repo.markPayoutPaid(orderId, tx, now());
        processed += 1;
      } else {
        // Receipt not yet visible → re-check in seconds (state BROADCAST).
        repo.requeuePayoutJob(orderId, now() + 8, now());
      }
    } catch (error) {
      const attempts = Number(payout.attempts ?? 0);
      const terminal = attempts >= 5;
      const retryAt = now() + Math.min(3600, 30 * 2 ** attempts);
      repo.markPayoutFailed(orderId, error instanceof Error ? error.message : String(error), retryAt, terminal, now());
    }
  }
  return { processed };
}
