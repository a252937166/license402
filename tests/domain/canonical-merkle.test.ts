import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "../../src/server/domain/canonical.js";
import { computeMerkleRoot, verifyMerkleRoot } from "../../src/server/domain/merkle.js";

describe("canonical commitments", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 1, nested: { b: true, a: "x" }, list: [2, 1] };
    const right = { list: [2, 1], nested: { a: "x", b: true }, z: 1 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalHash(left)).toBe(canonicalHash(right));
    expect(canonicalHash({ ...right, list: [1, 2] })).not.toBe(canonicalHash(left));
  });
});

describe("evidence Merkle root", () => {
  it("is deterministic, ordered, and supports an odd leaf count", () => {
    const leaves = [canonicalHash("a"), canonicalHash("b"), canonicalHash("c")];
    const root = computeMerkleRoot(leaves);

    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeMerkleRoot(leaves)).toBe(root);
    expect(verifyMerkleRoot(leaves, root)).toBe(true);
    expect(computeMerkleRoot([...leaves].reverse())).not.toBe(root);
  });

  it("uses a stable sentinel for an empty result set", () => {
    const root = computeMerkleRoot([]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verifyMerkleRoot([], root)).toBe(true);
  });
});
