import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { privateKeyToAddress } from "./license/eip712.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "../..");

/** Load KEY=VALUE lines from .env.local into process.env (only if not already set). */
export function loadDotEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env.local — rely on the ambient environment (e.g. server systemd unit).
  }
}

export type PaymentMode = "off" | "live";

/** One settlement rail: which chain, which token, and the token's EIP-712 domain. */
export interface NetworkProfile {
  key: "mainnet" | "testnet";
  network: `${string}:${string}`;
  chainId: number;
  rpc: string;
  asset: string;
  assetName: string;
  assetVersion: string;
  explorerTx: string;
}

export interface AppConfig {
  port: number;
  publicOrigin: string;
  paymentMode: PaymentMode;
  network: `${string}:${string}`;
  priceUsd: string;
  dbPath: string;
  issuerPrivateKey: string;
  issuerAddress: string;
  servicePrivateKey: string;
  serviceAddress: string;
  payToAddress: string;
  demoBuyerPrivateKey?: string;
  okx?: { apiKey: string; secretKey: string; passphrase: string };
  /** X Layer testnet rail (free judge experience). Present when TESTNET_ENABLED=1. */
  testnet?: NetworkProfile;
}

/** X Layer mainnet profile (values verified on-chain 2026-07-11). */
export function mainnetProfile(config: AppConfig): NetworkProfile {
  return {
    key: "mainnet",
    network: config.network,
    chainId: 196,
    rpc: process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech",
    asset: process.env.X402_ASSET ?? "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    assetName: process.env.X402_ASSET_NAME ?? "USD₮0",
    assetVersion: process.env.X402_ASSET_VERSION ?? "1",
    explorerTx: "https://www.oklink.com/x-layer/tx/"
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(): AppConfig {
  loadDotEnvLocal();

  const paymentMode = (process.env.PAYMENT_MODE ?? "off") as PaymentMode;
  if (paymentMode !== "off" && paymentMode !== "live") {
    throw new Error("PAYMENT_MODE must be 'off' or 'live'");
  }

  const issuerPrivateKey = required("ISSUER_PRIVATE_KEY");
  const servicePrivateKey = required("SERVICE_WALLET_PRIVATE_KEY");
  const serviceAddress = privateKeyToAddress(servicePrivateKey);

  const config: AppConfig = {
    port: Number(process.env.PORT ?? 8799),
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "https://license402.axiqo.xyz",
    paymentMode,
    network: (process.env.X402_NETWORK ?? "eip155:196") as `${string}:${string}`,
    priceUsd: process.env.X402_PRICE ?? "$0.10",
    dbPath: process.env.DB_PATH ?? resolve(PROJECT_ROOT, "data/license402.db"),
    issuerPrivateKey,
    issuerAddress: privateKeyToAddress(issuerPrivateKey),
    servicePrivateKey,
    serviceAddress,
    payToAddress: process.env.PAY_TO_ADDRESS?.trim() || serviceAddress,
    demoBuyerPrivateKey: process.env.DEMO_BUYER_PRIVATE_KEY?.trim() || undefined
  };

  if (paymentMode === "live") {
    config.okx = {
      apiKey: required("OKX_API_KEY"),
      secretKey: required("OKX_SECRET_KEY"),
      passphrase: required("OKX_PASSPHRASE")
    };
  }

  // X Layer testnet rail — token is the OFFICIAL x402 testnet default asset
  // (SDK defaultAssets), EIP-3009 verified on-chain: domain USD₮0/1/1952.
  if (process.env.TESTNET_ENABLED === "1") {
    config.testnet = {
      key: "testnet",
      network: "eip155:1952",
      chainId: 1952,
      rpc: process.env.TESTNET_RPC ?? "https://testrpc.xlayer.tech",
      asset: process.env.TESTNET_ASSET ?? "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c",
      assetName: process.env.TESTNET_ASSET_NAME ?? "USD₮0",
      assetVersion: process.env.TESTNET_ASSET_VERSION ?? "1",
      explorerTx: "https://www.oklink.com/x-layer-test/tx/"
    };
  }

  return config;
}
