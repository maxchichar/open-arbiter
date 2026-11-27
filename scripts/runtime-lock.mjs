#!/usr/bin/env node
// Writes sites/oja/tests/runtime-lock.json: the agentic-web commit Oja's runtime/ is copied
// from, and the SHA-256 of each file there at that commit (invariant 6: runtime/ is upstream's
// copy, unedited). tests/runtime-pin.test.mjs checks runtime/ and the pins against it offline.
//
//   node scripts/runtime-lock.mjs <agentic-web clone> <commit>
//
// It reads the commit's tree with git (ls-tree, cat-file); the clone's checkout is not used.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = "skills/agentify-website/runtime";
const OUT = fileURLToPath(new URL("../sites/oja/tests/runtime-lock.json", import.meta.url));

const [clone, ref] = process.argv.slice(2);
if (!clone || !ref) {
  console.error("usage: node scripts/runtime-lock.mjs <agentic-web clone> <commit>");
  process.exit(2);
}
const git = (args, opts = {}) => execFileSync("git", ["-C", clone, ...args], { maxBuffer: 64 << 20, ...opts });
const commit = git(["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit id: ${commit}`);

const files = {};
const tree = git(["ls-tree", "-r", "-z", commit, "--", `${SOURCE}/`], { encoding: "utf8" });
for (const entry of tree.split("\0").filter(Boolean)) {
  const [meta, path] = entry.split("\t");
  const [mode, type, sha] = meta.split(" ");
  if (type !== "blob" || mode === "120000") throw new Error(`${path}: only regular files are expected (${mode} ${type})`);
  const bytes = git(["cat-file", "blob", sha]);
  files[path.slice(SOURCE.length + 1)] = createHash("sha256").update(bytes).digest("hex");
}
if (!Object.keys(files).length) throw new Error(`${SOURCE} is empty at ${commit}`);

const lock = { repository: "cognizant-ai-labs/agentic-web", commit, path: SOURCE, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) };
writeFileSync(OUT, JSON.stringify(lock, null, 2) + "\n");
console.log(`runtime lock: ${commit}, ${Object.keys(files).length} files -> ${OUT}`);
