import { sha256Hex } from "../domain/index.js";
import { privateKeyToAddress, purchaseIntentToTypedMessage, signTypedData } from "../license/eip712.js";
import { buildQuote } from "../license/quote.js";
import { useSpecHash } from "../license/commitments.js";
import { legalTextHash } from "../legal.js";
import type { CatalogOffer } from "../license/quote.js";
import { PurchaseIntentSchema, UseSpecSchema } from "../license/types.js";
import { prepareDelivery, onSettlementSuccess } from "./prepare.js";
import { runPayoutWorker } from "../payout/worker.js";
import type { Repo } from "../store/repo.js";
import type { AppConfig } from "../config.js";



export interface DemoAcquireResult {
  ok: boolean;
  error?: string;
  orderId?: string;
  credential?: unknown;
  asset?: { assetId: string; url: string; displayUrl: string; sha256: string; mimeType: string; previewUrl: string; title: string };
  quote?: unknown;
}

/**
 * Wallet-free judge experience (DEV MODE ONLY): the server signs a PurchaseIntent
 * on behalf of a demo buyer key and runs the real credential/scope/settlement
 * logic with a simulated payment. Every signature and every scope decision is
 * real; only the payment is simulated — the whole deployment is labeled DEV.
 */
export async function runDemoAcquire(
  repo: Repo,
  config: AppConfig,
  catalog: CatalogOffer[],
  use: unknown,
  demoBuyerKey: string,
  nowSeconds: number,
  buildPreviewUrl: (assetId: string) => string,
  signAssetUrl: (assetId: string) => string,
  signDisplayUrl: (assetId: string) => string
): Promise<DemoAcquireResult> {
  if (config.paymentMode !== "off") return { ok: false, error: "DEMO_DISABLED_IN_LIVE_MODE" };

  const parsedUse = UseSpecSchema.safeParse(use);
  if (!parsedUse.success) return { ok: false, error: "INVALID_USESPEC" };
  const buyer = privateKeyToAddress(demoBuyerKey);

  const quote = buildQuote(catalog, parsedUse.data, buyer, { nowSeconds });
  if (!quote.serviceable || !quote.selected) return { ok: false, error: "NOT_SERVICEABLE", quote };

  const sel = quote.selected;
  repo.insertQuote(
    {
      quoteId: sel.quoteId,
      quoteCommitment: sel.quoteCommitment,
      offerId: sel.offerId,
      offerDigest: sel.offerDigest,
      licenseeWallet: buyer.toLowerCase(),
      useSpec: parsedUse.data,
      useSpecHash: useSpecHash(parsedUse.data),
      priceMicro: sel.priceMicro,
      platformFeeMicro: sel.platformFeeMicro,
      creatorPayoutMicro: sel.creatorPayoutMicro,
      idempotencyKey: sel.idempotencyKey,
      expiresAt: sel.quoteExpiresAt
    },
    nowSeconds
  );

  const intentUnsigned = {
    quoteId: sel.quoteId,
    quoteCommitment: sel.quoteCommitment,
    buyer,
    licensee: buyer,
    assetSha256: sel.assetSha256,
    offerDigest: sel.offerDigest,
    policyAstHash: sel.policyAstHash,
    legalTextHash: legalTextHash(),
    totalPrice: sel.price,
    currency: "USDT" as const,
    expiresAt: sel.quoteExpiresAt,
    nonce: sha256Hex(`demo-${buyer}-${sel.quoteId}`)
  };
  const signature = signTypedData("PurchaseIntent", purchaseIntentToTypedMessage(intentUnsigned), demoBuyerKey);
  const intent = PurchaseIntentSchema.parse({ ...intentUnsigned, signature });

  const paymentId = `demo-${sha256Hex(sel.quoteId).slice(2, 16)}`;
  const prepared = prepareDelivery(
    repo,
    config,
    { use: parsedUse.data, licenseeWallet: buyer, quoteCommitment: sel.quoteCommitment, idempotencyKey: sel.idempotencyKey, purchaseIntent: intent },
    { nowSeconds, verifiedPayer: buyer, buyerPaymentId: paymentId, paymentAuthorizationDigest: sha256Hex(`demo-auth-${paymentId}`), environment: "sample" }
  );
  if (!prepared.ok) return { ok: false, error: prepared.error.code };

  onSettlementSuccess(repo, prepared.delivery.orderId, `0xdemo${sha256Hex(paymentId).slice(2, 58)}`, { nowSeconds });
  await runPayoutWorker(repo, config, () => nowSeconds);

  return {
    ok: true,
    orderId: prepared.delivery.orderId,
    credential: prepared.delivery.credential,
    quote: {
      asset: { assetId: sel.assetId, title: sel.title, creator: sel.creatorDisplay },
      effectiveGrant: sel.effectiveGrant,
      rejectedCandidates: quote.rejectedCandidates
    },
    asset: {
      assetId: prepared.delivery.assetId,
      url: signAssetUrl(prepared.delivery.assetId),
      displayUrl: signDisplayUrl(prepared.delivery.assetId),
      sha256: prepared.delivery.credential.assetSha256,
      mimeType: "image/png",
      previewUrl: buildPreviewUrl(prepared.delivery.assetId),
      title: sel.title
    }
  };
}
