import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startRuntime } from "./runtime.js";
import { providePrompt, stopChild } from "./process.js";
import { StreamCompletion } from "./stream.js";

const MAX_BODY = 32 * 1024 * 1024;
const UPSTREAM = "https://api.anthropic.com/v1/messages?beta=true";
const token = () => randomBytes(32).toString("hex");
type Json = Record<string, unknown>;

export interface BridgeOptions {
  cwd: string;
  configDir?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  // Dependency injection only: never configurable through the plugin or HTTP.
  launch?: typeof startRuntime;
  upstream?: (request: Request) => Promise<Response>;
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", failed);
      req.removeListener("aborted", aborted);
      if (error) { req.once("error", () => {}); req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) finish(new BodyError(413, "Request exceeds 32 MiB"));
      else chunks.push(Buffer.from(chunk));
    };
    const end = () => finish();
    const failed = () => finish(new BodyError(400, "Request body could not be read"));
    const aborted = () => finish(new BodyError(400, "Request body was interrupted"));
    const timer = setTimeout(() => finish(new BodyError(408, "Request body timed out")), 30_000);
    timer.unref();
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    req.once("aborted", aborted);
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) finish(new BodyError(413, "Request exceeds 32 MiB"));
  });
}

function error(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    if (String(res.getHeader("content-type")).includes("text/event-stream")) {
      res.end(`\n\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`);
    } else res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status === 400 ? "invalid_request_error" : status === 413 ? "request_too_large" : "api_error";
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

export function requestHeaders(runtime: IncomingMessage["headers"], native: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  const hop = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "cookie", "x-open-claude-token",
    ...String(runtime.connection || "").split(",").map(name => name.trim().toLowerCase())]);
  // Only the CLI supplies credentials. Never use the OpenCode connection marker
  // or the loopback capability as upstream authentication.
  for (const [name, value] of Object.entries(runtime)) {
    if (value !== undefined && !hop.has(name) && !name.startsWith("x-opencode-")) {
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
  }
  const betas = new Set(`${headers.get("anthropic-beta") || ""},${native["anthropic-beta"] || ""}`.split(",").map(s => s.trim()).filter(Boolean));
  if (betas.size) headers.set("anthropic-beta", [...betas].join(","));
  headers.set("content-type", "application/json");
  headers.set("accept-encoding", "identity");
  return headers;
}

// OpenCode's instructions/history are authoritative. Retain only the runtime's
// account attribution and billing-attribution block. Live subscription requests
// without that block returned 429; retaining it alone succeeded, with no Claude
// agent identity or coding instructions. Never synthesize vendor attribution.
export function upstreamBody(native: Json, runtime: Json): Json {
  const metadata = runtime.metadata as Json | undefined;
  const attribution = (Array.isArray(runtime.system) ? runtime.system : []).flatMap((block: Json) =>
    block.type === "text" && typeof block.text === "string" && block.text.startsWith("x-anthropic-billing-header:")
      ? [{ type: "text", text: block.text }] : [],
  );
  const system = typeof native.system === "string" ? [{ type: "text", text: native.system }] : (native.system ?? []);
  return {
    ...native,
    ...(attribution.length ? { system: [...attribution, ...(system as unknown[])] } : {}),
    ...(typeof metadata?.user_id === "string" ? {
      metadata: { ...(native.metadata as Json | undefined), user_id: metadata.user_id },
    } : {}),
  };
}

function finishRuntime(res: ServerResponse, model: string): void {
  // The actual response goes ONLY to OpenCode. Giving the CLI a terminal dummy
  // answer ensures it never sees or executes OpenCode's tool calls.
  const message = { id: "msg_transport", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } });
  emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } });
  emit("content_block_stop", { type: "content_block_stop", index: 0 });
  emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
  emit("message_stop", { type: "message_stop" });
  res.end();
}

