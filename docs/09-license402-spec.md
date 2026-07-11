> **IMPLEMENTATION STATUS (2026-07-12).** This document is a historical design
> plan. The SHIPPED system deliberately converged on a simpler, more trustworthy
> core: the license scope is a **canonical PolicyV1 evaluated by a deterministic
> TypeScript engine** (server + agent API), NOT an RVM bytecode / on-chain
> interpreter — RVM-1 / RightsScopeOracle / "the chain runs the license" were cut
> and are NOT claimed in the submission. X Layer carries what is real: x402
> payments, settlements, and creator payouts. Accurate one-liner:
> **"The credential carries a portable deterministic scope policy that any
> downstream agent can evaluate."** See the repo root README for what runs.

# LICENSE402 — frozen specification v4

> Status: **FROZEN v4** for the OKX.AI Genesis Hackathon build. §0 below is **normative and overrides** any conflicting statement in the v2/v3 body or in `10-rights-vm.md` (now demoted to a future-compile-target reference). Changes after implementation starts must be recorded in the changelog.

## 0. v4 normative amendments (override layer)

1. **Settlement safety (verified against installed SDK source).** Facilitator client MUST set `syncSettle: true`. Order machine gains `SETTLEMENT_PENDING / SETTLEMENT_TIMEOUT / SETTLEMENT_UNKNOWN`. **Only `settleResponse.status === "success"` may transition to BUYER_SETTLED → LICENSE_ACTIVE → full-asset release** — the SDK treats `"pending"` as a releasable success (`success:true`), so the after-settle hook MUST re-check status explicitly; pending/timeout/hook-error go to a reconciler that polls `GET /settle/status` (SDK `pollSettleStatus`, `onSettlementTimeout` exist). Request timeout ≠ on-chain failure; never mark SETTLEMENT_FAILED without terminal evidence.
2. **Buyer PurchaseIntent (EIP-712, mandatory).** `{quoteId, quoteCommitment, buyer, licensee, assetSha256, offerDigest, policyHash, legalTextHash, totalPrice, currency, expiresAt, nonce}`. Order binds PurchaseIntent signature + x402 payment-authorization digest + verifiedPayer + quoteCommitment, with `verifiedPayer == buyer == licensee` (no third-party payment in MVP). Rationale: EIP-3009 authorization fields carry no business binding; x402 proves payment happened, PurchaseIntent proves what it bought.
3. **Three-signature credential.** CreatorOffer (creator) / PurchaseIntent (buyer) / Credential (issuer). Credential v2 fields add: `credentialVersion, issuer, purchaseIntentDigest, paymentAuthorizationDigest, policyAstHash, [policyProgramHash], statusUrl`; `paymentRef` stays `{buyerPaymentId, orderId}`. EIP-712 is REQUIRED for CreatorOffer and PurchaseIntent; day-one compatibility check of Agentic Wallet typed-data signing; only on confirmed incapacity fall back to RFC 8785 JCS + domain-prefixed digest, documented as such.
4. **Legal-text precedence.** `Legal Text → Canonical PolicyV1 AST → (optional) compiled Policy Capsule`. Credential states: machine policy serves automated scope checks; on conflict the versioned legal text prevails. External wording: *"The license carries a portable executable scope policy"* — never "the license is a program", never "carries its own law", never any "first-ever" claim (prior art acknowledged: ODRL evaluators, Accord Project, Story PIL, OPA).
5. **Policy layer re-based.** G0/G1 run a deterministic **PolicyV1 AST evaluator** (single implementation shared by API and Guard). Primary compiled form (P3) = **License402 Policy Capsule**: canonical fixed binary encoding of PolicyV1 (permission/prohibition/channel/transformation bitsets + territory/maxDuration/expiry/duties words), embeddable, chain-reproducible. RVM bytecode = future compile target only. Invariants: `decode(encode(ast))==ast`; deterministic `compile(ast)`; `evalTS==evalSolidity`; non-canonical input fails closed. On-chain artifact renamed **`RightsPolicyEvaluator.sol`** (not an oracle): `evaluateStatic(..., at) pure` + `evaluateNow(...) view`; `UseContextV1 {assetHash, licensee, action, channel, territory, transformations, useStart, useEnd, commercial}`; `verifyCredential` (crypto/status) and `evaluatePolicy` (scope math) are separate concepts; wording: *on-chain reproducible policy computation*, `eth_call` = *read-only, no transaction fee*.
6. **Scope-check decisions (5-state) & Guard duality.** `PERMITTED / PERMITTED_WITH_DUTIES / NOT_PERMITTED / INVALID_CREDENTIAL / INDETERMINATE` (missing context, unsupported version, unreachable status → INDETERMINATE, fail-closed). Result = `{staticScope, currentStatus}`; offline Guard returns `currentStatus:"UNKNOWN_OFFLINE"`; online adds ACTIVE/suspended/revoked. Duties structured: `{type:"ATTRIBUTION", text}`. Revocation reality: payout failure never revokes; fraud, misissuance, rights disputes, lawful takedown may suspend/revoke via documented process. Derivatives: capsule anchors the ORIGINAL asset hash only; scope check answers "is this transformation permitted", not provenance of transformed files (optional `TransformationReceipt {parentAssetSha256, derivedAssetSha256, operation, credentialId, processorSignature}` in P3).
7. **`alternatives[]` removed** (single-SKU contradiction): NOT_PERMITTED returns `nextAction:"REQUEST_DIFFERENT_LICENSE"`; re-enable only when a purchasable `ai-training-license-v1` exists.
8. **Payout anti-duplication beyond DB constraints**: payout job lease + fixed on-chain nonce + persist transaction intent BEFORE broadcast + on restart reconcile by address/nonce/txHash + retry only when confirmed unbroadcast. Never claim chain-level "never-twice" without the escrowed `paid[orderId]` contract (roadmap). `0.03` is called **Platform fee**, never profit/margin.
9. **Naming**: `L402 Envelope` → **License402 Capsule** (`.license402.json`) — avoids Lightning Labs L402 collision.
10. **Review & deadline wording**: listing review budgeted at **two business days** (official pages show both "24 hours" and "two business days"; 07-11 is a Saturday); submission: official text 23:59 UTC, internal conservative 22:59 UTC, form target ≤18:59 UTC. P0 minimal listing (3–5 assets) submits immediately; catalog grows post-listing.
> Positioning (narrowed, honest): machine-readable licensing is not new (W3C ODRL, Story PIL, TollBit exist). LICENSE402's claim is the **first complete agent-callable loop on OKX.AI**: `Use Intent → Signed Offer → Terms Commitment → x402 Settlement → License Credential → Scope Check → Creator Payout`.
> Slogan: **Acquire the asset. Verify the scope. Audit the payment.**

