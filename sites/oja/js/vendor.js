// Seller console: seal list and lowest prices with the arbiter. Moved out of vendor.html so the
// page runs under a CSP with no inline script.
import { arbiterUrl } from "./config.js";
const base = arbiterUrl().replace(/\/+$/, "");
const $ = (s) => document.querySelector(s);
const ngn = (k) => `₦${(k / 100).toLocaleString("en-NG")}`;
$("#host").textContent = new URL(base).host;
let key = sessionStorage.getItem("oja-vendor-key") || "";
const api = (method, body) => fetch(`${base}/v1/listings`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, data: await r.json() }));
async function load() {
  const r = await api("GET");
  if (!r.ok) { $("#who").textContent = r.data.message; $("#who").className = "flash error"; return; }
  sessionStorage.setItem("oja-vendor-key", key);
  $("#who").textContent = `Signed in as ${r.data.vendor.name}.`;
  $("#who").className = "flash";
  $("#listing").hidden = false; $("#mine").hidden = false;
  $("#rows").replaceChildren(...r.data.listings.map((l) => {
    const tr = document.createElement("tr");
    for (const [v, cls] of [[`${l.title} (${l.sku})`, ""], [ngn(l.ask_cents), "num"], [ngn(l.floor_cents), "num"], [`${l.delivery_hours} h`, "num"], [l.stock, "num"]]) {
      const td = document.createElement("td"); td.textContent = v; td.className = cls; tr.append(td);
    }
    tr.addEventListener("click", () => {
      $("#sku").value = l.sku; $("#unit").value = l.unit; $("#title").value = l.title;
      $("#ask").value = l.ask_cents / 100; $("#floor").value = l.floor_cents / 100; $("#hours").value = l.delivery_hours; $("#stock").value = l.stock;
    });
    return tr;
  }));
}
$("#login").addEventListener("submit", (e) => { e.preventDefault(); key = $("#key").value.trim(); load(); });
$("#listing").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api("PUT", {
    sku: $("#sku").value.trim(), unit: $("#unit").value.trim(), title: $("#title").value.trim(), currency: "NGN",
    ask_cents: Math.round(Number($("#ask").value) * 100), floor_cents: Math.round(Number($("#floor").value) * 100),
    delivery_hours: Number($("#hours").value), stock: Number($("#stock").value),
  });
  $("#saved").textContent = r.ok ? `Sealed ${r.data.sku}.` : r.data.message;
  $("#saved").className = r.ok ? "flash" : "flash error";
  if (r.ok) load();
});
if (key) { $("#key").value = key; load(); }
