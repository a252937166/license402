import express from "express";
import type { Express, Request, Response } from "express";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { loadConfig, PROJECT_ROOT } from "./config.js";
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
import { formatMicroUsdt, CREATOR_PAYOUT_MICRO, PLATFORM_FEE_MICRO, SALE_PRICE_MICRO } from "./license/money.js";
import { UseSpecSchema } from "./license/types.js";
import { onSettlementFailure, onSettlementSuccess, prepareDelivery } from "./orders/prepare.js";
import { runDemoAcquire } from "./orders/demo.js";
import { DevPaymentAdapter } from "./payment/adapter.js";
import type { PaymentAdapter } from "./payment/adapter.js";
import { LivePaymentAdapter } from "./payment/live.js";
import { reconcileSettlements } from "./payment/reconcile.js";
import { runPayoutWorker } from "./payout/worker.js";
import { renderDashboard } from "./dashboard.js";

export interface CreateAppOptions {
  config?: AppConfig;
  now?: () => number;
  dbPath?: string;
  /** Inject a payment adapter (tests use a fake live adapter to exercise the x402 path offline). */
  payment?: PaymentAdapter;
}

const SIGNED_URL_TTL = 3 * 3600;


function signedAssetUrl(config: AppConfig, assetId: string, nowSeconds: number): string {
  const exp = nowSeconds + SIGNED_URL_TTL;
  const sig = createHmac("sha256", config.servicePrivateKey).update(`${assetId}.${exp}`).digest("hex").slice(0, 32);
  return `${config.publicOrigin}/v1/assets/${encodeURIComponent(assetId)}?exp=${exp}&sig=${sig}`;
}

/** Same signature/expiry as the download URL, but serves the fast webp display rendition. */
function signedDisplayUrl(config: AppConfig, assetId: string, nowSeconds: number): string {
  const exp = nowSeconds + SIGNED_URL_TTL;
  const sig = createHmac("sha256", config.servicePrivateKey).update(`${assetId}.${exp}`).digest("hex").slice(0, 32);
  return `${config.publicOrigin}/v1/assets/${encodeURIComponent(assetId)}/display?exp=${exp}&sig=${sig}`;
}

