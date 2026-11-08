import { spawn, type ChildProcess } from "node:child_process";
import type { Credential, Integration } from "@opencode/plugin";
import { childEnvironment, configDirectory, runtimePath } from "./runtime.js";
import { spawnSupervised, stopChild } from "./process.js";

export const PROVIDER_ID = "open-claude";
export const METHOD_ID = "claude-code";
export const marker = (): Credential.OAuth => ({
  type: "oauth", methodID: METHOD_ID as Integration.MethodID,
  access: "managed-by-bundled-claude-code", refresh: "managed-by-bundled-claude-code",
  expires: Date.now() + 365 * 24 * 60 * 60_000,
});

export class Login {
  private child?: ChildProcess;
  private cancelCurrent?: () => void;
  private readonly stopping = new Set<Promise<void>>();
  constructor(private readonly launch?: typeof spawn, private readonly timeoutMs = 10 * 60_000) {}

  async cancel(): Promise<void> { this.cancelCurrent?.(); await Promise.all(this.stopping); }

  async authorize() {
    await Promise.all(this.stopping);
    if (this.child) throw new Error("A Claude Code sign-in is already running. Finish it or cancel first.");
    const env = childEnvironment();
    const child = (this.launch || spawnSupervised)(runtimePath(), ["auth", "login", "--claudeai"], {
      cwd: configDirectory(), env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let text = "";
    let submitted = false;
    let resolveURL!: (url: string) => void;
    let rejectURL!: (error: Error) => void;
    const url = new Promise<string>((resolve, reject) => { resolveURL = resolve; rejectURL = reject; });
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // The process can fail while the user is still reading the URL.
    void done.catch(() => {});
    const cleanup = () => {
      clearTimeout(timer);
      if (this.child === child) {
        this.child = undefined;
        this.cancelCurrent = undefined;
      }
    };
    const fail = (message: string) => {
      const error = new Error(message);
      rejectURL(error);
      rejectDone(error);
      const stopped = stopChild(child);
      this.stopping.add(stopped);
      void stopped.finally(() => this.stopping.delete(stopped));
      cleanup();
    };
    const timer = setTimeout(() => fail("Claude Code sign-in expired. Start /connect again."), this.timeoutMs);
    timer.unref();
    this.cancelCurrent = () => fail("Claude Code sign-in cancelled");
    const output = (chunk: Buffer) => {
      text = (text + chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).slice(-65536);
      if (submitted && /invalid code|authentication failed|token exchange failed/i.test(text)) {
        fail("Claude Code rejected the authorization code. Start /connect again.");
        return;
      }
      for (const match of text.matchAll(/https:\/\/[^\s<>"']+(?=\s)/g)) {
        try {
          const candidate = new URL(match[0]);
          if (["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(candidate.hostname) && /oauth|authorize/.test(candidate.pathname)) {
            resolveURL(candidate.href);
          }
        } catch { /* incomplete chunk */ }
      }
    };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    child.stdin?.on("error", () => {});
    child.once("error", () => fail("Cannot start bundled Claude Code sign-in. Run pixi run doctor."));
    child.once("exit", (code) => {
      if (code === 0) {
        resolveDone();
        rejectURL(new Error("Sign-in completed without an authorization URL; try /connect again."));
      } else {
        const error = new Error("Claude Code sign-in failed. Start /connect again.");
        rejectDone(error);
        rejectURL(error);
      }
      cleanup();
    });
    const authorizeURL = await url;
    const common = {
      url: authorizeURL,
      instructions: "Sign in in your browser using Claude Code's own OAuth/SSO flow. Tokens stay in the bundled runtime's isolated store.",
      expiresAt: Date.now() + this.timeoutMs,
    };
    // Loopback redirects complete in the CLI itself. OOB redirects need the
    // host's native code-entry form. Do not force a code prompt after a browser
    // flow has already completed, or require the user to invent a code.
    const redirect = new URL(authorizeURL).searchParams.get("redirect_uri");
    let automatic = false;
    if (redirect) {
      try {
        const callback = new URL(redirect);
        automatic = ["http:", "https:"].includes(callback.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname);
      } catch { /* OOB redirect */ }
    }
    if (automatic) {
      const callback = done.then(() => marker());
      void callback.catch(() => {});
      return { ...common, mode: "auto" as const, callback };
    }
    return {
      ...common,
      mode: "code" as const,
      instructions: `${common.instructions} Paste the authorization code shown by the browser.`,
      callback: async (code: string) => {
        if (submitted) throw new Error("An authorization code is already being verified");
        if (code.length > 16384 || /[\r\n]/.test(code)) {
          fail("Invalid authorization code format. Start /connect again.");
          await done;
        }
        submitted = true;
        text = "";
        if (child.exitCode === null) child.stdin?.write(`${code.trim()}\n`);
        await done;
        return marker();
      },
    };
  }
}
