// P0.8: a strict Content-Security-Policy for Oja's pages, sent from _headers (Cloudflare Pages).
// Scripts run only from Oja's own origin: no inline script, no eval, no third-party script.
// Styles: Oja's stylesheets plus the runtime's one <style> block by hash; inline style attributes
// are allowed (the runtime, which we do not edit, renders some; they cannot run code).
// connect-src: Oja, the arbiter, the LLM providers the runtime's settings offer and the endpoints its
// key sign-ins fetch the key from (Connect with Otari, Connect with OpenRouter). Nothing else.
// The browser half (zero CSP violations in a real page) is browser_check.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PRESENTATION_CSS } from "../runtime/cruse-render.js";
import { API_KEY_PROVIDERS } from "../runtime/ui.js";
import { OtariConnect } from "../runtime/otari-connect.js";
import { OpenRouterConnect } from "../runtime/openrouter-connect.js";
import { DEFAULT_ARBITER_URL } from "../js/config.js";

const SITE = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, SITE), "utf8");

/** Parse a Netlify/Cloudflare Pages _headers file into { path: { header: value } }. */
export function parseHeaders(text) {
  const rules = {};
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = rules[line.trim()] = {}; continue; }
    const i = line.indexOf(":");
    current[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return rules;
}
export const directives = (csp) => Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/);
  return [name, values];
}));

/** The runtime's injected stylesheet (runtime/ui.js BASE_CSS), rebuilt from source and hashed. */
export function runtimeStyleHash() {
  const ui = read("runtime/ui.js");
  const m = ui.match(/const BASE_CSS = PRESENTATION_CSS \+ `([\s\S]*?)`;/);
  assert.ok(m, "BASE_CSS not found in runtime/ui.js: the runtime changed, recompute the CSP hash");
  assert.ok(!m[1].includes("${"), "BASE_CSS has interpolation: a static hash is impossible");
  const css = PRESENTATION_CSS + new Function(`return \`${m[1]}\`;`)();
  return `'sha256-${createHash("sha256").update(css, "utf8").digest("base64")}'`;
}

const PAGES = ["/", "/index.html", "/vendor", "/vendor.html"];
const rules = () => parseHeaders(read("_headers"));

test("every HTML page gets the same page CSP from _headers", () => {
  const r = rules();
  const policies = PAGES.map((p) => r[p]?.["content-security-policy"]);
  assert.ok(policies[0], "no Content-Security-Policy for / in _headers");
  for (const [i, p] of policies.entries()) assert.equal(p, policies[0], `${PAGES[i]} differs`);
});

test("the page CSP is strict for scripts and locked down elsewhere", () => {
  const d = directives(rules()["/"]["content-security-policy"]);
  assert.deepEqual(d["default-src"], ["'none'"]);
  assert.deepEqual(d["script-src"], ["'self'"], "scripts only from Oja's origin");
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'none'"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"], "the pages with Accept buttons cannot be framed");
  assert.deepEqual(d["frame-src"], ["'none'"], "no partner sites are linked (peer_policy closed)");
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.deepEqual(d["worker-src"], ["'self'"]);
  assert.deepEqual(d["style-src-elem"].sort(), ["'self'", runtimeStyleHash()].sort(), "stylesheets plus the runtime's <style> by hash");
  assert.deepEqual(d["style-src-attr"], ["'unsafe-inline'"]);
  for (const name of ["script-src", "style-src-elem", "connect-src"]) {
    for (const bad of ["'unsafe-eval'", "'unsafe-inline'", "*", "https:", "http:", "data:", "blob:"]) {
      assert.ok(!(d[name] || []).includes(bad), `${name} must not allow ${bad}`);
    }
  }
});

test("the page CSP turns on Trusted Types, allowing only the runtime's one policy (P1.3b)", () => {
  // The name the runtime creates, read from its source so a rename upstream fails here.
  let policyName;
  try { policyName = read("runtime/trusted-types.js").match(/createPolicy\("([^"]+)"/)?.[1]; } catch {}
  assert.ok(policyName, "runtime/trusted-types.js with a createPolicy call is missing");
  for (const path of PAGES) {
    const d = directives(rules()[path]["content-security-policy"]);
    assert.deepEqual(d["require-trusted-types-for"], ["'script'"], `${path}: require-trusted-types-for`);
    // No 'allow-duplicates', no 'none', no "default" policy: exactly the runtime's.
    assert.deepEqual(d["trusted-types"], [policyName], `${path}: trusted-types`);
  }
});

/** Where the runtime's key sign-ins (Connect with Otari, Connect with OpenRouter) fetch a key. */
export const RUNTIME_SIGN_IN_ORIGINS = [OtariConnect.TOKEN_URL, OpenRouterConnect.KEYS_URL].map((u) => new URL(u).origin);

test("connect-src allows exactly Oja, the arbiter, the runtime's LLM providers and its key sign-ins", () => {
  const d = directives(rules()["/"]["content-security-policy"]);
  const manifest = JSON.parse(read("agent-manifest.json"));
  const expected = new Set(["'self'", new URL(DEFAULT_ARBITER_URL).origin,
    ...API_KEY_PROVIDERS.map((p) => new URL(p.router).origin),
    ...RUNTIME_SIGN_IN_ORIGINS,
    ...[manifest.llm_router?.base_url, manifest.llm_router?.byok_router].filter(Boolean).map((u) => new URL(u).origin)]);
  assert.deepEqual(new Set(d["connect-src"]), expected);
});

test("the bridge keeps a script policy but can be framed (spec: callers load it in a hidden frame)", () => {
  const csp = rules()["/bridge/*"]?.["content-security-policy"];
  assert.ok(csp, "no CSP for /bridge/*");
  const d = directives(csp);
  assert.deepEqual(d["script-src"], ["'self'"]);
  assert.equal(d["frame-ancestors"], undefined);
});

test("the coded-tool worker keeps the skill's own CSP", () => {
  assert.equal(rules()["/runtime/sandbox-worker.js"]["content-security-policy"], "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'");
});

test("Oja's own HTML has no inline script, event handler or style attribute", () => {
  for (const f of ["index.html", "vendor.html", "bridge/action-bridge.html"]) {
    const html = read(f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f}: inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: inline event handler`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${f}: style attribute`);
  }
});