---

## 1. The single paid SKU

**`social-commercial-v1` — Standard Social Commercial License, 0.10 USDT per acquisition (Pilot Terms).**

Template maximum grant (buyers may request a subset, never a superset):

```json
{
  "templateId": "social-commercial-v1",
  "commercialUse": true,
  "channels": ["x", "linkedin", "instagram"],
  "territory": "worldwide",
  "maxDurationDays": 30,
  "allowedTransformations": ["crop", "resize", "overlay_text"],
  "modelTraining": false,
  "ragIndexing": false,
  "exclusive": false,
  "resale": false,
  "sublicensing": false
}
```

Economics per sale (Pilot Terms, labeled as such everywhere): buyer pays `0.10` USDT via x402; creator payout `0.07`; platform fee `0.03`. Creator payout is executed **asynchronously after buyer settlement** (§5); once the buyer settles, the payout is a platform liability — retried until paid, never silently dropped, and the license is never revoked because a payout failed.

Model-training licenses are **not sold**; `model_training` exists to be deterministically **denied** at scope check.

**A fixed, versioned legal text** `legal/social-commercial-v1.md` is part of this SKU (grant, parties, asset, channels, territory, duration, permitted transformations, attribution duty when flagged, prohibitions incl. training/RAG/resale/sublicense, creator rights declaration, takedown & dispute handling, liability limits, non-transferability, payment/refund). Its SHA-256 is `legalTextHash`, bound into Offer, Quote commitment, and Credential. The JSON terms are metadata; the legal text is the contract.

