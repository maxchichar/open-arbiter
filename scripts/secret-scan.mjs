// Secret scan (P1.1 AC-1.3). Finds secret files and secret-shaped values.
//   node scripts/secret-scan.mjs            every tracked file, as in the work tree
//   node scripts/secret-scan.mjs --staged   the staged content of every file being committed (the pre-commit hook)
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

const git = (args, cwd) => execFileSync("git", args, { cwd, maxBuffer: 64 << 20 });

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--staged")) { process.stderr.write("usage: secret-scan.mjs [--staged]\n"); process.exit(2); }
  const { files, problems } = scanRepo({ staged: args.includes("--staged") });
  if (problems.length) {
    process.stderr.write(`secret scan: ${problems.length} finding(s) in ${files} file(s):\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`secret scan: ${files} file(s), no findings\n`);
}
