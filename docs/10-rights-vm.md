> **IMPLEMENTATION STATUS (2026-07-12).** This document is a historical design
> plan. The SHIPPED system deliberately converged on a simpler, more trustworthy
> core: the license scope is a **canonical PolicyV1 evaluated by a deterministic
> TypeScript engine** (server + agent API), NOT an RVM bytecode / on-chain
> interpreter — RVM-1 / RightsScopeOracle / "the chain runs the license" were cut
> and are NOT claimed in the submission. X Layer carries what is real: x402
> payments, settlements, and creator payouts. Accurate one-liner:
> **"The credential carries a portable deterministic scope policy that any
> downstream agent can evaluate."** See the repo root README for what runs.

# RVM-1 — the Rights VM (reference: FUTURE compile target, demoted by spec v4)

> ⚠️ **Status: demoted, not deleted (2026-07-11, sixth review).** Spec v4 §0 overrides this annex: the semantic source of truth is the **Canonical PolicyV1 AST**; the primary compiled form is the fixed-structure **License402 Policy Capsule**; a general bytecode VM becomes worthwhile only when the policy space outgrows one closed template. Superseded points: "the license is a program" wording (→ "carries a portable executable scope policy"); `compile(decompile(p))==p` invariant (→ AST round-trip + deterministic compile + differential eval); `evaluate(program, action, channel, at)` context (→ full `UseContextV1`); `RightsScopeOracle` name (→ `RightsPolicyEvaluator`, "on-chain reproducible policy computation"); "L402 Envelope" (→ License402 Capsule); byte-size claims (unmeasured numbers removed); RVM's place in M1/G1 (→ P3, after listing). The ISA below remains a useful reference for RVM-2 planning.

> Governs the "terms logic" layer of LICENSE402. Crypto checks (signatures, hashes, settlement) stay OUTSIDE the VM; the VM answers exactly one question deterministically: **given this credential's terms, is this proposed use permitted, and what duties apply?**
>
> One-line claim (honest, precise): *the license's terms ship as an executable program inside the credential; the buyer's runtime, any third-party agent, and the X Layer chain evaluate it identically.* Declarative rights languages (W3C ODRL), fixed parameter licenses (Story PIL), and server-side term enforcement (TollBit) exist; an executable, credential-embedded, dual-runtime (native + EVM) license program is the new primitive.

---

## 1. Why a VM instead of JSON fields

1. **Self-contained credentials.** The credential carries its own law: `check-license-scope` needs no schema version negotiation, no server, no registry lookup — load program, run, done. Offline verification becomes *total* (crypto + logic).
2. **Chain-answerable.** A ~150-line Solidity pure interpreter makes every license question answerable by `eth_call` on X Layer. Any contract or agent can compose on verdicts without trusting our server. Demo beat: *ask the chain whether model training is permitted; the chain says NOT_PERMITTED.*
3. **Generalizes without migrations.** New clause types = new compiled programs; verifiers never change. Same VM later licenses datasets, prompt packs, and skills (asset classes differ; the rights question is identical).
4. **Testable as a unit of truth.** Programs are fuzzable, differential-testable across runtimes, and hash-committed (`policyHash`) into the offer digest, quote commitment, and credential — the terms the buyer reviewed are byte-identical to the logic that will judge future use.

## 2. Execution model

- **Total & bounded:** a program is an ordered list of ≤ 32 fixed-width instructions, executed top-to-bottom exactly once. No loops, no jumps backward, no state. Every input terminates in O(n).
- **Fail-fast:** the first failing assertion halts with `NOT_PERMITTED + reasonCode`. Malformed programs halt with `INVALID_PROGRAM`. A program that reaches `HALT_PERMIT` yields `PERMITTED + dutiesMask`.
- **Closed world:** the program encodes the *grant's constants* (compiled from the signed offer). The runtime supplies only the **UseContext** — the proposed use.

### 2.1 UseContext (runtime input)

| field | type | encoding |
|---|---|---|
| `action` | uint8 | 1=commercial_social_post 2=crop 3=resize 4=overlay_text 5=model_training 6=rag_indexing 7=resale 8=sublicense 9=exclusive_use |
| `channel` | uint8 | 0=none 1=x 2=linkedin 3=instagram |
| `atUnix` | uint64 | proposed time of use (seconds) |

Enum registries are frozen in `rvm/vocab.ts` and mirrored in the Solidity library; adding vocabulary bumps the VM version tag (`RVM-1` → `RVM-2`), never silently reinterprets old programs.

### 2.2 Verdict (runtime output)

