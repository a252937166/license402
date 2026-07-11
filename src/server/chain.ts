import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "./config.js";

/**
 * Minimal X Layer chain access for the two service-wallet duties:
 * creator payouts and the judge faucet. USDT0 transfers via viem.
 */

export const X_LAYER = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/x-layer" } }
});

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

  constructor(config: AppConfig) {
    const asset = process.env.X402_ASSET?.trim();
    if (!asset) throw new Error("X402_ASSET required for on-chain operations");
    this.token = asset as `0x${string}`;
    this.account = privateKeyToAccount(config.servicePrivateKey as `0x${string}`);
    this.wallet = createWalletClient({ account: this.account, chain: X_LAYER, transport: http() });
    this.pub = createPublicClient({ chain: X_LAYER, transport: http() });
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

  async nextNonce(): Promise<number> {
    return this.pub.getTransactionCount({ address: this.account.address, blockTag: "pending" });
  }

  /** Broadcast a USDT transfer with a FIXED nonce (double-spend-proof retries). */
  async sendUsdt(to: string, amountMicro: number, nonce: number): Promise<string> {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to as `0x${string}`, BigInt(amountMicro)] });
    return this.wallet.sendTransaction({ to: this.token, data, nonce, chain: X_LAYER });
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
}
