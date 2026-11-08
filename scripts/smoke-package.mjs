import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "open-claude-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
try {
  const archive = JSON.parse(run(process.execPath, ["scripts/pack.mjs", directory]))[0];
  if (!archive.files.some(file => file.path === "server.ts")) throw new Error("Early V2 directory entry missing from archive");
  if (!archive.files.some(file => file.path === "npm-shrinkwrap.json")) throw new Error("Archive dependency graph is not pinned");
  const installed = join(directory, "installed");
  await mkdir(installed);
  run(npm, ["install", "--prefix", installed, "--omit=dev", "--ignore-scripts", "--no-audit", join(directory, archive.filename)]);
  const plugin = join(installed, "node_modules", "opencode-open-claude");
  const runtime = await import(pathToFileURL(join(plugin, "dist/runtime.js")));
  const version = run(runtime.runtimePath(), ["--version"]).trim();
  if (!version.includes("2.1.296")) throw new Error("Unexpected bundled version");
  console.log(`Installed archive has its own runtime: ${version}`);
  console.log(run(process.execPath, ["scripts/smoke-opencode.mjs", "--plugin", plugin]).trim());
  console.log("PASS: production-only package install, bundled runtime resolution, and real V2 host loading.");
} finally { await rm(directory, { recursive: true, force: true }); }
