// Concurrency checks against a running arbiter (wrangler dev or a staging deploy).
//   node scripts/concurrency.mjs http://127.0.0.1:8787 [admin-token]
// Needs a fresh database: it asserts the audit chain is intact before and after.
// Each run uses random skus, so the anti-probing limits of earlier runs do not interfere.
// Exits 1 if any check fails, after running all of them.
const base = process.argv[2] || "http://127.0.0.1:8787";
const admin = process.argv[3] || process.env.ADMIN_TOKEN || "dev-admin-token";
const tag = Math.random().toString(36).slice(2, 8);
const failures = [];

const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
};
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures.push(name);
};
const tally = (rs) => rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

const before = await call("GET", "/v1/audit/verify");
check("chain intact before", before.data.ok === true, JSON.stringify(before.data));

// F2: rounds of 25 concurrent mandates, same buyer, a fresh sku per round, distinct terms.
// Cap is 3 per item per day. The race window is narrow, so one burst is not a reliable
// reproduction; every round must hold.
{
  const rounds = [];
  for (let r = 0; r < 8; r++) {
    const sku = `probe-${tag}-cap${r}`;
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => call("POST", "/v1/mandates", {
      body: { sku, quantity: i + 1, max_total_cents: 1_000_000, deliver_within_hours: 48 },
    })));
    rounds.push(tally(rs));
  }
  const worst = Math.max(...rounds.map((t) => t[201] || 0));
  const clean = rounds.every((t) => (t[201] || 0) + (t[429] || 0) === 25);
  check("F2 daily cap holds under concurrency", worst <= 3 && clean, `most 201s in a round: ${worst} (cap 3); rounds ${JSON.stringify(rounds)}`);
}

// F2b: 5 concurrent identical terms -> one 201, rest 409, never 500.
{
  const sku = `probe-${tag}-dup`;
  const rs = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/v1/mandates", {
    body: { sku, quantity: 1, max_total_cents: 1_000_000, deliver_within_hours: 48 },
  })));
  const t = tally(rs);
  check("F2 identical terms give one 201 and 409s", t[201] === 1 && t[409] === 4, `statuses ${JSON.stringify(t)}`);
}

// F3: 20 concurrent writes of mixed kinds (vendor registration, listing, mandates), then the chain.
{
  const reg = await call("POST", "/v1/vendors", { token: admin, body: { name: `Probe ${tag}` } });
  check("vendor registered", reg.status === 201, String(reg.status));
  const key = reg.data?.api_key;
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(call("POST", "/v1/mandates", { body: { sku: `probe-${tag}-chain-${i}`, quantity: 1, max_total_cents: 1_000_000, deliver_within_hours: 48 } }));
    jobs.push(call("PUT", "/v1/listings", { token: key, body: { sku: `probe-${tag}-l${i}`, title: "Probe item", unit: "item", ask_cents: 100_000, floor_cents: 50_000, delivery_hours: 1, stock: 5 } }));
  }
  const rs = await Promise.all(jobs);
  const t = tally(rs);
  check("F3 concurrent writes succeed", rs.every((r) => r.status < 300), `statuses ${JSON.stringify(t)}`);
  const after = await call("GET", "/v1/audit/verify");
  check("F3 audit chain intact after concurrent writes", after.data.ok === true, JSON.stringify(after.data));
}

