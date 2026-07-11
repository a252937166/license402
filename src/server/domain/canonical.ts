import { createHash, timingSafeEqual } from "node:crypto";

export const SHA256_HEX_PATTERN = /^0x[0-9a-f]{64}$/;

function serializeCanonical(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "object":
      break;
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError("Canonical JSON does not support cyclic values");
  }
  seen.add(object);

  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.valueOf())) throw new TypeError("Invalid Date");
      return JSON.stringify(value.toISOString());
    }

    if (Array.isArray(value)) {
      return `[${value.map((entry) => serializeCanonical(entry, seen)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** Stable, key-sorted JSON used for every off-chain hash commitment. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new WeakSet());
}

export function sha256Hex(value: string | Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

/** sha256 over canonical JSON, with optional domain separation. */
export function canonicalHash(value: unknown, domain?: string): string {
  const payload = domain ? { domain, payload: value } : value;
  return sha256Hex(canonicalJson(payload));
}

export function secureHashEqual(left: string, right: string): boolean {
  if (!SHA256_HEX_PATTERN.test(left) || !SHA256_HEX_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left.slice(2), "hex"), Buffer.from(right.slice(2), "hex"));
}
