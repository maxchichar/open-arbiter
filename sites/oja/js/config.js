// Where the Open Arbiter runs, and the key its receipts must be signed with.
//
// Before publishing: set DEFAULT_ARBITER_URL to your deployed Worker, for example
// "https://open-arbiter.<you>.workers.dev", and pin its public key in ARBITER_KEYS
// (`node arbiter/scripts/pubkey.mjs < private.jwk` prints it). Copy both into
// agent-manifest.json's "open_arbiter" too; `npm test` fails until they match, and fails if a
// non-loopback arbiter has no pinned key.
export const DEFAULT_ARBITER_URL = "http://localhost:8787";

/**
 * Public keys (JWK with kid) the browser accepts receipt signatures from. A receipt is checked only
 * against the pinned key whose kid equals its key_id, never against keys the arbiter serves. Keep
 * retired keys here after a rotation, so older receipts still verify. Empty is allowed only while
 * the arbiter is on this machine (local development), where the arbiter's JWKS is used instead.
 */
export const ARBITER_KEYS = [];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for http(s) URLs on this machine. */
export function isLoopback(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The arbiter to use. A ?arbiter=<http(s) URL> in the page address is honoured only when the page
 * itself is served from this machine (local development), so a link to the published site cannot
 * point it at another arbiter.
 */
export function arbiterUrl(href = globalThis.location?.href) {
  try {
    if (href && isLoopback(href)) {
      const fromQuery = new URL(href).searchParams.get("arbiter");
      if (fromQuery && /^https?:\/\//.test(fromQuery)) return fromQuery;
    }
  } catch { /* not a URL */ }
  return DEFAULT_ARBITER_URL;
}
