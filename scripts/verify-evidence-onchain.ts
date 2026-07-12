/**
 * ON-CHAIN evidence verifier — proves the SETTLEMENT SEMANTICS the offline
 * pass cannot: for every production/testnet bundle it reads the X Layer RPC
 * and checks, from receipts' Transfer logs on the exact settlement token:
 *
 *   buyer settlement tx : Transfer(from = licensee, value = priceMicro)   [to = payTo when the bundle names it]
 *   creator payout tx   : Transfer(to = the SIGNED offer's payoutWallet, value = creatorPayoutMicro)
 *
 * Usage: tsx scripts/verify-evidence-onchain.ts [file.json ...]
 * Exit 0 = every settlement is semantically proven on-chain.
 * Not part of CI (needs live RPCs); run before freezing evidence.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, defineChain, http, parseAbiItem, decodeEventLog } from "viem";
import { PROJECT_ROOT } from "../src/server/config.js";

type Json = Record<string, any>;

const RAILS: Record<string, { chainId: number; rpc: string; token: string }> = {
  production: { chainId: 196, rpc: process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech", token: "0x779ded0c9e1022225f8e0630b35a9b54be713736" },
  testnet: { chainId: 1952, rpc: process.env.TESTNET_RPC ?? "https://testrpc.xlayer.tech", token: "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c" }
};
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function clientFor(env: string) {
  const rail = RAILS[env];
  const chain = defineChain({
    id: rail.chainId,
    name: env,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rail.rpc] } }
  });
  return { pub: createPublicClient({ chain, transport: http(undefined, { timeout: 20_000, retryCount: 2 }) }), token: rail.token };
}

async function findTransfer(
  pub: ReturnType<typeof clientFor>["pub"],
  token: string,
  tx: string,
  expect: { from?: string; to?: string; value: bigint }
): Promise<{ ok: boolean; detail: string }> {
  const receipt = await pub.getTransactionReceipt({ hash: tx as `0x${string}` });
  if (receipt.status !== "success") return { ok: false, detail: `receipt status ${receipt.status}` };
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const dec = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      const a = dec.args as { from: string; to: string; value: bigint };
      if (
        a.value === expect.value &&
        (!expect.from || a.from.toLowerCase() === expect.from.toLowerCase()) &&
        (!expect.to || a.to.toLowerCase() === expect.to.toLowerCase())
      ) {
        return { ok: true, detail: `Transfer ${a.from.slice(0, 10)}… → ${a.to.slice(0, 10)}… ${a.value}µ` };
      }
    } catch {
      // not a Transfer log
    }
  }
  return { ok: false, detail: "no matching Transfer log on the settlement token" };
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(resolve(PROJECT_ROOT, "docs/evidence"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => resolve(PROJECT_ROOT, "docs/evidence", f));

let allPass = true;
for (const f of files) {
  const bundle = JSON.parse(readFileSync(f, "utf8")) as Json;
  const env = String(bundle.environment);
  console.log(`\n${f.split("/").slice(-1)[0]} (${env})`);
  if (!RAILS[env]) {
    console.log("   – sample environment: no on-chain settlement to prove");
    continue;
  }
  const { pub, token } = clientFor(env);
  const licensee = String(bundle.licenseCredential.licenseeWallet);
  const priceMicro = BigInt(bundle.quote.priceMicro);
  const payTo = typeof bundle.quote.payTo === "string" && bundle.quote.payTo ? String(bundle.quote.payTo) : undefined;

  const buyer = await findTransfer(pub, token, String(bundle.order.buyerSettleTx), { from: licensee, to: payTo, value: priceMicro });
  console.log(`   ${buyer.ok ? "✓" : "✗"} buyer settlement ${String(bundle.order.buyerSettleTx).slice(0, 14)}… — ${buyer.detail}`);
  allPass &&= buyer.ok;

  if (bundle.creatorPayout?.state === "PAID" && bundle.creatorPayout.confirmedTx) {
    const payoutWallet = String(bundle.creatorOffer.payoutWallet);
    const payoutMicro = BigInt(bundle.quote.creatorPayoutMicro);
    // from = the named payout sender (service wallet): a third party sending
    // the same amount to the creator can no longer satisfy this check.
    const payoutSender = typeof bundle.creatorPayout.payoutSender === "string" ? String(bundle.creatorPayout.payoutSender) : undefined;
    const payout = await findTransfer(pub, token, String(bundle.creatorPayout.confirmedTx), { from: payoutSender, to: payoutWallet, value: payoutMicro });
    console.log(`   ${payout.ok ? "✓" : "✗"} creator payout ${String(bundle.creatorPayout.confirmedTx).slice(0, 14)}… — ${payout.detail}`);
    allPass &&= payout.ok;
  }
}
console.log(`\n${allPass ? "ALL SETTLEMENTS PROVEN ON-CHAIN" : "ON-CHAIN VERIFICATION FAILED"}`);
process.exit(allPass ? 0 : 1);
