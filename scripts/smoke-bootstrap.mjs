import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { parse } from "jsonc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "open-claude-bootstrap-"));
const run = (command, args, cwd = root, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout);
  return result.stdout;
};
try {
  const artifact = JSON.parse(run(process.execPath, ["scripts/release-archive.mjs", join(directory, "artifacts")]));
  const contents = run("tar", ["-tzf", artifact.archive]).trim().split("\n");
  assert.ok(!contents.some(path => /\/(?:node_modules|\.pixi|\.git|test-results|dist)\//.test(path)), "Source archive included local/generated files");
  const extracted = join(directory, "extracted");
  await mkdir(extracted);
  run("tar", ["-xzf", artifact.archive, "-C", extracted]);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const source = join(extracted, `open-claude-${pkg.version}`);
  const env = { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state") };
  console.log(run("pixi", ["run", "--locked", "install"], source, env).trim());
  const config = parse(await readFile(join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), "utf8"));
  const plugin = config.plugins[0];
  assert.ok(plugin.startsWith(join(env.XDG_DATA_HOME, "open-claude", "releases")));
  console.log(run(process.execPath, ["scripts/smoke-opencode.mjs", "--plugin", plugin], source, env).trim());
  console.log("PASS: clean source archive → Pixi bootstrap → immutable installation → native host provider loading.");
} finally { await rm(directory, { recursive: true, force: true }); }
