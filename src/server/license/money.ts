/** USDT amounts are integers in micro units (6 decimals). Pilot Terms pricing. */

export const USDT_DECIMAL_PATTERN = /^\d{1,7}(?:\.\d{1,6})?$/;

export const SALE_PRICE_MICRO = 100_000; // 0.10 USDT
export const CREATOR_PAYOUT_MICRO = 70_000; // 0.07 USDT
export const PLATFORM_FEE_MICRO = 30_000; // 0.03 USDT — platform fee, not profit
export const CURRENCY = "USDT";

// The split MUST cover the sale exactly — asserted at load so a careless edit
// to one constant can never ship a quote whose parts disagree with its total.
if (CREATOR_PAYOUT_MICRO + PLATFORM_FEE_MICRO !== SALE_PRICE_MICRO) {
  throw new Error("price split invariant broken: CREATOR_PAYOUT_MICRO + PLATFORM_FEE_MICRO must equal SALE_PRICE_MICRO");
}

export function parseUsdtToMicro(value: string): number {
  if (!USDT_DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`Not a plain USDT decimal string: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 1_000_000 + Number(`${frac}000000`.slice(0, 6));
}

export function formatMicroUsdt(micro: number): string {
  if (!Number.isInteger(micro) || micro < 0) throw new TypeError(`Invalid micro amount: ${micro}`);
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : String(whole);
}
