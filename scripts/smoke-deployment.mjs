import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { parse, modify, applyEdits } from "jsonc-parser";
import { verifyRelease } from "./deploy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "open-claude-deployment-smoke-"));
const source = join(directory, "source");
const configHome = join(directory, "config");
const dataHome = join(directory, "data");
const env = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome };
const run = (script, args = []) => {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 120_000, cwd: source });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout);
  return result.stdout;
};
try {
  await mkdir(source);
  for (const path of ["dist", "docs", "scripts", "server.ts", "README.md", "CHANGELOG.md", "package.json", "package-lock.json"]) await cp(join(root, path), join(source, path), { recursive: true });
  // Development-only script dependencies; deployed snapshots install their OWN
  // production modules and must not resolve through this symlink.
  await symlink(join(root, "node_modules"), join(source, "node_modules"), "dir");
  const installer = join(source, "scripts", "install.mjs");
  run(installer);
  const statePath = join(dataHome, "open-claude", "releases", "installation.json");
  const first = JSON.parse(await readFile(statePath, "utf8")).current;
  await verifyRelease(first);
  const configPath = join(configHome, "opencode", "opencode.jsonc");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, applyEdits(config, modify(config, ["username"], "preserve-this-setting", {})));
  await writeFile(join(source, "README.md"), "Independent update artifact\n");
  run(installer);
  const second = JSON.parse(await readFile(statePath, "utf8")).current;
  assert.notEqual(first, second);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).previous, first);
  await verifyRelease(first);
  await verifyRelease(second);
  run(installer, ["--rollback"]);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).current, first);
  const rolledBack = parse(await readFile(configPath, "utf8"));
  assert.equal(rolledBack.username, "preserve-this-setting");
  assert.deepEqual(rolledBack.plugins, [first]);
  console.log(run(join(root, "scripts", "smoke-opencode.mjs"), ["--plugin", first]).trim());
  console.log("PASS: immutable production installation, update, verified rollback, and preservation of unrelated configuration.");
} finally { await rm(directory, { recursive: true, force: true }); }