## 2. Supply model — signed Offer Registry (creators do NOT run servers)

Creators onboard by (a) uploading original asset files, (b) signing an immutable **CreatorOffer** (EIP-712), (c) providing a payout wallet. LICENSE402 is the only deployed ASP. First-round catalog is **first-party** (team-original works) and is publicly labeled **"First-party signed catalog"** — never "open creator marketplace".

Creator onboarding record (internal, for dispute handling; not public): display name, legal name/entity, contact email, country, payout wallet, source files / process evidence, per-asset rights attestation, legal-text acceptance record. A wallet signature proves key control, not legal identity — the record supplies the rest.

### 2.1 CreatorOffer (EIP-712 signed, immutable)

```json
{
  "offerId": "off_<id>",
  "offerVersion": 1,
  "assetId": "asset_<id>",
  "assetSha256": "0x…",
  "mimeType": "image/png",
  "licensorWallet": "0x…",
  "payoutWallet": "0x…",
  "templateId": "social-commercial-v1",
  "legalTextHash": "0x…",
  "terms": {
    "commercialUse": true,
    "channels": ["x", "linkedin", "instagram"],
    "territory": "worldwide",
    "maxDurationDays": 30,
    "allowedTransformations": ["crop", "resize", "overlay_text"],
    "modelTraining": false,
    "ragIndexing": false,
    "exclusive": false,
    "resale": false,
    "sublicensing": false,
    "attributionRequired": false
  },
  "creatorNetPrice": "0.07",
  "currency": "USDT",
  "rightsAttestationHash": "0x…",
  "validFrom": "<ISO8601>",
  "validUntil": "<ISO8601>",
  "nonce": "<hex>",
  "signature": "0x…"
}
```

- Signature: **EIP-712 typed data** (domain `{name:"LICENSE402", version:"1", chainId:196}`), signed by `licensorWallet`. `offerDigest` = the EIP-712 typed-data hash. *Pragmatic fallback if time-boxed:* `personal_sign(canonicalJson(offer minus signature))` — equally verifiable; if used it MUST be documented as such.
- Offers are immutable: any change = new offerId + new signature. Expired (`validUntil`), tampered, or signature-mismatched offers are hard-gate ineligible.

## 3. Deterministic policy engine

### 3.1 Two-phase selection at QUOTE time (hard gates never weighted)

**Phase 1 — hard gates** over each candidate offer (any failure disqualifies with a reason code):

| # | Gate | Failure reason code |
|---|---|---|
| 1 | EIP-712 signature recovers to licensorWallet | `OFFER_SIGNATURE_INVALID` |
| 2 | now ∈ [validFrom, validUntil] | `OFFER_EXPIRED` |
| 3 | assetSha256 matches stored bytes | `ASSET_HASH_MISMATCH` |
| 4 | commercial use allowed | `COMMERCIAL_USE_PROHIBITED` |
| 5 | requested channel licensed | `CHANNEL_NOT_LICENSED` |
| 6 | territory covered | `TERRITORY_NOT_COVERED` |
| 7 | durationDays ≤ maxDurationDays | `DURATION_EXCEEDS_LIMIT` |
| 8 | transformations ⊆ allowed | `TRANSFORMATION_NOT_ALLOWED` |
| 9 | request has modelTraining=false, ragIndexing=false; offer prohibits both | `MODEL_TRAINING_PROHIBITED` / `RAG_INDEXING_PROHIBITED` |
| 10 | request has exclusive=false | `EXCLUSIVITY_NOT_OFFERED` |
| 11 | sale price ≤ maxBudget | `BUDGET_EXCEEDED` |

**Phase 2 — soft ranking** of survivors only (brief relevance, then price/recency). Soft scores can order eligible offers, never resurrect gated-out ones. Every gate result becomes an evidence leaf feeding the Merkle receipt (`evidenceRoot`, `receiptHash`) — reused from the existing domain kernel.

