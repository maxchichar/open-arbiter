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
