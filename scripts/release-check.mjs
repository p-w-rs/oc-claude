import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const checks = [
  ["types", "npm", ["run", "check"]],
  ["offline tests", "npm", ["test"]],
  ["real host protocol round trip", process.execPath, ["scripts/smoke-opencode.mjs", "--offline"]],
  ...["truncated", "stalled", "disconnected"].map(fault => [`native host ${fault} stream`, process.execPath, ["scripts/smoke-opencode.mjs", `--fault=${fault}`]]),
  ["production archive", process.execPath, ["scripts/smoke-package.mjs"]],
  ["immutable install and rollback", process.execPath, ["scripts/smoke-deployment.mjs"]],
  ["production dependency audit", "npm", ["audit", "--omit=dev", "--audit-level=low"]],
];
const results = [];
for (const [name, command, args] of checks) {
  console.log(`\nRelease check: ${name}`);
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 240_000 });
  results.push({ name, passed: !result.error && result.status === 0, durationMs: Date.now() - started });
  if (result.error || result.status !== 0) break;
}
await mkdir("test-results", { recursive: true });
await writeFile(join("test-results", "release-check.json"), JSON.stringify({ date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, results }, null, 2) + "\n");
if (results.length !== checks.length || results.some(result => !result.passed)) process.exitCode = 1;
else console.log("\nAll offline release checks passed. Live and platform-specific validation remain separate gates.");
