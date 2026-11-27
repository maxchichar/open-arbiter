// Deploy the arbiter to one named environment (P1.1, ADR 0004):
//   npm run deploy:arbiter -- staging [--dry-run]
//   npm run deploy:arbiter -- production --confirm-production [--dry-run]
// Refuses without an environment: wrangler only warns when --env is missing and then deploys the
// top level, which is local development only. Refuses an environment whose D1 or KV ids are still
// placeholders. --confirm-production is a guard against slips, not an approval: production deploys
// still need the owner's approval at that step (plan approval A3) and follow docs/runbooks/deploy.md.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unstable_readConfig } from "wrangler";

const ENVS = new Set(["staging", "production"]);
const ARBITER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: npm run deploy:arbiter -- <staging|production> [--dry-run] [--confirm-production]";

/** An all-zero id prefix marks a placeholder, e.g. 00000000-0000-0000-0000-00000000000a. */
const isPlaceholder = (id) => !id || /^0{8}-?0{4}-?0{4}-?0{4}-?0{10}[0-9a-f]{2}$|^0{30}[0-9a-f]{2}$/.test(id);

/** Reads arbiter/wrangler.toml through wrangler, so the check sees what a deploy would. */
export function tomlPlaceholders(configPath = join(ARBITER_DIR, "wrangler.toml")) {
  return {
    hasPlaceholderIds(env) {
      const c = unstable_readConfig({ config: configPath, env }, { hideWarnings: true });
      const ids = [...c.d1_databases.map((d) => d.database_id), ...c.kv_namespaces.map((k) => k.id)];
      return ids.length === 0 || ids.some(isPlaceholder);
    },
  };
}

/** The wrangler arguments for argv, or throws with the reason. Pure apart from `ids`. */
export function deployArgs(argv, ids) {
  const [env, ...flags] = argv;
  if (!ENVS.has(env)) throw new Error(`name an environment: staging|production (got ${JSON.stringify(env ?? null)})\n${USAGE}`);
  const known = new Set(["--dry-run", "--confirm-production"]);
  const unknown = flags.filter((f) => !known.has(f));
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(" ")} (staging|production only)\n${USAGE}`);
  const dryRun = flags.includes("--dry-run");
  if (env === "production" && !dryRun && !flags.includes("--confirm-production")) {
    throw new Error("a production deploy needs --confirm-production, and the owner's approval (docs/runbooks/deploy.md)");
  }
  if (!dryRun && ids.hasPlaceholderIds(env)) {
    throw new Error(`[env.${env}] in arbiter/wrangler.toml still has placeholder D1/KV ids: create the resources first (staging|production runbook)`);
  }
  return ["deploy", "--env", env, ...(dryRun ? ["--dry-run"] : [])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = deployArgs(process.argv.slice(2), tomlPlaceholders());
  } catch (e) {
    process.stderr.write(`deploy:arbiter: ${e.message}\n`);
    process.exit(2);
  }
  const wrangler = join(ARBITER_DIR, "..", "node_modules", ".bin", "wrangler");
  const r = spawnSync(wrangler, args, { cwd: ARBITER_DIR, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
