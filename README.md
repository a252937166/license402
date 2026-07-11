# LICENSE402

**Acquire the asset. Verify the scope. Audit the payment.**

An agent-native service for acquiring content with signed, machine-checkable usage terms — built for the OKX.AI Genesis Hackathon. An AI agent (or a person) states an intended use, receives a rights-matched asset with a fixed price locked *before* payment, pays 0.10 USDT over x402 on X Layer, and gets back the asset plus a verifiable **License Credential**. Any downstream agent can then check "may I use this, this way?" and get a deterministic `PERMITTED` / `NOT_PERMITTED` / `INVALID` verdict — offline.

Live: **https://license402.axiqo.xyz**

> LICENSE402 records signed rights declarations, payments, and machine-checkable scope. It does not adjudicate copyright ownership or infringement, and it is not DRM.

## What makes it more than a paywall

Real content licensing is not one signature. LICENSE402 binds five things into one agent-native transaction:

1. **Signed creator offer** — the creator signs an immutable `CreatorOffer` (EIP-712): asset hash, payout wallet, legal-text hash, and a policy.
2. **Payment-bound purchase intent** — the buyer signs an EIP-712 `PurchaseIntent` that names the exact asset, terms, and price. x402 proves *that* money moved; the intent proves *what it bought*. (EIP-3009 transfer authorizations carry no business binding — this closes that gap.)
3. **x402 settlement on X Layer** — `syncSettle: true`, and a license is only activated when settlement status is `success`. Pending/timeout go to a reconciler, never a premature unlock.
4. **Portable executable scope policy** — the terms are a projection of a versioned legal text; the legal text prevails on conflict.
5. **Auditable credential** — a three-signature document (creator / buyer / issuer) with the payment record. Verifiable offline.

The scope engine is deterministic — an LLM may draft a use request, but it has **no** authority over the verdict.

## The verdict states

| Verdict | Meaning |
|---|---|
| `PERMITTED` / `PERMITTED_WITH_DUTIES` | the use is inside the license scope (duties like attribution are surfaced) |
| `NOT_PERMITTED` | the license does not grant this use — with a precise reason code |
| `INVALID_CREDENTIAL` | the credential itself does not verify |
| `INDETERMINATE` | missing context / current status unknown — fails closed |

The grant narrows the offer: buy a license for channel X and a LinkedIn post is `NOT_PERMITTED` (`CHANNEL_NOT_LICENSED`), even though the underlying offer allowed LinkedIn.

## API

| Endpoint | Price | Purpose |
|---|---|---|
| `POST /v1/quote` | free | rights-match the catalog, lock exact terms + price, return the purchase-intent fields to sign |
| `POST /v1/acquire/social-commercial` | 0.10 USDT (x402) | pay → issue credential + deliver a short-lived signed asset URL |
| `POST /v1/check-license-scope` | free | deterministic scope verdict for a credential + proposed use |
| `GET /v1/orders/:orderId` | free | terminal settlement truth — buyer tx, creator payout, economics |
| `POST /v1/demo/acquire` | free (DEV mode) | wallet-free judge experience: the server signs a demo buyer intent and runs the real logic with a simulated payment |

`GET /` serves the **Proof Studio** — a clearance console where you acquire a license, get a passport, and stamp scope checks live.

## Run locally

```bash
npm install
cp .env.example .env.local      # fill in keys; PAYMENT_MODE=off for the wallet-free demo
python3 scripts/gen_catalog.py  # generate the first-party art catalog
npx tsx scripts/seed-catalog.ts # sign the CreatorOffers
npm run dev                     # http://127.0.0.1:8799
npm run check                   # typecheck + tests + build
```

`node:sqlite` (built into Node 22) is the datastore — **zero native dependencies**, so it deploys on any Node 22+ host.

## Layout

```
src/server/
  license/   deterministic core: EIP-712, policy engine, eligibility gates,
             commitments, three-signature credential, scope check, quote
  orders/    settlement state machine (only status="success" activates)
  payment/   dev + live x402 adapters
  payout/    creator payout worker (lease + nonce + intent-persist, no double-pay)
  store/     node:sqlite (WAL) with anti-duplication constraints
  catalog/   signed first-party offer registry loader
public/      Proof Studio (self-contained, self-hosted fonts)
scripts/     catalog art generation (Python + Pillow) and offer signing
tests/       59 tests: EIP-712 (differential vs viem), policy, eligibility,
             credential, commitments, sqlite invariants, HTTP end-to-end
```

## Honesty

Settled figures show only after a creator payout is `PAID` — otherwise `payable / PENDING`. Demo/dev transactions are labeled and excluded from real-revenue claims. The catalog is a first-party signed set of original generative art. Machine-readable licensing is not new (W3C ODRL, Story PIL, TollBit) — LICENSE402's contribution is combining signed offers, payment-bound intent, x402 settlement, a portable scope policy, and an auditable credential in one agent-native transaction on OKX.AI.
