# Runbook: deploy and migrations (DRAFT: P1.11 completes it)

Status: started 2026-11-27 with rules already decided. P1.11 adds the full step-by-step procedures (deploy, rollback, restore, key rotation, incident) and drills each one on staging (AC-11.4). Until then this file is incomplete: don't run a production step from it.

## Rules recorded so far

### R1. Key and token backup (owner, 2026-11-27; plan AC-11.6)
- The **production** signing key (`ARBITER_SIGNING_JWK`) and the **production** admin token go into the owner's password manager when they are created, **before** `wrangler secret put … --env production`. They must never exist only on one laptop.
- Check before setting the secret: the entry is in the password manager and readable. Who: the owner.
- Generate with `node arbiter/scripts/keygen.mjs --out <path outside the repo>` (it refuses a path in the repo or a terminal). Never paste a value into a terminal, an evidence file or a commit message.
- Staging material may live in `~/.config/open-arbiter/staging/` (directory 0700, files 0600).

### R2. Table rebuilds in a migration (ADR 0005 point 8; measured 2026-11-27)
A migration that rebuilds a table (create new, copy, drop, rename) **must** do all four of these, in this order:
1. `PRAGMA defer_foreign_keys = true;`
2. the rebuild;
3. the guard, which fails the migration (and rolls it back) if any reference is broken:
   ```sql
   CREATE TABLE _fk_check (orphans INTEGER NOT NULL CHECK (orphans = 0));
   INSERT INTO _fk_check (orphans) SELECT COUNT(*) FROM pragma_foreign_key_check;
   DROP TABLE _fk_check;
   ```
4. `PRAGMA defer_foreign_keys = false;`

**Why the guard is required:**
- On hosted D1, `wrangler d1 migrations apply --remote` **committed** a rebuild that orphaned rows when the guard was left out. It recorded the migration and left 2 orphaned offers (`docs/rpi/phase-1/evidence/p1.2-hosted-h4-unguarded-orphaning.txt`).
- Turning defer off discards outstanding violations, real ones included. Leaving it on makes the commit fail even when every reference holds again.

Template and tests: `arbiter/test/fixtures/rebuild-mandates.sql`, `arbiter/test/migrations.test.mjs` (AC-2.6), `npm run test:migrations-d1`.

### R3. Before any migration on a database with data (ADR 0005 points 5, 6, 9)
1. Take a Time Travel bookmark (`wrangler d1 time-travel info <db> --env <env>`) and record it.
2. Run `node arbiter/scripts/premigrate-check.mjs --d1 <db> --env <env> --remote`. It must exit 0.
3. `npm run test:m2` passes on the commit being deployed.
4. Migrate, then deploy (never the reverse).
5. Production: owner approval at this step, manual, never from CI.

## After a deploy

1. `curl -s https://<arbiter origin>/health` must answer **200** with `"ok": true`. Check that `version.git` is the commit you deployed, that `version.worker` is the new version id (`wrangler deployments list --env <env>`), that `key.kid` is the `kid` pinned in that environment's Oja (`sites/oja/environments.json`), and that `migrations.applied` is the latest file in `arbiter/migrations/`. A **503** names what is wrong in `error`:
   - `db_unavailable`: D1 is not answering `SELECT 1`. Check the D1 binding and the Cloudflare status page.
   - `schema_outdated`: the database was never migrated. Run the migrations (R3 above), then recheck.
   - `migrations_pending`: a migration this Worker needs is not applied, so writes are refused. Migrate (R3), then recheck. Never roll the Worker back instead (ADR 0005).
   - `key_missing`: `ARBITER_SIGNING_JWK` is not set: `wrangler secret put ARBITER_SIGNING_JWK --env <env>`.
   - `key_invalid`: the secret is not a private P-256 JWK. Put the right one (R1 backup).
   - `key_dev_in_deployed_env`: `DEV=1` is set in a deployed environment. Remove it at once (`wrangler secret delete DEV --env <env>`) and redeploy.
2. Oja's seller console (`/vendor`) shows the same check in its status line: "Arbiter healthy · signing key <kid> · database at <migration>".
3. Then the environment's smoke test (P1.4b).

`/health` makes at most 3 queries, reads no business table and is never cached by clients or the edge (`cache-control: no-store`). Each Worker instance reuses its checks for 10 s (`checked_at` says when they ran), so a burst costs at most 3 queries per instance per 10 s. A failure is held for those 10 s as well: after a fix, wait 10 s before rechecking.

## Logs

Workers Logs is on in both environments (`[env.X.observability]`, sampling 1), with Cloudflare's own invocation logs **off** (`invocation_logs = false`): the docs don't say whether they leave out headers such as `Authorization` or the caller IP. Every request writes one JSON object (`arbiter/src/log.js`):

```json
{"ts": "…", "level": "info|error", "request_id": "…", "env": "staging", "version": "3.0.0", "method": "POST", "route": "/v1/mandates/:id/resolve", "status": 404, "code": "not_found", "duration_ms": 12}
```

Optional fields: `mcp` (`[{method, tool, code}]`), `reason` on `misconfigured` (`signing_key_missing`, `migrations_missing`), and `error_class` plus `error_fingerprint` on `internal`. A line never holds a body, a header, a raw path, a query or an error message, so a floor, a maximum, a token, a key or an IP cannot appear in it (`arbiter/test/redaction.test.mjs`).

- Live: `npx wrangler tail --env staging --format json` or `npx wrangler tail --env production --format json`, run in `arbiter/`. Add `--status error` for failures only.
- Stored: Cloudflare dashboard, Workers & Pages → the Worker → Logs. Free plan: 200,000 log events per day, kept 3 days (Workers Logs docs, 2026-11-18; Cloudflare Observability pricing from 1 Dec 2026).
- From a user report: every response carries `x-request-id`, and every error body has `request_id`. Search the logs for it.
- An `internal` with the same `error_fingerprint` is the same failure path. The fingerprint is a hash of the stack's function names, not the message, so reproduce it locally to see the message.
