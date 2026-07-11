import type { Express } from "express";

export type PaymentMode = "off" | "live";

export interface PaymentStatus {
  mode: PaymentMode;
  network: `${string}:${string}`;
  price: string;
  protectedRoute: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when X402_MODE=live`);
  }
  return value;
};

export function getPaymentStatus(): PaymentStatus {
  const configuredMode = process.env.X402_MODE;
  if (configuredMode !== undefined && configuredMode !== "off" && configuredMode !== "live") {
    throw new Error("X402_MODE must be exactly 'off' or 'live'");
  }
  if (configuredMode === undefined && process.env.NODE_ENV === "production") {
    throw new Error("X402_MODE must be explicitly configured in production");
  }
  const mode: PaymentMode = configuredMode === "live" ? "live" : "off";
  const network = (process.env.X402_NETWORK || "eip155:196") as `${string}:${string}`;
  const price = process.env.X402_PRICE || "$0.05";
  const protectedRoute = "POST /api/v1/resolve";
  return { mode, network, price, protectedRoute };
}

export async function installX402(
  app: Express,
  status: PaymentStatus = getPaymentStatus()
): Promise<PaymentStatus> {
  const { mode, network, price, protectedRoute } = status;

  if (mode === "off") {
    return status;
  }

  const payTo = required("PAY_TO_ADDRESS");
  const apiKey = required("OKX_API_KEY");
  const secretKey = required("OKX_SECRET_KEY");
  const passphrase = required("OKX_PASSPHRASE");

  const [{ paymentMiddleware, x402ResourceServer }, { ExactEvmScheme }, { OKXFacilitatorClient }] =
    await Promise.all([
      import("@okxweb3/x402-express"),
      import("@okxweb3/x402-evm/exact/server"),
      import("@okxweb3/x402-core")
    ]);

  const facilitator = new OKXFacilitatorClient({ apiKey, secretKey, passphrase });
  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(network, new ExactEvmScheme());

  app.use(
    paymentMiddleware(
      {
        [protectedRoute]: {
          accepts: [{ scheme: "exact", network, payTo, price }],
          description: "Resolve a structured data request through quality-ranked providers with automatic fallback and a route receipt",
          mimeType: "application/json"
        }
      },
      resourceServer
    )
  );

  return status;
}
