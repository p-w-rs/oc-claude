import { spawn, spawnSync } from "node:child_process";
import { childEnvironment, configDirectory, runtimePath, authStatusAsync } from "./runtime.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const command = process.argv[2];
if (command === "login") {
  const env = childEnvironment();
  const child = spawn(runtimePath(), ["auth", "login", "--claudeai"], { cwd: configDirectory(), env, stdio: "inherit" });
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
} else if (command === "status") {
  console.log(JSON.stringify(await authStatusAsync(), null, 2));
} else if (command === "doctor") {
  const env = childEnvironment();
  const result = spawnSync(runtimePath(), ["--version"], { env, encoding: "utf8", timeout: 15_000 });
  const sdkPath = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const sdk = JSON.parse(readFileSync(join(dirname(sdkPath), "package.json"), "utf8"));
  const version = result.stdout?.trim() || "unavailable";
  const matchesPin = version.startsWith(`${sdk.claudeCodeVersion} `);
  const auth = await authStatusAsync().catch(error => ({ loggedIn: null, diagnostic: error.message }));
  console.log(JSON.stringify({
    runtime: runtimePath(), version, sdk: sdk.version, matchesPin, configDirectory: configDirectory(), auth,
    platform: `${process.platform}-${process.arch}`, releaseStatus: "private release candidate; see docs/release-checklist.md",
  }, null, 2));
  if (result.error || result.status !== 0 || !matchesPin) process.exitCode = 1;
} else {
  console.error("Usage: pixi run login | status | doctor");
  process.exitCode = 1;
}