// F4: two concurrent accepts of different offers on one mandate -> exactly one receipt.
{
  const reg = await call("POST", "/v1/vendors", { token: admin, body: { name: `Probe ${tag} B` } });
  const reg2 = await call("POST", "/v1/vendors", { token: admin, body: { name: `Probe ${tag} C` } });
  const sku = `probe-${tag}-acc`;
  for (const r of [reg, reg2]) {
    await call("PUT", "/v1/listings", { token: r.data.api_key, body: { sku, title: "Probe item", unit: "item", ask_cents: 100_000, floor_cents: 50_000, delivery_hours: 1, stock: 5 } });
  }
  const m = await call("POST", "/v1/mandates", { body: { sku, quantity: 1, max_total_cents: 100_000, deliver_within_hours: 48 } });
  const out = await call("POST", `/v1/mandates/${m.data.mandate_id}/resolve`, { token: m.data.buyer_token });
  const offers = out.data.offers || [];
  const rs = await Promise.all(offers.map((o) => call("POST", `/v1/offers/${o.offer_id}/accept`, { token: m.data.buyer_token })));
  const t = tally(rs);
  check("F4 concurrent accepts settle once", offers.length === 2 && t[200] === 1 && t[409] === 1, `offers ${offers.length}, statuses ${JSON.stringify(t)}`);
  const after = await call("GET", "/v1/audit/verify");
  check("F4 audit chain intact after accepts", after.data.ok === true, JSON.stringify(after.data));
}

// F4: overselling is refused by CHECK (stock >= 0) and reported as out_of_stock; nothing else changes.
{
  const reg = await call("POST", "/v1/vendors", { token: admin, body: { name: `Probe ${tag} D` } });
  const key = reg.data.api_key;
  const sku = `probe-${tag}-oos`;
  const listing = { sku, title: "Probe item", unit: "item", ask_cents: 100_000, floor_cents: 50_000, delivery_hours: 1, stock: 5 };
  await call("PUT", "/v1/listings", { token: key, body: listing });
  const m = await call("POST", "/v1/mandates", { body: { sku, quantity: 3, max_total_cents: 300_000, deliver_within_hours: 48 } });
  const out = await call("POST", `/v1/mandates/${m.data.mandate_id}/resolve`, { token: m.data.buyer_token });
  await call("PUT", "/v1/listings", { token: key, body: { ...listing, stock: 2 } }); // the offer is for 3
  const acc = await call("POST", `/v1/offers/${out.data.offers[0].offer_id}/accept`, { token: m.data.buyer_token });
  const after = await call("GET", `/v1/mandates/${m.data.mandate_id}`, { token: m.data.buyer_token });
  const stock = (await call("GET", "/v1/listings", { token: key })).data.listings.find((l) => l.sku === sku)?.stock;
  check("F4 oversell refused as out_of_stock", acc.status === 409 && acc.data?.error === "out_of_stock", `${acc.status} ${acc.data?.error}`);
  check("F4 after out_of_stock: mandate RESOLVED, offer VOID, stock unchanged, no receipt",
    after.data.state === "RESOLVED" && after.data.offers[0].state === "VOID" && stock === 2 && after.data.receipt_id === null,
    `state ${after.data.state}, offer ${after.data.offers[0]?.state}, stock ${stock}, receipt ${after.data.receipt_id}`);
}

// P0.10: 6 concurrent creates with one client-made secret (a client retrying a lost answer) ->
// one mandate; every answer names it; a later repeat is 200, not 201, 409 or 429.
{
  const sku = `probe-${tag}-idem`;
  const secret = `bt_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const body = { sku, quantity: 1, max_total_cents: 1_000_000, deliver_within_hours: 48, buyer_token_hash: hash };
  const rs = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/v1/mandates", { body })));
  const ids = new Set(rs.map((r) => r.data?.mandate_id));
  const t = tally(rs);
  check("P0.10 concurrent creates with one secret make one mandate", ids.size === 1 && t[201] === 1 && t[200] === 5, `ids ${ids.size}, statuses ${JSON.stringify(t)}`);
  const again = await call("POST", "/v1/mandates", { body });
  const read = await call("GET", `/v1/mandates/${[...ids][0]}`, { token: secret });
  check("P0.10 repeat is 200 with the same mandate; the secret works as the token", again.status === 200 && again.data.mandate_id === [...ids][0] && read.status === 200,
    `repeat ${again.status}, read ${read.status}`);
}

console.log(failures.length ? `CONCURRENCY FAILED: ${failures.join("; ")}` : "CONCURRENCY OK");
process.exit(failures.length ? 1 : 0);
