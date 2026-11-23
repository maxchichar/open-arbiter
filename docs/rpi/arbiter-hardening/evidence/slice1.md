# Slice 1: F7, fail closed without a signing key (evidence)

Date: 2026-11-23 · Branch: `arbiter-hardening` on top of `7a952a2` (uncommitted)

## Changes

| File | Change |
| --- | --- |
| `arbiter/src/core.js` | New `allowGeneratedKey` option, default `false`. Without `signingJwk`, `key()` logs and throws `ArbiterError("misconfigured", …, 500)` unless the option is set. In that case it neither reads nor writes `signing_keys`. `acceptOffer` calls `key()` before any read or write, so a misconfigured arbiter changes no state. |
| `arbiter/src/index.js` | `allowGeneratedKey: env.DEV === "1"`. Only the exact string `"1"` enables it. |
| `arbiter/test/signing.test.mjs` | New. 7 tests (below). |
| `arbiter/test/core.test.mjs`, `sites/oja/tests/market.test.mjs` | **Setup only:** opt the test arbiter into dev keys (`allowGeneratedKey: true` / `DEV: "1"`). No assertion changed. |
| `README.md`, `CLAUDE.md`, `arbiter/wrangler.toml` | `.dev.vars` needs `DEV=1` locally. Never set `DEV` in a deployment. A missing key returns 500 `misconfigured`. |

## Red: the new tests on the old code (`slice1-red.txt`)

`node --no-warnings --test arbiter/test/signing.test.mjs` exited 1 with **5 failing, 2 passing**:

- ✖ no signing key and DEV unset, `0`, `true`, `yes` (4 tests): `200 !== 500`. The old code generated a key, stored it in D1 and signed.
- ✖ core: `Arbiter` without a key or `allowGeneratedKey` refuses to sign. Expected a rejection; it resolved.
- ✔ DEV=1 keeps local behaviour, and ✔ a configured key works without DEV and is never stored. These are regression guards and pass on both old and new code.

## Green (`slice1-green.txt`)

- `npm test`: **28/28 pass**: 18 original, 3 adapter, 7 signing.
- The no-key tests also assert that mandates, stock, offers, receipts and `signing_keys` are **identical** before and after the attempted jwks, accept and verify calls.

## On workerd

- **DEV=1** (`npm run test:worker`, `slice1-test-worker.txt`): seed OK and `E2E OK`; receipt `rct_s9wW1-m0uggpuVv7` was signed by a generated dev key and verifies. Concurrency is still **red** for F2 (worst round 25 of a cap of 3) and F3 (`broken_at: 23`). That is expected until slices 2–3.
- **No DEV** (one-off wrangler dev with an env file holding only `ADMIN_TOKEN` and `BUYER_SALT`; `slice1-workerd-nodev.txt`):
  - `GET /.well-known/jwks.json` → 500 `misconfigured`
  - `POST /v1/receipts/verify` → 500 `misconfigured`
  - 0 rows in `signing_keys`
  - Worker log: `Open Arbiter: ARBITER_SIGNING_JWK is not set and DEV is not "1"; refusing to sign.`

  The server and its temp state were removed afterwards (checked with `pgrep`).

## Note for the developer's own machine

Your existing `arbiter/.dev.vars` has no `DEV` line, so a plain `wrangler dev` now refuses to sign until you add `DEV=1`. I did not edit that file.

## Added before commit (owner request): DEV never in wrangler.toml

`arbiter/test/config-guard.test.mjs` fails if `arbiter/wrangler.toml` assigns `DEV` anywhere: `[vars]`, `[env.*.vars]`, inline tables, quoted or dotted keys. Comments are ignored. A detector test proves it catches each form and does not match `DEVICE`, `NODEV` or `# DEV = …` (`slice1-guard.txt`).

- **Red:** a copy of `wrangler.toml` with `[vars]\nDEV = "1"` appended, checked via `ARBITER_WRANGLER_TOML=…`, fails with `DEV must come only from .dev.vars, found in wrangler.toml: 18: DEV = "1"`.
- **Green:** the real `arbiter/wrangler.toml` passes. Its comment mentions `DEV=1` and is correctly ignored.
- `npm test`: **30/30**.
