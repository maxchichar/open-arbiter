// pubkey.mjs prints the key to pin: public fields only, with the kid receipts carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateSigningKey, keyId, signPayload } from "../src/crypto.js";
import { Arbiter } from "../src/core.js";
import { memoryD1 } from "./sqlite-d1.mjs";

test("pubkey.mjs prints only the public key, with the kid the arbiter signs under", async () => {
  const { privateJwk, publicJwk } = await generateSigningKey();
  const out = execFileSync(process.execPath, [new URL("../scripts/pubkey.mjs", import.meta.url).pathname], { input: JSON.stringify(privateJwk) }).toString();
  const pub = JSON.parse(out);
  assert.deepEqual(Object.keys(pub).sort(), ["crv", "kid", "kty", "x", "y"]);
  assert.ok(!out.includes(privateJwk.d), "the private scalar is never printed");
  assert.equal(pub.kid, await keyId(publicJwk));
  const arb = new Arbiter(memoryD1(), { signingJwk: privateJwk });
  assert.equal((await arb.key()).kid, pub.kid);
  assert.ok(await signPayload(privateJwk, { a: 1 }));
});
