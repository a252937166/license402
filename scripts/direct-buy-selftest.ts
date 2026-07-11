/** A2MCP DIRECT purchase smoke — exactly what an OKX.AI marketplace agent does:
 *  ONE paid POST, no quote, no PurchaseIntent. SELFTEST_NETWORK=testnet for the free rail. */
import { request } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/server/config.js";
import { privateKeyToAddress } from "../src/server/license/eip712.js";

const config = loadConfig();
const PORT = Number(process.env.PORT ?? 8799);
const buyerKey = process.env.DEMO_BUYER_PRIVATE_KEY!;
const BUYER = privateKeyToAddress(buyerKey);
const NETWORK = process.env.SELFTEST_NETWORK === "testnet" ? "testnet" : "mainnet";

function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port: PORT, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = ""; res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, headers: res.headers }));
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}

async function main() {
  console.log("direct buyer:", BUYER, "| rail:", NETWORK);
  const body = { brief: "marketplace-style direct purchase", ...(NETWORK === "testnet" ? { network: "testnet" } : {}) };
  let r = await http("POST", "/v1/acquire/social-commercial", body);
  console.log("1 no-payment →", r.status, "(expect 402)");
  if (r.status !== 402) throw new Error("expected 402");
  const account = privateKeyToAccount(buyerKey as `0x${string}`);
  const signer = { address: account.address, signTypedData: (m: any) => account.signTypedData(m) };
  const { x402Client, x402HTTPClient } = await import("@okxweb3/x402-core/client");
  const { registerExactEvmScheme } = await import("@okxweb3/x402-evm/exact/client");
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: signer as never, networks: ["eip155:196", "eip155:1952"] });
  const hc = new x402HTTPClient(client);
  const payload = await hc.createPaymentPayload(r.json);
  const payHeaders = hc.encodePaymentSignatureHeader(payload);
  r = await http("POST", "/v1/acquire/social-commercial", body, payHeaders as Record<string, string>);
  console.log("2 paid POST →", r.status, "| PAYMENT-RESPONSE:", Boolean(r.headers["payment-response"]));
  if (r.status !== 200) throw new Error("direct settle failed: " + JSON.stringify(r.json).slice(0, 300));
  console.log("   licensee:", r.json.license.licenseeWallet, "(== payer:", (r.json.license.licenseeWallet === BUYER.toLowerCase()) + ")");
  console.log("   order:", r.json.orderId, "| buyerTx:", r.json.settlement.buyerTx);
  console.log("DIRECT MODE OK");
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
