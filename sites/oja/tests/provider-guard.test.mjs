// P0.8 follow-up (owner, 2026-11-24): the strict connect-src blocks a custom Provider URL, and the
// settings panel must say so and name the providers that work. The DOM half is browser_check.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_KEY_PROVIDERS } from "../runtime/ui.js";
import { OtariConnect } from "../runtime/otari-connect.js";
import { OpenRouterConnect } from "../runtime/openrouter-connect.js";
import { DEFAULT_ARBITER_URL } from "../js/config.js";
import {
  ALLOWED_PROVIDER_NAMES, ALLOWED_PROVIDER_ORIGINS, SIGN_IN_ORIGINS, blockedProviderOrigin, blockedProviderMessage, isBlockedProviderCall,
} from "../js/provider-guard.js";

const PROD = "https://oja.example/";
const DEV = "http://127.0.0.1:8080/";

test("the guard's sign-in endpoints are the runtime's (Connect with Otari, Connect with OpenRouter)", () => {
  assert.deepEqual(SIGN_IN_ORIGINS, new Set([OtariConnect.TOKEN_URL, OpenRouterConnect.KEYS_URL].map((u) => new URL(u).origin)));
  assert.ok(SIGN_IN_ORIGINS.has("https://otari.ai"));
});

test("model routers plus sign-in endpoints are exactly the CSP's other origins", () => {
  // The / policy's connect-src (csp.test.mjs checks every page has the same policy).
  const headers = readFileSync(new URL("../_headers", import.meta.url), "utf8");
  const policy = headers.split("\n/\n")[1].split("\n")[0];
  const connect = new Set(policy.match(/connect-src ([^;]*)/)[1].trim().split(/\s+/));
  connect.delete("'self'");
  connect.delete(new URL(DEFAULT_ARBITER_URL).origin);
  assert.deepEqual(connect, new Set([...ALLOWED_PROVIDER_ORIGINS, ...SIGN_IN_ORIGINS]));
});

test("every runtime provider URL is allowed", () => {
  for (const p of API_KEY_PROVIDERS) assert.equal(blockedProviderOrigin(p.router, PROD), null, p.name);
  assert.equal(blockedProviderOrigin("https://api.openai.com/v1/", PROD), null);
});

test("a custom provider is blocked on the published site, with its origin named", () => {
  assert.equal(blockedProviderOrigin("https://llm.example.com/v1", PROD), "https://llm.example.com");
  assert.equal(blockedProviderOrigin("http://localhost:11434/v1", PROD), "http://localhost:11434", "a local model is blocked from the published page");
  assert.equal(blockedProviderOrigin("https://api.openai.com.evil.example/v1", PROD), "https://api.openai.com.evil.example");
  assert.equal(blockedProviderOrigin("http://api.openai.com/v1", PROD), "http://api.openai.com", "scheme matters");
});

test("empty, invalid and same-origin values are not reported; local models are fine on a dev page", () => {
  for (const v of ["", "   ", null, undefined, "not a url", "data:text/plain,x"]) assert.equal(blockedProviderOrigin(v, PROD), null, String(v));
  assert.equal(blockedProviderOrigin("https://oja.example/api/v1", PROD), null);
  assert.equal(blockedProviderOrigin("http://127.0.0.1:8799", DEV), null);
  assert.equal(blockedProviderOrigin("https://llm.example.com/v1", DEV), "https://llm.example.com");
});

test("the message names the blocked origin and every allowed provider", () => {
  const m = blockedProviderMessage("https://llm.example.com");
  assert.match(m, /blocks https:\/\/llm\.example\.com/);
  for (const name of ["Otari", "Google AI Studio", "Groq", "OpenRouter", "OpenAI", "Anthropic"]) {
    assert.ok(ALLOWED_PROVIDER_NAMES.includes(name), name);
    assert.ok(m.includes(name), `message names ${name}`);
  }
});

test("only connect-src blocks of a model URL count, not the arbiter or this page", () => {
  const ev = (blockedURI, effectiveDirective = "connect-src") => ({ blockedURI, effectiveDirective });
  assert.equal(isBlockedProviderCall(ev("https://llm.example.com/v1/chat/completions"), PROD), true);
  assert.equal(isBlockedProviderCall(ev(`${DEFAULT_ARBITER_URL}/v1/listings`), PROD), false);
  assert.equal(isBlockedProviderCall(ev("https://oja.example/x"), PROD), false);
  assert.equal(isBlockedProviderCall(ev("https://llm.example.com/v1", "style-src-elem"), PROD), false);
  assert.equal(isBlockedProviderCall(ev("inline"), PROD), false);
});

test("a key sign-in is never reported as a blocked AI provider", () => {
  const ev = (blockedURI) => ({ blockedURI, effectiveDirective: "connect-src" });
  assert.equal(isBlockedProviderCall(ev(OtariConnect.TOKEN_URL), PROD), false, "the Otari key exchange is not a model call");
  assert.equal(isBlockedProviderCall(ev(OpenRouterConnect.KEYS_URL), PROD), false);
  assert.equal(blockedProviderOrigin(OtariConnect.ISSUER, PROD), null, "otari.ai is allowed by the CSP");
  assert.ok(!ALLOWED_PROVIDER_ORIGINS.has("https://otari.ai"), "otari.ai is a sign-in endpoint, not a model router");
});
