// Web Crypto helpers. Work unchanged in Cloudflare Workers, browsers and Node 20+.
import { canonicalJson } from "./mechanism.js";

const enc = new TextEncoder();
const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** An unguessable bearer token (256 bits). */
export function newToken(prefix) {
  return `${prefix}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** A short public id (96 bits). */
export function newId(prefix) {
  return `${prefix}_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateSigningKey() {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { privateJwk, publicJwk: publicFromPrivate(privateJwk) };
}

export function publicFromPrivate(jwk) {
  const { kty, crv, x, y } = jwk;
  return { kty, crv, x, y, alg: "ES256", use: "sig" };
}

/** Key id = first 16 hex chars of SHA-256 over the canonical public key. */
export async function keyId(publicJwk) {
  const { kty, crv, x, y } = publicJwk;
  return (await sha256Hex(canonicalJson({ crv, kty, x, y }))).slice(0, 16);
}

export async function signPayload(privateJwk, payload) {
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"] }, ALG, false, ["sign"]);
  const sig = await crypto.subtle.sign(SIGN, key, enc.encode(canonicalJson(payload)));
  return b64url(sig);
}

export async function verifyPayload(publicJwk, payload, signature) {
  const { kty, crv, x, y } = publicJwk;
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y, key_ops: ["verify"] }, ALG, false, ["verify"]);
  return crypto.subtle.verify(SIGN, key, fromB64url(signature), enc.encode(canonicalJson(payload)));
}
