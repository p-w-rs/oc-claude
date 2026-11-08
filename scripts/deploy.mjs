import { mkdir, readFile, writeFile, rename, cp, readdir, stat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const releaseDirectory = () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "open-claude", "releases");

export async function verifyRelease(target) {
  const manifest = JSON.parse(await readFile(join(target, ".open-claude-release.json"), "utf8"));
  for (const [file, expected] of Object.entries(manifest.files || {})) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Invalid path in release integrity manifest");
    const actual = createHash("sha256").update(await readFile(join(target, file))).digest("hex");
    if (actual !== expected) throw new Error(`Installed release has been modified (${file}); refusing to overwrite or activate it.`);
  }
  if (!manifest.files || !manifest.files["dist/plugin.js"]) throw new Error("Release integrity manifest is incomplete");
  return manifest;
}

async function files(root, directory = "dist") {
  const result = [];
  for (const entry of (await readdir(join(root, directory))).sort()) {
    const path = join(directory, entry);
    if ((await stat(join(root, path))).isDirectory()) result.push(...await files(root, path));
    else result.push(path);
  }
  return result;
}

export async function deploy(root) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const entries = ["package.json", "package-lock.json", "server.ts", "README.md", "CHANGELOG.md", ...await files(root), ...await files(root, "docs")];
  const hash = createHash("sha256").update(`${process.platform}-${process.arch}`);
  for (const file of entries) hash.update(file).update(await readFile(join(root, file)));
  const fingerprint = hash.digest("hex");
  const directory = releaseDirectory();
  const target = join(directory, `${pkg.version}-${fingerprint.slice(0, 20)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const manifest = await verifyRelease(target);
    if (manifest.fingerprint !== fingerprint) throw new Error("Release snapshot fingerprint mismatch");
    return target;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const staging = join(directory, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const file of entries) {
      await mkdir(join(staging, file, ".."), { recursive: true });
      await cp(join(root, file), join(staging, file));
    }
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging, stdio: "inherit" });
    if (result.error || result.status !== 0) throw result.error || new Error(`Release dependency installation failed (${result.status})`);
    const runtime = await import(pathToFileURL(join(staging, "dist/runtime.js")).href);
    const version = spawnSync(runtime.runtimePath(), ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (version.error || version.status !== 0) throw new Error("Release's own bundled runtime failed verification");
    const checksums = Object.fromEntries(await Promise.all(entries.map(async file => [file, createHash("sha256").update(await readFile(join(staging, file))).digest("hex")])));
    const bundled = relative(staging, runtime.runtimePath());
    if (!bundled.startsWith("..") && !isAbsolute(bundled)) checksums[bundled] = createHash("sha256").update(await readFile(join(staging, bundled))).digest("hex");
    await writeFile(join(staging, ".open-claude-release.json"), JSON.stringify({ fingerprint, files: checksums, version: pkg.version, runtime: version.stdout.trim(), source: root }, null, 2) + "\n", { mode: 0o600 });
    try { await rename(staging, target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      const existing = await verifyRelease(target);
      if (existing.fingerprint !== fingerprint) throw new Error("Conflicting release appeared during installation");
      await rm(staging, { recursive: true, force: true });
    }
    return target;
  } catch (error) {
    // Only this invocation's unique incomplete staging directory is removed.
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
