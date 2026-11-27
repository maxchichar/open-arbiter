// Captures everything the arbiter writes to the console while `fn` runs (P1.5 tests).
const METHODS = ["log", "info", "warn", "error", "debug", "trace"];

/** Run fn with console captured. Returns { result, calls: [{ method, args }] }. */
export async function captureLogs(fn) {
  const calls = [];
  const saved = Object.fromEntries(METHODS.map((m) => [m, console[m]]));
  for (const m of METHODS) console[m] = (...args) => { calls.push({ method: m, args }); };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    Object.assign(console, saved);
  }
}

/** Every captured call as one string, objects JSON-encoded (what a log reader would see). */
export const renderCalls = (calls) => calls.map((c) => c.args.map((a) => {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}).join(" "));
