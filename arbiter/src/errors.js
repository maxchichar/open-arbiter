// Stable error codes (P1.5 AC-5.3). Every error the arbiter returns has one of these codes, and
// each code has exactly one HTTP status. Clients may branch on `error`; `message` is for people and
// may change. The README's "Error codes" table lists the same codes (a test keeps them in step).

export const ERRORS = Object.freeze({
  invalid: { status: 400, meaning: "The request's fields are missing, malformed or out of range; the message says which." },
  invalid_json: { status: 400, meaning: "The request body is not JSON." },
  unauthorized: { status: 401, meaning: "The admin token or vendor key is missing or wrong." },
  not_found: { status: 404, meaning: "No such route, mandate, offer or receipt, or the buyer token does not match." },
  unknown_tool: { status: 404, meaning: "An MCP tools/call named a tool this server does not have." },
  method_not_allowed: { status: 405, meaning: "The route exists but not for this HTTP method." },
  already_settled: { status: 409, meaning: "The mandate already has an accepted offer." },
  offer_closed: { status: 409, meaning: "The offer is no longer open; nothing changed." },
  out_of_stock: { status: 409, meaning: "The seller no longer has the stock for this offer; nothing changed." },
  identical_terms: { status: 409, meaning: "These exact terms were already negotiated by this caller; changing only the budget is not allowed." },
  token_reused: { status: 409, meaning: "This buyer secret already belongs to a negotiation with other terms or budget." },
  offer_expired: { status: 410, meaning: "The offer's 15 minutes have passed." },
  too_large: { status: 413, meaning: "The request body is over 64 KB." },
  rate_limited: { status: 429, meaning: "The caller reached the daily negotiation cap for this item (20 by default; GET / lists it). Load protection; identical terms are refused separately." },
  rate_limited_ip: { status: 429, meaning: "Too many requests from this address in the last minute (quota protection); retry after the retry-after header's seconds." },
  internal: { status: 500, meaning: "An unexpected error. Whether a write happened is unknown; the request_id identifies it in the logs." },
  misconfigured: { status: 500, meaning: "The deployment is missing its signing key or its database migrations; nothing was written." },
  busy: { status: 503, meaning: "The audit log is busy with concurrent writes; nothing was written. Retry shortly." },
  // GET /health only (P1.6). The body also carries every check, so one call shows what is wrong.
  db_unavailable: { status: 503, meaning: "/health: the database did not answer SELECT 1." },
  schema_outdated: { status: 503, meaning: "/health: the database has no migrations table; it was never migrated." },
  migrations_pending: { status: 503, meaning: "/health: a migration this Worker needs is not applied; it refuses writes until it is." },
  key_missing: { status: 503, meaning: "/health: no ARBITER_SIGNING_JWK secret, so the arbiter cannot sign receipts." },
  key_invalid: { status: 503, meaning: "/health: ARBITER_SIGNING_JWK is not a private P-256 JWK." },
  key_dev_in_deployed_env: { status: 503, meaning: "/health: DEV=1 is set in staging or production; it must never be deployed." },
});

export class ArbiterError extends Error {
  /**
   * @param code a key of ERRORS; its status is the response status
   * @param message for people; returned to the caller, never logged
   * @param opts.reason a fixed, value-free word for the log (e.g. "signing_key_missing")
   * @param opts.headers extra response headers (e.g. allow on 405)
   * @param opts.details extra, value-free fields for the response body (e.g. /health's checks)
   */
  constructor(code, message, { reason, headers, details } = {}) {
    if (!Object.hasOwn(ERRORS, code)) throw new Error(`unknown error code: ${code}`);
    super(message);
    this.code = code;
    this.status = ERRORS[code].status;
    this.reason = reason;
    this.headers = headers;
    this.details = details;
  }
}
