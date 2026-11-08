import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";

test("installer preserves JSONC, backs up, honors precedence and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-install-"));
  const config = join(directory, "opencode");
  await mkdir(config);
  const source = '{\n  // Keep my configuration\n  "model": "openai/test",\n  "plugins": ["keep-me"],\n}\n';
  await writeFile(join(config, "opencode.jsonc"), source);
  await writeFile(join(config, "opencode.json"), '{"model":"lower-priority"}');
  const install = () => spawnSync(process.execPath, ["scripts/install.mjs", "--dev"], { cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: directory }, encoding: "utf8" });
  try {
    const first = install();
    assert.equal(first.status, 0, first.stderr);
    const updated = await readFile(join(config, "opencode.jsonc"), "utf8");
    assert.match(updated, /Keep my configuration/);
    const parsed = parse(updated);
    assert.equal(parsed.model, "openai/test");
    assert.deepEqual(parsed.plugins, ["keep-me", process.cwd()]);
    assert.equal(await readFile(join(config, "opencode.json"), "utf8"), '{"model":"lower-priority"}');
    const backups = (await readdir(config)).filter(name => name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(config, backups[0]!), "utf8"), source);
    assert.equal(install().status, 0);
    assert.equal(await readFile(join(config, "opencode.jsonc"), "utf8"), updated);
    assert.equal((await readdir(config)).filter(name => name.endsWith(".bak")).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("installer refuses malformed config rather than overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-install-invalid-"));
  const config = join(directory, "opencode");
  await mkdir(config);
  await writeFile(join(config, "opencode.jsonc"), "{broken");
  try {
    const result = spawnSync(process.execPath, ["scripts/install.mjs", "--dev"], { env: { ...process.env, XDG_CONFIG_HOME: directory }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(config, "opencode.jsonc"), "utf8"), "{broken");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("uninstall removes only owned entries, preserves options elsewhere and never deletes credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-uninstall-"));
  const config = join(directory, "config", "opencode");
  const data = join(directory, "data");
  const credentialDirectory = join(data, "open-claude", "claude");
  await mkdir(config, { recursive: true });
  await mkdir(credentialDirectory, { recursive: true });
  const path = join(config, "opencode.jsonc");
  const other = { package: "another-plugin", options: { keep: true } };
  await writeFile(path, `// Keep this comment\n${JSON.stringify({ model: "keep/model", plugins: [other, process.cwd(), { package: join(data, "open-claude", "releases", "test"), options: { maxConcurrent: 2 } }] })}`);
  await writeFile(join(credentialDirectory, "fixture"), "synthetic-store-marker");
  const run = () => spawnSync(process.execPath, ["scripts/install.mjs", "--uninstall"], { env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: data }, encoding: "utf8" });
  try {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const updated = await readFile(path, "utf8");
    assert.match(updated, /Keep this comment/);
    assert.deepEqual(parse(updated), { model: "keep/model", plugins: [other] });
    assert.equal(await readFile(join(credentialDirectory, "fixture"), "utf8"), "synthetic-store-marker");
    assert.equal(run().status, 0);
    assert.equal(await readFile(path, "utf8"), updated);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("development install preserves existing object options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-install-options-"));
  const config = join(directory, "opencode");
  await mkdir(config);
  const entry = { package: process.cwd(), options: { maxConcurrent: 2 } };
  await writeFile(join(config, "opencode.jsonc"), JSON.stringify({ plugins: [entry] }));
  try {
    const result = spawnSync(process.execPath, ["scripts/install.mjs", "--dev"], { env: { ...process.env, XDG_CONFIG_HOME: directory }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parse(await readFile(join(config, "opencode.jsonc"), "utf8")).plugins, [entry]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
