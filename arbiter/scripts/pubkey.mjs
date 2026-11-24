// Print the public half of the arbiter's signing key, with its kid, for pinning in the site
// (sites/oja/js/config.js ARBITER_KEYS and agent-manifest.json "open_arbiter".keys).
//   node arbiter/scripts/pubkey.mjs < private.jwk
// Reads the private JWK on stdin; prints only public fields (kid, kty, crv, x, y).
import { publicFromPrivate, keyId } from "../src/crypto.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const priv = JSON.parse(input);
const pub = publicFromPrivate(priv);
const kid = await keyId(pub);
process.stdout.write(`${JSON.stringify({ kid, kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y })}\n`);
