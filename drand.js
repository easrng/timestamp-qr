/* global BigInt */
export const info = {
  public_key:
    "868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31",
  period: 30,
  genesis_time: 1595431050,
  hash: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
  groupHash: "176f93498eac9ca337150b46d21dd58673ea4e3581185f869672e59fa4cb390a",
};
export async function encodeDrand(res) {
  let drandRandPlusSignature = new Uint8Array(32 + 96);
  let rand = res.randomness.match(/../g).map((e) => parseInt(e, 16));
  if (rand.length != 32) throw new Error("");
  drandRandPlusSignature.set(rand, 0);
  let signature = res.signature.match(/../g).map((e) => parseInt(e, 16));
  if (signature.length != 96) throw new Error("");
  drandRandPlusSignature.set(signature, 32);
  return (
    res.round.toString(36) +
    ":" +
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", drandRandPlusSignature)
    )
      .slice(0, 33)
      .reduce((a, b) => BigInt(b) + (a << 8n), 0n)
      .toString(36)
  );
}
