// Renders the Oja page and wires its own forms. The assistant uses the same App.page.
import { App, naira } from "./market.js";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
};
const dur = (h) => (h < 24 ? `${h} h` : `${Math.round(h / 24)} d`);

function renderCatalog(m) {
  const box = $("#catalog-body");
  box.replaceChildren();
  if (m.catalogError) {
    box.append(el("p", { class: "error" }, `Could not load the market: ${m.catalogError}`));
    return;
  }
  for (const item of m.items()) {
    const rows = m.catalog.filter((r) => r.sku === item.sku).sort((a, b) => a.list_price - b.list_price);
    box.append(el("article", { class: "item-card" },
      el("header", {},
        el("h3", {}, item.name.split(",")[0]),
        el("code", { class: "sku" }, item.sku)),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Seller"), el("th", { class: "num" }, "List price"), el("th", { class: "num" }, "Delivery"))),
        el("tbody", {}, rows.map((r) => el("tr", { class: r.in_stock ? "" : "muted" },
          el("td", {}, r.vendor_origin ? el("a", { href: r.vendor_origin }, r.vendor_name) : r.vendor_name),
          el("td", { class: "num" }, `${naira(r.list_price)} / ${r.unit}`),
          el("td", { class: "num" }, r.in_stock ? dur(r.delivery_hours) : "sold out"))))),
      el("button", { class: "ghost", type: "button", onclick: () => prefill(item.sku) }, "Haggle for this")));
  }
  const sel = $("#h-sku");
  const current = sel.value;
  sel.replaceChildren(...m.items().map((i) => el("option", { value: i.sku }, `${i.name.split(",")[0]} (${i.sku})`)));
  if (current) sel.value = current;
}

function prefill(sku) {
  $("#h-sku").value = sku;
  $("#haggle").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#h-qty").focus();
}

function renderNegotiations(m) {
  const list = $("#negotiations");
  list.replaceChildren();
  const state = m.getState();
  if (!state.negotiations.length) {
    list.append(el("p", { class: "muted" }, "No negotiations yet. Sellers never see your sealed maximum."));
    return;
  }
  for (const n of state.negotiations) {
    list.append(el("article", { class: `deal ${n.state.toLowerCase()}` },
      el("header", {},
        el("strong", {}, `${n.terms.quantity} × ${n.terms.sku}`),
        el("span", { class: `badge ${n.state.toLowerCase()}` }, n.state === "NO_AGREEMENT" ? "No agreement" : n.state === "SETTLED" ? "Settled" : "Offers ready")),
      n.agreement ? null : el("p", { class: "muted" }, n.message || ""),
      n.offers.length ? el("ol", { class: "offers" }, n.offers.map((o) => el("li", { class: o.state.toLowerCase() },
        el("div", {},
          el("strong", {}, o.seller), " · ", naira(o.total),
          el("span", { class: "save" }, ` save ${naira(o.saving)}`),
          el("div", { class: "muted small" }, `list ${naira(o.list_total)} · delivers within ${dur(o.delivery_hours)} · ${o.state === "OPEN" ? `open until ${new Date(o.expires_at).toLocaleTimeString()}` : o.state.toLowerCase()}`)),
        o.state === "OPEN" && n.state !== "SETTLED"
          ? el("button", { type: "button", onclick: () => manualAccept(o.offer_id) }, "Accept")
          : null))) : null));
  }
}

function renderReceipts(m) {
  const box = $("#receipts");
  box.replaceChildren();
  for (const r of m.getState().receipts) {
    box.append(el("article", { class: "receipt" },
      el("header", {}, el("strong", {}, r.seller), el("span", { class: `badge ${r.signature_verified_in_browser ? "settled" : "no_agreement"}`, title: `Checked in this browser with: ${r.verified_with}` },
        r.signature_verified_in_browser ? (r.verified_with === "pinned key" ? "Signature verified" : "Signature verified (dev key, not pinned)") : "Signature NOT verified")),
      el("p", {}, `${r.quantity} × ${r.item}: ${naira(r.total)} (list ${naira(r.list_total)})`),
      el("p", { class: "muted small" }, `Receipt ${r.receipt_id} · settlement ${r.settlement} · delivers within ${dur(r.delivery_hours)}`)));
  }
}

async function manualAccept(offerId) {
  const check = App.page.checkAccept({ offer_id: offerId });
  if (!check.ok) { flash(check.reason, true); return; }
  const dlg = $("#confirm");
  $("#confirm-details").replaceChildren(...Object.entries(check.details).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  dlg.returnValue = "";
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "confirm") return;
    try {
      const r = await App.page.acceptOffer({ offer_id: offerId });
      flash(r.ok ? `Deal settled with ${r.seller}. Receipt ${r.receipt_id}.` : r.reason, !r.ok);
    } catch (error) {
      // Outcome unknown (the arbiter's answer was lost). Never retried; the next refresh shows the truth.
      flash(error.message, true);
      App.page.refreshCatalog();
    }
  }, { once: true });
}

function flash(text, isError = false) {
  const f = $("#flash");
  f.textContent = text;
  f.className = isError ? "flash error" : "flash";
}

async function onHaggle(ev) {
  ev.preventDefault();
  const args = {
    sku: $("#h-sku").value,
    quantity: Number($("#h-qty").value),
    max_total: Number($("#h-max").value),
    deliver_within_hours: Number($("#h-hours").value),
  };
  const btn = ev.submitter;
  btn.disabled = true;
  const r = await App.page.negotiate(args);
  btn.disabled = false;
  flash(r.ok ? (r.agreement ? `${r.offers.length} offer(s) ready below.` : "No seller could meet those terms.") : r.reason, !r.ok);
}

async function onVerify(ev) {
  ev.preventDefault();
  const id = $("#v-id").value.trim();
  const r = await App.page.verifyReceipt({ receipt_id: id });
  $("#v-out").textContent = !r.ok ? r.reason
    : r.valid ? `Valid: signed by the arbiter. ${r.quantity} × ${r.item} from ${r.seller} for ${naira(r.total)}.`
    : "Invalid: this receipt does not match the arbiter's signature.";
}

export function start() {
  const m = App.page;
  m.onChange(() => { renderCatalog(m); renderNegotiations(m); renderReceipts(m); });
  $("#haggle-form").addEventListener("submit", onHaggle);
  $("#verify-form").addEventListener("submit", onVerify);
  $("#arbiter-host").textContent = new URL(m.client.baseUrl).host;
  $("#jwks-link").href = `${m.client.baseUrl}/.well-known/jwks.json`;
  $("#mcp-url").textContent = `${m.client.baseUrl}/mcp`;
  renderNegotiations(m);
  m.refreshCatalog();
  setInterval(() => renderNegotiations(m), 30_000); // offers expire
}

start();
