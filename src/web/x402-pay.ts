/**
 * Browser payment module — bundles the OFFICIAL OKX x402 client (the same
 * @okxweb3/x402-core / x402-evm code the server and facilitator are built on),
 * adapted to a browser wallet (window.ethereum). Because payload construction
 * is the official client, the wire format cannot drift from the server.
 *
 * Build: npm run build:web  →  public/js/x402-pay.js (iife, global L402PAY)
 */
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { registerExactEvmScheme } from "@okxweb3/x402-evm/exact/client";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface TypedDataMessage {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** MetaMask/OKX Wallet's eth_signTypedData_v4 requires types.EIP712Domain; derive it from the domain keys. */
function domainType(domain: Record<string, unknown>): { name: string; type: string }[] {
  const map: Record<string, string> = { name: "string", version: "string", chainId: "uint256", verifyingContract: "address", salt: "bytes32" };
  return Object.keys(domain)
    .filter((k) => map[k])
    .map((k) => ({ name: k, type: map[k] }));
}

/** JSON for eth_signTypedData_v4 — BigInt values become decimal strings. */
function typedDataJson(m: TypedDataMessage): string {
  const types = (m.types as Record<string, unknown>).EIP712Domain ? m.types : { EIP712Domain: domainType(m.domain), ...m.types };
  return JSON.stringify({ domain: m.domain, types, primaryType: m.primaryType, message: m.message }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  );
}

export interface PaymentExpectations {
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
}

/**
 * Given the 402 PaymentRequired body, produce the PAYMENT-SIGNATURE header via
 * the official client. The wallet prompts once (EIP-3009 TransferWithAuthorization
 * typed-data signature) — gasless for the payer; the facilitator broadcasts.
 *
 * `expected` is a business preflight: the challenge must match what the page
 * showed the buyer (network / token / payTo / amount) or we refuse to invoke
 * the wallet at all — a swapped challenge can never reach a signature prompt.
 */
export async function buildPaymentHeaders(
  paymentRequired: Record<string, unknown>,
  ethereum: Eip1193,
  account: `0x${string}`,
  expected?: PaymentExpectations
): Promise<Record<string, string>> {
  if (expected) {
    const accepts = (paymentRequired.accepts as Record<string, unknown>[]) ?? [];
    const match = accepts.find(
      (r) =>
        (!expected.network || r.network === expected.network) &&
        (!expected.asset || String(r.asset).toLowerCase() === expected.asset.toLowerCase()) &&
        (!expected.payTo || String(r.payTo).toLowerCase() === expected.payTo.toLowerCase()) &&
        (!expected.amount || String(r.amount) === expected.amount)
    );
    if (!match) {
      throw new Error("Challenge mismatch: the server's payment terms differ from what this page displayed — refusing to sign.");
    }
  }
  const signer = {
    address: account,
    async signTypedData(message: TypedDataMessage): Promise<`0x${string}`> {
      return (await ethereum.request({
        method: "eth_signTypedData_v4",
        params: [account, typedDataJson(message)]
      })) as `0x${string}`;
    }
  };
  const client = new x402Client();
  // Both X Layer rails: mainnet 196 (real USDT) and testnet 1952 (free test USDT).
  registerExactEvmScheme(client, { signer, networks: ["eip155:196", "eip155:1952"] });
  const http = new x402HTTPClient(client);
  const payload = await http.createPaymentPayload(paymentRequired as never);
  return http.encodePaymentSignatureHeader(payload);
}

/** Decode the PAYMENT-RESPONSE header (base64 SettleResponse) for display. */
export function decodePaymentResponse(header: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(header)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
