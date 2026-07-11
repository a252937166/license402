import express from "express";
import type { Express, Request, Response } from "express";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { loadConfig, mainnetProfile, PROJECT_ROOT } from "./config.js";
import type { AppConfig } from "./config.js";
import { sha256Hex } from "./domain/index.js";
import { legalTextHash } from "./legal.js";
import { openDatabase } from "./store/db.js";
import type { AppDatabase } from "./store/db.js";
import { Repo } from "./store/repo.js";
import { loadCatalog } from "./catalog/loader.js";
import { buildQuote } from "./license/quote.js";
import type { CatalogOffer } from "./license/quote.js";
import { useSpecHash } from "./license/commitments.js";
import { checkLicenseScope } from "./license/scopeCheck.js";
import { EIP712_TYPES } from "./license/eip712.js";
import { CREDENTIAL_VERSION, EIP712_DOMAIN } from "./license/vocab.js";
import { formatMicroUsdt, CREATOR_PAYOUT_MICRO, PLATFORM_FEE_MICRO, SALE_PRICE_MICRO } from "./license/money.js";
import { UseSpecSchema } from "./license/types.js";
import { onSettlementFailure, onSettlementSuccess, prepareDelivery, prepareDirectDelivery, validateSignedAcquire, SETTLED_STATES } from "./orders/prepare.js";
import { runDemoAcquire } from "./orders/demo.js";
import { buildSampleEnvelope } from "./orders/sample.js";
import { DevPaymentAdapter } from "./payment/adapter.js";
import type { PaymentAdapter } from "./payment/adapter.js";
import { LivePaymentAdapter } from "./payment/live.js";
import { reconcileSettlements } from "./payment/reconcile.js";
import { runPayoutWorker, LivePayoutSender } from "./payout/worker.js";
import type { PayoutSender } from "./payout/worker.js";
import { XLayerService } from "./chain.js";
import { renderDashboard } from "./dashboard.js";

export interface CreateAppOptions {
  config?: AppConfig;
  now?: () => number;
  dbPath?: string;
  /** Inject a payment adapter (tests use a fake live adapter to exercise the x402 path offline). */
  payment?: PaymentAdapter;
}

const SIGNED_URL_TTL = 3 * 3600;

/**
 * Dedicated HMAC secrets (review §8): the wallet private key that moves real
 * funds must NEVER be the URL-signing key. Live mode requires explicit secrets;
 * dev/test fall back to fixed dev-only constants.
 */
function assetUrlSecret(config: AppConfig): string {
  const s = process.env.ASSET_URL_HMAC_SECRET?.trim();
  if (s) return s;
  if (config.paymentMode === "live") throw new Error("ASSET_URL_HMAC_SECRET is required in live mode");
  return "dev-asset-url-secret";
}
function deliveryTicketSecret(config: AppConfig): string {
  const s = process.env.DELIVERY_TICKET_HMAC_SECRET?.trim();
  if (s) return s;
  if (config.paymentMode === "live") throw new Error("DELIVERY_TICKET_HMAC_SECRET is required in live mode");
  return "dev-delivery-ticket-secret";
}

function signedAssetUrl(config: AppConfig, assetId: string, nowSeconds: number): string {
  const exp = nowSeconds + SIGNED_URL_TTL;
  const sig = createHmac("sha256", assetUrlSecret(config)).update(`${assetId}.${exp}`).digest("hex").slice(0, 32);
  return `${config.publicOrigin}/v1/assets/${encodeURIComponent(assetId)}?exp=${exp}&sig=${sig}`;
}

/** Same signature/expiry as the download URL, but serves the fast webp display rendition. */
function signedDisplayUrl(config: AppConfig, assetId: string, nowSeconds: number): string {
  const exp = nowSeconds + SIGNED_URL_TTL;
  const sig = createHmac("sha256", assetUrlSecret(config)).update(`${assetId}.${exp}`).digest("hex").slice(0, 32);
  return `${config.publicOrigin}/v1/assets/${encodeURIComponent(assetId)}/display?exp=${exp}&sig=${sig}`;
}

/**
 * Bearer claim-ticket for delayed delivery (settlement returned pending/timeout).
 * Only the buyer receives it (in the 202 body); it lets them collect the
 * credential + asset once the reconciler activates the order. 24h validity.
 */
function signedDeliveryUrl(config: AppConfig, orderId: string, nowSeconds: number): string {
  const exp = nowSeconds + 24 * 3600;
  const sig = createHmac("sha256", deliveryTicketSecret(config)).update(`delivery.${orderId}.${exp}`).digest("hex").slice(0, 32);
  return `${config.publicOrigin}/v1/orders/${encodeURIComponent(orderId)}/delivery?exp=${exp}&sig=${sig}`;
}

function verifyDeliverySig(config: AppConfig, orderId: string, exp: number, sig: string, nowSeconds: number): boolean {
  if (!Number.isFinite(exp) || exp < nowSeconds) return false;
  const expected = createHmac("sha256", deliveryTicketSecret(config)).update(`delivery.${orderId}.${exp}`).digest("hex").slice(0, 32);
  return expected === sig;
}

/** Standard x402 receipt header for settlements confirmed via status polling. */
function synthesizePaymentResponse(tx: string, network: string, payer: string): string | null {
  try {
    return Buffer.from(JSON.stringify({ success: true, status: "success", transaction: tx, network, payer })).toString("base64");
  } catch {
    return null;
  }
}

