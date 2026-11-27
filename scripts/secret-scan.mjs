// Secret scan (P1.1 AC-1.3). Finds secret files and secret-shaped values.
//   node scripts/secret-scan.mjs            every tracked file, as in the work tree
//   node scripts/secret-scan.mjs --staged   the staged content of every file being committed (the pre-commit hook)
//   node scripts/secret-scan.mjs --history  every file version in every commit reachable from any ref (before a push; CI)
// Exits 1 on any finding, listing file and reason, never the value. Used by .githooks/pre-commit,
// arbiter/test/secret-scan.test.mjs and scripts/save-output.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Paths that must never be committed. */
export const FORBIDDEN_PATHS = [/(^|\/)\.dev\.vars(\..+)?$/, /(^|\/)\.env(\..+)?$/, /(^|\/)\.seed-keys\.json$/, /\.jwk$/, /\.pem$/, /(^|\/)\.wrangler\//];

/** Files skipped by content: binaries, and this scanner's own test, whose fixtures are fake secrets. */
const SKIP_CONTENT = [/\.(png|jpe?g|gif|ico|woff2?)$/, /^arbiter\/test\/secret-scan\.test\.mjs$/];

/** Values a secret assignment may carry in the repo: local dev values. Interpolations ($X, ${X}) pass too. */
const DEV_VALUES = new Set(["dev-admin-token", "dev", "harness", "admin"]);

/** Secret-shaped spans in text: [{ reason, start, end }] (end exclusive; the span covers the value). */
export function secretSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/"d"\s*:\s*"([A-Za-z0-9_-]{32,})"/g)) spans.push({ reason: "private JWK (\"d\")", start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length });
  for (const m of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g)) spans.push({ reason: "PEM private key", start: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(/\b(ADMIN_TOKEN|BUYER_SALT|ARBITER_SIGNING_JWK|CLOUDFLARE_API_TOKEN)\s*=\s*['"]?([^\s'"\\]+)/g)) {
    const value = m[2];
    if (DEV_VALUES.has(value) || value.startsWith("$") || value.startsWith("[REDACTED")) continue;
    const start = m.index + m[0].lastIndexOf(value);
    spans.push({ reason: `${m[1]} assigned a value`, start, end: start + value.length });
  }
  for (const m of text.matchAll(/(api[_-]?token|CF_API_TOKEN)["'\s:=]+([A-Za-z0-9_-]{40})\b/gi)) {
    const start = m.index + m[0].lastIndexOf(m[2]);
    spans.push({ reason: "Cloudflare API token", start, end: start + 40 });
  }
  return spans;
}

/** The reasons found in text, one per finding. */
export const findSecrets = (text) => secretSpans(text).map((s) => s.reason);

/** text with every secret-shaped value replaced by [REDACTED: reason]. */
export function redact(text) {
  const spans = secretSpans(text).sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of spans) out = out.slice(0, s.start) + `[REDACTED: ${s.reason}]` + out.slice(s.end);
  return out;
}

const git = (args, cwd, input) => execFileSync("git", args, { cwd, maxBuffer: 256 << 20, ...(input === undefined ? {} : { input }) });

/** Findings as "path: reason" strings. staged: scan what the index holds for added/changed files. */
export function scanRepo({ cwd = process.cwd(), staged = false } = {}) {
  const root = git(["rev-parse", "--show-toplevel"], cwd).toString().trim();
  const files = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root).toString().split("\0").filter(Boolean)
    : git(["ls-files", "-z"], root).toString().split("\0").filter(Boolean);
  const problems = [];
  for (const f of files) {
    if (FORBIDDEN_PATHS.some((r) => r.test(f))) { problems.push(`${f}: must not be committed`); continue; }
    if (SKIP_CONTENT.some((r) => r.test(f))) continue;
    let text;
    try { text = staged ? git(["show", `:${f}`], root).toString("utf8") : readFileSync(`${root}/${f}`, "utf8"); } catch { continue; }
    for (const why of findSecrets(text)) problems.push(`${f}: ${why}`);
  }
  return { files: files.length, problems };
}

/**
 * Every blob reachable from any ref (git rev-list --all), with each path it appears under. Findings
 * name the path, the blob and the first commit that has it; never the value.
 */
export function scanHistory({ cwd = process.cwd() } = {}) {
  const root = git(["rev-parse", "--show-toplevel"], cwd).toString().trim();
  const commits = git(["rev-list", "--all"], root).toString().split("\n").filter(Boolean).length;
  const paths = new Map(); // blob sha -> Set(path)
  for (const line of git(["rev-list", "--all", "--objects", "--filter=object:type=blob", "--filter-provided-objects"], root).toString().split("\n")) {
    const m = line.match(/^([0-9a-f]{40,64}) (.+)$/);
    if (!m) continue;
    if (!paths.has(m[1])) paths.set(m[1], new Set());
    paths.get(m[1]).add(m[2]);
  }
  const problems = [];
  const where = (sha) => git(["log", "--all", "--format=%h", "--reverse", `--find-object=${sha}`], root).toString().split("\n")[0];
  const toRead = [];
  for (const [sha, ps] of paths) {
    const forbidden = [...ps].filter((f) => FORBIDDEN_PATHS.some((r) => r.test(f)));
    for (const f of forbidden) problems.push(`${f} (blob ${sha.slice(0, 12)}, commit ${where(sha)}): must not be committed`);
    if (forbidden.length === ps.size) continue;
    if ([...ps].every((f) => SKIP_CONTENT.some((r) => r.test(f)))) continue;
    toRead.push(sha);
  }
  const out = toRead.length ? git(["cat-file", "--batch"], root, toRead.join("\n") + "\n") : Buffer.alloc(0);
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(10, at);
    const [sha, , size] = out.subarray(at, nl).toString().split(" ");
    const body = out.subarray(nl + 1, nl + 1 + Number(size));
    at = nl + 1 + Number(size) + 1;
    for (const why of findSecrets(body.toString("utf8"))) problems.push(`${[...paths.get(sha)].join(", ")} (blob ${sha.slice(0, 12)}, commit ${where(sha)}): ${why}`);
  }
  return { commits, blobs: paths.size, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => a !== "--staged" && a !== "--history")) { process.stderr.write("usage: secret-scan.mjs [--staged | --history]\n"); process.exit(2); }
  if (args[0] === "--history") {
    const { commits, blobs, problems } = scanHistory();
    if (problems.length) {
      process.stderr.write(`secret scan (history): ${problems.length} finding(s) in ${blobs} file version(s) across ${commits} commit(s):\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write(`secret scan (history): ${commits} commit(s), ${blobs} file version(s), no findings\n`);
  } else {
    const { files, problems } = scanRepo({ staged: args.includes("--staged") });
    if (problems.length) {
      process.stderr.write(`secret scan: ${problems.length} finding(s) in ${files} file(s):\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write(`secret scan: ${files} file(s), no findings\n`);
  }
}
