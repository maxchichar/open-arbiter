-- A database created and filled by v0.0's own code (arbiter/scripts/make-v0-fixture.mjs).
-- Schema: v0.0's arbiter/schema.sql, verbatim. Rows: dumped after the flows in that script.
-- Do not edit by hand; regenerate.

-- Open Arbiter schema (Cloudflare D1 / SQLite).
-- Floors and budgets are stored here and nowhere else; no API returns them.

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT,                 -- the vendor's agentic website, shown to buyers
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'item',
  currency TEXT NOT NULL DEFAULT 'NGN',
  ask_cents INTEGER NOT NULL,      -- public list price per unit
  floor_cents INTEGER NOT NULL,    -- SEALED: lowest acceptable price per unit
  delivery_hours INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vendor_id, sku),
  -- Overselling fails the whole accept batch (core.js maps it to out_of_stock). A constraint, not a
  -- trigger: no dependence on trigger behaviour in hosted D1, and it ports to PostgreSQL unchanged.
  CONSTRAINT stock_nonneg CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  buyer_key TEXT NOT NULL,         -- hashed caller identity used for anti-probing limits
  terms_key TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  max_total_cents INTEGER NOT NULL, -- SEALED: buyer's maximum
  deliver_within_hours INTEGER NOT NULL,
  vendor_ids TEXT,                  -- JSON array or NULL for all vendors
  caller_origin TEXT,
  state TEXT NOT NULL,              -- OPEN | RESOLVED | NO_AGREEMENT | SETTLED
  created_at INTEGER NOT NULL,
  UNIQUE (buyer_key, terms_key)
);
CREATE INDEX IF NOT EXISTS mandates_by_buyer ON mandates (buyer_key, sku, created_at);
-- A buyer's page may make its own secret and send only its hash. A retry with the same hash (the
-- answer to the first create was lost) must find the existing mandate, never make a second one.
CREATE UNIQUE INDEX IF NOT EXISTS mandates_token_unique ON mandates (token_hash);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  rank INTEGER NOT NULL,
  vendor_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  list_total_cents INTEGER NOT NULL,
  delivery_hours INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL               -- OPEN | ACCEPTED | VOID
);
CREATE INDEX IF NOT EXISTS offers_by_mandate ON offers (mandate_id, rank);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Append-only, hash-chained audit log. Payloads never hold floors or budgets.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One child per event: two writers extending the same head conflict here, and the loser retries
-- with the new head (core.js commit()), so the chain stays linear under concurrent writes.
CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events (prev_hash);

