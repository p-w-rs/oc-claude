import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function checkHost({ platform = process.platform, arch = process.arch, run = spawnSync, candidates } = {}) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported platform ${platform}-${arch}. OpenClaude requires macOS or Linux on arm64/x64; Windows is not supported.`);
  }
  if (!candidates) {
    candidates = ["opencode"];
    if (platform === "darwin") {
      const desktop = join(homedir(), "Library/Application Support/ai.opencode.desktop/cli");
      try { candidates.unshift(...readdirSync(desktop).sort().reverse().map(name => join(desktop, name, "opencode-cli"))); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  let found;
  for (const command of candidates) {
    const result = run(command, ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status !== 0) continue;
    const version = String(result.stdout).trim();
    found = version;
    const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/.exec(version);
    if (match && Number(match[1]) === 2 && (Number(match[2]) > 0 || Number(match[3]) >= 18)) return { version, command, platform: `${platform}-${arch}` };
  }
  if (found !== undefined) throw new Error(`OpenClaude requires OpenCode V2 >= 2.0.18 (found ${found.slice(0, 100)}). No configuration was changed.`);
  throw new Error("OpenCode V2 is not available on PATH or in the Desktop CLI directory. Install it from https://opencode.ai/docs/ and retry. No configuration was changed.");
}
