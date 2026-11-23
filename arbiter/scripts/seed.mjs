// Seed demo vendors and sealed listings.
//   node scripts/seed.mjs http://localhost:8787 <ADMIN_TOKEN> [vendor-origin-base]
// Prices are illustrative demo figures, not market data.
// Writes vendor API keys to .seed-keys.json (keep it out of git).
import { writeFileSync } from "node:fs";

const [base = "http://localhost:8787", admin = "dev-admin-token", siteBase = "http://localhost:8080"] = process.argv.slice(2);
const N = (naira) => naira * 100; // kobo

const vendors = [
  {
    slug: "iya-basira", name: "Iya Basira Foodstuff", listings: [
      { sku: "rice-50kg", title: "Local parboiled rice, 50 kg bag", unit: "bag", ask: 92000, floor: 81000, delivery_hours: 24, stock: 40 },
      { sku: "beans-oloyin-50kg", title: "Oloyin honey beans, 50 kg bag", unit: "bag", ask: 118000, floor: 104000, delivery_hours: 24, stock: 15 },
      { sku: "garri-ijebu-50kg", title: "Ijebu garri, 50 kg bag", unit: "bag", ask: 54000, floor: 47000, delivery_hours: 24, stock: 25 },
    ],
  },
  {
    slug: "chika-provisions", name: "Chika Provisions", listings: [
      { sku: "rice-50kg", title: "Ofada rice, 50 kg bag", unit: "bag", ask: 89000, floor: 84000, delivery_hours: 6, stock: 8 },
      { sku: "palm-oil-25l", title: "Red palm oil, 25 L keg", unit: "keg", ask: 61000, floor: 55000, delivery_hours: 6, stock: 12 },
    ],
  },
  {
    slug: "alhaji-musa-grains", name: "Alhaji Musa Grains", listings: [
      { sku: "rice-50kg", title: "Kano long-grain rice, 50 kg bag", unit: "bag", ask: 95000, floor: 78000, delivery_hours: 72, stock: 120 },
      { sku: "beans-oloyin-50kg", title: "Oloyin beans, 50 kg bag", unit: "bag", ask: 112000, floor: 101000, delivery_hours: 72, stock: 60 },
      { sku: "garri-ijebu-50kg", title: "White garri, 50 kg bag", unit: "bag", ask: 50000, floor: 45500, delivery_hours: 48, stock: 80 },
    ],
  },
];

const keys = {};
for (const v of vendors) {
  const r = await fetch(`${base}/v1/vendors`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ name: v.name, origin: `${siteBase}/${v.slug}/` }),
  });
  const reg = await r.json();
  if (!r.ok) throw new Error(`register ${v.name}: ${JSON.stringify(reg)}`);
  keys[v.slug] = reg;
  for (const l of v.listings) {
    const put = await fetch(`${base}/v1/listings`, {
      method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${reg.api_key}` },
      body: JSON.stringify({ sku: l.sku, title: l.title, unit: l.unit, currency: "NGN", ask_cents: N(l.ask), floor_cents: N(l.floor), delivery_hours: l.delivery_hours, stock: l.stock }),
    });
    if (!put.ok) throw new Error(`listing ${l.sku}: ${await put.text()}`);
  }
  console.log(`${v.name}: ${reg.vendor_id} (${v.listings.length} sealed listings)`);
}
writeFileSync(new URL("../.seed-keys.json", import.meta.url), JSON.stringify(keys, null, 2));
console.log("Vendor keys written to .seed-keys.json");
