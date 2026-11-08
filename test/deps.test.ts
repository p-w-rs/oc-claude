import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore: build tooling is deliberately plain JavaScript for Pixi bootstrap.
import { ensureDependencies } from "../scripts/deps.mjs";

test("routine dependency preparation adopts a locked install and never reinstalls it", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-claude-deps-"));
  try {
    const packages = { "node_modules/example": { version: "1.0.0", integrity: "sha512-test" } };
    await mkdir(join(root, "node_modules", "example"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { example: "1.0.0" } }));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages }));
    await writeFile(join(root, "node_modules", ".package-lock.json"), JSON.stringify({ packages }));
    await writeFile(join(root, "node_modules", "example", "package.json"), '{"version":"1.0.0"}');
    let reinstalls = 0;
    const run = () => { reinstalls++; };
    assert.equal(await ensureDependencies(root, { run }), "prepared");
    assert.equal(await ensureDependencies(root, { run }), "unchanged");
    assert.equal(reinstalls, 0);
    await writeFile(join(root, "node_modules", "example", "package.json"), '{"version":"2.0.0"}');
    await assert.rejects(ensureDependencies(root, { run }), /deps-update/);
    assert.equal(reinstalls, 0);
    assert.equal(await readFile(join(root, "node_modules", "example", "package.json"), "utf8"), '{"version":"2.0.0"}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
