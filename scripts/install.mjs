import { mkdir, readFile, writeFile, copyFile, rename, chmod, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";
import { deploy, releaseDirectory, verifyRelease } from "./deploy.mjs";
import { checkHost } from "./preflight.mjs";

// Local directory plugins are idiomatic V2. Activate a verified snapshot without
// changing the model selection, unrelated settings, or an in-flight artifact.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uninstall = process.argv.includes("--uninstall");
const allowed = new Set(["--dev", "--rollback", "--uninstall"]);
if (process.argv.slice(2).some(arg => !allowed.has(arg))) throw new Error("Usage: install.mjs [--dev | --rollback | --uninstall]");
if (process.argv.slice(2).length > 1) throw new Error("Choose one installation operation at a time");
if (!uninstall) checkHost();
const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
await mkdir(directory, { recursive: true });
const dev = process.argv.includes("--dev");
const rollback = process.argv.includes("--rollback");
if (dev && rollback) throw new Error("Choose either a development link or rollback, not both");
const statePath = join(releaseDirectory(), "installation.json");
const guard = join(directory, ".open-claude-install.lock");
try { await writeFile(guard, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
catch (error) {
  if (error.code === "EEXIST") throw new Error(`Another OpenClaude installation holds ${guard}. If a prior installation crashed, confirm it is no longer running before removing that lock.`);
  throw error;
}

try {
  let path = join(directory, "opencode.jsonc");
  let source;
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try { source = await readFile(join(directory, name), "utf8"); path = join(directory, name); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const existed = source !== undefined;
  source ??= '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid config: ${path}`);
  const plugins = config.plugins ?? [];
  if (!Array.isArray(plugins)) throw new Error(`Expected a V2 plugins array in ${path}; refusing to rewrite it.`);

  let state = {};
  if (!dev) {
    try { state = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (rollback && !state.previous) throw new Error("No previous managed release is available for rollback");
  const target = uninstall ? undefined : dev ? root : rollback ? state.previous : await deploy(root);
  if (rollback) await verifyRelease(target);

  const entryPath = entry => typeof entry === "string" ? entry : entry?.package;
  const owned = plugins.flatMap((entry, index) => {
    const path = entryPath(entry);
    return typeof path === "string" && (path === root || path.startsWith(`${releaseDirectory()}/`)) ? [index] : [];
  });
  const installed = uninstall ? owned.length === 0 : owned.length === 1 && entryPath(plugins[owned[0]]) === target;
  if (!installed) {
    const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let updated = source;
    if (uninstall) {
      for (const index of [...owned].reverse()) updated = applyEdits(updated, modify(updated, ["plugins", index], undefined, format));
    } else if (!Array.isArray(config.plugins)) updated = applyEdits(updated, modify(updated, ["plugins"], [target], format));
    else if (!owned.length) updated = applyEdits(updated, modify(updated, ["plugins", plugins.length], target, format));
    else {
      const first = owned[0];
      updated = applyEdits(updated, modify(updated, typeof plugins[first] === "string" ? ["plugins", first] : ["plugins", first, "package"], target, format));
      for (const index of owned.slice(1).reverse()) updated = applyEdits(updated, modify(updated, ["plugins", index], undefined, format));
    }
    if (existed) {
      if (await readFile(path, "utf8") !== source) throw new Error("OpenCode configuration changed during installation; retry without overwriting it.");
      const backup = `${path}.open-claude-${Date.now()}-${process.pid}.bak`;
      await copyFile(path, backup);
      await chmod(backup, 0o600);
    } else {
      try { await readFile(path); throw new Error("OpenCode configuration appeared during installation; retry without overwriting it."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const temporary = `${path}.open-claude-${process.pid}.tmp`;
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
  if (!dev && !uninstall && state.current !== target) {
    await mkdir(releaseDirectory(), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ current: target, previous: state.current }, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, statePath);
  }
  if (uninstall) {
    console.log(`OpenClaude ${installed ? "already absent" : "removed"} from ${path}`);
    console.log("Credentials, release snapshots, and unrelated settings were preserved. Use /reload if needed.");
  } else {
    console.log(`OpenClaude ${installed ? "already installed" : "installed"} in ${path}`);
    console.log(`Plugin: ${target}${dev ? " (development link)" : " (immutable release snapshot)"}`);
    console.log("OpenCode watches configuration. Use /reload if needed, then /connect → Claude Code (OpenClaude), then /models.");
  }
} finally { await unlink(guard); }
