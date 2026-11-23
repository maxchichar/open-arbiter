// Print a new private ECDSA P-256 JWK for receipts. Store it as a secret:
//   node arbiter/scripts/keygen.mjs | npx wrangler secret put ARBITER_SIGNING_JWK
import { generateSigningKey } from "../src/crypto.js";
const { privateJwk } = await generateSigningKey();
process.stdout.write(JSON.stringify(privateJwk));
