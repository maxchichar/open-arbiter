// M2 check (P1.2 AC-2.3, ADR 0005): every migration stays compatible with the previous Worker
// version, because a rollback does not roll back D1 and migrations are applied before the Worker
// that needs them is deployed. For each release ref, run that release's own arbiter tests against
// a database migrated to HEAD (plus any --extra-migration):
//   node arbiter/scripts/m2-check.mjs                       every v* release tag not at HEAD
//   node arbiter/scripts/m2-check.mjs --ref v0.0 [--extra-migration <file.sql>]...
// A schema.sql-era release (v0.0) gets, as its schema.sql, the schema of an empty database migrated
// to HEAD (migrate.mjs schemaScriptOf). A release with migrations/ gets HEAD's migrations in place
// of its own, and its "[tree]" tests (which check its own files, not compatibility) are skipped.
// Prints "<ref>: PASS" or "<ref>: FAIL" per ref; exits 1 if any failed, 2 on a usage error.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, migrationNames, schemaScriptOf, MIGRATIONS_DIR } from "../test/migrate.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const usage = (msg) => { process.stderr.write(`m2-check: ${msg}\nusage: m2-check.mjs [--ref <tag>]... [--extra-migration <file.sql>]...\n`); process.exit(2); };

const refs = [], extraFiles = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] === "--ref" && argv[i + 1]) refs.push(argv[i + 1]);
  else if (argv[i] === "--extra-migration" && argv[i + 1]) extraFiles.push(argv[i + 1]);
  else usage(`unknown argument ${argv[i]}`);
}
const head = git("rev-parse", "HEAD");
if (!refs.length) {
  for (const t of git("tag", "-l", "v*", "--sort=v:refname").split("\n").filter(Boolean)) {
    if (git("rev-parse", `${t}^{commit}`) !== head) refs.push(t);
  }
  if (!refs.length) usage("no release tags found (CI: check out with fetch-depth: 0)");
}
for (const r of refs) {
  if (spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `${r}^{commit}`]).status !== 0) usage(`unknown ref ${r}`);
}
// Extra migrations run after HEAD's, numbered after them, as a later release would add them.
const next = migrationNames().length;
const extra = extraFiles.map((f, i) => ({ name: `${String(next + i).padStart(4, "0")}_${basename(f).replace(/^\d+_/, "")}`, sql: readFileSync(f, "utf8") }));

const { NODE_TEST_CONTEXT, ...env } = process.env; // a nested run must report its own exit code
let failed = false;
for (const ref of refs) {
  const tmp = mkdtempSync(join(tmpdir(), `m2-${ref}-`));
  execFileSync("sh", ["-c", 'git -C "$1" archive "$2" arbiter package.json | tar -x -C "$3"', "sh", REPO, ref, tmp]);
  symlinkSync(join(REPO, "node_modules"), join(tmp, "node_modules"));
  const oldMigrations = join(tmp, "arbiter", "migrations");
  const testArgs = ["--test", "--test-reporter=spec"];
  if (existsSync(oldMigrations)) {
    for (const f of readdirSync(oldMigrations)) rmSync(join(oldMigrations, f));
    for (const n of migrationNames()) copyFileSync(new URL(n, MIGRATIONS_DIR), join(oldMigrations, n));
    const lock = JSON.parse(readFileSync(new URL("lock.json", MIGRATIONS_DIR), "utf8"));
    for (const x of extra) {
      writeFileSync(join(oldMigrations, x.name), x.sql);
      lock[x.name] = createHash("sha256").update(x.sql).digest("hex");
    }
    writeFileSync(join(oldMigrations, "lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    testArgs.push("--test-skip-pattern", "\\[tree\\]");
  } else {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, { extra });
    writeFileSync(join(tmp, "arbiter", "schema.sql"), schemaScriptOf(db));
  }
  const tests = readdirSync(join(tmp, "arbiter", "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => join("arbiter", "test", f));
  const r = spawnSync(process.execPath, ["--no-warnings", ...testArgs, ...tests], { cwd: tmp, env, encoding: "utf8", maxBuffer: 64 << 20 });
  const log = `${r.stdout}${r.stderr}`;
  writeFileSync(join(tmp, "m2-test-output.txt"), log);
  const summary = log.split("\n").filter((l) => /^ℹ (tests|pass|fail) /.test(l)).join(", ");
  const ok = r.status === 0;
  failed ||= !ok;
  process.stdout.write(`${ref}: ${ok ? "PASS" : "FAIL"} (${summary}; migrations: ${[...migrationNames(), ...extra.map((x) => x.name)].join(", ")})\n`);
  if (ok) rmSync(tmp, { recursive: true, force: true });
  else {
    const failing = log.split("\n").filter((l) => /^✖ /.test(l) && !/failing tests/.test(l));
    process.stdout.write(`${[...new Set(failing)].slice(0, 15).map((l) => `  ${l}`).join("\n")}\n  full output: ${join(tmp, "m2-test-output.txt")}\n`);
  }
}
process.exit(failed ? 1 : 0);
