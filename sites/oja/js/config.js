// Where the Open Arbiter runs. Set this to your deployed Worker before publishing,
// for example "https://open-arbiter.<you>.workers.dev". During local development the
// page also accepts ?arbiter=http://localhost:8787 in its address.
export const DEFAULT_ARBITER_URL = "http://localhost:8787";

export function arbiterUrl() {
  try {
    const fromQuery = new URL(globalThis.location?.href ?? "").searchParams.get("arbiter");
    if (fromQuery && /^https?:\/\//.test(fromQuery)) return fromQuery;
  } catch { /* no location in tests */ }
  return DEFAULT_ARBITER_URL;
}