```
decision  : uint8   1=PERMITTED  2=NOT_PERMITTED  3=INVALID_PROGRAM
reasonCode: uint16  index into the frozen reason registry (shared TS/Solidity/docs table)
dutiesMask: uint64  bit 0 = ATTRIBUTION_REQUIRED (rest reserved)
```

Reason registry v1 (uint16 → string): 0=ALL_REQUIRED_TERMS_SATISFIED, 1=MODEL_TRAINING_PROHIBITED, 2=RAG_INDEXING_PROHIBITED, 3=RESALE_PROHIBITED, 4=SUBLICENSING_PROHIBITED, 5=EXCLUSIVITY_NOT_OFFERED, 6=LICENSE_NOT_YET_VALID, 7=LICENSE_EXPIRED, 8=ACTION_NOT_PERMITTED, 9=CHANNEL_NOT_LICENSED, 100=PROGRAM_TOO_LONG, 101=UNKNOWN_OPCODE, 102=MISSING_HALT, 103=DUPLICATE_HALT.

## 3. Instruction set (RVM-1)

Fixed width: **17 bytes** per instruction — `op:uint8 | arg:uint64 BE | code:uint16 BE | aux:uint48 BE`. Program bytes = concatenation; `policyHash = keccak256(0x52564d31 ‖ program)` (`"RVM1"` domain prefix).

| op | mnemonic | semantics |
|---|---|---|
| 0x01 | `DENY_ACTION_IN mask, code` | if `bit(action) & arg` → halt NOT_PERMITTED(code). *(prohibitions; one instruction per prohibited action for precise codes)* |
| 0x02 | `REQUIRE_ACTION_IN mask, code` | if `bit(action) & arg == 0` → halt NOT_PERMITTED(code) |
| 0x03 | `REQUIRE_CHANNEL_IN mask, code, aux=actionMask` | applies only when `bit(action) & aux`; then if `bit(channel) & arg == 0` → halt NOT_PERMITTED(code) |
| 0x04 | `REQUIRE_NOT_BEFORE tsUnix, code` | if `atUnix < arg` → halt NOT_PERMITTED(code) |
| 0x05 | `REQUIRE_NOT_AFTER tsUnix, code` | if `atUnix > arg` → halt NOT_PERMITTED(code) |
| 0x06 | `EMIT_DUTY dutyMask, aux=actionMask` | if `bit(action) & aux` → `duties |= arg`; never halts |
| 0x00 | `HALT_PERMIT` | halt PERMITTED(0, duties). Must be the final instruction, exactly once |

Static validity (checked before execution, both runtimes): length ≤ 32×17 bytes and a multiple of 17; known opcodes; exactly one `HALT_PERMIT`, at the end. Violation → `INVALID_PROGRAM(100..103)`.

## 4. Compiler (single source of truth for terms)

`compileTerms(offer.terms, grant.window, duties) → program` emits, in order:

```
DENY_ACTION_IN  {model_training}   MODEL_TRAINING_PROHIBITED
DENY_ACTION_IN  {rag_indexing}     RAG_INDEXING_PROHIBITED
DENY_ACTION_IN  {resale}           RESALE_PROHIBITED
DENY_ACTION_IN  {sublicense}       SUBLICENSING_PROHIBITED
DENY_ACTION_IN  {exclusive_use}    EXCLUSIVITY_NOT_OFFERED
REQUIRE_NOT_BEFORE issuedAt        LICENSE_NOT_YET_VALID
REQUIRE_NOT_AFTER  expiresAt       LICENSE_EXPIRED
REQUIRE_ACTION_IN  permittedMask   ACTION_NOT_PERMITTED      # commercial_social_post + granted transformations
REQUIRE_CHANNEL_IN channelMask     CHANNEL_NOT_LICENSED  aux={commercial_social_post}
[EMIT_DUTY ATTRIBUTION aux=ALL]                              # only when offer.terms.attributionRequired
HALT_PERMIT
```

≈ 10–11 instructions (~187 bytes; base64 ≈ 250 chars — embeds comfortably in the credential).

**Projection-consistency invariant:** the credential's human-readable `grant/prohibitions/duties` JSON is *generated by decompiling the program* (`decompile(program) → projection`), and a test asserts `compile(projection) == program`. The JSON can therefore never drift from the law that executes.

## 5. Credential integration (spec v3 delta)

```json
"policy": {
  "vm": "RVM-1",
  "program": "base64…",
  "policyHash": "0x…"
}
```

