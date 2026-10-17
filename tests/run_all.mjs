// Runs every automated check: model parity with the Windows app's Python model (if that folder is next to this one),
// then the four end-to-end suites in a real headless Chromium.   Usage:  node tests/run_all.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname), desktop = path.resolve(here, "../../DualNote");
let failed = 0;
const run = (title, cmd, args, opts = {}) => {
  console.log(`\n######## ${title}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: here, ...opts });
  if (r.status !== 0) { failed++; console.log(`>>> ${title}: FAILED`); }
};
if (fs.existsSync(path.join(desktop, "model.py"))) {
  const gen = spawnSync("python3", ["parity_gen.py"], { cwd: here, encoding: "utf-8", maxBuffer: 1 << 28 });
  if (gen.status === 0) { fs.writeFileSync("/tmp/parity.json", gen.stdout); run("model parity (JavaScript vs the Windows app's Python)", "node", ["parity.mjs", "/tmp/parity.json"]); }
  else console.log("parity: skipped (python3 not available)");
} else console.log("parity: skipped (Windows app folder 'DualNote' not found next to this folder)");
for (const f of ["e2e1", "e2e2", "e2e3", "e2e4"]) run(f, "node", [`${f}.mjs`]);
console.log(failed ? `\n${failed} suite(s) FAILED` : "\nALL SUITES PASSED");
process.exit(failed ? 1 : 0);
