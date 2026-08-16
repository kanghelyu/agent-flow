// Vendor the dependency-free core modules from the DeepSeek Flow plugin repo
// into agent-flow/lib. These files share one contract: pure ESM, no external
// dependencies, identical gate semantics on both sides.
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sourceRoot = process.env.DFLOW_SOURCE_ROOT
  ?? join(process.env.TMPDIR || "/tmp", "dsh-deepseek-flow-review");
const here = dirname(fileURLToPath(import.meta.url));
const targetLib = join(here, "..", "lib");

const MODULES = [
  "condition-gates.js",
  "logic-semantics.js",
  "topology-model.js",
  "flow-validation.js",
  "document-workflow.js"
];

await mkdir(targetLib, { recursive: true });
for (const name of MODULES) {
  await copyFile(join(sourceRoot, "lib", name), join(targetLib, name));
  console.log(`vendored ${name}`);
}
