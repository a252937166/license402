# Multi-buyer consumption — 6 orders, 3 distinct buyer wallets (official onchainos CLI)

Six real mainnet purchases of the listed A2MCP service, each signed with the **official
`onchainos payment pay-local`** client (x402 v2, exact + EIP-3009, X Layer eip155:196),
from three distinct buyer wallets. Date: 2026-07-14 (UTC+8).

| buyer wallet | order | buyer settle tx |
| --- | --- | --- |
| `0x5f45…00AB` | `ord-90797288490b2499` | `0xe9b97f7ec7303e669d583ddd0eb3431e92c046d0a78c387772a0e3886e2802f4` |
| `0x5f45…00AB` | `ord-705e0fd552a671e6` | `0xc7d6a2a79b13e6e2e08801089579dc08623410323f5fb056e6bd9f25c0ba9fb8` |
| `0x3758…4256` | `ord-2c9278eaecac023c` | `0x245e52c9250a02bba6fc6a5a54257edae005187b17b1af0981d3b8d935fea069` |
| `0x3758…4256` | `ord-37154b302a79db3c` | `0xe4f73138f654e3c32289ec5e139f810f8cebe1c5be2dcd1502b3d60a28196d80` |
| `0xd906…789e` | `ord-24e4e3c6394bf59e` | `0x35b43a68747f3735b2a6db4c87684e6474590276870d232d80b2175d28d7fae0` |
| `0xd906…789e` | `ord-c3be719b80c69a05` | `0x7c9d1cd05d5e38bb453a9a2a9a593730d04584182386d7e7d8b191f0a9ac1e3c` |

All six orders reached `CREATOR_PAID` (0.07 USDT auto payout each). Ledger after this
batch: **13 production licenses · 7 distinct buyers · 13 creator payouts, 0 outstanding**.

## Honesty note

The three buyer wallets are **project-funded demo buyers**, created for this test and
funded 0.25 USDT each from the service treasury by the project owner (funding txs used
treasury nonces 11–13). Disclosed here exactly like every other internal order; the
protocol path is identical to a third-party buyer's.

## Bonus: the payout state machine survived a live nonce collision

The owner's funding transfer consumed treasury nonce 11 — the exact nonce the payout
worker had reserved for `ord-90797288490b2499`'s creator payout. The worker detected
`nonce already consumed`, refused to guess, and parked the payout as
`PAYOUT_NEEDS_RECONCILIATION` (fail-closed, zero double-pay risk). It was then released
through the admin **machine-proof** endpoint: the proof named the consuming tx
(`0xb5a58bd0…`, the 0.25 funding transfer), the server verified on-chain that this tx is
NOT the owed 0.07 transfer, released a fresh nonce, and the payout re-broadcast and
confirmed as `0x2b84df71db3a…`. Order final state: `CREATOR_PAID`.

Verify any bundle from the repo root:

```bash
npx tsx scripts/verify-evidence.ts docs/evidence/okxai-consumption/multi-buyers/bundle-<order>.json
npx tsx scripts/verify-evidence-onchain.ts docs/evidence/okxai-consumption/multi-buyers/bundle-<order>.json
```
