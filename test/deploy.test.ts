import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore: bootstrap/deployment stays runnable without TypeScript tooling.
import { deploy, verifyRelease } from "../scripts/deploy.mjs";

test("deploy creates independent content-addressed snapshots without mutating the prior release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-deploy-"));
  const root = join(directory, "source");
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(directory, "data");
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "docs"));
    const pkg = { name: "open-claude-deployment-test", version: "1.0.0", type: "module", private: true };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version } } }));
    await writeFile(join(root, "dist", "runtime.js"), "export const runtimePath=()=>process.execPath;\n");
    await writeFile(join(root, "dist", "plugin.js"), "export default {id:'original'};\n");
    await writeFile(join(root, "server.ts"), "export {default} from './dist/plugin.js';\n");
    await writeFile(join(root, "README.md"), "Deployment fixture\n");
    await writeFile(join(root, "CHANGELOG.md"), "Deployment changes\n");
    await writeFile(join(root, "docs", "test.md"), "Fixture\n");
    const first = await deploy(root);
    assert.ok(first.startsWith(join(directory, "data")));
    assert.equal(await deploy(root), first);
    await writeFile(join(root, "dist", "plugin.js"), "export default {id:'updated'};\n");
    const second = await deploy(root);
    assert.notEqual(first, second);
    assert.match(await readFile(join(first, "dist", "plugin.js"), "utf8"), /original/);
    assert.match(await readFile(join(second, "dist", "plugin.js"), "utf8"), /updated/);
    await verifyRelease(first);
    await verifyRelease(second);
    await writeFile(join(second, "dist", "plugin.js"), "tampered");
    await assert.rejects(verifyRelease(second), /modified/);
    await assert.rejects(deploy(root), /modified/);
    assert.ok(!(await readdir(join(directory, "data", "open-claude", "releases"))).some(name => name.startsWith(".staging-")));
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
