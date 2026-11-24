// P0.6: F5 (the ?arbiter= override works only on a loopback page) and F6 (receipts verify against
// a key set pinned in the site, selected by kid; a hostile arbiter's own JWKS is never trusted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../../../arbiter/src/index.js";
import { memoryD1 } from "../../../arbiter/test/sqlite-d1.mjs";
import { generateSigningKey, keyId } from "../../../arbiter/src/crypto.js";
import { ArbiterClient } from "../js/arbiter-client.js";
import { Market } from "../js/market.js";
import * as config from "../js/config.js";

// ---------- F5 ----------
function withLocation(href, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: { href }, configurable: true });
  try { return fn(); } finally {
    if (saved) Object.defineProperty(globalThis, "location", saved); else delete globalThis.location;
  }
}

test("AC-F5-1: ?arbiter= is ignored on a non-loopback page", () => {
  for (const href of ["https://oja.example/?arbiter=https://evil.example", "https://oja.example/vendor.html?arbiter=http://127.0.0.1:8787",
    "http://localhost.evil.example/?arbiter=https://evil.example", "http://192.168.1.5:8080/?arbiter=https://evil.example"]) {
    assert.equal(withLocation(href, () => config.arbiterUrl()), config.DEFAULT_ARBITER_URL, href);
    assert.equal(config.arbiterUrl(href), config.DEFAULT_ARBITER_URL, href);
  }
});

test("AC-F5-1: ?arbiter= is honoured on loopback pages, http(s) only", () => {
  for (const host of ["localhost:8080", "127.0.0.1:8080", "[::1]:8080"]) {
    const href = `http://${host}/?arbiter=http://127.0.0.1:8787`;
    assert.equal(withLocation(href, () => config.arbiterUrl()), "http://127.0.0.1:8787", href);
    assert.equal(config.arbiterUrl(href), "http://127.0.0.1:8787", href);
  }
  assert.equal(config.arbiterUrl("http://localhost:8080/?arbiter=javascript:alert(1)"), config.DEFAULT_ARBITER_URL);
});

// ---------- F6 ----------
async function arbiterEnv(privateJwk) {
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", ...(privateJwk ? { ARBITER_SIGNING_JWK: JSON.stringify(privateJwk) } : { DEV: "1" }) };
  const calls = { jwks: 0 };
  const fetchImpl = (url, init = {}) => {
    if (new URL(url).pathname === "/.well-known/jwks.json") calls.jwks++;
    return worker.fetch(new Request(url, init), env);
  };
  const reg = await (await fetchImpl("https://x.test/v1/vendors", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name: "Iya Basira" }) })).json();
  await fetchImpl("https://x.test/v1/listings", { method: "PUT", headers: { authorization: `Bearer ${reg.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_200_000, floor_cents: 8_100_000, delivery_hours: 24, stock: 9 }) });
  return { env, calls, fetchImpl };
}
async function keyPair() {
  const { privateJwk, publicJwk } = await generateSigningKey();
  const kid = await keyId(publicJwk);
  return { privateJwk, pub: { kid, kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
}
async function buy(market) {
  await market.refreshCatalog();
  const neg = await market.negotiate({ sku: "rice-50kg", quantity: 1, max_total: 90_000, deliver_within_hours: 48 });
  assert.equal(neg.ok, true, JSON.stringify(neg));
  return market.acceptOffer({ offer_id: neg.offers[0].offer_id });
}

test("AC-F6-1: a receipt from a hostile arbiter (its own key, its own JWKS) is NOT verified", async () => {
  const honest = await keyPair(), hostile = await keyPair();
  const a = await arbiterEnv(hostile.privateJwk);
  const m = new Market(new ArbiterClient("https://arbiter.example", { fetchImpl: a.fetchImpl, pinnedKeys: [honest.pub] }));
  const acc = await buy(m);
  assert.equal(acc.ok, true);
  assert.equal(acc.signature_verified_in_browser, false, "a receipt signed by an unpinned key must not verify");
  assert.equal(a.calls.jwks, 0, "the arbiter's JWKS is never fetched when keys are pinned");
});

test("AC-F6-2: pinned key verifies with no JWKS fetch; selection by kid survives rotation", async () => {
  const old = await keyPair(), current = await keyPair();
  const a = await arbiterEnv(old.privateJwk); // receipts signed by the older key
  const client = new ArbiterClient("https://arbiter.example", { fetchImpl: a.fetchImpl, pinnedKeys: [current.pub, old.pub] });
  const acc = await buy(new Market(client));
  assert.equal(acc.signature_verified_in_browser, true);
  assert.equal(acc.verified_with, "pinned key");
  assert.equal(a.calls.jwks, 0);
});

test("AC-F6-2: a pinned key with another receipt's kid does not verify (no fallback to other keys)", async () => {
  const k = await keyPair(), other = await keyPair();
  const a = await arbiterEnv(k.privateJwk);
  const client = new ArbiterClient("https://arbiter.example", { fetchImpl: a.fetchImpl, pinnedKeys: [{ ...k.pub, kid: other.pub.kid }] });
  const acc = await buy(new Market(client));
  assert.equal(acc.signature_verified_in_browser, false);
});

test("AC-F6-2: no pinned key and a non-loopback arbiter → not verified, no JWKS fetch", async () => {
  const a = await arbiterEnv(null);
  const acc = await buy(new Market(new ArbiterClient("https://arbiter.example", { fetchImpl: a.fetchImpl })));
  assert.equal(acc.signature_verified_in_browser, false);
  assert.equal(a.calls.jwks, 0);
});

test("AC-F6-2: no pinned key and a loopback dev arbiter → JWKS used, labelled dev-jwks", async () => {
  const a = await arbiterEnv(null);
  const acc = await buy(new Market(new ArbiterClient("http://127.0.0.1:8787", { fetchImpl: a.fetchImpl })));
  assert.equal(acc.signature_verified_in_browser, true);
  assert.equal(acc.verified_with, "dev JWKS (unpinned)");
  assert.equal(a.calls.jwks, 1);
});

test("AC-F6-3: config.js ARBITER_KEYS equals the manifest's open_arbiter pin; a public arbiter needs a pinned key", () => {
  const manifest = JSON.parse(readFileSync(new URL("../agent-manifest.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(config.ARBITER_KEYS), "config.js exports ARBITER_KEYS");
  assert.deepEqual(manifest.open_arbiter, { url: config.DEFAULT_ARBITER_URL, keys: config.ARBITER_KEYS });
  for (const k of config.ARBITER_KEYS) {
    assert.deepEqual(Object.keys(k).sort(), ["crv", "kid", "kty", "x", "y"], "public fields only");
  }
  if (!config.isLoopback(config.DEFAULT_ARBITER_URL)) assert.ok(config.ARBITER_KEYS.length > 0, "a non-loopback arbiter must have a pinned key");
});

test("the tripwire itself: a public URL with no keys is refused", () => {
  assert.equal(config.isLoopback("http://localhost:8787"), true);
  assert.equal(config.isLoopback("http://127.0.0.1:8787"), true);
  assert.equal(config.isLoopback("https://open-arbiter.example.workers.dev"), false);
});
