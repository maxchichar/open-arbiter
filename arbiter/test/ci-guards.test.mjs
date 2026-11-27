// P1.3: CI guards. AC-3.4 (no production, no credentials), AC-3.5 (M3), AC-3.7 (hardening), and the
// two CI preconditions from P1.2: test:m2 refuses to pass without tags, and the history secret scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowProblems, ciProblems, jobBlocks, m3Problems, mechanismVersion, deployFiles, WORKFLOW_DIR } from "../../scripts/ci-guards.mjs";
import { scanHistory, findSecrets, REVIEWED_BLOBS } from "../../scripts/secret-scan.mjs";

const REPO = new URL("../../", import.meta.url).pathname;
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const GOOD = `name: x
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - run: npm test
`;
const withStep = (line) => GOOD + `      - run: ${line}\n`;

test("[tree] every workflow passes the guards, and ci.yml runs every required check", () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.includes("ci.yml"), "ci.yml exists");
  for (const f of files) {
    const text = readFileSync(join(WORKFLOW_DIR, f), "utf8");
    assert.deepEqual(workflowProblems(text), [], f);
    if (f === "ci.yml") assert.deepEqual(ciProblems(text), [], f);
  }
  const ci = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");
  assert.deepEqual(jobBlocks(ci).map(([n]) => n), ["unit", "worker", "network-and-browser"]);
  const pin = readFileSync(join(REPO, "CLAUDE.md"), "utf8").match(/pinned at commit `([0-9a-f]{40})`/)[1];
  assert.equal([...ci.matchAll(new RegExp(pin, "g"))].length, 2, "CI clones agentic-web at CLAUDE.md's pin (env + checkout ref)");
});

test("the minimal good workflow passes", () => {
  assert.deepEqual(workflowProblems(GOOD), []);
});

test("AC-3.4: production, remote migrations, credentials and deploys are refused", () => {
  const cases = [
    ["npx wrangler deploy --env production", /production/],
    ["npm run deploy:arbiter -- production --confirm-production", /production/],
    ["cd arbiter && npx wrangler d1 migrations apply open-arbiter-staging --env staging --remote", /remote D1/],
    ["npx wrangler deploy --env staging", /deploys or changes a Worker/],
    ["npx wrangler versions deploy x@10", /deploys or changes a Worker/],
    ["npx wrangler secret put ADMIN_TOKEN --env staging", /deploys or changes a Worker/],
    ["echo ${{ secrets.CF_TOKEN }}", /secrets\.\*/],
    ["CLOUDFLARE_API_TOKEN=$CF npx wrangler whoami", /Cloudflare credential/],
  ];
  for (const [line, re] of cases) {
    const p = workflowProblems(withStep(line));
    assert.ok(p.some((x) => re.test(x)), `${line} -> ${JSON.stringify(p)}`);
  }
  assert.ok(workflowProblems(GOOD + "      - uses: cloudflare/wrangler-action@" + SHA + "\n").some((x) => /wrangler-action/.test(x)));
  assert.ok(workflowProblems(GOOD.replace("jobs:", "    environment: production\njobs:")).length);
});

test("AC-3.7: hardening rules", () => {
  assert.ok(workflowProblems(GOOD.replace("  push:", "  pull_request_target:")).some((x) => /pull_request_target/.test(x)));
  assert.ok(workflowProblems(GOOD.replace("contents: read", "contents: write")).some((x) => /permissions/.test(x)));
  assert.ok(workflowProblems(GOOD.replace("permissions:\n  contents: read\n", "")).some((x) => /permissions/.test(x)));
  assert.ok(workflowProblems(GOOD + "      - uses: actions/setup-node@v7\n").some((x) => /not pinned.*setup-node@v7/.test(x)));
  assert.ok(workflowProblems(GOOD.replace("        with:\n          persist-credentials: false\n", "")).some((x) => /persist-credentials/.test(x)));
  assert.ok(workflowProblems(GOOD.replace("    timeout-minutes: 5\n", "")).some((x) => /job a has no timeout-minutes/.test(x)));
});

test("ci.yml requirements: each missing check is named", () => {
  const ci = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");
  for (const [needle, re] of [["fetch-depth: 0", /fetch-depth/], ["npm run test:m2", /test:m2/], ["npm run test:migrations-d1", /test:migrations-d1/], ["--history", /full history/], ["--port 8787 browser", /browser/], ["ci-guards.mjs m3", /M3/]]) {
    assert.ok(ciProblems(ci.replaceAll(needle, "REMOVED")).some((x) => re.test(x)), needle);
  }
});

test("AC-3.5 M3: a mechanism version change may not ship as split traffic", () => {
  const split = { "wf.yml": "run: npx wrangler versions deploy abc@10% --yes" };
  const pct = { "wf.yml": "run: npx wrangler versions deploy --percentage 10" };
  const full = { "wf.yml": "run: npx wrangler deploy --env staging" };
  assert.equal(m3Problems({ before: "3.0.0", after: "3.1.0", files: split }).length, 1);
  assert.match(m3Problems({ before: "3.0.0", after: "3.1.0", files: pct })[0], /wf\.yml: split-traffic deploy while MECHANISM\.version changes 3\.0\.0 -> 3\.1\.0/);
  assert.deepEqual(m3Problems({ before: "3.0.0", after: "3.1.0", files: full }), []);
  assert.deepEqual(m3Problems({ before: "3.0.0", after: "3.0.0", files: split }), []);
  assert.equal(m3Problems({ before: "3.0.0", after: null, files: {} }).length, 1);
  assert.match(mechanismVersion(readFileSync(join(REPO, "arbiter/src/mechanism.js"), "utf8")), /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m3Problems({ before: "0.0.0", after: "1.0.0", files: deployFiles() }), [], "nothing in the tree deploys split traffic");
});