**Selection is final at quote time.** The quote pins ONE exact offer/asset. There is no post-payment selection, no failover-after-payment. No provider timeouts or circuit breakers exist in this domain (offers are immutable registry rows, not live APIs).

### 3.2 UseSpec (buyer input; LLM may draft it upstream, engine decides)

```json
{
  "brief": "cyberpunk dragon on a dark background",
  "channel": "x",
  "commercial": true,
  "durationDays": 14,
  "territory": "worldwide",
  "transformations": ["crop", "overlay_text"],
  "modelTraining": false,
  "ragIndexing": false,
  "exclusive": false,
  "maxBudget": "0.10"
}
```

## 4. Commitments (payment-before-use lock, two layers)

```
offerDigest     = EIP-712 typed-data hash of CreatorOffer (what the creator signed)
useSpecHash     = sha256(canonicalJson(UseSpec))
quoteCommitment = sha256(canonicalJson({
                    offerDigest, licenseeWallet, useSpecHash,
                    price: "0.10", platformFee: "0.03", creatorPayout: "0.07",
                    quoteExpiresAt, idempotencyKey
                  }))            # domain-separated "L402:QUOTE:v1"
```

`/v1/quote` therefore **requires `licenseeWallet`** in the request. `/v1/acquire` recomputes the commitment; on any drift (offer expired/delisted, price change, field change) it returns **`409 TERMS_COMMITMENT_CHANGED` BEFORE generating the 402 challenge**. Guarantee: what the buyer authorizes is byte-exactly what it reviewed — asset, creator, legal text version, scope, and price split included.

## 5. Settlement order (matches the real x402 middleware, verified from SDK source)

The official express middleware **buffers** the handler's response, settles the buyer payment **after** the handler completes, discards the buffered response if settlement fails, and only then releases content with `PAYMENT-RESPONSE`. Consequences (hard rules):

1. **Never pay the creator inside the handler.** (Settlement may still fail → platform loss.)
2. **Never put a buyer settlement tx hash inside the credential/response body.** (It does not exist yet at handler time.)
3. Delivery is prepared in the handler; the buyer only ever SEES it if settlement succeeded.

Order state machine:

```
QUOTED → PAYMENT_VERIFIED → DELIVERY_PREPARED → BUYER_SETTLED → LICENSE_ACTIVE
       → CREATOR_PAYOUT_PENDING → CREATOR_PAID
failure branches: SETTLEMENT_FAILED · PAYOUT_RETRYING · PAYOUT_FAILED
```

Flow: handler (validate commitment → idempotent order create/read → prepare credential + short-lived asset URL) → middleware settles → `onAfterSettle` (persist buyerTx, mark BUYER_SETTLED/LICENSE_ACTIVE, enqueue `creator_payout` into transactional outbox — fast persistence only) → `onSettleFailure` (mark SETTLEMENT_FAILED, void prepared records) → **payout worker** (transfer creatorNetPrice to payoutWallet, persist creatorTx, mark CREATOR_PAID; retry with backoff; failures visible as PAYOUT_RETRYING/FAILED).

## 6. Persistence (SQLite WAL + transactional outbox)

Tables: `offers, quotes, orders, licenses, buyer_settlements, creator_payouts, outbox_jobs`.

Uniqueness invariants:

```
UNIQUE(quote_commitment, licensee_wallet, idempotency_key)
UNIQUE(buyer_payment_id)
UNIQUE(order_id, payout_type)
UNIQUE(license_id)
```

Replaying the same payment N times returns the same `orderId`/`licenseId` and enqueues at most ONE payout job. Idempotency is durable (survives restart) — never an in-process Map.

## 7. Public API (v1)

