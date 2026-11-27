// Runs checks against a throwaway local Worker: its own D1 state in a temp directory,
// a free port and fixed test variables, so a developer's local data is never touched.
//   node arbiter/scripts/worker-harness.mjs [step ...]      (steps: seed e2e concurrency browser; default all but browser)
//   node arbiter/scripts/worker-harness.mjs --serve         (start, print the URL, wait for Ctrl-C)
//   node arbiter/scripts/worker-harness.mjs --port 8787 browser
//       browser (P1.3 CI): seed, then serve sites/oja on :8080 with the agentify skill's serve_site.mjs
//       from $AGENTIC_WEB (a clone at the pinned commit), tests/fake-llm.mjs on :8799, and run
//       sites/oja/tests/browser_check.py into $BROWSER_OUT. The page expects the arbiter on :8787.
// Exits non-zero if any step fails. Every step runs even if an earlier one failed,
// except that e2e and concurrency need seed.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const arbiterDir = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(arbiterDir, "..", "node_modules", ".bin", "wrangler");
const ADMIN = "harness-admin-token";
const args = process.argv.slice(2);
const serveOnly = args.includes("--serve");
const portArg = args.indexOf("--port");
const fixedPort = portArg >= 0 ? Number(args[portArg + 1]) : 0;
if (portArg >= 0 && !(Number.isInteger(fixedPort) && fixedPort > 0)) { console.error("--port needs a port number"); process.exit(2); }
const steps = args.filter((a, i) => !a.startsWith("--") && !(portArg >= 0 && i === portArg + 1));
const unknown = steps.filter((s) => !["seed", "e2e", "concurrency", "browser"].includes(s));
if (unknown.length) { console.error(`unknown step(s): ${unknown.join(" ")}`); process.exit(2); }
const want = steps.length ? steps : ["seed", "e2e", "concurrency"];

const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const state = mkdtempSync(join(tmpdir(), "open-arbiter-harness-"));
// An explicit env file, so the developer's .dev.vars (other admin token, maybe no DEV) is not used.
const envFile = join(state, "harness.env");
writeFileSync(envFile, `ADMIN_TOKEN=${ADMIN}\nBUYER_SALT=harness\nDEV=1\n`);
const port = fixedPort || await freePort();
const base = `http://127.0.0.1:${port}`;

// The same migrations a deployment gets (arbiter/migrations/); not interactive, so wrangler does not prompt.
const schema = spawnSync(wrangler, ["d1", "migrations", "apply", "open-arbiter", "--local", "--persist-to", state], { cwd: arbiterDir, encoding: "utf8", env: { ...process.env, CI: "1" } });
if (schema.status !== 0) { console.error(schema.stdout, schema.stderr); process.exit(2); }

const server = spawn(wrangler, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state,
  "--env-file", envFile, "--var", `ADMIN_TOKEN:${ADMIN}`, "--var", "BUYER_SALT:harness", "--var", "DEV:1",
  "--show-interactive-dev-session=false", "--log-level", "warn"], { cwd: arbiterDir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

const stop = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
  rmSync(state, { recursive: true, force: true });
};
process.on("SIGINT", () => { stop(); process.exit(130); });

let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { up = (await fetch(base + "/")).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error("Worker did not start.\n" + serverLog); stop(); process.exit(2); }
console.log(`harness: worker at ${base}, state in ${state}`);

if (serveOnly) {
  console.log(`harness: admin token ${ADMIN}. Ctrl-C to stop.`);
  await new Promise(() => {});
}

const run = (name, script, extra = [], env = {}) => {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [join(arbiterDir, "scripts", script), base, ...extra], { stdio: "inherit", env: { ...process.env, ...env } });
  return r.status === 0;
};

const results = {};
if (want.length) {
  results.seed = run("seed", "seed.mjs", [ADMIN, "http://127.0.0.1:8080"], { SEED_KEYS_OUT: join(state, "seed-keys.json") });
}
if (want.includes("e2e")) results.e2e = results.seed && run("e2e", "e2e.mjs", [ADMIN]);
if (want.includes("concurrency")) results.concurrency = results.seed && run("concurrency", "concurrency.mjs", [ADMIN]);
if (want.includes("browser")) results.browser = results.seed && await browser();

/** Site on :8080 and the scripted LLM on :8799, then browser_check.py. Both are stopped afterwards. */
async function browser() {
  console.log("\n=== browser ===");
  const repo = join(arbiterDir, "..");
  const aw = process.env.AGENTIC_WEB;
  if (!aw) { console.error("browser: set AGENTIC_WEB to a clone of cognizant-ai-labs/agentic-web at the pinned commit"); return false; }
  const kids = [
    spawn(process.execPath, [join(repo, "sites/oja/tests/fake-llm.mjs"), "8799"], { stdio: "inherit", detached: true }),
    spawn(process.execPath, [join(aw, "skills/agentify-website/scripts/serve_site.mjs"), join(repo, "sites/oja"), "--host", "127.0.0.1", "--port", "8080"], { stdio: "inherit", detached: true }),
  ];
  try {
    for (const url of ["http://127.0.0.1:8799/", "http://127.0.0.1:8080/"]) {
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) { try { await fetch(url); ok = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
      if (!ok) { console.error(`browser: ${url} did not start`); return false; }
    }
    const out = process.env.BROWSER_OUT || mkdtempSync(join(tmpdir(), "oja-shots-"));
    const r = spawnSync("python3", [join(repo, "sites/oja/tests/browser_check.py"), out], { stdio: "inherit", env: process.env });
    console.log(`browser: screenshots in ${out}`);
    return r.status === 0;
  } finally {
    for (const k of kids) { try { process.kill(-k.pid, "SIGTERM"); } catch { /* gone */ } }
  }
}

stop();
console.log("\nharness results:", JSON.stringify(results));
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