test("AC-3.5 M3 CLI: base = HEAD compares with HEAD~1 and passes", () => {
  const r = spawnSync(process.execPath, [join(REPO, "scripts/ci-guards.mjs"), "m3"], { encoding: "utf8", env: { ...process.env, M3_BASE: "HEAD" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ci-guards m3: OK/);
});

test("test:m2 without tags (a shallow clone) fails loudly instead of checking nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "m2-shallow-"));
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1", "--no-tags", `file://${REPO}`, dir]);
    const r = spawnSync(process.execPath, [join(dir, "arbiter/scripts/m2-check.mjs")], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /no release tags found \(CI: check out with fetch-depth: 0\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("secret scan --history finds a key that was committed and later removed, without printing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "scan-history-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...a]);
  const FAKE = "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK";
  try {
    g("init", "-q");
    writeFileSync(join(dir, "a.txt"), "clean\n");
    g("add", "."); g("commit", "-qm", "clean");
    assert.deepEqual(scanHistory({ cwd: dir }).problems, []);
    writeFileSync(join(dir, "key.json"), `{"kty":"EC","d":"${FAKE}"}`);
    writeFileSync(join(dir, ".dev.vars"), "x\n");
    g("add", "."); g("commit", "-qm", "oops");
    g("rm", "-q", "key.json", ".dev.vars"); g("commit", "-qm", "remove");
    const { commits, problems } = scanHistory({ cwd: dir });
    assert.equal(commits, 3);
    assert.equal(problems.length, 2, JSON.stringify(problems));
    assert.ok(problems.some((p) => /^key\.json \(blob [0-9a-f]{12}, commit [0-9a-f]+\): private JWK/.test(p)));
    assert.ok(problems.some((p) => /^\.dev\.vars .*must not be committed/.test(p)));
    assert.ok(!problems.join("\n").includes(FAKE));
    const cli = spawnSync(process.execPath, [join(REPO, "scripts/secret-scan.mjs"), "--history"], { cwd: dir, encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.ok(!(cli.stdout + cli.stderr).includes(FAKE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reviewed blobs: only the exact reviewed .env.example blob passes; a different .env.example is refused", () => {
  const ID = "005915ebbca6eb6d021d5445891006ac5668cad3";
  assert.deepEqual([...REVIEWED_BLOBS.keys()], [ID]);
  assert.match(REVIEWED_BLOBS.get(ID).reason, /placeholder-only \.env\.example from the earlier away-bot project; reviewed by owner 27 Nov 2026/);
  assert.equal(REVIEWED_BLOBS.get(ID).date, "2026-11-27");
  const dir = mkdtempSync(join(tmpdir(), "scan-reviewed-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...a]);
  try {
    g("init", "-q");
    // A different .env.example (one byte changed from anything reviewed): a new blob id, still refused.
    writeFileSync(join(dir, ".env.example"), "DISCORD_BOT_TOKEN=your-bot-token-here\nNVIDIA_API_KEY=nvapi-your-key-here\n# changed\n");
    g("add", "."); g("commit", "-qm", "example");
    const blob = execFileSync("git", ["-C", dir, "rev-parse", "HEAD:.env.example"], { encoding: "utf8" }).trim();
    assert.notEqual(blob, ID);
    const { problems } = scanHistory({ cwd: dir });
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /^\.env\.example \(blob [0-9a-f]{12}, commit [0-9a-f]+\): must not be committed$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (spawnSync("git", ["-C", REPO, "cat-file", "-e", ID]).status === 0) {
    const real = scanHistory({ cwd: REPO }).problems.filter((p) => p.includes(ID.slice(0, 12)));
    assert.deepEqual(real, [], "the reviewed blob itself passes in this repo's history");
  }
});

test("Discord bot tokens and NVIDIA API keys are detected; placeholders are not", () => {
  // Fake values of the right shape, built at run time so this file holds none.
  const discord = ["M" + "T".repeat(23), "G" + "a".repeat(5), "x".repeat(27)].join(".");
  const nvidia = "nvapi-" + "Q".repeat(64);
  assert.deepEqual(findSecrets(`DISCORD_BOT_TOKEN=${discord}`), ["Discord bot token"]);
  assert.deepEqual(findSecrets(`token: "${discord}"`), ["Discord bot token"]);
  assert.deepEqual(findSecrets(`NVIDIA_API_KEY=${nvidia}`), ["NVIDIA API key"]);
  assert.deepEqual(findSecrets("DISCORD_BOT_TOKEN=your-bot-token-here\nNVIDIA_API_KEY=nvapi-your-key-here"), []);
  assert.deepEqual(findSecrets("see example.com.ng and v1.2.3 and a.b.c"), []);
});
