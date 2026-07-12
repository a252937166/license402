import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbiItem, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig, NetworkProfile } from "./config.js";
import { mainnetProfile } from "./config.js";

/**
 * X Layer chain access (mainnet or testnet profile) for the service-wallet
 * duties: creator payouts and the testnet faucet. All sends from one instance
 * are SERIALIZED through an in-process queue with locally-tracked nonces, so
 * concurrent faucet/payout requests can never race the same nonce (review §5).
 */

function chainFor(profile: NetworkProfile) {
  return defineChain({
    id: profile.chainId,
    name: profile.key === "testnet" ? "X Layer Testnet" : "X Layer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [profile.rpc] } }
  });
}

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }]
  }
] as const;

export class XLayerService {
  private readonly account;
  private readonly wallet;
  private readonly pub;
  private readonly token: `0x${string}`;
  private readonly chain;
  readonly profile: NetworkProfile;
  /** Serialized send queue + locally-advanced nonce (never re-read mid-burst). */
  private sendQueue: Promise<unknown> = Promise.resolve();
  private localNonce: number | null = null;

  constructor(config: AppConfig, profile?: NetworkProfile) {
    this.profile = profile ?? mainnetProfile(config);
    if (!this.profile.asset) throw new Error("settlement token contract required for on-chain operations");
    this.token = this.profile.asset as `0x${string}`;
    this.chain = chainFor(this.profile);
    this.account = privateKeyToAccount(config.servicePrivateKey as `0x${string}`);
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(undefined, { timeout: 15_000, retryCount: 1 }) });
    this.pub = createPublicClient({ chain: this.chain, transport: http(undefined, { timeout: 15_000, retryCount: 1 }) });
  }

  get address(): string {
    return this.account.address;
  }

  async usdtBalance(owner: string): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner as `0x${string}`]
    })) as bigint;
  }

  async okbBalance(owner: string): Promise<bigint> {
    return this.pub.getBalance({ address: owner as `0x${string}` });
  }

  /**
   * Reserve the next nonce, serialized: the first call seeds from the RPC's
   * pending count; subsequent calls advance locally so two concurrent callers
   * (faucet + payout) can never both receive the same nonce.
   */
  async nextNonce(): Promise<number> {
    const run = this.sendQueue.then(async () => {
      if (this.localNonce === null) {
        this.localNonce = await this.pub.getTransactionCount({ address: this.account.address, blockTag: "pending" });
      }
      const n = this.localNonce;
      this.localNonce = n + 1;
      return n;
    });
    this.sendQueue = run.catch(() => {});
    return run;
  }

  /** Broadcast a USDT transfer with a FIXED nonce (double-spend-proof retries). */
  async sendUsdt(to: string, amountMicro: number, nonce: number): Promise<string> {
    const run = this.sendQueue.then(async () => {
      const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to as `0x${string}`, BigInt(amountMicro)] });
      try {
        return await this.wallet.sendTransaction({ to: this.token, data, nonce, chain: this.chain });
      } catch (e) {
        // A failed send may leave the local counter ahead of the chain — reseed
        // from the RPC on the next reservation instead of guessing.
        this.localNonce = null;
        throw e;
      }
    });
    this.sendQueue = run.catch(() => {});
    return run as Promise<string>;
  }

  /** Convenience: reserve a nonce and send in one serialized step. */
  async transferUsdt(to: string, amountMicro: number): Promise<string> {
    const nonce = await this.nextNonce();
    return this.sendUsdt(to, amountMicro, nonce);
  }

  /** "confirmed" | "reverted" | "pending" (not yet found). */
  async receiptStatus(tx: string): Promise<"confirmed" | "reverted" | "pending"> {
    try {
      const r = await this.pub.getTransactionReceipt({ hash: tx as `0x${string}` });
      return r.status === "success" ? "confirmed" : "reverted";
    } catch {
      return "pending";
    }
  }

  /**
   * SEMANTIC receipt verification (round-11): a payout may be marked PAID only
   * by a receipt whose Transfer log proves the exact obligation — OUR token
   * contract emitted Transfer(from=SERVICE wallet, to=the signed payout
   * wallet, value=the owed amount). A merely-successful but unrelated tx
   * (admin typo in attach_tx, nonce consumed by something else) returns
   * "mismatch" and must never settle the obligation.
   */
  async verifyUsdtTransfer(tx: string, expectTo: string, expectAmountMicro: number): Promise<"confirmed" | "reverted" | "pending" | "mismatch"> {
    let receipt;
    try {
      receipt = await this.pub.getTransactionReceipt({ hash: tx as `0x${string}` });
    } catch {
      return "pending";
    }
    if (receipt.status !== "success") return "reverted";
    const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.token.toLowerCase()) continue;
      try {
        const dec = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
        const a = dec.args as { from: string; to: string; value: bigint };
        if (
          a.from.toLowerCase() === this.account.address.toLowerCase() &&
          a.to.toLowerCase() === expectTo.toLowerCase() &&
          a.value === BigInt(expectAmountMicro)
        ) {
          return "confirmed";
        }
      } catch {
        // not a Transfer log — keep scanning
      }
    }
    return "mismatch";
  }
}
