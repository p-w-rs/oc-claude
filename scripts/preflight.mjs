import { spawnSync } from "node:child_process";

export function checkHost({ platform = process.platform, arch = process.arch, run = spawnSync } = {}) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported platform ${platform}-${arch}. OpenClaude requires macOS or Linux on arm64/x64; Windows is not supported.`);
  }
  const result = run("opencode", ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error("OpenCode V2 is not available on PATH. Install it from https://opencode.ai/v2/docs/ and retry. No configuration was changed.");
  const version = result.stdout.trim();
  const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/.exec(version);
  if (!match || Number(match[1]) !== 2 || (Number(match[2]) === 0 && Number(match[3]) < 18)) {
    throw new Error(`OpenClaude requires OpenCode V2 >= 2.0.18 (found ${version.slice(0, 100)}). No configuration was changed.`);
  }
  return { version, platform: `${platform}-${arch}` };
}