function verifyAssetSig(config: AppConfig, assetId: string, exp: number, sig: string, nowSeconds: number): boolean {
  if (!Number.isFinite(exp) || exp < nowSeconds) return false;
  const expected = createHmac("sha256", assetUrlSecret(config)).update(`${assetId}.${exp}`).digest("hex").slice(0, 32);
  return expected === sig;
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  const config = options.config ?? loadConfig();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const db = openDatabase(options.dbPath ?? config.dbPath);
  const repo = new Repo(db);

  const seed = loadCatalog(repo, now());
  if (seed.skipped.length > 0) console.warn("[LICENSE402] catalog skipped:", seed.skipped);
  console.log(`[LICENSE402] catalog loaded: ${seed.loaded} offers`);

  const payment: PaymentAdapter = options.payment ?? (config.paymentMode === "live" ? new LivePaymentAdapter(config) : new DevPaymentAdapter());
  // Optional second rail: X Layer TESTNET — the free judge experience. Same code
  // path, same facilitator, test-value token. Orders are stamped 'testnet'.
  const paymentTestnet: PaymentAdapter | undefined =
    config.paymentMode === "live" && config.testnet && !options.payment ? new LivePaymentAdapter(config, config.testnet) : undefined;
  // Live mode gains real on-chain capability: creator payouts + the testnet faucet.
  let chainMain: XLayerService | undefined;
  let chainTest: XLayerService | undefined;
  const payoutSenders: { production?: PayoutSender; testnet?: PayoutSender } = {};
  if (config.paymentMode === "live" && !options.payment) {
    chainMain = new XLayerService(config, mainnetProfile(config));
    payoutSenders.production = new LivePayoutSender(chainMain);
    if (config.testnet) {
      chainTest = new XLayerService(config, config.testnet);
      payoutSenders.testnet = new LivePayoutSender(chainTest);
    }
  }

  /** Resolve the settlement rail for a request ("testnet" opt-in, mainnet default). */
  const railFor = (networkParam: unknown): { key: "mainnet" | "testnet"; profile: ReturnType<typeof mainnetProfile> } | null => {
    if (networkParam === "testnet") {
      if (!config.testnet) return null;
      return { key: "testnet", profile: config.testnet };
    }
    return { key: "mainnet", profile: mainnetProfile(config) };
  };

  let buildInfo: { commit?: string; builtAt?: string } = {};
  try {
    buildInfo = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "BUILD_INFO.json"), "utf8")) as typeof buildInfo;
  } catch {
    // local dev — no build stamp
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use((req, res, next) => {
    // Verifiable build identity on EVERY response — judges and crawlers can
    // confirm which commit is serving without trusting page content.
    if (buildInfo.commit) res.setHeader("X-License402-Build", String(buildInfo.commit));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.path.endsWith(".html") || req.path.startsWith("/js/") || req.path === "/" || ["/buy", "/market", "/verify"].includes(req.path)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  const catalogOffers = (): CatalogOffer[] =>
    repo.listActiveOffers().map((row) => {
      const asset = repo.getAsset(row.assetId);
      return {
        offer: row.offer,
        storedAssetSha256: row.assetSha256,
        previewUrl: `${config.publicOrigin}/v1/previews/${row.assetId}`,
        title: asset?.title ?? row.assetId,
        creatorDisplay: asset?.creatorDisplay ?? "creator",
        tags: asset?.tags ?? []
      };
    });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "license402", paymentMode: config.paymentMode, issuer: config.issuerAddress });
  });

  // Deep readiness (round-10): proves the pieces a purchase would touch are
  // actually wired — db writable, catalog loaded, rails + live secrets present.
  app.get("/readyz", (_req, res) => {
    const checks: Record<string, boolean> = {};
    try {
      checks.db = Boolean(db.prepare("SELECT 1 AS one").get());
    } catch {
      checks.db = false;
    }
    checks.catalog = catalogOffers().length > 0;
    checks.mainnetRail = Boolean(payment);
    checks.testnetRail = Boolean(paymentTestnet);
    if (config.paymentMode === "live") {
      checks.assetUrlSecret = Boolean(process.env.ASSET_URL_HMAC_SECRET?.trim());
      checks.deliveryTicketSecret = Boolean(process.env.DELIVERY_TICKET_HMAC_SECRET?.trim());
      checks.adminToken = Boolean(process.env.ADMIN_TOKEN?.trim());
    }
    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({ ready, checks, paymentMode: config.paymentMode });
  });

  // --- POST /v1/quote (free) -------------------------------------------------
  app.post("/v1/quote", (req: Request, res: Response) => {
    const parsedUse = UseSpecSchema.safeParse(req.body?.use);
    if (!parsedUse.success) {
      res.status(400).json({ error: "INVALID_USESPEC", detail: parsedUse.error.issues.slice(0, 4) });
      return;
    }
    const licenseeWallet = req.body?.licenseeWallet;
    if (typeof licenseeWallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(licenseeWallet)) {
      res.status(400).json({ error: "INVALID_LICENSEE_WALLET" });
      return;
    }

    // Optional exact-offer pin (market → buy): hard gates still run; the engine
    // never substitutes a different asset for the one the buyer clicked.
    const requestedOfferId = typeof req.body?.requestedOfferId === "string" ? req.body.requestedOfferId : undefined;
    const railSel = railFor(req.body?.network);
    if (!railSel) {
      res.status(503).json({ error: "TESTNET_DISABLED" });
      return;
    }
    const rail = { settlementNetwork: railSel.profile.network, paymentAsset: railSel.profile.asset, payTo: config.payToAddress };
    const quote = buildQuote(catalogOffers(), parsedUse.data, licenseeWallet, { nowSeconds: now(), pinOfferId: requestedOfferId, rail });
    if (!quote.serviceable || !quote.selected) {
      res.status(200).json({
        serviceable: false,
        requestedOfferId: requestedOfferId ?? null,
        reasons: quote.reasons ?? [],
        rejectedCandidates: quote.rejectedCandidates,
        nextAction: requestedOfferId ? "OFFER_NOT_ELIGIBLE_FOR_THIS_USE" : "REQUEST_DIFFERENT_LICENSE"
      });
      return;
    }

    repo.insertQuote(
      {
        quoteId: quote.selected.quoteId,
        quoteCommitment: quote.selected.quoteCommitment,
        offerId: quote.selected.offerId,
        offerDigest: quote.selected.offerDigest,
        licenseeWallet: licenseeWallet.toLowerCase(),
        useSpec: parsedUse.data,
        useSpecHash: useSpecHash(parsedUse.data),
        priceMicro: quote.selected.priceMicro,
        platformFeeMicro: quote.selected.platformFeeMicro,
        creatorPayoutMicro: quote.selected.creatorPayoutMicro,
        settlementNetwork: quote.selected.settlementNetwork,
        paymentAsset: quote.selected.paymentAsset,
        payTo: quote.selected.payTo,
        idempotencyKey: quote.selected.idempotencyKey,
        expiresAt: quote.selected.quoteExpiresAt
      },
      now()
    );

    res.status(200).json({
      serviceable: true,
      template: "social-commercial-v1",
      settlementNetwork: quote.selected.settlementNetwork,
      paymentAsset: quote.selected.paymentAsset,
      payTo: quote.selected.payTo,
      quoteId: quote.selected.quoteId,
      asset: {
        assetId: quote.selected.assetId,
        assetSha256: quote.selected.assetSha256,
        // Canonical field is previewUrl; watermarkedPreviewUrl kept as an alias
        // for early consumers. (Naming: previewUrl / displayUrl / url everywhere.)
        previewUrl: quote.selected.previewUrl,
        watermarkedPreviewUrl: quote.selected.previewUrl,
        title: quote.selected.title,
        creator: quote.selected.creatorDisplay
      },
      legalTextHash: legalTextHash(),
      legalTextVersion: "social-commercial-v1:v1",
      effectiveGrant: quote.selected.effectiveGrant,
      policyAstHash: quote.selected.policyAstHash,
      price: quote.selected.price,
      platformFee: quote.selected.platformFee,
      creatorPayout: quote.selected.creatorPayout,
      currency: "USDT",
      offerDigest: quote.selected.offerDigest,
      quoteCommitment: quote.selected.quoteCommitment,
      idempotencyKey: quote.selected.idempotencyKey,
      quoteExpiresAt: quote.selected.quoteExpiresAt,
      rejectedCandidates: quote.rejectedCandidates,
      purchaseIntentFields: {
        primaryType: "PurchaseIntent",
        quoteId: quote.selected.quoteId,
        quoteCommitment: quote.selected.quoteCommitment,
        buyer: licenseeWallet.toLowerCase(),
        licensee: licenseeWallet.toLowerCase(),
        assetSha256: quote.selected.assetSha256,
        offerDigest: quote.selected.offerDigest,
        policyAstHash: quote.selected.policyAstHash,
        legalTextHash: legalTextHash(),
        totalPrice: quote.selected.price,
        currency: "USDT",
        settlementNetwork: quote.selected.settlementNetwork,
        paymentAsset: quote.selected.paymentAsset,
        payTo: quote.selected.payTo,
        creatorPayoutMicro: quote.selected.creatorPayoutMicro,
        platformFeeMicro: quote.selected.platformFeeMicro,
        // The buyer's signed intent must carry EXACTLY this expiry — it is part
        // of the quote's committed terms and is verified verbatim at acquire.
        expiresAt: quote.selected.quoteExpiresAt
      },
      // Ready-to-sign EIP-712 definition for wallets (eth_signTypedData_v4):
      // fill message from purchaseIntentFields + a fresh 32-byte nonce, with
      // totalPriceMicro as the decimal string of price × 10^6.
      eip712: {
        domain: EIP712_DOMAIN,
        primaryType: "PurchaseIntent",
        types: {
          EIP712Domain: EIP712_TYPES.EIP712Domain,
          PurchaseIntent: EIP712_TYPES.PurchaseIntent
        }
      }
    });
  });

  // --- POST /v1/acquire/social-commercial (x402-protected) -------------------
  // body.network selects the settlement rail: "mainnet" (default, real 0.10
  // USDT) or "testnet" (X Layer 1952, free test-value experience).
  app.post("/v1/acquire/social-commercial", async (req: Request, res: Response) => {
    const wantTestnet = req.body?.network === "testnet";
    if (wantTestnet && !paymentTestnet) {
      res.status(503).json({ error: "TESTNET_DISABLED", detail: "testnet rail is not enabled on this deployment" });
      return;
    }
    const rail = wantTestnet ? paymentTestnet! : payment;
    const environment: "sample" | "production" | "testnet" = wantTestnet ? "testnet" : rail.mode === "live" ? "production" : "sample";

    // Two authorization modes share this endpoint:
    //  - SIGNED-INTENT (the site / integrators): body carries quoteCommitment +
    //    an EIP-712 PurchaseIntent — the strong two-signature binding.
    //  - DIRECT (OKX.AI A2MCP marketplace agents): one paid POST, no pre-flow.
    //    The x402 payment signature is the authorization; payer == licensee.
    // Half-present signed fields are an ERROR, never a silent fallback to
    // direct mode (review §4) — a dropped field must not re-select the asset.
    const hasCommitment = Boolean(req.body?.quoteCommitment);
    const hasIntent = Boolean(req.body?.purchaseIntent);
    if (hasCommitment !== hasIntent) {
      res.status(400).json({
        error: "INCOMPLETE_SIGNED_INTENT",
        detail: "quoteCommitment and purchaseIntent must be sent together (signed-intent mode) or both omitted (direct mode)"
      });
      return;
    }
    const isDirect = !hasCommitment;

    // Direct-mode terms (round-10): an x402 payment signature binds the MONEY,
    // not the terms — so direct mode sells exactly ONE fixed marketplace SKU
    // (documented default terms), and the terms binding is the issuer-signed
    // credential over the canonical UseSpec. A PROVIDED `use` that fails
    // validation is therefore a 400 — never silently replaced with defaults
    // the caller didn't ask for. Checked BEFORE the 402 challenge so an agent
    // never signs a payment for a doomed request.
    if (isDirect && req.body?.use !== undefined) {
      const probe = UseSpecSchema.safeParse(req.body.use);
      if (!probe.success) {
        res.status(400).json({
          error: "INVALID_USESPEC",
          detail: probe.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          hint: "omit `use` to buy the fixed marketplace SKU (default terms), or send a valid UseSpec"
        });
        return;
      }
    }

    const verified = await rail.verify(req);
    if (!verified) {
      // Business preflight BEFORE the 402 challenge (review §9): a buyer is
      // never asked to sign a payment for terms that would be rejected anyway.
      if (!isDirect) {
        const pre = validateSignedAcquire(
          repo,
          {
            use: req.body?.use,
            licenseeWallet: req.body?.licenseeWallet,
            quoteCommitment: req.body?.quoteCommitment,
            idempotencyKey: req.body?.idempotencyKey,
            purchaseIntent: req.body?.purchaseIntent
          },
          now()
        );
        if (!pre.ok) {
          res.status(pre.error.http).json({ error: pre.error.code, ...("detail" in pre.error ? { detail: pre.error.detail } : {}) });
          return;
        }
      }
      const challenge = await rail.challenge(`${config.publicOrigin}/v1/acquire/social-commercial`);
      for (const [k, v] of Object.entries(challenge.headers)) res.setHeader(k, v);
      res.status(challenge.status).json(challenge.body);
      return;
    }
    let prepared: ReturnType<typeof prepareDelivery>;
    if (isDirect) {
      // The marketplace caller may state the licensee — it must be the payer.
      const claimed = typeof req.body?.licenseeWallet === "string" ? req.body.licenseeWallet.toLowerCase() : null;
      if (claimed && claimed !== verified.verifiedPayer.toLowerCase()) {
        res.status(400).json({ error: "PAYER_MISMATCH", detail: "in direct mode the licensee is the paying wallet" });
        return;
      }
      const brief =
        typeof req.body?.brief === "string" && req.body.brief.trim()
          ? req.body.brief.trim().slice(0, 240)
          : "commercial social campaign image";
      // By this point `use` is either ABSENT (→ the fixed marketplace SKU
      // below) or VALID (the guard above already 400'd anything else).
      const parsedUse = UseSpecSchema.safeParse(req.body?.use);
      // payment-ref salt in the brief → every distinct payment pins its own
      // quote/order (direct purchases are one-license-per-payment by design).
      const ref = ` [ref:${verified.paymentAuthorizationDigest.slice(2, 10)}]`;
      const use = parsedUse.success
        ? UseSpecSchema.parse({ ...parsedUse.data, brief: `${parsedUse.data.brief.slice(0, 240)}${ref}` })
        : UseSpecSchema.parse({
            brief: `${brief}${ref}`,
            channel: "x",
            commercial: true,
            durationDays: 14,
            territory: "worldwide",
            transformations: ["crop", "overlay_text"],
            maxBudget: "0.10"
          });
      const railProfile = wantTestnet ? config.testnet! : mainnetProfile(config);
      const q = buildQuote(catalogOffers(), use, verified.verifiedPayer, {
        nowSeconds: now(),
        rail: { settlementNetwork: railProfile.network, paymentAsset: railProfile.asset, payTo: config.payToAddress }
      });
      if (!q.serviceable || !q.selected) {
        // Payment was VERIFIED but never settled — no funds moved; safe to refuse.
        res.status(409).json({ error: "NOT_SERVICEABLE", reasons: q.reasons ?? [], rejectedCandidates: q.rejectedCandidates });
        return;
      }
      repo.insertQuote(
        {
          quoteId: q.selected.quoteId,
          quoteCommitment: q.selected.quoteCommitment,
          offerId: q.selected.offerId,
          offerDigest: q.selected.offerDigest,
          licenseeWallet: verified.verifiedPayer.toLowerCase(),
          useSpec: use,
          useSpecHash: useSpecHash(use),
          priceMicro: q.selected.priceMicro,
          platformFeeMicro: q.selected.platformFeeMicro,
          creatorPayoutMicro: q.selected.creatorPayoutMicro,
          settlementNetwork: q.selected.settlementNetwork,
          paymentAsset: q.selected.paymentAsset,
          payTo: q.selected.payTo,
          idempotencyKey: q.selected.idempotencyKey,
          expiresAt: q.selected.quoteExpiresAt
        },
        now()
      );
      prepared = prepareDirectDelivery(repo, config, q.selected, use, {
        nowSeconds: now(),
        verifiedPayer: verified.verifiedPayer,
        buyerPaymentId: verified.buyerPaymentId,
        paymentAuthorizationDigest: verified.paymentAuthorizationDigest,
        requestBodyHash: sha256Hex(JSON.stringify(req.body ?? {})),
        environment
      });
    } else {
      prepared = prepareDelivery(
        repo,
        config,
        {
          use: req.body?.use,
          licenseeWallet: req.body?.licenseeWallet,
          quoteCommitment: req.body?.quoteCommitment,
          idempotencyKey: req.body?.idempotencyKey,
          purchaseIntent: req.body?.purchaseIntent
        },
        {
          nowSeconds: now(),
          verifiedPayer: verified.verifiedPayer,
          buyerPaymentId: verified.buyerPaymentId,
          paymentAuthorizationDigest: verified.paymentAuthorizationDigest,
          environment
        }
      );
    }

    if (!prepared.ok) {
      res.status(prepared.error.http).json({
        error: prepared.error.code,
        ...("detail" in prepared.error ? { detail: prepared.error.detail } : {})
      });
      return;
    }

    // Idempotent replay: this exact payment already settled this order — return
    // the delivery again WITHOUT re-settling (a spent EIP-3009 nonce would fail
    // and must never void the license it already bought).
    const settledOrder = repo.getOrder(prepared.delivery.orderId);
    if (settledOrder && SETTLED_STATES.has(settledOrder.status) && settledOrder.paymentAuthorizationDigest === verified.paymentAuthorizationDigest) {
      // The replay carries the SAME standard receipt header the first delivery did.
      if (settledOrder.paymentResponseHeader) res.setHeader("PAYMENT-RESPONSE", settledOrder.paymentResponseHeader);
      res.status(200).json({
        orderId: prepared.delivery.orderId,
        license: prepared.delivery.credential,
        asset: {
          assetId: prepared.delivery.assetId,
          url: signedAssetUrl(config, prepared.delivery.assetId, now()),
          displayUrl: signedDisplayUrl(config, prepared.delivery.assetId, now()),
          sha256: prepared.delivery.credential.assetSha256,
          mimeType: "image/png"
        },
        settlement: { status: "SETTLED", buyerTx: settledOrder.buyerSettleTx },
        statusUrl: prepared.delivery.credential.statusUrl
      });
      return;
    }

    // Exactly one payment authorization may settle an order. A concurrent
    // request with a different authorization for the same quote stops HERE —
    // before the facilitator ever sees it.
    const claimed = repo.claimForSettlement(prepared.delivery.orderId, verified.paymentAuthorizationDigest, now());
    if (!claimed) {
      res.status(409).json({ error: "PAYMENT_ALREADY_IN_FLIGHT", orderId: prepared.delivery.orderId });
      return;
    }

    const outcome = await rail.settle(verified);
    if (outcome.status === "success") {
      onSettlementSuccess(repo, prepared.delivery.orderId, outcome.tx, { nowSeconds: now() });
      // Payout runs ASYNC — the buyer's delivery must never wait on the creator
      // broadcast. The outbox job is already persisted; this kick plus the live
      // reconcile interval drain it, and a crash loses nothing.
      void runPayoutWorker(repo, config, now, payoutSenders).catch((e) => console.warn("[payout] inline:", e));
      // Standard x402 v2 receipt: the settle response, base64-encoded —
      // persisted so idempotent replays return the identical header.
      if (outcome.responseHeader) {
        repo.setPaymentResponseHeader(prepared.delivery.orderId, outcome.responseHeader, now());
        res.setHeader("PAYMENT-RESPONSE", outcome.responseHeader);
      }
      res.status(200).json({
        orderId: prepared.delivery.orderId,
        license: prepared.delivery.credential,
        asset: {
          assetId: prepared.delivery.assetId,
          url: signedAssetUrl(config, prepared.delivery.assetId, now()),
          displayUrl: signedDisplayUrl(config, prepared.delivery.assetId, now()),
          sha256: prepared.delivery.credential.assetSha256,
          mimeType: "image/png"
        },
        settlement: { status: "SETTLED", buyerTx: outcome.tx },
        statusUrl: prepared.delivery.credential.statusUrl
      });
      return;
    }
    // Direct A2MCP callers are plain x402 agents that expect a terminal answer
    // in ONE request — poll the settle status for up to ~24s before giving up
    // and falling back to the 202 + delivery-ticket flow (browsers handle that).
    if (isDirect && (outcome.status === "pending" || outcome.status === "timeout") && outcome.tx && rail.settleStatus) {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const st = await rail.settleStatus(outcome.tx);
          if (st.status === "success") {
            onSettlementSuccess(repo, prepared.delivery.orderId, outcome.tx, { nowSeconds: now() });
            void runPayoutWorker(repo, config, now, payoutSenders).catch(() => {});
            const header = synthesizePaymentResponse(outcome.tx, wantTestnet ? config.testnet!.network : config.network, verified.verifiedPayer);
            if (header) {
              repo.setPaymentResponseHeader(prepared.delivery.orderId, header, now());
              res.setHeader("PAYMENT-RESPONSE", header);
            }
            res.status(200).json({
              orderId: prepared.delivery.orderId,
              license: prepared.delivery.credential,
              asset: {
                assetId: prepared.delivery.assetId,
                url: signedAssetUrl(config, prepared.delivery.assetId, now()),
                displayUrl: signedDisplayUrl(config, prepared.delivery.assetId, now()),
                sha256: prepared.delivery.credential.assetSha256,
                mimeType: "image/png"
              },
              settlement: { status: "SETTLED", buyerTx: outcome.tx },
              statusUrl: prepared.delivery.credential.statusUrl
            });
            return;
          }
          if (st.status === "failed") {
            onSettlementFailure(repo, prepared.delivery.orderId, st.detail ?? "settlement failed", { nowSeconds: now() });
            res.status(402).json({ error: "SETTLEMENT_FAILED", detail: st.detail ?? "settlement failed" });
            return;
          }
        } catch {
          // transient poll error — keep waiting
        }
      }
    }

    if (outcome.status === "pending") {
      // Persist the broadcast tx so the reconciler can poll it to a terminal state.
      repo.markSettlementPending(prepared.delivery.orderId, outcome.tx, "SETTLEMENT_PENDING", null, now());
      res.status(202).json({
        orderId: prepared.delivery.orderId,
        settlement: { status: "PENDING" },
        statusUrl: prepared.delivery.credential.statusUrl,
        deliveryUrl: signedDeliveryUrl(config, prepared.delivery.orderId, now())
      });
      return;
    }
    if (outcome.status === "timeout") {
      repo.markSettlementPending(prepared.delivery.orderId, outcome.tx, "SETTLEMENT_TIMEOUT", outcome.detail, now());
      res.status(202).json({
        orderId: prepared.delivery.orderId,
        settlement: { status: "TIMEOUT" },
        statusUrl: prepared.delivery.credential.statusUrl,
        deliveryUrl: signedDeliveryUrl(config, prepared.delivery.orderId, now())
      });
      return;
    }
    onSettlementFailure(repo, prepared.delivery.orderId, outcome.detail, { nowSeconds: now() });
    res.status(402).json({ error: "SETTLEMENT_FAILED", detail: outcome.detail });
  });

  // --- POST /v1/check-license-scope (free) -----------------------------------
  app.post("/v1/check-license-scope", (req: Request, res: Response) => {
    const result = checkLicenseScope({
      credential: req.body?.license,
      use: req.body?.action ? { action: req.body.action, channel: req.body.channel, at: req.body.at } : req.body?.use,
      licensee: req.body?.licensee ?? "0x0000000000000000000000000000000000000000",
      issuerAddress: config.issuerAddress,
      nowSeconds: now()
    });

    // Online status is STRICT: this service is the issuer, so it must know every
    // credential it issued. ACTIVE/REVOKED come from the ledger; a signed sample
    // (never a purchase, never in the ledger) is labeled SAMPLE and may pass;
    // anything else is unknown to the issuer and can never be effectively permitted.
    const credOrderId = typeof (req.body?.license as { orderId?: unknown })?.orderId === "string" ? String((req.body.license as { orderId: string }).orderId) : "";
    let currentStatus = "UNKNOWN_TO_ISSUER";
    if (result.licenseId) {
      const orderId = repo.getOrderIdByLicenseId(result.licenseId);
      const licenseStatus = orderId ? repo.getLicenseStatus(orderId) : undefined;
      if (licenseStatus === "ACTIVE") currentStatus = "ACTIVE";
      else if (licenseStatus === "VOID_SETTLEMENT_FAILED") currentStatus = "REVOKED";
      else if (licenseStatus) currentStatus = licenseStatus;
      else if (credOrderId.startsWith("sample-")) currentStatus = "SAMPLE";
    } else if (credOrderId.startsWith("sample-")) {
      currentStatus = "SAMPLE";
    }
    if (result.decision === "INVALID_CREDENTIAL") currentStatus = result.currentStatus ?? currentStatus;

    // Merge scope + status into one effective decision so a downstream agent
    // reading a single field can't act on a PERMITTED scope over a REVOKED
    // credential. Unknown-to-issuer fails closed as INDETERMINATE.
    const scopeOk = result.decision === "PERMITTED" || result.decision === "PERMITTED_WITH_DUTIES";
    // A TESTNET credential is real protocol execution over test-value money —
    // it must NEVER read as a production permission (review §2). The credential
    // itself carries credentialEnvironment, so this works fully offline too.
    const credEnv = (req.body?.license as { credentialEnvironment?: string })?.credentialEnvironment;
    if (credEnv === "testnet" && currentStatus === "ACTIVE") currentStatus = "TESTNET_ACTIVE";
    const statusOk = currentStatus === "ACTIVE" || currentStatus === "SAMPLE";
    const effectiveDecision =
      scopeOk && currentStatus === "TESTNET_ACTIVE"
        ? "PERMITTED_TESTNET_ONLY"
        : scopeOk && statusOk
          ? result.decision
          : result.decision === "INVALID_CREDENTIAL"
            ? "INVALID_CREDENTIAL"
            : scopeOk && currentStatus === "UNKNOWN_TO_ISSUER"
              ? "INDETERMINATE"
              : "NOT_PERMITTED";

    res.status(200).json({
      decision: result.decision,
      staticScopeDecision: result.decision,
      credentialStatus: currentStatus,
      effectiveDecision,
      staticScope: result.staticScope,
      currentStatus,
      reasonCodes: result.reasonCodes,
      duties: result.duties,
      checks: result.checks,
      licenseId: result.licenseId
    });
  });

  // --- GET /v1/orders/:orderId/delivery (bearer claim after delayed settle) --
  // Idempotent: once the reconciler activates the order, the buyer collects the
  // credential and fresh signed asset URLs with the ticket from the 202 response.
  app.get("/v1/orders/:orderId/delivery", (req: Request, res: Response) => {
    const orderId = String(req.params.orderId);
    if (!verifyDeliverySig(config, orderId, Number(req.query.exp), String(req.query.sig ?? ""), now())) {
      res.status(403).json({ error: "INVALID_OR_EXPIRED_TICKET" });
      return;
    }
    const order = repo.getOrder(orderId);
    if (!order) return void res.status(404).json({ error: "ORDER_NOT_FOUND" });
    const activeStates = ["LICENSE_ACTIVE", "CREATOR_PAYOUT_PENDING", "PAYOUT_RETRYING", "PAYOUT_FAILED", "CREATOR_PAID"];
    if (!activeStates.includes(order.status)) {
      res.status(409).json({ error: "NOT_SETTLED_YET", status: order.status, statusUrl: `${config.publicOrigin}/v1/orders/${orderId}` });
      return;
    }
    const credential = repo.getLicenseByOrder(orderId);
    if (!credential) return void res.status(404).json({ error: "LICENSE_NOT_FOUND" });
    const offer = repo.listActiveOffers().find((o) => o.assetSha256 === credential.assetSha256);
    const assetId = offer?.assetId ?? "";
    // The standard receipt accompanies delayed deliveries too (review §6). If the
    // reconciler activated this order, synthesize + persist the header once.
    let receipt = order.paymentResponseHeader;
    if (!receipt && order.buyerSettleTx) {
      const net = order.environment === "testnet" && config.testnet ? config.testnet.network : config.network;
      receipt = synthesizePaymentResponse(order.buyerSettleTx, net, order.licenseeWallet);
      if (receipt) repo.setPaymentResponseHeader(orderId, receipt, now());
    }
    if (receipt) res.setHeader("PAYMENT-RESPONSE", receipt);
    res.status(200).json({
      orderId,
      license: credential,
      asset: {
        assetId,
        url: signedAssetUrl(config, assetId, now()),
        displayUrl: signedDisplayUrl(config, assetId, now()),
        sha256: credential.assetSha256,
        mimeType: "image/png"
      },
      settlement: { status: "SETTLED", buyerTx: order.buyerSettleTx }
    });
  });

  // --- GET /v1/orders/:orderId (free — terminal settlement truth) ------------
  app.get("/v1/orders/:orderId", (req: Request, res: Response) => {
    const order = repo.getOrder(String(req.params.orderId));
    if (!order) {
      res.status(404).json({ error: "ORDER_NOT_FOUND" });
      return;
    }
    const payout = repo.getPayout(order.orderId);
    const licenseStatus = repo.getLicenseStatus(order.orderId);
    const settledStates = ["LICENSE_ACTIVE", "CREATOR_PAYOUT_PENDING", "CREATOR_PAID", "PAYOUT_RETRYING", "PAYOUT_FAILED"];
    const settled = settledStates.includes(order.status);
    res.status(200).json({
      orderId: order.orderId,
      status: order.status,
      licenseStatus,
      buyerSettleTx: order.buyerSettleTx,
      creatorPayout: payout
        ? {
            state: payout.state,
            amount: formatMicroUsdt(payout.amount_micro as number),
            confirmedTx: payout.confirmed_tx ?? null,
            broadcastTx: payout.broadcast_tx ?? null
          }
        : null,
      economics:
        settled && payout?.state === "PAID"
          ? {
              buyerSettled: formatMicroUsdt(SALE_PRICE_MICRO),
              creatorPaid: formatMicroUsdt(CREATOR_PAYOUT_MICRO),
              platformFee: formatMicroUsdt(PLATFORM_FEE_MICRO)
            }
          : {
              price: formatMicroUsdt(SALE_PRICE_MICRO),
              creatorPayoutPayable: formatMicroUsdt(CREATOR_PAYOUT_MICRO),
              payoutStatus: (payout?.state as string) ?? "PENDING"
            }
    });
  });

  // --- GET /v1/offers/:offerId — the full signed CreatorOffer (head version)
  app.get("/v1/offers/:offerId", (req: Request, res: Response) => {
    const row = repo.getOffer(String(req.params.offerId));
    if (!row) return void res.status(404).json({ error: "OFFER_NOT_FOUND" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ offer: row.offer, offerDigest: row.offerDigest, verify: "recover the EIP-712 CreatorOffer signer; it must equal licensorWallet" });
  });

  // --- GET /v1/attestations/:slug — the rights attestation whose sha256 the offer pins
  app.get("/v1/attestations/:slug", (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) return void res.status(400).json({ error: "INVALID_SLUG" });
    const path = resolve(PROJECT_ROOT, `catalog/attestations/${slug}.md`);
    if (!existsSync(path)) return void res.status(404).json({ error: "ATTESTATION_NOT_FOUND" });
    const body = readFileSync(path);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("X-Attestation-Sha256", sha256Hex(body));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(body);
  });

  // --- GET /v1/legal/:hash — the exact legal text bytes a credential references
  app.get("/v1/legal/:hash", (req: Request, res: Response) => {
    const hash = String(req.params.hash);
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return void res.status(400).json({ error: "INVALID_HASH" });
    const body = repo.getLegalText(hash);
    if (!body) return void res.status(404).json({ error: "LEGAL_TEXT_NOT_FOUND" });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(body);
  });

  // --- GET /v1/orders/:orderId/bundle — the full reproducible proof chain ----
  app.get("/v1/orders/:orderId/bundle", (req: Request, res: Response) => {
    const order = repo.getOrder(String(req.params.orderId));
    if (!order) {
      res.status(404).json({ error: "ORDER_NOT_FOUND" });
      return;
    }
    const quote = repo.getQuoteById(order.quoteId);
    // The bundle must carry the offer version THIS order was made under —
    // never the current head, which may have been re-signed since.
    const historicalOffer = quote ? repo.getOfferByDigest(quote.offerDigest) : undefined;
    const offerRow = quote ? repo.getOffer(quote.offerId) : undefined;
    const credential = repo.getLicenseByOrder(order.orderId);
    const payout = repo.getPayout(order.orderId);
    res.status(200).json({
      generatedFor: order.orderId,
      environment: order.environment,
      authorization:
        (order.purchaseIntent as { mode?: string })?.mode === "x402_direct"
          ? {
              mode: "x402_direct",
              note: "Authorized by the x402 EIP-3009 payment signature — no separate PurchaseIntent signature exists for direct purchases.",
              record: order.purchaseIntent
            }
          : { mode: "eip712_purchase_intent", note: "Buyer-signed EIP-712 PurchaseIntent (recover the signer to verify)." },
      creatorOffer: historicalOffer ?? offerRow?.offer ?? null,
      legalTextUrl: historicalOffer ? `${config.publicOrigin}/v1/legal/${historicalOffer.legalTextHash}` : null,
      quote: quote
        ? {
            quoteId: quote.quoteId,
            quoteCommitment: quote.quoteCommitment,
            offerDigest: quote.offerDigest,
            useSpec: quote.useSpec,
            priceMicro: quote.priceMicro,
            platformFeeMicro: quote.platformFeeMicro,
            creatorPayoutMicro: quote.creatorPayoutMicro,
            // Rail + idempotency key make the commitment fully recomputable
            // offline (scripts/verify-evidence.ts) — nothing here is secret
            // once the purchase exists. v1-era quotes (migration backfill has
            // an empty paymentAsset) are emitted WITHOUT rail fields: their
            // commitment predates rail binding and must recompute as v1.
            ...(quote.paymentAsset
              ? { settlementNetwork: quote.settlementNetwork, paymentAsset: quote.paymentAsset, payTo: quote.payTo }
              : {}),
            idempotencyKey: quote.idempotencyKey,
            expiresAt: quote.expiresAt
          }
        : null,
      purchaseIntent: order.purchaseIntent,
      licenseCredential: credential ?? null,
      order: { orderId: order.orderId, status: order.status, buyerPaymentId: order.buyerPaymentId, buyerSettleTx: order.buyerSettleTx, paymentAuthorizationDigest: order.paymentAuthorizationDigest },
      creatorPayout: payout ? { state: payout.state, amountMicro: payout.amount_micro, confirmedTx: payout.confirmed_tx ?? null } : null,
      notes: "Verify: recover CreatorOffer + PurchaseIntent signers (EIP-712), recompute quoteCommitment, recover the credential issuer signature, and re-run check-license-scope. Sample environment = simulated settlement, no funds moved."
    });
  });

  // --- previews (free) & full asset (signed, post-payment) -------------------
  const imageMime = (path: string): string => (path.endsWith(".webp") ? "image/webp" : "image/png");

  app.get("/v1/previews/:assetId", (req: Request, res: Response) => {
    const asset = repo.getAsset(String(req.params.assetId));
    if (!asset) return void res.status(404).json({ error: "NOT_FOUND" });
    const path = resolve(PROJECT_ROOT, asset.previewPath);
    if (!existsSync(path)) return void res.status(404).json({ error: "NOT_FOUND" });
    res.setHeader("Content-Type", imageMime(path));
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(readFileSync(path));
  });

  /**
   * Post-purchase DISPLAY rendition (clean webp, ~1400px) — what the UI shows.
   * The signed download URL below still delivers the exact sha256-bound PNG;
   * this exists only so the page doesn't pull multi-MB originals to render.
   * Derived from the asset file path, e.g. catalog/assets/x.png → catalog/display/x.display.webp.
   */
  app.get("/v1/assets/:assetId/display", (req: Request, res: Response) => {
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig ?? "");
    const assetId = String(req.params.assetId);
    if (!verifyAssetSig(config, assetId, exp, sig, now())) {
      return void res.status(403).json({ error: "INVALID_OR_EXPIRED_URL" });
    }
    const asset = repo.getAsset(assetId);
    if (!asset) return void res.status(404).json({ error: "NOT_FOUND" });
    const slug = asset.filePath.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "");
    const displayPath = resolve(PROJECT_ROOT, `catalog/display/${slug}.display.webp`);
    const path = existsSync(displayPath) ? displayPath : resolve(PROJECT_ROOT, asset.filePath);
    res.setHeader("Content-Type", imageMime(path));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(readFileSync(path));
  });

  app.get("/v1/assets/:assetId", (req: Request, res: Response) => {
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig ?? "");
    if (!verifyAssetSig(config, String(req.params.assetId), exp, sig, now())) {
      return void res.status(403).json({ error: "INVALID_OR_EXPIRED_URL" });
    }
    const asset = repo.getAsset(String(req.params.assetId));
    if (!asset) return void res.status(404).json({ error: "NOT_FOUND" });
    const path = resolve(PROJECT_ROOT, asset.filePath);
    if (!existsSync(path)) return void res.status(404).json({ error: "NOT_FOUND" });
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${asset.filePath.replace(/^.*\//, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(readFileSync(path));
  });

  // --- signed sample (free, READ-ONLY — the public no-wallet experience) -----
  // Fully signed end-to-end but never a purchase: built in memory, writes
  // nothing (no order, no license row, no payout), and serves the badged
  // sample rendition instead of the licensed deliverable. Works identically
  // in dev and live mode, so flipping PAYMENT_MODE never breaks the sample.
  app.get("/v1/samples/default", (_req: Request, res: Response) => {
    try {
      const envelope = buildSampleEnvelope(config, catalogOffers(), now());
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({ ok: true, ...envelope });
    } catch (e) {
      res.status(503).json({ ok: false, error: e instanceof Error ? e.message : "SAMPLE_UNAVAILABLE" });
    }
  });

  app.get("/v1/samples/art/:slug", (req: Request, res: Response) => {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, "");
    const path = resolve(PROJECT_ROOT, `catalog/sample/${slug}.sample.webp`);
    if (!existsSync(path)) return void res.status(404).json({ error: "NOT_FOUND" });
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(readFileSync(path));
  });

  // --- GET /v1/balance/:address — read-only, server-side (no wallet chain dance)
  app.get("/v1/balance/:address", async (req: Request, res: Response) => {
    const address = String(req.params.address);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return void res.status(400).json({ error: "INVALID_ADDRESS" });
    const svc = req.query.network === "testnet" ? chainTest : chainMain;
    if (!svc) return void res.status(503).json({ error: "RAIL_UNAVAILABLE" });
    try {
      const bal = await svc.usdtBalance(address);
      res.json({ address: address.toLowerCase(), network: req.query.network === "testnet" ? "testnet" : "mainnet", balanceMicro: Number(bal) });
    } catch {
      res.status(502).json({ error: "CHAIN_UNAVAILABLE" });
    }
  });

  // --- faucet (TESTNET ONLY — 0.5 test USDT per claim) ------------------------
  // Dispenses from OUR service wallet (the official faucet is captcha-gated and
  // has no API). 0.5 per claim, unlimited claims with a 60s cooldown; purchases
  // replenish the pool (0.10 in / 0.07 payout → net +0.03 per order). The
  // official faucet link is offered in the UI for bigger top-ups.
  const FAUCET_AMOUNT_MICRO = 500_000;
  app.post("/v1/faucet", async (req: Request, res: Response) => {
    if (config.paymentMode !== "live" || !chainTest || !config.testnet) {
      res.status(503).json({ error: "FAUCET_DISABLED", detail: "the faucet serves TESTNET funds only" });
      return;
    }
    const address = String(req.body?.address ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "INVALID_ADDRESS" });
      return;
    }
    try {
      const pool = Number(await chainTest.usdtBalance(chainTest.address));
      if (pool - 100_000 < FAUCET_AMOUNT_MICRO) {
        res.status(503).json({ error: "FAUCET_POOL_LOW", detail: "pool refilling — use the official faucet meanwhile" });
        return;
      }
    } catch {
      res.status(502).json({ error: "CHAIN_UNAVAILABLE" });
      return;
    }
    // ATOMIC cooldown (round-10): check-and-take is ONE sql statement — two
    // concurrent claims for the same address can never both pass.
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "");
    if (!repo.tryTakeFaucetSlot(address, ip, FAUCET_AMOUNT_MICRO, "testnet", now(), 60)) {
      res.status(429).json({ error: "COOLDOWN", detail: "wait a minute between claims" });
      return;
    }
    try {
      const tx = await chainTest.transferUsdt(address, FAUCET_AMOUNT_MICRO);
      repo.recordFaucetTx(address, "testnet", tx);
      res.status(200).json({ ok: true, network: "testnet", tx, amount: "0.5", explorer: `${config.testnet.explorerTx}${tx}` });
    } catch (e) {
      // Nothing was delivered — reopen the slot so the retry isn't punished.
      repo.reopenFaucetSlot(address, "testnet");
      res.status(502).json({ error: "FAUCET_SEND_FAILED", detail: e instanceof Error ? e.message : "send failed" });
    }
  });

  // --- wallet-free judge demo (DEV MODE ONLY) --------------------------------
  app.post("/v1/demo/acquire", async (req: Request, res: Response) => {
    if (!config.demoBuyerPrivateKey) {
      res.status(503).json({ error: "DEMO_UNAVAILABLE" });
      return;
    }
    const use = req.body?.use ?? {
      brief: "cyberpunk dragon on a dark background",
      channel: "x",
      commercial: true,
      durationDays: 14,
      territory: "worldwide",
      transformations: ["crop", "overlay_text"],
      maxBudget: "0.10"
    };
    const result = await runDemoAcquire(
      repo,
      config,
      catalogOffers(),
      use,
      config.demoBuyerPrivateKey,
      now(),
      (assetId) => `${config.publicOrigin}/v1/previews/${assetId}`,
      (assetId) => signedAssetUrl(config, assetId, now()),
      (assetId) => signedDisplayUrl(config, assetId, now())
    );
    res.status(result.ok ? 200 : 400).json(result);
  });

  // --- public data + Proof Studio SPA ----------------------------------------
  app.get("/v1/ledger", (_req, res) => {
    res.json(ledgerJson(db));
  });
  app.get("/v1/catalog", (_req, res) => {
    res.json({
      offers: catalogOffers().map((c) => ({
        assetId: c.offer.assetId,
        offerId: c.offer.offerId,
        title: c.title,
        creator: c.creatorDisplay,
        previewUrl: `${config.publicOrigin}/v1/previews/${c.offer.assetId}`,
        commercialUse: c.offer.policy.commercialUse,
        modelTraining: c.offer.policy.modelTraining,
        expired: c.offer.validUntil < now(),
        creatorNetPrice: c.offer.creatorNetPrice,
        // Provenance: the signed offer JSON + the rights attestation the
        // creator hashed into it — both linkable from the market cards.
        offerUrl: `${config.publicOrigin}/v1/offers/${c.offer.offerId}`,
        attestationUrl: `${config.publicOrigin}/v1/attestations/${c.offer.offerId.replace(/^off-/, "")}`,
        tags: c.tags ?? []
      }))
    });
  });
  app.get("/config.json", (_req, res) => {
    const main = mainnetProfile(config);
    res.json({
      paymentMode: config.paymentMode,
      network: config.network,
      issuer: config.issuerAddress,
      payTo: config.payToAddress,
      price: config.priceUsd,
      // Set OKX_LISTING_URL once the marketplace listing is approved — the site
      // then shows "Hire on OKX.AI ↗" buttons without a code change.
      listingUrl: process.env.OKX_LISTING_URL?.trim() || null,
      rails: {
        mainnet: { network: main.network, chainId: main.chainId, asset: main.asset, explorerTx: main.explorerTx, faucet: false },
        ...(config.testnet
          ? { testnet: { network: config.testnet.network, chainId: config.testnet.chainId, asset: config.testnet.asset, explorerTx: config.testnet.explorerTx, faucet: true, officialFaucet: "https://web3.okx.com/xlayer/faucet" } }
          : {})
      }
    });
  });
  // Version transparency: judges and crawlers can confirm the running build
  // matches GitHub main. BUILD_INFO.json is written at deploy time (gitignored).
  app.get("/version.json", (_req, res) => {
    let build: Record<string, unknown> = { commit: "dev", builtAt: null };
    try {
      build = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "BUILD_INFO.json"), "utf8")) as Record<string, unknown>;
    } catch {
      // local dev — no build stamp
    }
    res.json({ ...build, paymentMode: config.paymentMode, apiVersion: "2", credentialVersion: CREDENTIAL_VERSION, eip712DomainVersion: EIP712_DOMAIN.version, x402Version: 2 });
  });
  // Reconcile settlements the facilitator left pending/timeout, then drain payouts.
  // Idempotent and side-effect-safe (never moves new buyer funds); also runs on a
  // live-mode interval below. In live mode this endpoint requires ADMIN_TOKEN —
  // it triggers facilitator API calls and payout broadcasts, so it must not be
  // publicly drivable.
  app.post("/internal/reconcile", async (req, res) => {
    if (config.paymentMode === "live") {
      const adminToken = process.env.ADMIN_TOKEN?.trim();
      if (!adminToken || req.header("x-admin-token") !== adminToken) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
    }
    try {
      const settled = await reconcileSettlements(repo, payment, now);
      const payouts = await runPayoutWorker(repo, config, now, payoutSenders);
      res.json({ ok: true, settled, payouts });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "reconcile failed" });
    }
  });

  // Resolve a payout parked in NEEDS_RECONCILIATION (nonce consumed, hash lost).
  // Two explicit admin actions, mirroring what the explorer shows:
  //   {action:"attach_tx", tx}   — the broadcast DID land; worker confirms → PAID
  //   {action:"fresh_nonce"}     — nonce went to an unrelated tx; retry fresh
  // There is deliberately NO automatic path out of this state (round-10 P0).
  app.post("/internal/payouts/:orderId/reconcile", express.json(), (req, res) => {
    if (config.paymentMode === "live") {
      const adminToken = process.env.ADMIN_TOKEN?.trim();
      if (!adminToken || req.header("x-admin-token") !== adminToken) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
    }
    const orderId = String(req.params.orderId);
    const action = (req.body as { action?: string })?.action;
    if (action === "attach_tx") {
      const tx = (req.body as { tx?: string })?.tx;
      if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return void res.status(400).json({ error: "INVALID_TX" });
      const ok = repo.attachReconciledPayoutTx(orderId, tx, now());
      if (!ok) return void res.status(409).json({ error: "NOT_IN_NEEDS_RECONCILIATION" });
      void runPayoutWorker(repo, config, now, payoutSenders).catch(() => {});
      return void res.json({ ok: true, orderId, state: "BROADCAST", tx });
    }
    if (action === "fresh_nonce") {
      const ok = repo.releasePayoutForFreshNonce(orderId, now());
      if (!ok) return void res.status(409).json({ error: "NOT_IN_NEEDS_RECONCILIATION" });
      void runPayoutWorker(repo, config, now, payoutSenders).catch(() => {});
      return void res.json({ ok: true, orderId, state: "PENDING" });
    }
    res.status(400).json({ error: "INVALID_ACTION", allowed: ["attach_tx", "fresh_nonce"] });
  });
  app.get("/ledger.html", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboard(db, config));
  });
  // Pretty routes for the feature pages (each a self-contained HTML file).
  for (const page of ["buy", "market", "verify"]) {
    app.get(`/${page}`, (_req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      if (page === "buy") {
        // The wallet page runs NO inline script (external /js/buy.js only) so it
        // gets a strict CSP — an injected <script> can never reach the wallet.
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        );
      }
      res.sendFile(resolve(PROJECT_ROOT, `public/${page}.html`));
    });
  }
  app.use(
    express.static(resolve(PROJECT_ROOT, "public"), {
      index: "index.html",
      maxAge: "5m",
      setHeaders: (res, path) => {
        // Page shells must never be stale for judges; fonts/assets can cache.
        if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
      }
    })
  );

  // JSON 404 + error handler (never leak Express HTML pages to API clients).
  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND", path: req.path });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("[LICENSE402] unhandled:", err);
    res.status(500).json({ error: "INTERNAL", detail: err instanceof Error ? err.message : "error" });
  });

  // Live mode: periodically finalize pending settlements and drain creator payouts.
  // Never started in dev/test (no pending settlements exist; would leak a timer).
  if (config.paymentMode === "live" && payment.settleStatus) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; // no overlapping passes
      running = true;
      try {
        await reconcileSettlements(repo, payment, now);
        await runPayoutWorker(repo, config, now, payoutSenders);
      } catch (e) {
        console.warn("[reconcile] interval error:", (e as Error).message);
      } finally {
        running = false;
      }
    }, 20_000);
    timer.unref?.();
  }

  return app;
}

