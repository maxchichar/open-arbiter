// P1.1 AC-1.1: two named environments, each with its own D1, KV, cron trigger and required secrets,
// and no DEV. The top level is local development only. Read through wrangler's own config reader,
// so inheritance (triggers, workers_dev) is resolved exactly as `wrangler deploy --env X` resolves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";

const ENVS = ["staging", "production"];
const SECRETS = ["ADMIN_TOKEN", "ARBITER_SIGNING_JWK", "BUYER_SALT"];
const BINDINGS = { d1: ["DB"], kv: ["AUDIT_ANCHOR"] };

// ARBITER_WRANGLER_TOML points the check at another file (used to record red evidence).
function configPath() {
  const src = process.env.ARBITER_WRANGLER_TOML || new URL("../wrangler.toml", import.meta.url).pathname;
  // wrangler resolves `main` relative to the config file, so read a copy placed next to src/.
  const dir = mkdtempSync(join(tmpdir(), "wrangler-env-"));
  const p = join(dir, "wrangler.toml");
  writeFileSync(p, readFileSync(src, "utf8").replace(/^main = "src\/index\.js"$/m, `main = "${new URL("../src/index.js", import.meta.url).pathname}"`));
  return p;
}
const read = (env) => unstable_readConfig({ config: configPath(), env }, { hideWarnings: true });

for (const env of ENVS) {
  test(`[env.${env}] is a separate Worker with its own D1, KV, cron, required secrets and no DEV`, () => {
    const c = read(env);
    assert.equal(c.name, `open-arbiter-${env}`);
    assert.deepEqual(c.d1_databases.map((d) => d.binding), BINDINGS.d1, "D1 bindings are not inherited: list them per environment");
    assert.deepEqual(c.kv_namespaces.map((k) => k.binding), BINDINGS.kv, "the audit anchor KV (P1.12) per environment");
    assert.ok(c.d1_databases[0].database_id, "a database_id");
    assert.ok(c.kv_namespaces[0].id, "a KV namespace id");
    assert.ok(c.triggers?.crons?.length >= 1, "a cron trigger for checkpoints (P1.12)");
    assert.deepEqual([...(c.secrets?.required ?? [])].sort(), SECRETS, "deploy fails while a secret is unset");
    assert.ok(!("DEV" in (c.vars ?? {})), "DEV never ships");
    assert.equal(c.workers_dev, true);
    assert.equal(c.preview_urls, false, "no per-version URLs reaching this environment's database");
  });
}

test("staging, production and the local top level never share a database, KV namespace or name", () => {
  const all = [read(undefined), ...ENVS.map(read)];
  for (const key of [(c) => c.d1_databases[0].database_id, (c) => c.d1_databases[0].database_name, (c) => c.kv_namespaces[0].id, (c) => c.name]) {
    const values = all.map(key);
    assert.equal(new Set(values).size, values.length, `shared: ${values.join(", ")}`);
  }
});

test("the top level is local only: placeholder ids, no workers.dev route, no secrets.required", () => {
  const c = read(undefined);
  assert.equal(c.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000000");
  assert.equal(c.kv_namespaces[0].id, "00000000000000000000000000000000");
  assert.equal(c.workers_dev, false);
  assert.deepEqual(c.triggers?.crons ?? [], [], "no cron on the local Worker");
  // In `wrangler dev`, secrets.required loads only the listed keys from .dev.vars, which would drop DEV=1.
  assert.equal(c.secrets, undefined);
  assert.deepEqual(c.d1_databases.map((d) => d.binding), BINDINGS.d1);
  assert.deepEqual(c.kv_namespaces.map((k) => k.binding), BINDINGS.kv, "local dev has the same bindings as the environments");
});

// P1.5 AC-5.6: Workers Logs on in both environments, every request sampled, and each Worker names
// its environment in its log lines. Workers Logs docs (2026-11-18) repeat [env.X.observability] per
// environment, so the file does too; this reads the resolved config either way.
for (const env of ENVS) {
  test(`[env.${env}] has Workers Logs on (sampling 1) and ENVIRONMENT = "${env}"`, () => {
    const c = read(env);
    assert.equal(c.observability?.enabled, true, "observability.enabled");
    assert.equal(c.observability?.head_sampling_rate ?? 1, 1, "every request logged");
    // Cloudflare's automatic invocation logs record "the Request, Response, and related metadata";
    // the docs do not say whether headers (Authorization: buyer, vendor and admin tokens) or the IP
    // are excluded, so they are off. Our own line (src/log.js) carries what operations need.
    assert.equal(c.observability?.logs?.invocation_logs, false, "invocation logs off");
    assert.equal(c.vars?.ENVIRONMENT, env, "vars are not inherited: set ENVIRONMENT per environment");
  });
}

test("the top level logs as ENVIRONMENT = \"local\"", () => {
  assert.equal(read(undefined).vars?.ENVIRONMENT, "local");
});

test("the runbook says how to read the logs", () => {
  const rb = readFileSync(new URL("../../docs/runbooks/deploy.md", import.meta.url), "utf8");
  const section = rb.split(/^## Logs$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, "docs/runbooks/deploy.md has no '## Logs' section");
  for (const env of ENVS) assert.ok(section.includes(`wrangler tail --env ${env} --format json`), env);
  assert.match(section, /request_id/);
});

// P1.6: /health and the log lines name the Worker version. The binding is not inherited by
// [env.X] (checked with wrangler 4.166.0's config reader), so each environment declares it.
for (const env of [undefined, ...ENVS]) {
  test(`${env ? `[env.${env}]` : "the top level"} binds version metadata as CF_VERSION_METADATA`, () => {
    assert.equal(read(env).version_metadata?.binding, "CF_VERSION_METADATA");
  });
}

// P1.7: the per-IP limit. Each environment binds IP_RATE_LIMIT in its own namespace, with the same
// limit as its IP_LIMIT_PER_60S var (the instance window), 100 per 60 s when deployed.
const namespaces = new Set();
for (const env of [undefined, ...ENVS]) {
  test(`${env ? `[env.${env}]` : "the top level"} binds IP_RATE_LIMIT, agreeing with IP_LIMIT_PER_60S`, () => {
    const c = read(env);
    const rl = (c.ratelimits || []).find((r) => r.name === "IP_RATE_LIMIT");
    assert.ok(rl, "IP_RATE_LIMIT is bound");
    assert.equal(rl.simple.period, 60);
    assert.equal(String(rl.simple.limit), c.vars.IP_LIMIT_PER_60S);
    if (env) assert.equal(rl.simple.limit, 100);
    assert.match(rl.namespace_id, /^[1-9]\d*$/);
    assert.ok(!namespaces.has(rl.namespace_id), "its own namespace");
    namespaces.add(rl.namespace_id);
  });
}

// Owner, 2026-11-27: the daily negotiation cap is an environment setting, 20 everywhere.
for (const env of [undefined, ...ENVS]) {
  test(`${env ? `[env.${env}]` : "the top level"} sets MANDATES_PER_ITEM_PER_DAY = "20"`, () => {
    assert.equal(read(env).vars.MANDATES_PER_ITEM_PER_DAY, "20");
  });
}
