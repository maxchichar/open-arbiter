// The page CSP (_headers connect-src) lets the assistant reach only the AI providers the runtime's
// settings offer. A custom "Provider URL" elsewhere is blocked by the browser, so this module tells
// the visitor in the settings panel, naming the providers that work. tests/csp.test.mjs checks that
// connect-src and this list come from the same source (runtime/ui.js API_KEY_PROVIDERS).
import { API_KEY_PROVIDERS } from "../runtime/ui.js";
import { DEFAULT_ARBITER_URL, isLoopback } from "./config.js";

/** Provider names, in the settings panel's order. */
export const ALLOWED_PROVIDER_NAMES = [...new Set(API_KEY_PROVIDERS.map((p) => p.name))];

/** Origins the page CSP lets the assistant call for a model. */
export const ALLOWED_PROVIDER_ORIGINS = new Set(API_KEY_PROVIDERS.map((p) => new URL(p.router).origin));

/**
 * The origin of a Provider URL that the page CSP will block, or null when it is allowed, empty or
 * not a URL (the runtime reports those itself). On a page served from this machine, local model
 * servers are treated as allowed: development pages are not served with the CSP.
 */
export function blockedProviderOrigin(value, pageHref = globalThis.location?.href) {
  const text = String(value || "").trim();
  if (!text) return null;
  let origin;
  try { origin = new URL(text).origin; } catch { return null; }
  if (origin === "null") return null;
  if (ALLOWED_PROVIDER_ORIGINS.has(origin)) return null;
  try { if (pageHref && origin === new URL(pageHref).origin) return null; } catch { /* no page */ }
  if (pageHref && isLoopback(pageHref) && isLoopback(text)) return null;
  return origin;
}

/** The visitor-facing sentence for a blocked origin. */
export function blockedProviderMessage(origin) {
  return `This site's security policy blocks ${origin}, so the assistant cannot use it. `
    + `Use one of these providers instead: ${ALLOWED_PROVIDER_NAMES.join(", ")}.`;
}

/**
 * True when a CSP violation is the browser blocking a model call: a connect-src block of a URL that
 * is not this page or the arbiter.
 */
export function isBlockedProviderCall(event, pageHref = globalThis.location?.href) {
  const directive = event?.effectiveDirective || event?.violatedDirective || "";
  if (!directive.startsWith("connect-src")) return false;
  let origin;
  try { origin = new URL(event.blockedURI).origin; } catch { return false; }
  if (origin === new URL(DEFAULT_ARBITER_URL).origin) return false;
  try { if (pageHref && origin === new URL(pageHref).origin) return false; } catch { /* no page */ }
  return true;
}

/**
 * Wire the notice into the runtime's settings panel (which we do not edit): a warning under the
 * Provider URL field while it names a blocked origin, and, when the browser actually blocks a model
 * call, the same warning plus the assistant status line, with the advanced settings opened.
 */
export function guardProviderUrl(doc = document) {
  const router = doc.querySelector("#ns-router");
  if (!router) return null;
  const notice = doc.createElement("div");
  notice.id = "oja-router-blocked";
  notice.className = "ns-hint warn";
  notice.setAttribute("role", "alert");
  notice.hidden = true;
  (doc.querySelector("#ns-router-hint") || router).after(notice);
  const show = (origin) => {
    notice.textContent = origin ? `⚠ ${blockedProviderMessage(origin)}` : "";
    notice.hidden = !origin;
  };
  const check = () => show(blockedProviderOrigin(router.value));
  router.addEventListener("input", check);
  router.addEventListener("change", check);
  check();
  doc.addEventListener("securitypolicyviolation", (event) => {
    if (!isBlockedProviderCall(event)) return;
    const origin = new URL(event.blockedURI).origin;
    show(origin);
    const status = doc.querySelector("#assistant-status");
    if (status) status.textContent = blockedProviderMessage(origin);
    const advanced = notice.closest("details.ns-settings-advanced");
    if (advanced) advanced.open = true;
    const settings = notice.closest("details.ns-settings");
    if (settings) settings.open = true;
  });
  return notice;
}
