import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "./domain/index.js";
import { PROJECT_ROOT } from "./config.js";

/**
 * legalTextHash binds the ACTUAL bytes of the versioned legal text — so editing
 * the document changes the hash, and the hash carried in every offer, quote,
 * intent, and credential provably references this exact text. (An earlier
 * version hashed the filename string, which bound nothing.)
 */
export const LEGAL_TEXT_VERSION = "social-commercial-v1:v1";
export const LEGAL_TEXT_PATH = "legal/social-commercial-v1.md";

let cached: string | undefined;

export function legalTextHash(): string {
  if (!cached) cached = sha256Hex(readFileSync(resolve(PROJECT_ROOT, LEGAL_TEXT_PATH)));
  return cached;
}