- `policyHash` is included in `offerDigest` (creators sign the *program*, not prose alone) and in `quoteCommitment` (buyers pin the program pre-payment).
- `check-license-scope` = credential crypto checks (issuer signature → licensee match → program hash) **then** VM execution. `INVALID_CREDENTIAL` covers crypto/hash failures; the VM alone decides PERMITTED / NOT_PERMITTED.
- **Deny-with-alternatives** (product layer, server-side only): on NOT_PERMITTED, the free endpoint may append `alternatives[]` — catalog offers whose programs WOULD permit the requested use (computed by running the same VM over the catalog). Every rejection becomes a conversion path. Local/offline verification simply omits alternatives.

## 6. On-chain half: `RightsScopeOracle.sol` (X Layer)

```solidity
contract RightsScopeOracle {
    function evaluate(bytes calldata program, uint8 action, uint8 channel, uint64 atUnix)
        external pure returns (uint8 decision, uint16 reason, uint64 duties);
    function policyHash(bytes calldata program) external pure returns (bytes32);

    // registry half — anchors are optional; evaluation never depends on anchoring
    function anchor(bytes32 licenseId, bytes32 policyHash_, bytes32 quoteCommitment, uint64 expiresAt) external;
    function checkAnchored(bytes32 licenseId, bytes calldata program, uint8 action, uint8 channel, uint64 atUnix)
        external view returns (uint8 decision, uint16 reason, uint64 duties); // verifies hash-vs-anchor first
}
```

- `evaluate` is `pure`: costless via `eth_call`, callable by any contract/agent, no dependency on our infra or on anchoring.
- Interpreter mirrors §3 exactly (bounded loop over ≤32 instructions; no storage reads in `evaluate`).
- Extends the existing Foundry setup (`contracts/` already builds & tests `PactRegistry.t.sol`).

## 7. Equivalence discipline (the depth is only real if proven)

1. **Golden vectors:** `rvm/vectors.json` — ≥ 200 (program, context, verdict) triples covering every opcode, boundary timestamps, malformed programs.
2. **Differential fuzzing:** TS generator produces random valid+invalid programs and contexts; vitest asserts TS interpreter vs vectors; a Foundry fuzz test replays the same vectors and randomized inputs against the Solidity interpreter. Divergence = build failure.
3. **Compiler round-trip:** `compile(decompile(p)) == p` for all catalog programs.
4. **Threat model:** programs enter the system only via offers we compile and creators sign; verifiers still treat program bytes as untrusted input (static validity → `INVALID_PROGRAM`, never a crash). Interpreters are allocation-free on the hot path; Solidity `evaluate` is loop-bounded by program length ≤ 32.

## 8. Sibling deep pillars (specified here, built alongside)

### 8.1 L402 Envelope + Guard skill (proof-carrying content between agents)

- **Envelope** = `{assetSha256, credential}` attached to content as it moves through agent pipelines (file sidecar `<name>.l402.json` or inline field).
- **Guard** = an installable agent skill + tiny library (`@license402/guard`) embedding the TS interpreter: before an agent publishes / transforms / trains on an asset carrying an envelope, it runs the scope check **locally** (no network, no trust in our uptime), enforces duties (auto-attribution snippet), and refuses NOT_PERMITTED with the reason — optionally querying our free endpoint for compliant alternatives.
- Effect: LICENSE402 becomes protocol, not app; the verifier outlives the service.

### 8.2 Money-path exhaustive exploration

A finite-model explorer (TS, in CI) walks the full order state machine — states × events {settle_ok, settle_fail, crash-before-persist, payout_fail×N, replay×N} — and asserts invariants on every reachable path:

- **I1** never CREATOR_PAID without BUYER_SETTLED;
- **I2** at most one payout per order (mirrors `UNIQUE(order_id, payout_type)`);
- **I3** replaying any request/payment converges to the same terminal (orderId, licenseId);
- **I4** no LICENSE_ACTIVE on any path through SETTLEMENT_FAILED;
- **I5** under fair retry, every BUYER_SETTLED reaches CREATOR_PAID or a *publicly visible* PAYOUT_FAILED.

Output: `docs/11-money-path-model.md` (generated reachability report) + a CI test. Claimed as "exhaustively explored finite model", not "formally verified" — honesty red lines apply to engineering claims too.

## 9. Scope discipline

In: RVM-1 (compiler, TS interpreter, Solidity interpreter, vectors, fuzz), credential embedding, oracle contract, guard skill, money-path explorer, deny-with-alternatives.
Out (roadmap): new vocab (RVM-2), dataset/prompt/skill asset classes, revocation lists, ZK-private scope proofs, third-party compilers with licensor-signed programs, protocol-level splits.
Ordering: RVM-1 TS half lands inside M1 (it *is* the terms engine — one engine, not two); Solidity half + guard + explorer land in M4, off the G0/G1 critical path; Plan B cut order: oracle → guard → explorer (TS VM itself is never cut — it is the core).
