import { readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const json = async path => JSON.parse(await readFile(path, "utf8"));
const exists = async path => { try { await readFile(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

export async function ensureDependencies(root, { refresh = false, run } = {}) {
  const packageText = await readFile(join(root, "package.json"), "utf8");
  const lockText = await readFile(join(root, "package-lock.json"), "utf8");
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  const fingerprint = createHash("sha256").update(packageText).update(lockText).update(`${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`).digest("hex");
  const stamp = join(root, "node_modules", ".open-claude-deps.json");
  const healthy = async () => {
    try {
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if ((await json(join(root, "node_modules", name, "package.json"))).version !== lock.packages[`node_modules/${name}`]?.version) return false;
      }
      const installed = await json(join(root, "node_modules", ".package-lock.json"));
      return Object.entries(installed.packages).every(([key, value]) => {
        const expected = lock.packages[key];
        return expected && value.version === expected.version && value.integrity === expected.integrity;
      });
    } catch { return false; }
  };
  if (!refresh && await exists(stamp) && (await json(stamp)).fingerprint === fingerprint && await healthy()) return "unchanged";
  const guard = join(root, ".open-claude-deps.lock");
  try { await writeFile(guard, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Dependency preparation is already locked (${guard}). If a prior setup crashed, confirm it is no longer running before removing its lock.`); throw error; }
  try {
    if (refresh || !(await exists(join(root, "node_modules", ".package-lock.json")))) {
      // Never replace a working install during an ordinary build/test/login.
      if (!refresh) {
        let entries = [];
        try { entries = await readdir(join(root, "node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (entries.length) throw new Error("Existing node_modules has no npm installation metadata. Refusing to replace it; use pixi run deps-update explicitly.");
      }
      const invoke = run || (() => {
        const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
        if (result.error || result.status !== 0) throw result.error || new Error(`npm ci failed (${result.status})`);
      });
      await invoke();
    }
    if (!(await healthy())) throw new Error("Development dependencies differ from package-lock.json. Run pixi run deps-update to explicitly replace them. Installed release snapshots are separate.");
    const temporary = `${stamp}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ fingerprint }) + "\n");
    await rename(temporary, stamp);
    return "prepared";
  } finally { await unlink(guard); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const state = await ensureDependencies(root, { refresh: process.argv.includes("--refresh") });
  if (state !== "unchanged") console.log("Locked development dependencies are ready.");
}
