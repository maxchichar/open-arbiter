// CI guards (P1.3). Text checks on .github/workflows/*.yml (no YAML dependency) and the M3 guard.
//   node scripts/ci-guards.mjs workflows     every workflow file: hardening rules + AC-3.4 (no production, no credentials)
//   node scripts/ci-guards.mjs m3            M3 (ADR 0005): if MECHANISM.version changed since the base, nothing may
//                                            deploy with `versions deploy` / a percentage. Base: $M3_BASE, else
//                                            merge-base with origin/main (HEAD~1 when HEAD is on main). Needs fetch-depth 0.
// Exits 1 on any problem (listed), 2 on a usage or git error. Tests: arbiter/test/ci-guards.test.mjs.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
export const WORKFLOW_DIR = join(REPO, ".github", "workflows");

/**
 * Until P1.4 (approvals A2, A4) CI holds no Cloudflare credential and deploys nothing. P1.4 relaxes the
 * deploy rules for staging only; the production rules stay.
 */
const FORBIDDEN = [
  [/\bpull_request_target\b/, "uses pull_request_target (runs PR code with base-repo privileges)"],
  [/\$\{\{\s*secrets\./, "references secrets.* (CI holds no secrets until P1.4/A4)"],
  [/^\s*environment\s*:/m, "uses a deployment environment (P1.4)"],
  [/--env[\s=]+production\b|confirm-production|\bproduction\b[^\n]*\b(deploy|migrations|wrangler)\b|\b(deploy|migrations|wrangler)\b[^\n]*\bproduction\b/i, "mentions production in a deploy, migration or wrangler command (AC-3.4)"],
  [/migrations\s+apply[^\n]*--remote/, "applies migrations to a remote D1 (AC-3.4, M1)"],
  [/wrangler-action/, "uses cloudflare/wrangler-action (P1.4)"],
  [/\bwrangler\s+(deploy|versions|secret|publish)\b|deploy:arbiter/, "deploys or changes a Worker (P1.4)"],
  [/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/, "sets a Cloudflare credential (P1.4/A4)"],
  [/:\s*write\b/, "grants a write permission"],
];

/** Problems in one workflow file's text. */
export function workflowProblems(text) {
  const p = FORBIDDEN.filter(([re]) => re.test(text)).map(([, why]) => why);
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(text)) p.push("top-level permissions must be exactly `contents: read`");
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    if (!m[1].startsWith("./") && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1])) p.push(`action not pinned to a full commit SHA: ${m[1]}`);
  }
  const checkouts = [...text.matchAll(/uses:\s*actions\/checkout@/g)].length;
  const noPersist = [...text.matchAll(/persist-credentials:\s*false\b/g)].length;
  if (checkouts !== noPersist) p.push(`every actions/checkout needs persist-credentials: false (${checkouts} checkout(s), ${noPersist} set)`);
  const jobs = jobBlocks(text);
  if (!jobs.length) p.push("no jobs found");
  for (const [name, body] of jobs) if (!/^\s+timeout-minutes:\s*\d+\s*$/m.test(body)) p.push(`job ${name} has no timeout-minutes`);
  return p;
}

/** [name, text] for each job under the top-level `jobs:` (two-space indented keys). */
export function jobBlocks(text) {
  const i = text.search(/^jobs:\s*$/m);
  if (i < 0) return [];
  const lines = text.slice(i).split("\n").slice(1);
  const out = [];
  for (const line of lines) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) out.push([m[1], ""]);
    else if (out.length) out[out.length - 1][1] += line + "\n";
  }
  return out;
}

