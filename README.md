# LICENSE402 — a file is not permission

[![CI](https://github.com/a252937166/license402/actions/workflows/ci.yml/badge.svg)](https://github.com/a252937166/license402/actions/workflows/ci.yml)

An agent can download an image. **Using** it is a different question. LICENSE402 is an
agent-native content-licensing service (an OKX.AI ASP): an agent buys a license for an
original artwork, pays **0.10 USDT over x402 on X Layer**, and receives the asset plus a
**signed, machine-checkable usage scope**. Any downstream agent can then ask, deterministically:
*may I use this, this way?* → `PERMITTED / PERMITTED_WITH_DUTIES / NOT_PERMITTED /
INVALID_CREDENTIAL / INDETERMINATE` (+ `PERMITTED_TESTNET_ONLY` for test credentials).

- **Live site:** https://license402.axiqo.xyz (check `/version.json` and the
  `X-License402-Build` header — every response carries the serving commit)
- **OKX.AI listing:** ASP **#5089 "LICENSE402"**, service "Commercial image license"
  (A2MCP, 0.1 USDT/call) — endpoint `POST /v1/acquire/social-commercial`
- **Pages:** [`/market`](https://license402.axiqo.xyz/market) (signed catalog) ·
  [`/buy`](https://license402.axiqo.xyz/buy) (wallet checkout, mainnet + free testnet) ·
  [`/verify`](https://license402.axiqo.xyz/verify) (paste any credential → verdict)

## Three-minute judge flow

1. **No wallet:** open the home page — the *Interactive signed sample* is a real
   creator-offer + buyer-intent + issuer credential (nothing written, no funds moved).
   Click the hero buttons: publish → permitted, train → not permitted, tamper → invalid.
2. **Zero cost, full loop:** `/buy` → select **Testnet** → connect OKX Wallet/MetaMask →
   grab free test USDT from the official X Layer faucet → two signatures → REAL x402 settlement + REAL creator payout on
   X Layer testnet, with OKLink links.
3. **Real money:** `/buy` → **Mainnet** → fund your wallet with 0.10 USDT (X Layer) →
   the identical flow settles a production license. (There is deliberately **no mainnet
   faucet** — production purchases are self-funded, so qualified revenue stays honest.)
4. **As an agent:** hire ASP #5089 on OKX.AI, or POST the endpoint yourself (below).

## Experience truth matrix

| Mode | Signatures | Settlement | Credential | Counts as revenue |
|---|---|---|---|---|
| Signed sample | real | none | `credentialEnvironment: "sample"` | no |
| Testnet loop | real | real (eip155:1952, test USDT) | `"testnet"` → verdicts read `PERMITTED_TESTNET_ONLY` | no |
| Mainnet live | real | real (eip155:196, USDT) | `"production"` | yes (qualified) |
| OKX.AI direct | x402 payment sig | real (USDT) | `"production"`, `authorizationMode: "x402_direct"` | yes (qualified) |

Sponsored orders (buyer drew mainnet faucet funds — historical only) are labeled and
**excluded** from qualified revenue.

## The transaction, end to end

```
POST /v1/quote {use, licenseeWallet, network?}     one exact asset+price+scope, pinned in a
                                                   commitment that includes the settlement rail
buyer signs PurchaseIntent (EIP-712)               binds asset, policy, legal text, price,
                                                   network, token, payTo, and the exact split
POST /v1/acquire/social-commercial                 → 402 + standard PAYMENT-REQUIRED header
retry with PAYMENT-SIGNATURE                       official x402 client, EIP-3009, zero buyer gas
                                                   → 200 + license + asset + PAYMENT-RESPONSE
GET  /v1/orders/:id                                settlement truth; creator payout tx when PAID
POST /v1/check-license-scope                       deterministic verdict + per-term evidence
GET  /v1/orders/:id/bundle                         proof bundle (all signatures, re-verifiable)
```

**Two authorization modes**, both recorded in the credential (`authorizationMode`):

- `eip712_purchase_intent` — the web/integrator flow above (two signatures).
- `x402_direct` — OKX.AI marketplace agents send **one paid POST** (optionally with
  `{brief}`); the EIP-3009 payment signature *is* the authorization, the verified payer
  becomes the licensee, and no PurchaseIntent is fabricated — the credential carries a
  digest of the canonical authorization record instead.

Sending `quoteCommitment` without `purchaseIntent` (or vice versa) is a
`400 INCOMPLETE_SIGNED_INTENT`, never a silent fallback.

## Verify it yourself (no wallet needed)

```bash
CRED=$(curl -s https://license402.axiqo.xyz/v1/samples/default | jq .credential)
curl -s https://license402.axiqo.xyz/v1/check-license-scope \
  -H 'content-type: application/json' \
  -d "{\"license\": $CRED, \"action\": \"model_training\", \"licensee\": $(echo $CRED | jq .licenseeWallet)}"
# → "effectiveDecision": "NOT_PERMITTED", reason MODEL_TRAINING_PROHIBITED
```

## Evidence (real transactions)

| What | Tx |
|---|---|
| Facilitator interop self-test (mainnet, 0.10 self-transfer) | `0xd8cecdcc…34ca8` |
| First production purchase (signed-intent, mainnet) | buyer `0x36c19b15…ccea` · payout `0x66d8754d…f199` |
| External buyer purchase (mainnet) | buyer `0x98ab4a03…9173` · payout `0xd7f95342…e8b8` |
| Testnet full loop (signed-intent) | buyer `0xa5eb8a69…684c` (eip155:1952) |
| Testnet A2MCP direct purchase | order `ord-b9b65667fb3e77be`, delivered via ticket |

See `docs/evidence/` and the public **Receipts** tabs (Production / Testnet / Samples).

## Architecture

- `src/server/license/` — deterministic core: zod types, explicit EIP-712
  (differential-tested against viem), PolicyV1 evaluator (5-state), 14 quote hard gates
  with Merkle evidence, commitments (offer digest / quote commitment v2 incl. rail),
  issuer credential (authorization union).
- `src/server/orders/` — `prepare` (preflight-before-402, signed + direct modes,
  transactional settlement activation), read-only `sample`, dev `demo`.
- `src/server/payment/` — official x402 v2 codecs, verify-before-prepare (payer
  binding), settle with `syncSettle`, reconciler for pending/timeout.
- `src/server/payout/` — creator payouts: nonce reserved *before* broadcast,
  receipt-confirmed `PAID`, expired-lease recovery; serialized per-chain nonce
  queue shared with the testnet faucet. Double-pay is structurally impossible:
  a payout that ever persisted a nonce only ever retries with that SAME nonce,
  a "nonce already consumed" answer parks it in `NEEDS_RECONCILIATION` (admin
  attaches the explorer-found tx or explicitly releases a fresh nonce — never
  automatic), and only a receipt-proven revert unpins a nonce.
- `src/web/x402-pay.ts` — the browser bundle **is the official x402 client**
  (`x402Client` + `registerExactEvmScheme`, both rails) with a wallet adapter and a
  business preflight that refuses to sign if the challenge differs from displayed terms.
- `catalog/` — assets (sha-256-signed deliverables), previews/display/sample webp
  renditions, **real rights attestations** (`catalog/attestations/*.md`, hashed into
  each signed offer).

The credential carries a **portable deterministic scope policy** that any downstream
agent can evaluate — payments settle on X Layer; scope verdicts are deterministic
engine calls (no LLM authority, no on-chain evaluator claimed).

## Run it

```bash
npm ci
python3 scripts/make_media.py     # webp renditions from catalog/assets/*.png
npx tsx scripts/seed-catalog.ts   # sign the catalog (needs DEMO_CREATOR_PRIVATE_KEY)
npm run dev                       # PAYMENT_MODE=off — full flow with simulated settlement
npm run check                     # typecheck + 65 tests + build (CI also verifies the
                                  # browser bundle has no drift and catalog integrity)
```

See `.env.example` for configuration. Live mode additionally requires the OKX
facilitator credentials, `X402_ASSET`, and dedicated HMAC secrets (never the wallet key).

## Honest limitations

- First-party catalog (7 assets); external creators are a pilot goal, not yet onboarded.
- Scope evaluation is server/local-deterministic, not an on-chain interpreter.
- `buyer == licensee` (no third-party gifting) in this MVP.
- The credential records a *contractual permission* from the controlling party — it does
  not adjudicate copyright subsistence in AI-assisted work, and it is not DRM.
