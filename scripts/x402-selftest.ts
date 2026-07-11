/**
 * Live x402 facilitator self-test (run on the server — direct route to OKX).
 *
 *   tsx scripts/x402-selftest.ts supported   # list facilitator-supported kinds
 *   tsx scripts/x402-selftest.ts verify      # sign a real EIP-3009 auth (service
 *                                            # wallet → itself, 0.10 USDT) and call
 *                                            # facilitator verify — NO funds move
 *   tsx scripts/x402-selftest.ts settle      # verify + SETTLE the same self-transfer:
 *                                            # a REAL X Layer transaction (0.10 USDT
 *                                            # service → service, zero net loss)
 *
 * verify/settle use a SELF-transfer authorization (from == to == service wallet),
 * so settling moves 0.10 USDT from the service wallet to the service wallet.
 * Zero net loss, real wire format, real on-chain settlement evidence.
 */
import { randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { loadConfig } from "../src/server/config.js";
import { privateKeyToAddress, recoverDigestSigner, signDigest } from "../src/server/license/eip712.js";

const config = loadConfig();
if (!config.okx) throw new Error("OKX credentials missing in env");

// USDT0 on X Layer — verified on-chain 2026-07-11:
//   name()="USD₮0", DOMAIN_SEPARATOR matches {name:"USD₮0",version:"1",chainId:196},
//   TRANSFER_WITH_AUTHORIZATION_TYPEHASH = standard EIP-3009 typehash.
const ASSET = process.env.X402_ASSET ?? "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const DOMAIN_SEPARATOR = hexToBytes("d591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d");
const TRANSFER_TYPEHASH = hexToBytes("7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267");

function abiWord(hexNo0x: string): Uint8Array {
  return hexToBytes(hexNo0x.padStart(64, "0"));
}
function addressWord(addr: string): Uint8Array {
  return abiWord(addr.replace(/^0x/, "").toLowerCase());
}
function uintWord(n: bigint): Uint8Array {
  return abiWord(n.toString(16));
}

export function transferAuthorizationDigest(auth: {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Uint8Array;
}): Uint8Array {
  const structHash = keccak_256(
    concatBytes(
      TRANSFER_TYPEHASH,
      addressWord(auth.from),
      addressWord(auth.to),
      uintWord(auth.value),
      uintWord(auth.validAfter),
      uintWord(auth.validBefore),
      auth.nonce
    )
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

async function main(): Promise<void> {
  const step = process.argv[2] ?? "supported";
  const { OKXFacilitatorClient } = await import("@okxweb3/x402-core");
  const client = new OKXFacilitatorClient({
    apiKey: config.okx!.apiKey,
    secretKey: config.okx!.secretKey,
    passphrase: config.okx!.passphrase,
    syncSettle: true
  });

  if (step === "supported") {
    const kinds = await client.getSupported();
    console.log(JSON.stringify(kinds, null, 2));
    return;
  }

  if (step === "verify" || step === "settle") {
    const serviceKey = process.env.SERVICE_WALLET_PRIVATE_KEY;
    if (!serviceKey) throw new Error("SERVICE_WALLET_PRIVATE_KEY missing");
    const payer = privateKeyToAddress(serviceKey);
    const now = Math.floor(Date.now() / 1000);
    const nonce = new Uint8Array(randomBytes(32));

    const requirements = {
      scheme: "exact",
      network: config.network,
      asset: ASSET,
      amount: "100000", // 0.10 USDT (6 decimals)
      payTo: config.payToAddress,
      maxTimeoutSeconds: 120,
      extra: { name: "USD₮0", version: "1" }
    };

    const authorization = {
      from: payer,
      to: config.payToAddress,
      value: "100000",
      validAfter: String(now - 5),
      validBefore: String(now + 120),
      nonce: `0x${bytesToHex(nonce)}`
    };
    const digest = transferAuthorizationDigest({
      from: payer,
      to: config.payToAddress,
      value: 100000n,
      validAfter: BigInt(now - 5),
      validBefore: BigInt(now + 120),
      nonce
    });
    const signature = signDigest(digest, serviceKey);
    // Sanity: the signature must recover to the payer before we send anything.
    if (recoverDigestSigner(digest, signature) !== payer.toLowerCase()) {
      throw new Error("local recover failed — signature would be rejected");
    }

    const paymentPayload = {
      x402Version: 2,
      resource: {
        url: `${config.publicOrigin}/v1/acquire/social-commercial`,
        description: "LICENSE402 social-commercial license",
        mimeType: "application/json"
      },
      accepted: requirements,
      payload: { authorization, signature }
    };

    console.log("payer:", payer);
    const result = await client.verify(paymentPayload, requirements);
    console.log("verify result:", JSON.stringify(result, null, 2));
    if (step === "verify" || !result.isValid) return;

    // Real settlement: the facilitator broadcasts transferWithAuthorization on
    // X Layer. from == to == service wallet → zero net loss, real explorer tx.
    const settled = await client.settle(paymentPayload, requirements);
    console.log("settle result:", JSON.stringify(settled, null, 2));
    if (settled.transaction) {
      console.log(`explorer: https://www.oklink.com/x-layer/tx/${settled.transaction}`);
    }
    return;
  }

  if (step === "status") {
    const tx = process.argv[3];
    if (!tx) throw new Error("usage: x402-selftest.ts status <txHash>");
    const r = await client.getSettleStatus(tx);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  throw new Error(`unknown step ${step}`);
}

main().catch((e) => {
  console.error("SELFTEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
