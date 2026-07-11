// Browser stand-in for node "crypto": the only importer in the bundle is the
// facilitator client's HMAC signer, which is server-side code the browser
// bundle never executes. Throw loudly if anything ever does call it.
export function createHmac(): never {
  throw new Error("node crypto is unavailable in the browser bundle");
}
export default { createHmac };
