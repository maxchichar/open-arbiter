# Otari feedback log

Every time Otari causes friction while building Open Arbiter and Oja, add an entry here: the date, what happened, and what would help. Newest entries go at the top. Keep each entry factual and say how we found out (a test, the docs, the runtime source).

## 2026-11-24: live Connect with Otari sign-in can't be tested locally

- **What happened:** In P1.0 we could test Connect with Otari only against a mock of otari.ai (Playwright routes, `browser_check.py` step 9). A real sign-in needs an otari.ai account and an https origin, because the site's origin is the OAuth client ID. It also creates a real key, which needs the owner's approval. So the real flow waits for a staging deploy (Phase 1 research §3 item 3).
- **What would help:** a sandbox or test mode for the OAuth app flow that accepts a loopback origin such as `http://127.0.0.1:<port>` and issues keys that can't spend credit. Or a documented mock contract (requests, responses, errors) that site builders can test against.

## 2026-11-24: Connect with Otari needs a second origin in a strict CSP

- **What happened:** Oja's page CSP allowed `https://api.otari.ai` and `https://eu.api.otari.ai` for model calls. Connect with Otari also `POST`s the code exchange to `https://otari.ai/api/v1/oauth/apps/token`, a different origin. With our CSP the visitor approves on otari.ai, comes back, and the exchange is blocked ("could not reach otari.ai"). We learned this from the runtime source (`otari-connect.js` `TOKEN_URL`) and a red browser test (`docs/rpi/phase-1/evidence/p1.0-red-browser-otari.txt`), not from Otari documentation.
- **What would help:** list every origin a site must allow in `connect-src` for Connect with Otari, or serve the token endpoint from the API origin sites already allow.
