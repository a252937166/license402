import { canonicalHash, secureHashEqual, SHA256_HEX_PATTERN } from "./canonical.js";

function assertLeaf(hash: string): void {
  if (!SHA256_HEX_PATTERN.test(hash)) {
    throw new TypeError(`Invalid SHA-256 leaf: ${hash}`);
  }
}

/**
 * Ordered binary Merkle tree. An odd node is duplicated, and an empty result
 * set has a domain-separated sentinel root.
 */
export function computeMerkleRoot(leaves: readonly string[]): string {
  leaves.forEach(assertLeaf);
  if (leaves.length === 0) return canonicalHash([], "PACT:EVIDENCE:EMPTY:v1");

  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(canonicalHash({ left, right }, "PACT:EVIDENCE:NODE:v1"));
    }
    level = next;
  }
  return level[0];
}

export function verifyMerkleRoot(leaves: readonly string[], expectedRoot: string): boolean {
  try {
    return secureHashEqual(computeMerkleRoot(leaves), expectedRoot);
  } catch {
    return false;
  }
}
