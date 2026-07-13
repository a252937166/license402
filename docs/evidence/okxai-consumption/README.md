# OKX.AI marketplace consumption test — Agent #5089, service "商业图片授权"

Real-money purchase of the **listed A2MCP service** exactly as the OKX.AI marketplace
instructs a buyer's coding agent to do it (listing modal → "复制以下信息" → OKX Agent
Payments Protocol), executed with the **official `onchainos` CLI** (v4.2.3).

- Listing: https://www.okx.ai/agents/5089 (LICENSE402 · Agent ID 5089)
- A2MCP endpoint from the listing: `POST https://license402.axiqo.xyz/v1/acquire/social-commercial`
- Date: 2026-07-14 (UTC+8)

## Flow (x402 v2, exact + EIP-3009, X Layer mainnet eip155:196)

1. Unpaid `POST {}` → **402** with `PAYMENT-REQUIRED` header (`x402-402-headers.txt`);
   body pre-discloses the exact SKU (offer `off-cyber-dragon`, assetSha256, offerDigest,
   legalTextHash, price 0.10 USDT).
2. `onchainos payment pay-local --payload <PAYMENT-REQUIRED>` signed the EIP-3009
   authorization (`onchainos-pay-local-output.json` → `authorization_header`).
3. Paid retry with `PAYMENT-SIGNATURE` → **200** (`x402-200-headers.txt`) with
   `PAYMENT-RESPONSE` = settle tx.

## Result

| item | value |
| --- | --- |
| order | `ord-4355a86e49790f96` |
| credential | `lic-0bb40bb54c1670b7` (`license-lic-0bb40bb54c1670b7.json`) — offline verifier: AUTHENTIC PRODUCTION CREDENTIAL, authorization `x402_direct` |
| buyer settle tx | `0x629ed8e6735efc7ac5ab11dad67861ae724989894c2020af046c1cac3ce0bf81` (0.10 USDT buyer → service) |
| creator payout tx | `0x9a9c2509d6fbd180d38eadaa865cacbe5b0175606e0f36cf6b4a0a6868f70c53` (0.07 USDT service → creator, auto ~12 s) |
| order status | `CREATOR_PAID` · economics 0.10 = 0.07 creator + 0.03 platform |
| asset delivery | 200, 2,598,813 bytes, sha-pinned URL matches disclosed `assetSha256` |
| scope checks | `commercial_social_post`+`x` → PERMITTED · `model_training` → NOT_PERMITTED |

Explorer: https://www.oklink.com/x-layer/tx/0x629ed8e6735efc7ac5ab11dad67861ae724989894c2020af046c1cac3ce0bf81

## Honesty note

The buyer wallet is the project's demo **creator wallet** `0xc11e…29e9` signing locally
(`payment pay-local`), because the account's TEE Agentic Wallet
(`0x2e9c240e80acef59c304eb6b3854fcb357b0ecde`) holds no USDT yet — funding it requires a
manual top-up by the owner. Self-funded and disclosed, like every internal test order.
The protocol path (402 challenge → official OKX CLI signature → OKX facilitator
settlement → automatic on-chain creator payout) is identical to a third-party buyer's.
To replay TEE-mode: fund the agentic wallet with ≥0.2 USDT on X Layer and use
`onchainos payment pay` instead of `pay-local`.

Verify this bundle offline/on-chain from the repo root:

```bash
npx tsx scripts/verify-evidence.ts docs/evidence/okxai-consumption/bundle-ord-4355a86e49790f96.json
npx tsx scripts/verify-evidence-onchain.ts docs/evidence/okxai-consumption/bundle-ord-4355a86e49790f96.json
```
