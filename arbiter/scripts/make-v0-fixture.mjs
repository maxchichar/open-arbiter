// Make arbiter/test/fixtures/v0.0-seeded.{sql,json}: a database created and filled by the v0.0
// release's own code (git tag v0.0), so migration tests can start from data the previous version
// really wrote. Run once when the fixture must change:
//   node arbiter/scripts/make-v0-fixture.mjs [ref=v0.0]
// The signing key is made here and only its public half is saved; no private key is in the fixture.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ref = process.argv[2] || "v0.0";
const OUT = join(REPO, "arbiter", "test", "fixtures");

const tmp = mkdtempSync(join(tmpdir(), `arbiter-${ref}-`));
execFileSync("sh", ["-c", `git -C "$1" archive "$2" arbiter package.json | tar -x -C "$3"`, "sh", REPO, ref, tmp]);
symlinkSync(join(REPO, "node_modules"), join(tmp, "node_modules"));
const old = (p) => import(pathToFileURL(join(tmp, p)).href);
const { Arbiter } = await old("arbiter/src/core.js");
const { memoryD1, SCHEMA_SQL } = await old("arbiter/test/sqlite-d1.mjs");
const { generateSigningKey, keyId } = await old("arbiter/src/crypto.js");

const T0 = 1_795_000_000; // 2026-11-18T09:46:40Z; the fixture's clock, one second per step
let now = T0;
const clock = () => now++;
const { privateJwk, publicJwk } = await generateSigningKey();
const db = memoryD1();
const arb = new Arbiter(db, { clock, signingJwk: privateJwk, random: () => 0.5 });

const listing = (sku, title, ask, floor, stock) => ({ sku, title, unit: "bag", ask_cents: ask, floor_cents: floor, delivery_hours: 24, stock });
const vendors = [];
for (const [name, origin] of [["Iya Basira", "https://basira.example"], ["Chika", null]]) {
  const v = await arb.createVendor({ name, ...(origin ? { origin } : {}) });
  const vendor = await arb.vendorByKey(v.api_key);
  await arb.upsertListing(vendor, listing("rice-50kg", "Rice, 50 kg bag", 9_000_000, 8_000_000 + vendors.length * 200_000, 5));
  await arb.upsertListing(vendor, listing("beans-25kg", "Beans, 25 kg bag", 4_000_000, 3_500_000, 3));
  vendors.push(vendor);
}
const buyer = (b) => ({ buyerKey: `buyer-${b}`, callerOrigin: "https://oja.example" });
const mandate = (input, b) => arb.createMandate({ deliver_within_hours: 48, ...input }, buyer(b));

// SETTLED with a receipt
const settled = await mandate({ sku: "rice-50kg", quantity: 2, max_total_cents: 18_000_000 }, "a");
const settledOut = await arb.resolveMandate(settled.mandate_id, settled.buyer_token);
const accepted = await arb.acceptOffer(settledOut.offers[0].offer_id, settled.buyer_token);
// RESOLVED with open offers (accept it after migrating, before the clock passes expires_at)
const open = await mandate({ sku: "beans-25kg", quantity: 1, max_total_cents: 4_000_000 }, "b");
const openOut = await arb.resolveMandate(open.mandate_id, open.buyer_token);
// NO_AGREEMENT
const none = await mandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 1_000_000 }, "c");
await arb.resolveMandate(none.mandate_id, none.buyer_token);
// OPEN, client-made secret (only its hash is stored)
const secret = "fixture-client-secret";
const hash = execFileSync(process.execPath, ["-e", `process.stdout.write(require("crypto").createHash("sha256").update(${JSON.stringify(secret)}).digest("hex"))`]).toString();
const pending = await mandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, buyer_token_hash: hash }, "d");

const chain = await arb.verifyChain();
if (!chain.ok) throw new Error(`v0.0 chain not ok: ${JSON.stringify(chain)}`);

// Dump: the v0.0 schema file, then every row as an INSERT in seq/rowid order.
const raw = db.raw;
const lit = (v) => (v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map((r) => r.name);
const inserts = [];
for (const t of tables) {
  for (const row of raw.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) {
    const cols = Object.keys(row);
    inserts.push(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
  }
}
const counts = Object.fromEntries(tables.map((t) => [t, raw.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "v0.0-seeded.sql"), `-- A database created and filled by ${ref}'s own code (arbiter/scripts/make-v0-fixture.mjs).
-- Schema: ${ref}'s arbiter/schema.sql, verbatim. Rows: dumped after the flows in that script.
-- Do not edit by hand; regenerate.

${SCHEMA_SQL.trim()}

${inserts.join("\n")}
`);
writeFileSync(join(OUT, "v0.0-seeded.json"), `${JSON.stringify({
  ref,
  clock_start: T0,
  clock_end: now,
  public_key: { kid: await keyId(publicJwk), kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
  counts,
  chain_head: chain.head,
  settled: { mandate_id: settled.mandate_id, receipt_id: accepted.receipt.receipt_id },
  open: { mandate_id: open.mandate_id, buyer_token: open.buyer_token, offer_ids: openOut.offers.map((o) => o.offer_id), expires_at: Math.min(...openOut.offers.map((o) => o.expires_at)) },
  no_agreement: { mandate_id: none.mandate_id },
  pending: { mandate_id: pending.mandate_id, buyer_secret: secret },
}, null, 2)}\n`);
rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`wrote ${join(OUT, "v0.0-seeded.sql")} (${inserts.length} rows) and v0.0-seeded.json\n`);