-- Used only when no ARBITER_SIGNING_JWK secret is configured (local dev).
CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO vendors (id, name, origin, key_hash, created_at) VALUES ('ven_v6l-Whr3apBFePhH', 'Iya Basira', 'https://basira.example', 'a5857f80d3a982999f3ec4574ae11dd45202d5957ec1791263cea45a915d0ba7', 1795000001);
INSERT INTO vendors (id, name, origin, key_hash, created_at) VALUES ('ven_BoIvA_Gwwko4hKQ-', 'Chika', NULL, 'b284ec7deb7804b7d966ee5d980385fcfdbcfbd61a91ab0a337563a37f27b17a', 1795000007);
INSERT INTO listings (vendor_id, sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at) VALUES ('ven_v6l-Whr3apBFePhH', 'rice-50kg', 'Rice, 50 kg bag', 'bag', 'NGN', 9000000, 8000000, 24, 3, 1795000003);
INSERT INTO listings (vendor_id, sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at) VALUES ('ven_v6l-Whr3apBFePhH', 'beans-25kg', 'Beans, 25 kg bag', 'bag', 'NGN', 4000000, 3500000, 24, 3, 1795000005);
INSERT INTO listings (vendor_id, sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at) VALUES ('ven_BoIvA_Gwwko4hKQ-', 'rice-50kg', 'Rice, 50 kg bag', 'bag', 'NGN', 9000000, 8200000, 24, 5, 1795000009);
INSERT INTO listings (vendor_id, sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at) VALUES ('ven_BoIvA_Gwwko4hKQ-', 'beans-25kg', 'Beans, 25 kg bag', 'bag', 'NGN', 4000000, 3500000, 24, 3, 1795000011);
INSERT INTO mandates (id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at) VALUES ('man_wRZbTw2FEl8F6dzd', 'd7526273ea14b9dd1b4c036143266faabbd33609a9c9f8603be51b7942492f5a', 'buyer-a', 'rice-50kg|2|48|*', 'rice-50kg', 2, 18000000, 48, NULL, 'https://oja.example', 'SETTLED', 1795000012);
INSERT INTO mandates (id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at) VALUES ('man_pwe2K5bxoIzwCtVO', 'ae03fa73fc326a5ddc0dc1e707b82311c0c60bf145e9d5ad26a3f63066c61447', 'buyer-b', 'beans-25kg|1|48|*', 'beans-25kg', 1, 4000000, 48, NULL, 'https://oja.example', 'RESOLVED', 1795000019);
INSERT INTO mandates (id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at) VALUES ('man_8NWsgg81FQZqljLd', 'fe6587470cf80f798c80df58b61412965c7be32403ef831092de6099c3691a3b', 'buyer-c', 'rice-50kg|1|48|*', 'rice-50kg', 1, 1000000, 48, NULL, 'https://oja.example', 'NO_AGREEMENT', 1795000024);
INSERT INTO mandates (id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at) VALUES ('man_k2stqxBcgCSYWN_p', '6cc747807fe29b510de22f59116767bf907738cdcc287a5587ec42bd5467d716', 'buyer-d', 'rice-50kg|1|48|*', 'rice-50kg', 1, 9000000, 48, NULL, 'https://oja.example', 'OPEN', 1795000029);
INSERT INTO offers (id, mandate_id, rank, vendor_id, sku, quantity, total_cents, list_total_cents, delivery_hours, expires_at, state) VALUES ('off_HDUMUrAqlNuC8Xdf', 'man_wRZbTw2FEl8F6dzd', 0, 'ven_v6l-Whr3apBFePhH', 'rice-50kg', 2, 16960000, 18000000, 24, 1795000914, 'ACCEPTED');
INSERT INTO offers (id, mandate_id, rank, vendor_id, sku, quantity, total_cents, list_total_cents, delivery_hours, expires_at, state) VALUES ('off_uJWfahk5KyWTPiur', 'man_wRZbTw2FEl8F6dzd', 1, 'ven_BoIvA_Gwwko4hKQ-', 'rice-50kg', 2, 17280000, 18000000, 24, 1795000914, 'VOID');
INSERT INTO offers (id, mandate_id, rank, vendor_id, sku, quantity, total_cents, list_total_cents, delivery_hours, expires_at, state) VALUES ('off_K4zJ_q8Ru6Ile7Tu', 'man_pwe2K5bxoIzwCtVO', 0, 'ven_BoIvA_Gwwko4hKQ-', 'beans-25kg', 1, 3760000, 4000000, 24, 1795000921, 'OPEN');
INSERT INTO offers (id, mandate_id, rank, vendor_id, sku, quantity, total_cents, list_total_cents, delivery_hours, expires_at, state) VALUES ('off_rz0pj_qKULGDIipQ', 'man_pwe2K5bxoIzwCtVO', 1, 'ven_v6l-Whr3apBFePhH', 'beans-25kg', 1, 3760000, 4000000, 24, 1795000921, 'OPEN');
INSERT INTO receipts (id, mandate_id, payload, signature, key_id, created_at) VALUES ('rct_lZjoiGQYgK1sy2xX', 'man_wRZbTw2FEl8F6dzd', '{"audit_hash":"371f35b368c1a2944f1848e6b5be50766eb7d412e9e380d3529cb0db42898db7","caller_origin":"https://oja.example","currency":"NGN","delivery_hours":24,"grid_step_cents":320000,"issued_at":1795000017,"item":{"quantity":2,"sku":"rice-50kg","title":"Rice, 50 kg bag","unit":"bag"},"list_total_cents":18000000,"mandate_id":"man_wRZbTw2FEl8F6dzd","mechanism":{"buyer_weight":"1/2","grid_bps":250,"grid_min_unit_cents":10000,"grid_rule":"pow2","name":"open-arbiter/nash-midpoint-grid","seller_weight":"1/2","tie":"buyer","version":"3.0.0"},"offer_id":"off_HDUMUrAqlNuC8Xdf","receipt_id":"rct_lZjoiGQYgK1sy2xX","settlement":"simulated","total_cents":16960000,"type":"open-arbiter/receipt","unit_step_cents":160000,"vendor":{"id":"ven_v6l-Whr3apBFePhH","name":"Iya Basira","origin":"https://basira.example"},"version":1}', '9GuaWjva7xWntI3x8FR8WzYGBrZvTnR11hcpF4vQ0G6jLRB51HI1S-Bhke3_pNhOV9mYM_hBTSonps0c9y2TaA', '2bff084973a71d48', 1795000017);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (1, NULL, 'VENDOR_REGISTERED', '{"name":"Iya Basira","origin":"https://basira.example","vendor_id":"ven_v6l-Whr3apBFePhH"}', 'genesis', 'e3860262823b6aaeb6b31cb2bd8d7f63d9cde481414f1fd32ced062741a34fb1', 1795000000);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (2, NULL, 'LISTING_SEALED', '{"sku":"rice-50kg","vendor_id":"ven_v6l-Whr3apBFePhH"}', 'e3860262823b6aaeb6b31cb2bd8d7f63d9cde481414f1fd32ced062741a34fb1', '117e67f2a369769760b4dabc5d163cde7f0585319999134947aec9b0f9b7dffe', 1795000002);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (3, NULL, 'LISTING_SEALED', '{"sku":"beans-25kg","vendor_id":"ven_v6l-Whr3apBFePhH"}', '117e67f2a369769760b4dabc5d163cde7f0585319999134947aec9b0f9b7dffe', '94cedc58820a4517ffcfff6550dd0de8338563afc7daced8e59e4fda6165c5fc', 1795000004);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (4, NULL, 'VENDOR_REGISTERED', '{"name":"Chika","origin":null,"vendor_id":"ven_BoIvA_Gwwko4hKQ-"}', '94cedc58820a4517ffcfff6550dd0de8338563afc7daced8e59e4fda6165c5fc', 'd63b1f921827c91c56fabb8b7c94a9f50930b1f3aa6bc9e9013e5b903af9e512', 1795000006);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (5, NULL, 'LISTING_SEALED', '{"sku":"rice-50kg","vendor_id":"ven_BoIvA_Gwwko4hKQ-"}', 'd63b1f921827c91c56fabb8b7c94a9f50930b1f3aa6bc9e9013e5b903af9e512', 'e43554e3bba8a237e6c75c406bf0819684ca553049a5a09395a0712666739799', 1795000008);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (6, NULL, 'LISTING_SEALED', '{"sku":"beans-25kg","vendor_id":"ven_BoIvA_Gwwko4hKQ-"}', 'e43554e3bba8a237e6c75c406bf0819684ca553049a5a09395a0712666739799', '1d558d2e26d36ff6c6f8a4d598b47989e85dd5c6b99f3b6de35f12296d16c3d5', 1795000010);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (7, 'man_wRZbTw2FEl8F6dzd', 'MANDATE_CREATED', '{"caller_origin":"https://oja.example","deliver_within_hours":48,"quantity":2,"sku":"rice-50kg"}', '1d558d2e26d36ff6c6f8a4d598b47989e85dd5c6b99f3b6de35f12296d16c3d5', 'a201feb90daaf85129672542b8d07ba6feaa6ee657abd0863ce43d5c2353953b', 1795000013);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (8, 'man_wRZbTw2FEl8F6dzd', 'BARGAINING_RESOLVED', '{"agreements":["ven_v6l-Whr3apBFePhH","ven_BoIvA_Gwwko4hKQ-"],"considered":2,"mechanism":{"buyer_weight":"1/2","grid_bps":250,"grid_min_unit_cents":10000,"grid_rule":"pow2","name":"open-arbiter/nash-midpoint-grid","seller_weight":"1/2","tie":"buyer","version":"3.0.0"}}', 'a201feb90daaf85129672542b8d07ba6feaa6ee657abd0863ce43d5c2353953b', 'ff3f16fc68f189a0d2716d0233826e5f1ea8a9ef39948f8c969781e4f910dc42', 1795000015);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (9, 'man_wRZbTw2FEl8F6dzd', 'OFFER_ACCEPTED', '{"offer_id":"off_HDUMUrAqlNuC8Xdf","total_cents":16960000,"vendor_id":"ven_v6l-Whr3apBFePhH"}', 'ff3f16fc68f189a0d2716d0233826e5f1ea8a9ef39948f8c969781e4f910dc42', '371f35b368c1a2944f1848e6b5be50766eb7d412e9e380d3529cb0db42898db7', 1795000018);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (10, 'man_wRZbTw2FEl8F6dzd', 'RECEIPT_ISSUED', '{"receipt_id":"rct_lZjoiGQYgK1sy2xX"}', '371f35b368c1a2944f1848e6b5be50766eb7d412e9e380d3529cb0db42898db7', '882fdea7f0f4e7d1adfe1620a2328fd38d1f15422fdb467e766df944f11654cf', 1795000018);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (11, 'man_pwe2K5bxoIzwCtVO', 'MANDATE_CREATED', '{"caller_origin":"https://oja.example","deliver_within_hours":48,"quantity":1,"sku":"beans-25kg"}', '882fdea7f0f4e7d1adfe1620a2328fd38d1f15422fdb467e766df944f11654cf', '5456a4bbc9a9fd6d664f5b22475ea2b3d2ec6edbf9560c6cea3d1aaa8c1d4f79', 1795000020);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (12, 'man_pwe2K5bxoIzwCtVO', 'BARGAINING_RESOLVED', '{"agreements":["ven_BoIvA_Gwwko4hKQ-","ven_v6l-Whr3apBFePhH"],"considered":2,"mechanism":{"buyer_weight":"1/2","grid_bps":250,"grid_min_unit_cents":10000,"grid_rule":"pow2","name":"open-arbiter/nash-midpoint-grid","seller_weight":"1/2","tie":"buyer","version":"3.0.0"}}', '5456a4bbc9a9fd6d664f5b22475ea2b3d2ec6edbf9560c6cea3d1aaa8c1d4f79', '3d73e808b643837ad92408a452f16eabd3cac08d9ef74ba5eba79e0da842e76c', 1795000022);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (13, 'man_8NWsgg81FQZqljLd', 'MANDATE_CREATED', '{"caller_origin":"https://oja.example","deliver_within_hours":48,"quantity":1,"sku":"rice-50kg"}', '3d73e808b643837ad92408a452f16eabd3cac08d9ef74ba5eba79e0da842e76c', '622f800ed2861424e8593126dc817e37ce26e03613cc3e121786646effa43f49', 1795000025);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (14, 'man_8NWsgg81FQZqljLd', 'NO_AGREEMENT', '{"agreements":[],"considered":2,"mechanism":{"buyer_weight":"1/2","grid_bps":250,"grid_min_unit_cents":10000,"grid_rule":"pow2","name":"open-arbiter/nash-midpoint-grid","seller_weight":"1/2","tie":"buyer","version":"3.0.0"}}', '622f800ed2861424e8593126dc817e37ce26e03613cc3e121786646effa43f49', 'dc99ccdb0784fceac4e8f9358613c7221e14dd0cabeb2e0458b0af4698ec9f6a', 1795000027);
INSERT INTO events (seq, mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (15, 'man_k2stqxBcgCSYWN_p', 'MANDATE_CREATED', '{"caller_origin":"https://oja.example","deliver_within_hours":48,"quantity":1,"sku":"rice-50kg"}', 'dc99ccdb0784fceac4e8f9358613c7221e14dd0cabeb2e0458b0af4698ec9f6a', '388485ccc7f390dab3311b9e5c5e51a12f82f92dbab263fe6f7e2dbca4547c3c', 1795000030);