function ledgerJson(db: AppDatabase): unknown {
  // sponsored = the buyer wallet drew onboarding funds from OUR faucet. Those
  // orders prove the pipeline but are excluded from qualified revenue.
  const orders = db
    .prepare(
      `SELECT o.order_id, o.status, o.buyer_settle_tx, o.environment, o.created_at,
              p.confirmed_tx AS creator_payout_tx, p.state AS payout_state,
              CASE WHEN f.address IS NOT NULL THEN 1 ELSE 0 END AS sponsored
         FROM orders o
         LEFT JOIN creator_payouts p ON p.order_id = o.order_id AND p.payout_type = 'creator_net'
         LEFT JOIN faucet_claims f
           ON f.address = o.licensee_wallet AND f.network = 'mainnet' AND o.environment = 'production'
         ORDER BY o.created_at DESC LIMIT 100`
    )
    .all();
  const paid = db.prepare(`SELECT COUNT(*) AS n FROM creator_payouts WHERE state = 'PAID'`).get() as { n: number };
  const active = db.prepare(`SELECT COUNT(*) AS n FROM licenses WHERE status = 'ACTIVE'`).get() as { n: number };
  const buyers = db.prepare(`SELECT COUNT(DISTINCT licensee_wallet) AS n FROM orders WHERE status IN ('LICENSE_ACTIVE','CREATOR_PAYOUT_PENDING','CREATOR_PAID')`).get() as { n: number };
  // Production figures count ONLY environment='production' rows — flipping the
  // deployment to live can never re-label historical simulated orders.
  const prodSettled = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT licensee_wallet) AS buyers FROM orders
         WHERE environment = 'production' AND status IN ('LICENSE_ACTIVE','CREATOR_PAYOUT_PENDING','PAYOUT_RETRYING','PAYOUT_FAILED','CREATOR_PAID')`
    )
    .get() as { n: number; buyers: number };
  const prodPaid = db
    .prepare(
      `SELECT COUNT(*) AS n FROM creator_payouts p JOIN orders o ON o.order_id = p.order_id
         WHERE p.state = 'PAID' AND o.environment = 'production'`
    )
    .get() as { n: number };
  // Testnet split (round-10): settled ≠ paid-out — show both, never conflate.
  const testnetSettled = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
         WHERE environment = 'testnet' AND status IN ('LICENSE_ACTIVE','CREATOR_PAYOUT_PENDING','PAYOUT_RETRYING','PAYOUT_FAILED','CREATOR_PAID')`
    )
    .get() as { n: number };
  const testnetPaid = db
    .prepare(
      `SELECT COUNT(*) AS n FROM creator_payouts p JOIN orders o ON o.order_id = p.order_id
         WHERE p.state = 'PAID' AND o.environment = 'testnet'`
    )
    .get() as { n: number };
  // Qualified = production AND the buyer never drew faucet funds (self-funded).
  const qualified = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders o
         LEFT JOIN faucet_claims f ON f.address = o.licensee_wallet AND f.network = 'mainnet'
         WHERE o.environment = 'production' AND f.address IS NULL
           AND o.status IN ('LICENSE_ACTIVE','CREATOR_PAYOUT_PENDING','PAYOUT_RETRYING','PAYOUT_FAILED','CREATOR_PAID')`
    )
    .get() as { n: number };
  return {
    activeLicenses: active.n,
    creatorPayoutsPaid: paid.n,
    distinctBuyers: buyers.n,
    production: {
      licenses: prodSettled.n,
      distinctBuyers: prodSettled.buyers,
      creatorsPaid: prodPaid.n,
      qualified: qualified.n,
      sponsored: prodSettled.n - qualified.n
    },
    testnet: { settled: testnetSettled.n, payoutsPaid: testnetPaid.n },
    orders
  };
}
