import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { spawnSupervised, stopChild } from "./process.js";

export function runtimePath(): string {
  const suffix = process.platform === "win32" ? "claude.exe" : "claude";
  const platform = `${process.platform}-${process.arch}`;
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${platform}/${suffix}`);
  } catch {
    throw new Error(`Bundled Claude Code missing for ${platform}. Run pixi run deps (optional dependencies must be enabled).`);
  }
}

export function configDirectory(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "open-claude", "claude");
}

// Deliberately do not inherit API keys, SDK flags, NODE_OPTIONS, or Claude's
// project settings. Login and inference use the SAME isolated credential store.
export function childEnvironment(configDir = configDirectory()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "TZ",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_SAFE_MODE: "1",
  };
}

export function runtimeArguments(model: string): string[] {
  return [
    "--print", "--output-format", "json", "--model", model,
    "--safe-mode", "--tools", "", "--permission-mode", "dontAsk",
    "--disable-slash-commands", "--no-session-persistence", "--no-chrome",
    "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--system-prompt", "Transport only. Reply OK.",
  ];
}

export function startRuntime(baseURL: string, model: string, cwd: string, configDir?: string): ChildProcess {
  return spawnSupervised(runtimePath(), runtimeArguments(model), {
    cwd,
    env: { ...childEnvironment(configDir), ANTHROPIC_BASE_URL: baseURL },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function authStatus(): { loggedIn: boolean; authMethod?: string } {
  const result = spawnSync(runtimePath(), ["auth", "status", "--json"], {
    cwd: configDirectory(), env: childEnvironment(), encoding: "utf8", timeout: 15_000,
  });
  if (result.error) throw result.error;
  try {
    const parsed = JSON.parse(result.stdout);
    return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod };
  } catch {
    return { loggedIn: false };
  }
}

export async function authStatusAsync(): Promise<{ loggedIn: boolean; authMethod?: string }> {
  const env = childEnvironment();
  const child = spawn(runtimePath(), ["auth", "status", "--json"], {
    cwd: configDirectory(), env, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { void stopChild(child); reject(error); return; }
      try {
        const value = JSON.parse(output);
        if (typeof value.loggedIn !== "boolean") throw new Error();
        resolve({ loggedIn: value.loggedIn, ...(typeof value.authMethod === "string" ? { authMethod: value.authMethod } : {}) });
      } catch { reject(new Error("Bundled Claude Code did not return a valid sign-in status. Run pixi run doctor.")); }
    };
    const timer = setTimeout(() => finish(new Error("Bundled Claude Code sign-in check timed out")), 15_000);
    timer.unref();
    child.stdout.on("data", chunk => {
      if (output.length + chunk.length > 64 * 1024) finish(new Error("Bundled Claude Code returned an oversized sign-in status"));
      else output += chunk.toString();
    });
    child.stderr.resume();
    child.once("error", () => finish(new Error("Cannot start bundled Claude Code sign-in check")));
    child.once("close", () => finish());
  });
}
