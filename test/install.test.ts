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