export async function startBridge(options: BridgeOptions) {
  const secret = token();
  interface Pending {
    native: Json;
    headers: IncomingMessage["headers"];
    output: ServerResponse;
    controller: AbortController;
    claimed: boolean;
    refreshOffered: boolean;
    authenticationFailure?: { status: number; headers: Record<string, string>; body: Buffer };
    touch: (message: string, timeoutMs: number) => void;
    child?: ChildProcess;
    finish: () => void;
  }
  const pending = new Map<string, Pending>();
  const stopping = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let reading = 0;
  let baseURL = "";

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => error(res, 502, "Claude Code transport failed; run pixi run doctor."));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url || "").split("?")[0];
    const runtimeID = /^\/runtime\/([a-f0-9]{64})\/v1\/messages$/.exec(path || "")?.[1];
    if (runtimeID) {
      const task = pending.get(runtimeID);
      if (!task || task.claimed || req.method !== "POST") return error(res, 403, "Expired runtime capability");
      task.claimed = true; // at most ONE upstream request per OpenCode call
      task.touch("Claude Code upstream stopped responding", options.idleTimeoutMs ?? 120_000);
      try {
        const runtime = JSON.parse((await body(req)).toString()) as Json;
        const request = new Request(UPSTREAM, {
          method: "POST", headers: requestHeaders(req.headers, task.headers),
          body: JSON.stringify(upstreamBody(task.native, runtime)), signal: task.controller.signal,
          redirect: "error", // never redirect credentials
        });
        const response = await (options.upstream || fetch)(request);
        const headers: Record<string, string> = {};
        for (const [name, value] of response.headers) {
          if (["content-type", "request-id", "retry-after"].includes(name) || name.startsWith("anthropic-ratelimit-")) headers[name] = value;
        }
        headers["cache-control"] = "no-store";
        // A 401 cannot have generated a response. Let the official runtime
        // handle/refresh its own credentials ONCE before exposing the failure.
        // Rate limits, inference errors, and partial streams are never retried
        // here. Once an authenticated response is obtained, the capability is
        // permanently consumed and only OpenCode may decide about retries.
        if (response.status === 401 && !task.refreshOffered) {
          task.refreshOffered = true;
          const chunks: Buffer[] = [];
          let size = 0;
          if (response.body) for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 256 * 1024) throw new Error("Oversized authentication error");
            chunks.push(Buffer.from(chunk));
          }
          task.authenticationFailure = { status: 401, headers, body: Buffer.concat(chunks) };
          task.claimed = false;
          task.touch("Claude Code credential refresh did not complete", options.startupTimeoutMs ?? 60_000);
          res.writeHead(401, headers);
          res.end(task.authenticationFailure.body);
          return;
        }
        finishRuntime(res, task.native.model as string);
        task.authenticationFailure = undefined;
        const completion = response.ok && headers["content-type"]?.includes("text/event-stream") ? new StreamCompletion() : undefined;
        for (const [name, value] of Object.entries(headers)) task.output.setHeader(name, value);
        task.output.writeHead(response.status);
        if (response.body) {
          for await (const chunk of response.body) {
            if (task.controller.signal.aborted) break;
            task.touch("Claude Code upstream stream stalled", options.idleTimeoutMs ?? 120_000);
            completion?.push(chunk);
            if (!task.output.write(chunk)) await once(task.output, "drain", { signal: task.controller.signal });
          }
        }
        if (completion && !completion.finish()) error(task.output, 502, "Anthropic stream ended before message_stop; the response is incomplete.");
        else task.output.end();
      } catch {
        error(res, 502, "Upstream transport failed");
        error(task.output, 502, "Claude Code upstream transport failed");
      } finally {
        if (task.claimed) task.finish();
      }
      return;
    }

    if (req.headers["x-open-claude-token"] !== secret) return error(res, 401, "Invalid loopback capability");
    if (req.method !== "POST" || path !== "/v1/messages") return error(res, 404, "Not found");
    if (closed) return error(res, 503, "Plugin unloading");
    if (pending.size + reading >= (options.maxConcurrent ?? 8)) {
      res.setHeader("retry-after", "1");
      return error(res, 429, "Claude Code transport is busy");
    }
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") return error(res, 415, "Use settings.encoding: none");
    let native: Json;
    reading++;
    try {
      native = JSON.parse((await body(req)).toString());
      if (!native || typeof native.model !== "string" || !native.model || native.model.length > 200 || !Array.isArray(native.messages) ||
        (native.system !== undefined && typeof native.system !== "string" && !Array.isArray(native.system))) throw new Error();
    } catch (failure) {
      if (failure instanceof BodyError) return error(res, failure.status, failure.message);
      return error(res, 400, "Expected an Anthropic Messages request (maximum 32 MiB)");
    } finally {
      reading--;
    }
    if (closed || res.destroyed) return error(res, 503, "Plugin unloading");
    if (pending.size >= (options.maxConcurrent ?? 8)) return error(res, 429, "Claude Code transport is busy");
    const id = token();
    const controller = new AbortController();
    let finished = false;
    let activity: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      error(res, 504, "Claude Code request timed out. Check /connect and pixi run doctor.");
      task.finish();
    }, options.timeoutMs ?? 15 * 60_000);
    timer.unref();
    const task: Pending = {
      native, headers: req.headers, output: res, controller, claimed: false, refreshOffered: false,
      touch(message, timeoutMs) {
        clearTimeout(activity);
        activity = setTimeout(() => {
          if (task.authenticationFailure) {
            const failure = task.authenticationFailure;
            if (!res.headersSent && !res.destroyed) { res.writeHead(failure.status, failure.headers); res.end(failure.body); }
          } else error(res, 504, message);
          task.finish();
        }, timeoutMs);
        activity.unref();
      },
      finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(activity);
        controller.abort();
        pending.delete(id);
        const child = task.child;
        if (child && child.exitCode === null) {
          const stopped = stopChild(child);
          stopping.add(stopped);
          void stopped.finally(() => stopping.delete(stopped));
        }
      },
    };
    pending.set(id, task);
    task.touch("Bundled Claude Code did not dispatch a request. Check sign-in with pixi run status.", options.startupTimeoutMs ?? 60_000);
    res.once("close", task.finish);
    try {
      task.child = (options.launch || startRuntime)(`${baseURL}/runtime/${id}`, native.model as string, options.cwd, options.configDir);
      let authenticationError = false;
      const classify = (chunk: Buffer) => {
        // Retain only a boolean classification, never stderr, URLs or tokens.
        if (/not logged in|invalid api key|authentication failed|login required|please (?:run|use).*login/i.test(chunk.toString())) authenticationError = true;
      };
      task.child.stdout?.on("data", classify);
      task.child.stderr?.on("data", classify);
      task.child.once("error", () => {
        error(res, 502, "Cannot start bundled Claude Code. Run pixi run doctor.");
        task.finish();
      });
      task.child.once("exit", () => {
        // The dummy answer lets the CLI exit while OpenCode still consumes the
        // upstream stream. Only exit BEFORE dispatch means a runtime failure.
        if (!task.claimed && !finished) {
          if (task.authenticationFailure) {
            const failure = task.authenticationFailure;
            if (!res.destroyed) { res.writeHead(failure.status, failure.headers); res.end(failure.body); }
          } else error(res, authenticationError ? 401 : 502, "Claude Code exited before dispatch. Sign in using /connect → OpenClaude. If already signed in, run pixi run doctor.");
          task.finish();
        }
      });
      task.child.stdin?.on("error", () => {});
      providePrompt(task.child);
    } catch {
      error(res, 502, "Bundled Claude Code unavailable. Run pixi run deps.");
      task.finish();
    }
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  baseURL = `http://127.0.0.1:${address.port}`;
  return {
    baseURL, secret,
    close() {
      return closing ??= (async () => {
      closed = true;
      for (const task of pending.values()) {
        error(task.output, 503, "Plugin unloaded");
        task.finish();
      }
      const stopped = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      server.closeAllConnections();
      await stopped;
      await Promise.all(stopping);
      })();
    },
  };
}