/** What ci.yml itself must do (AC-3.1, AC-3.6, AC-3.7, ADR 0005). */
export const CI_REQUIRED = [
  [/^on:\s*\n(\s+.*\n)*?\s+push:/m, "runs on push"],
  [/^on:\s*\n(\s+.*\n)*?\s+pull_request:/m, "runs on pull_request"],
  [/fetch-depth:\s*0\b/, "checks out with fetch-depth: 0 (test:m2 needs the tags; M3 needs the base)"],
  [/\bnpm ci\b/, "installs with npm ci"],
  [/\bnpm test\b/, "runs npm test"],
  [/node scripts\/secret-scan\.mjs --history\b/, "runs the secret scan over the full history"],
  [/npm run test:m2\b/, "runs test:m2"],
  [/npm run test:worker\b/, "runs test:worker"],
  [/npm run test:migrations-d1\b/, "runs test:migrations-d1"],
  [/node scripts\/ci-guards\.mjs workflows\b/, "runs the workflow guard"],
  [/node scripts\/ci-guards\.mjs m3\b/, "runs the M3 guard"],
  [/build_network\.mjs oja_market\.hocon --manifest agent-manifest\.json --check/, "checks the network build"],
  [/worker-harness\.mjs --port 8787 browser/, "runs the browser check"],
];
export function ciProblems(text) {
  return CI_REQUIRED.filter(([re]) => !re.test(text)).map(([, why]) => `ci.yml must ${why}`);
}

/** The MECHANISM.version string in mechanism.js source, or null. */
export const mechanismVersion = (src) => src.match(/MECHANISM\s*=\s*Object\.freeze\(\{[\s\S]*?\bversion:\s*"([^"]+)"/)?.[1] ?? null;

const SPLIT = /\bversions\s+deploy\b|--percentage\b|\bgradual\b/i;
/** M3: files is { path: text } of everything that can deploy (workflows, deploy.mjs, package.json). */
export function m3Problems({ before, after, files }) {
  if (after === null) return ["MECHANISM.version not found at HEAD"];
  if (before === after) return [];
  return Object.entries(files).filter(([, t]) => SPLIT.test(t))
    .map(([f]) => `${f}: split-traffic deploy while MECHANISM.version changes ${before} -> ${after} (M3: ship with wrangler deploy, 100%)`);
}

export function deployFiles() {
  const files = {};
  if (existsSync(WORKFLOW_DIR)) for (const f of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) files[`.github/workflows/${f}`] = readFileSync(join(WORKFLOW_DIR, f), "utf8");
  for (const f of ["arbiter/scripts/deploy.mjs", "package.json"]) files[f] = readFileSync(join(REPO, f), "utf8");
  return files;
}

const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  let problems;
  try {
    if (mode === "workflows" && process.argv.length === 3) {
      if (!existsSync(WORKFLOW_DIR)) throw new Error("no .github/workflows directory");
      problems = [];
      for (const f of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
        const text = readFileSync(join(WORKFLOW_DIR, f), "utf8");
        for (const x of [...workflowProblems(text), ...(f === "ci.yml" ? ciProblems(text) : [])]) problems.push(`${f}: ${x}`);
      }
    } else if (mode === "m3" && process.argv.length === 3) {
      const head = git("rev-parse", "HEAD");
      let base = process.env.M3_BASE || git("merge-base", "HEAD", "origin/main");
      if (git("rev-parse", base) === head) base = git("rev-parse", "HEAD~1");
      const before = mechanismVersion(git("show", `${base}:arbiter/src/mechanism.js`));
      const after = mechanismVersion(readFileSync(join(REPO, "arbiter/src/mechanism.js"), "utf8"));
      console.log(`m3: MECHANISM.version ${before} at ${base.slice(0, 12)}, ${after} at HEAD`);
      problems = m3Problems({ before, after, files: deployFiles() });
    } else {
      process.stderr.write("usage: ci-guards.mjs workflows | m3\n");
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`ci-guards: ${e.message.split("\n")[0]}\n`);
    process.exit(2);
  }
  if (problems.length) { process.stderr.write(`ci-guards ${mode}: ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}\n`); process.exit(1); }
  console.log(`ci-guards ${mode}: OK`);
}