| Endpoint | Price | Notes |
|---|---|---|
| `POST /v1/quote` | free (companion API, not separately listed) | in: `{use, licenseeWallet}`; out: exact pinned asset `{assetId, assetSha256, watermarkedPreviewUrl, creatorDisplay}`, `legalTextHash` + version, effective scope, price split, `offerDigest`, `quoteCommitment`, `quoteExpiresAt`, and `rejectedCandidates[] {offerId, reasonCodes}` (feeds the demo beat) |
| `POST /v1/acquire/social-commercial` | **0.10** — the ONLY listed paid service in round 1 | in: `{use, licenseeWallet, quoteCommitment, idempotencyKey}`; 409 pre-challenge on drift; 402 → paid replay → 200 `{orderId, license, asset:{shortLivedUrl, sha256, mimeType}, receipt:{evidenceRoot, receiptHash}, settlement:{status:"PENDING_FINALIZATION"}}` |
| `GET /v1/orders/:orderId` | free | terminal truth: order status, buyerTx, creatorTx, settled amounts — the ONLY place settled figures appear |
| `POST /v1/check-license-scope` | free (companion API) | in: `{license, action, channel?, licensee}`; out: `{decision, reasonCodes[], duties[]}` |

`check-license-scope` decisions: `PERMITTED_BY_LICENSE` (e.g. reasonCodes `["COMMERCIAL_USE_PERMITTED","CHANNEL_PERMITTED","DURATION_WITHIN_LIMIT"]`, duties e.g. `["ATTRIBUTION_REQUIRED"]`) · `NOT_PERMITTED_BY_LICENSE` (e.g. `["MODEL_TRAINING_PROHIBITED"]`) · `INVALID_CREDENTIAL` (e.g. `["ISSUER_SIGNATURE_INVALID","LICENSEE_MISMATCH","LICENSE_EXPIRED","CREDENTIAL_MALFORMED"]`). Checks run in order: issuer signature → licensee match → validity window → prohibition → permission → channel; evaluated offline from the credential alone. UI may render `ALLOW — by license terms` / `DENY — by license terms`; copy never implies legality adjudication.

## 8. LicenseCredential

```json
{
  "licenseId": "lic-<hash-derived>",
  "templateId": "social-commercial-v1",
  "legalTextHash": "0x…",
  "assetSha256": "0x…",
  "licensorWallet": "0x…",
  "licenseeWallet": "0x…",
  "grant": {
    "permissions": ["commercial_social_post", "crop", "overlay_text"],
    "channels": ["x"],
    "territory": "worldwide",
    "issuedAt": "<ISO8601>",
    "expiresAt": "<issuedAt + durationDays>"
  },
  "duties": [],
  "prohibitions": ["model_training", "rag_indexing", "resale", "sublicensing", "exclusive_use"],
  "offerDigest": "0x…",
  "quoteCommitment": "0x…",
  "paymentRef": { "buyerPaymentId": "…", "orderId": "…" },
  "evidenceRoot": "0x…",
  "receiptHash": "0x…",
  "issuerSignature": "0x…"
}
```

- `licenseeWallet` = the paying wallet (Agentic Wallet identity reuse; non-transferable by construction).
- **No settlement tx hashes inside the credential** (§5); final txs live on the order record.
- `issuerSignature`: v1 = personal_sign over canonicalJson(credential minus issuerSignature) by the LICENSE402 service key; offline-verifiable. (EIP-712 upgrade on roadmap.)

## 9. Content delivery isolation (not DRM)

- Pre-payment: watermarked/low-res preview, description, terms — never the original file or its URL.
- Post-payment: short-lived signed download URL (TTL hours) + full file + `assetSha256`.
- Public copy states plainly: LICENSE402 cannot physically prevent copying after download; it provides auditable licensing, payment records, and scope checks.

## 10. Truthfulness red lines

1. No "proof of copyright ownership" claims — only signed rights declarations with verifiable signature/terms/payment records.
2. No infringement adjudication claims — only checks against machine-readable license conditions.
3. Demo rejection nodes come from our own labeled demo catalog (e.g. a deliberately expired first-party offer) — never impersonating third parties; no fake API timeouts.
4. `Settled` figures only after both settlements reconcile; otherwise `payable / PENDING`. No `Settled Gross Margin` before G2.
5. Internal test transactions tagged `demo`, excluded from public revenue; public metrics use independent-wallet counts.
6. First-party catalog labeled as such; "market validated" claims require G3.

