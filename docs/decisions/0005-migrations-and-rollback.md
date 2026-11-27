# ADR 0005: Numbered D1 migrations, compatible with the previous Worker

- **Status:** accepted, 2026-11-27 (owner decision 4, 2026-11-24; P1.2)
- **Tasks:** P1.2 (migrations, R6), P1.3 (CI runs the checks), P1.9 (rollback drill), P1.10 (restore drill), P1.11 (runbook)
- **Code:** `arbiter/migrations/` (`0000_baseline.sql`, `0001_settle_attempt.sql`, `lock.json`); `arbiter/src/core.js` `REQUIRED_MIGRATIONS`, `ensureSchema`, `acceptOffer`; `arbiter/scripts/{m2-check,premigrate-check,migrations-d1-check,make-v0-fixture}.mjs`; `arbiter/test/migrate.mjs`
- **Tests:** `arbiter/test/{migrations,schema-guard,premigrate-check,accept}.test.mjs`; `npm run test:m2`; `npm run test:migrations-d1`
- **Evidence:** `docs/rpi/phase-1/evidence/p1.2-*`

## Context

Until P1.2 the schema was one `CREATE … IF NOT EXISTS` script (`arbiter/schema.sql`), applied with `wrangler d1 execute --file`. A deployed database needs schema changes over time without losing data. Cloudflare's tooling and platform set these facts (research §2.2–2.4, and the wrangler 4.166.0 source):

- `wrangler d1 migrations apply` runs `migrations/*.sql` in name order and records each in `d1_migrations(id, name UNIQUE, applied_at)`. It sends each file plus its `INSERT` as one query, and D1 runs every query in an implicit transaction: "If applying a migration results in an error, this migration will be rolled back". **There are no down migrations.**
- **A Worker rollback does not touch D1:** "State changes for associated storage resources such as KV, R2, Durable Objects, and D1 are not tracked with versions." After a rollback, the previous Worker runs on the newer schema.
- During a gradual deployment two Worker versions serve at once, and each request is routed independently.
- Time Travel restores "any minute within the last 7 days on the Workers Free plan". The restore "overwrites the database in place", cancels in-flight queries and returns a bookmark that undoes it. It cannot restore into a new database.

## Decision

1. **Numbered migrations.** `arbiter/migrations/NNNN_name.sql`, starting at `0000_baseline.sql`, which is v0.0's `schema.sql` verbatim apart from its header and a baseline check. `schema.sql` is gone; local dev, tests, the harness and deployments all apply the migrations.
2. **Applied migrations never change.** `migrations/lock.json` pins every file's SHA-256, and a test fails if a file changes or appears without its hash. To change the schema, add a new number.
3. **The baseline also adopts a v0.0 database.** Every statement in `0000` is `IF NOT EXISTS`, so on a database made from v0.0's `schema.sql` it only records the level. `IF NOT EXISTS` would also accept an older `listings` table without `CHECK stock_nonneg`, so `0000` ends with a check that fails (and rolls back) on such a table. The two `UNIQUE` indexes are built if missing, which fails on a forked chain or duplicated token hashes. Tested on node:sqlite and local D1.
4. **The schema guard checks the migration level, not `sqlite_master`.** `ensureSchema` refuses writes (500 `misconfigured`) until every name in `REQUIRED_MIGRATIONS` is in `d1_migrations`. A missing `d1_migrations` table counts as level zero. Names newer than the Worker knows are allowed: by M2 they are compatible. `REQUIRED_MIGRATIONS` is always every migration in the Worker's tree (a test checks it). This works because the constraints come only from migrations (point 2), and the migration tests check that the migrations create them. The check is still cached per database per Worker instance.
5. **M1: production migrations are manual.** The owner approves each one and runs it from the runbook (P1.11): Time Travel bookmark, `premigrate-check.mjs --d1 … --env production --remote`, then `migrations apply --env production --remote`, then deploy. CI never applies production migrations (P1.3, AC-3.4).
6. **M2: every migration is compatible with the previous Worker version.** Expand, then contract: add first, deploy the Worker that uses it, and remove only after no deployed or rollback-reachable version reads it. Order: migrate, then deploy. A rollback leaves the schema at N, so version N−1 must run on it. **`npm run test:m2`** (`m2-check.mjs`) runs each release tag's own arbiter tests on a database migrated to HEAD. Two negative fixtures prove that it catches breaks: dropping `listings.title` (v0.0 reads it) and adding a column to `vendors` (v0.0 inserts positionally). HEAD now names the columns in every `INSERT`, so a later added column cannot break it (a `[tree]` test enforces this).
7. **M3: mechanism changes never ship as split traffic.** A `MECHANISM.version` change ships only with `wrangler deploy` (100%), never `versions deploy` at a percentage. CI guard in P1.3 (AC-3.5).
8. **Table rebuilds:** `PRAGMA defer_foreign_keys = true`, then rebuild, then fail the migration if `pragma_foreign_key_check` returns any row, then `PRAGMA defer_foreign_keys = false`. Measured (fixture `arbiter/test/fixtures/rebuild-mandates.sql`, node:sqlite and local D1):
   - Without deferring, dropping a parent table fails at once.
   - With defer on and nothing else, the commit fails even when every reference holds again: the drop's implicit delete stays counted.
   - Turning defer off, the pattern in the D1 docs, makes the commit go through but **discards real violations too**. Without the check, orphaned offers committed silently. Hence the explicit check.
9. **R6 (legacy SETTLED without a receipt).** `0001_settle_attempt` adds the nullable `mandates.settle_attempt`. The accept's first statement writes its own receipt id there, and its later statements require it. A mandate left SETTLED without a receipt by the pre-Phase-0 accept can then never take stock or get a receipt, even if it turns SETTLED between the accept's read and its batch (tested). `premigrate-check.mjs` reports such rows before a migration: SETTLED without a receipt, ACCEPTED offers without one, receipts whose `audit_hash` names no event, missing constraints. It exits 1 if it finds any.

## Consequences

- A rollback (P1.9) is safe only because of M2. It does not undo a migration. A bad migration is undone by a new migration (contract or fix), or by a Time Travel restore.
- **A restore is the expensive path.** It overwrites the whole database in place, including every accept and receipt after the restore point. Receipts issued after that point keep valid signatures but name audit events that no longer exist. The P1.12 KV anchor detects the rewind, and the restore runbook (P1.10, P1.11) lists those receipts. It is limited to the last 7 days on Free and cannot be tried on a copy first: the drill runs on staging.
- The M2 check needs the release tags, so CI checks out with `fetch-depth: 0` (P1.3). A release with `migrations/` gets HEAD's migrations in place of its own, and its `[tree]` tests are skipped there, because they check that tree's own files, not compatibility.
- Tested locally on node:sqlite and on wrangler's local D1. **Not yet shown on hosted D1:** that a remote apply rolls back a failed migration, that `pragma_foreign_key_check` and the `sqlite_master` read in the baseline check work there, and how long a migration locks the database. These go to P1.8 on staging.
- `wrangler d1 migrations apply` "captures a backup" after applying. Where that backup lives is not documented on the pages read, so the runbook relies on a Time Travel bookmark taken before.

## Alternatives considered

- **Keep `schema.sql` and introspect constraints** (the Phase 0 guard). It doesn't scale to column and data changes, has no record of what ran, and each regex on `sqlite_master` text has to survive table rebuilds.
- **Down migrations.** D1 has none, and with point-in-time restore available they add little. A forward fix or a restore covers it.
- **Triggers or application code to enforce invariants.** Rejected in ADR 0002. Guarantees stay in constraints that the migrations create.
