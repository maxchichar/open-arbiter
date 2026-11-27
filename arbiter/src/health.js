// GET /health (P1.6): is this deployment able to do its job? Cheap and read-only: SELECT 1, the
// migrations list and, in local dev only, the dev key's id. At most 3 statements, no business table,
// no secret material (only the key's kid). 503 with a registry code when something is wrong; the
// body carries every check either way.
import { ArbiterError } from "./errors.js";
import { REQUIRED_MIGRATIONS } from "./core.js";
import { MECHANISM } from "./mechanism.js";
import { keyId, publicFromPrivate } from "./crypto.js";

export const DEPLOYED_ENVS = new Set(["staging", "production"]);

/** This Worker's versions: Cloudflare's version id and tag, the mechanism, and the deployed commit. */
export function versionOf(env) {
  const vm = env?.CF_VERSION_METADATA;
  return {
    worker: typeof vm?.id === "string" && vm.id ? vm.id : "local",
    tag: typeof vm?.tag === "string" && vm.tag ? vm.tag : null,
    mechanism: MECHANISM.version,
    git: typeof env?.GIT_SHA === "string" && /^[0-9a-f]{40}(-dirty)?$/.test(env.GIT_SHA) ? env.GIT_SHA : "unknown",
  };
}

/**
 * The configured private signing key, or null when none is set. Throws misconfigured when the
 * secret is set but is not a private P-256 JWK, so no route crashes on it as internal.
 */
export function signingJwkOf(env) {
  const raw = env?.ARBITER_SIGNING_JWK;
  if (raw === undefined || raw === null || raw === "") return null;
  let jwk;
  try { jwk = JSON.parse(raw); } catch { jwk = null; }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new ArbiterError("misconfigured", "Signing key not configured.", { reason: "signing_key_invalid" });
  }
  return jwk;
}

/** One literal ArbiterError per /health code (the registry test scans for literals). */
const FAILURES = {
  db_unavailable: (o) => new ArbiterError("db_unavailable", "The database is not answering.", o),
  schema_outdated: (o) => new ArbiterError("schema_outdated", "The database has never been migrated.", o),
  migrations_pending: (o) => new ArbiterError("migrations_pending", "A migration this arbiter needs has not been applied.", o),
  key_missing: (o) => new ArbiterError("key_missing", "No signing key is configured.", o),
  key_invalid: (o) => new ArbiterError("key_invalid", "The signing key secret is not a private P-256 JWK.", o),
  key_dev_in_deployed_env: (o) => new ArbiterError("key_dev_in_deployed_env", "DEV=1 is set in a deployed environment.", o),
};

export async function health(db, env) {
  const out = { version: versionOf(env), db: "unknown", key: { loaded: false, kid: null, source: null }, migrations: { latest: REQUIRED_MIGRATIONS.at(-1), applied: null }, schema: "unknown" };
  let failed = null;
  const fail = (code) => { failed ??= code; };

  try {
    await db.prepare("SELECT 1 AS ok").first();
    out.db = "ok";
  } catch {
    out.db = "unavailable";
    fail("db_unavailable");
  }

  if (out.db === "ok") {
    try {
      const names = (await db.prepare('SELECT name FROM "d1_migrations" ORDER BY name').all()).results.map((r) => r.name);
      out.migrations.applied = names.at(-1) ?? null;
      const missing = REQUIRED_MIGRATIONS.filter((n) => !names.includes(n));
      out.schema = missing.length ? "outdated" : "ok";
      if (missing.length) fail("migrations_pending");
    } catch {
      out.schema = "outdated";
      fail("schema_outdated");
    }
  }

  const deployed = DEPLOYED_ENVS.has(env?.ENVIRONMENT);
  if (deployed && env?.DEV === "1") {
    out.key.source = "dev";
    fail("key_dev_in_deployed_env");
  } else {
    let jwk = null;
    try {
      jwk = signingJwkOf(env);
    } catch {
      out.key.source = "secret";
      fail("key_invalid");
    }
    if (jwk) {
      out.key = { loaded: true, kid: await keyId(publicFromPrivate(jwk)), source: "secret" };
    } else if (out.key.source === null && env?.DEV === "1") {
      out.key.source = "dev"; // local only: generated on first signature
      if (out.db === "ok") {
        try {
          const row = await db.prepare("SELECT id FROM signing_keys ORDER BY created_at LIMIT 1").first();
          if (row) out.key = { loaded: true, kid: row.id, source: "dev" };
        } catch { /* reported by the schema check */ }
      }
    } else if (out.key.source === null) {
      fail("key_missing");
    }
  }

  if (failed) throw FAILURES[failed]({ details: { ok: false, ...out }, headers: { "cache-control": "no-store" } });
  return { ok: true, ...out };
}