## 11. Eligibility & claim gates (G0–G3)

- **G0**: public HTTPS + standard 402 + paid replay 200 + PAYMENT-RESPONSE + minimal listing submitted. First priority; failure blocks everything (there is no fallback product).
- **G1**: legal text v1 + one signed offer + exact hash + full commitments + durable idempotency + credential + scope check (one PERMITTED, one NOT_PERMITTED). = LICENSE402 Core, the minimum shippable identity.
- **G2**: settlement persistence + payout outbox + one real payout to a distinct wallet + replay-safe + reconciled + order status endpoint. Unlocks settled-figures display and Revenue Rocket positioning.
- **G3**: ≥1 external creator, ≥1 external paying buyer, confirmed payout receipt, real asset usage. Unlocks demand-validation claims.

## 12. Out of v1 (roadmap only)

C2PA embedding/recovery · CLIP/pHash similarity · full ODRL/Z3 · protocol-level atomic splits · A2A clearance desk · training-license SKU · audio/video/datasets · open marketplace · NFT licenses · Creator Studio app · provider-API procurement (external Art-ASP as optional supply source, never critical path) · on-chain LicenseRegistry anchoring (optional, non-blocking if time allows).

---

Changelog:
- 2026-07-11 v1 frozen (initial).
- 2026-07-11 **v2 frozen** — integrated fifth review: supply = signed Offer Registry (no creator servers); EIP-712 offers + two-layer commitments (offerDigest/quoteCommitment, quote requires licenseeWallet, exact-asset pinning pre-402); settlement-order state machine + after-settle/settle-failure hooks + transactional outbox + async payout worker (verified against installed `@okxweb3/x402-express` source: handler-buffering, post-handler settlement, discard-on-failure); credential drops settlement txs (orderId + buyerPaymentId only; txs on order record); `verify` → `check-license-scope` with PERMITTED/NOT_PERMITTED/INVALID_CREDENTIAL + duties; legal text + legalTextHash; content payment isolation + not-DRM; single listed paid service; Pilot Terms labeling; narrowed novelty claim; G0–G3 gates.
- 2026-07-11 **v4 frozen (sixth review)** — normative §0 override layer added: syncSettle:true + pending/timeout/unknown settlement states with explicit `status==="success"` gate (SDK source shows pending treated as releasable success — hook-level check mandatory); EIP-712 BuyerPurchaseIntent binding payment to asset/terms/use; three-signature credential with digest chain + statusUrl; legal-text precedence; PolicyV1 AST as semantic source with Policy Capsule as primary compiled form (RVM → future target; `RightsPolicyEvaluator.sol` naming; UseContextV1 full fields; verifyCredential/evaluatePolicy split); 5-state decisions + Guard staticScope/currentStatus duality + revocation reality + derivative honesty; alternatives removed pending real training SKU; payout lease/nonce/intent-persist/reconcile discipline; License402 Capsule rename; two-business-day review budget and three-tier deadline. All "first-ever"/"license is a program"/"carries its own law" wording deleted.
- 2026-07-11 **v3 frozen (depth pillars)** — terms logic re-based onto **RVM-1** (see `10-rights-vm.md`, normative for the policy layer): terms compile to a bounded deterministic program; credential gains `policy:{vm:"RVM-1", program, policyHash}`; `policyHash` joins offerDigest and quoteCommitment; §3 gate table's terms gates (#4–#10) execute as the compiled program while crypto/budget facts (#1–#3, #11) stay native; human-readable grant/prohibitions/duties become the decompiled projection of the program (round-trip tested); `check-license-scope` = crypto checks → program-hash check → VM execution; on-chain `RightsScopeOracle` (pure `evaluate` + optional anchoring, replaces "LicenseRegistry anchoring" roadmap item); adds L402 Envelope + Guard skill (local offline verification), money-path exhaustive exploration report, and server-side deny-with-alternatives. Novelty claim precise form: first content license whose terms ship as an executable program inside the credential, evaluable identically by native runtimes and a public chain.