function verifyAssetSig(config: AppConfig, assetId: string, exp: number, sig: string, nowSeconds: number): boolean {
  if (!Number.isFinite(exp) || exp < nowSeconds) return false;
  const expected = createHmac("sha256", config.servicePrivateKey).update(`${assetId}.${exp}`).digest("hex").slice(0, 32);
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

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
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

    const quote = buildQuote(catalogOffers(), parsedUse.data, licenseeWallet, { nowSeconds: now() });
    if (!quote.serviceable || !quote.selected) {
      res.status(200).json({
        serviceable: false,
        reasons: quote.reasons ?? [],
        rejectedCandidates: quote.rejectedCandidates,
        nextAction: "REQUEST_DIFFERENT_LICENSE"
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
        idempotencyKey: quote.selected.idempotencyKey,
        expiresAt: quote.selected.quoteExpiresAt
      },
      now()
    );

    res.status(200).json({
      serviceable: true,
      template: "social-commercial-v1",
      quoteId: quote.selected.quoteId,
      asset: {
        assetId: quote.selected.assetId,
        assetSha256: quote.selected.assetSha256,
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
        currency: "USDT"
      }
    });
  });

  // --- POST /v1/acquire/social-commercial (x402-protected) -------------------
  app.post("/v1/acquire/social-commercial", async (req: Request, res: Response) => {
    const verified = await payment.verify(req);
    if (!verified) {
      const challenge = payment.challenge(config.priceUsd, config.network, config.payToAddress);
      for (const [k, v] of Object.entries(challenge.headers)) res.setHeader(k, v);
      res.status(challenge.status).json(challenge.body);
      return;
    }

    const prepared = prepareDelivery(
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
        paymentAuthorizationDigest: verified.paymentAuthorizationDigest
      }
    );

    if (!prepared.ok) {
      res.status(prepared.error.http).json({
        error: prepared.error.code,
        ...("detail" in prepared.error ? { detail: prepared.error.detail } : {})
      });
      return;
    }

    const outcome = await payment.settle(verified);
    if (outcome.status === "success") {
      onSettlementSuccess(repo, prepared.delivery.orderId, outcome.tx, { nowSeconds: now() });
      await runPayoutWorker(repo, config, now).catch((e) => console.warn("[payout] inline:", e));
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
    if (outcome.status === "pending") {
      // Persist the broadcast tx so the reconciler can poll it to a terminal state.
      repo.markSettlementPending(prepared.delivery.orderId, outcome.tx, "SETTLEMENT_PENDING", null, now());
      res.status(202).json({ orderId: prepared.delivery.orderId, settlement: { status: "PENDING" }, statusUrl: prepared.delivery.credential.statusUrl });
      return;
    }
    if (outcome.status === "timeout") {
      repo.markSettlementPending(prepared.delivery.orderId, outcome.tx, "SETTLEMENT_TIMEOUT", outcome.detail, now());
      res.status(202).json({ orderId: prepared.delivery.orderId, settlement: { status: "TIMEOUT" }, statusUrl: prepared.delivery.credential.statusUrl });
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

    let currentStatus = result.currentStatus;
    if (result.licenseId) {
      const orderId = repo.getOrderIdByLicenseId(result.licenseId);
      const licenseStatus = orderId ? repo.getLicenseStatus(orderId) : undefined;
      if (licenseStatus === "ACTIVE") currentStatus = "ACTIVE";
      else if (licenseStatus === "VOID_SETTLEMENT_FAILED") currentStatus = "REVOKED";
    }

    // Merge scope + status into one effective decision so a downstream agent
    // reading a single field can't act on a PERMITTED scope over a REVOKED
    // credential. Anything but a clean scope over a live/offline credential fails closed.
    const scopeOk = result.decision === "PERMITTED" || result.decision === "PERMITTED_WITH_DUTIES";
    const statusOk = currentStatus === "ACTIVE" || currentStatus === "UNKNOWN_OFFLINE";
    const effectiveDecision = scopeOk && statusOk ? result.decision : result.decision === "INVALID_CREDENTIAL" ? "INVALID_CREDENTIAL" : "NOT_PERMITTED";

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

  // --- GET /v1/orders/:orderId/bundle — the full reproducible proof chain ----
  app.get("/v1/orders/:orderId/bundle", (req: Request, res: Response) => {
    const order = repo.getOrder(String(req.params.orderId));
    if (!order) {
      res.status(404).json({ error: "ORDER_NOT_FOUND" });
      return;
    }
    const quote = repo.getQuoteById(order.quoteId);
    const offerRow = quote ? repo.getOffer(quote.offerId) : undefined;
    const credential = repo.getLicenseByOrder(order.orderId);
    const payout = repo.getPayout(order.orderId);
    res.status(200).json({
      generatedFor: order.orderId,
      environment: config.paymentMode === "live" ? "production" : "sample",
      creatorOffer: offerRow?.offer ?? null,
      quote: quote
        ? { quoteId: quote.quoteId, quoteCommitment: quote.quoteCommitment, offerDigest: quote.offerDigest, useSpec: quote.useSpec, priceMicro: quote.priceMicro, platformFeeMicro: quote.platformFeeMicro, creatorPayoutMicro: quote.creatorPayoutMicro, expiresAt: quote.expiresAt }
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
        title: c.title,
        creator: c.creatorDisplay,
        previewUrl: `${config.publicOrigin}/v1/previews/${c.offer.assetId}`,
        commercialUse: c.offer.policy.commercialUse,
        modelTraining: c.offer.policy.modelTraining
      }))
    });
  });
  app.get("/config.json", (_req, res) => {
    res.json({ paymentMode: config.paymentMode, network: config.network, issuer: config.issuerAddress, payTo: config.payToAddress, price: config.priceUsd });
  });
  // Reconcile settlements the facilitator left pending/timeout, then drain payouts.
  // Idempotent and side-effect-safe (never moves new buyer funds); also runs on a
  // live-mode interval below. Exposed for ops/manual drain and for tests.
  app.post("/internal/reconcile", async (_req, res) => {
    try {
      const settled = await reconcileSettlements(repo, payment, now);
      const payouts = await runPayoutWorker(repo, config, now);
      res.json({ ok: true, settled, payouts });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "reconcile failed" });
    }
  });
  app.get("/ledger.html", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboard(db, config));
  });
  app.use(
    express.static(resolve(PROJECT_ROOT, "public"), {
      index: "index.html",
      maxAge: "5m",
      setHeaders: (res, path) => {
        // The SPA shell must never be stale for judges; fonts/assets can cache.
        if (path.endsWith("index.html")) res.setHeader("Cache-Control", "no-store");
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
        await runPayoutWorker(repo, config, now);
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
  const orders = db.prepare(`SELECT order_id, status, buyer_settle_tx, created_at FROM orders ORDER BY created_at DESC LIMIT 100`).all();
  const paid = db.prepare(`SELECT COUNT(*) AS n FROM creator_payouts WHERE state = 'PAID'`).get() as { n: number };
  const active = db.prepare(`SELECT COUNT(*) AS n FROM licenses WHERE status = 'ACTIVE'`).get() as { n: number };
  const buyers = db.prepare(`SELECT COUNT(DISTINCT licensee_wallet) AS n FROM orders WHERE status IN ('LICENSE_ACTIVE','CREATOR_PAYOUT_PENDING','CREATOR_PAID')`).get() as { n: number };
  return { activeLicenses: active.n, creatorPayoutsPaid: paid.n, distinctBuyers: buyers.n, orders };
}
