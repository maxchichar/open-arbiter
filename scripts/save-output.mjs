// Run a command and save its output as evidence, keeping its exit status.
//   node scripts/save-output.mjs <file> -- <command> [args...]
// stdout and stderr go to the terminal unchanged and, interleaved, to <file>, with secret-shaped values
// redacted (scripts/secret-scan.mjs), then a final line "exit: <code>". This script exits with the
// command's own code (1 if it was killed by a signal), so `save-output … && next` stops on a failing
// test. A redaction is reported on stderr; it never changes the exit code. No shell is involved:
// pipe or filter inside the command (e.g. `-- sh -c '…'`) only if you mean to.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./secret-scan.mjs";

export function run(file, cmd, args, { stdio = process } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (b) => { chunks.push(b); stdio.stdout.write(b); });
    child.stderr.on("data", (b) => { chunks.push(b); stdio.stderr.write(b); });
    const finish = (code, note) => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const text = redact(raw);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${text}${text.endsWith("\n") || !text ? "" : "\n"}exit: ${code}${note ? ` (${note})` : ""}\n`);
      if (text !== raw) stdio.stderr.write(`save-output: redacted secret-shaped values in ${file}\n`);
      resolve(code);
    };
    child.on("error", (e) => finish(127, e.message));
    child.on("close", (code, signal) => finish(code ?? 1, signal ? `signal ${signal}` : ""));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, sep, cmd, ...args] = process.argv.slice(2);
  if (!file || sep !== "--" || !cmd) {
    process.stderr.write("usage: node scripts/save-output.mjs <file> -- <command> [args...]\n");
    process.exit(2);
  }
  process.exitCode = await run(file, cmd, args);
}
