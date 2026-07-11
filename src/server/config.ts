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

  return config;
}
