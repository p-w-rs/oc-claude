import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, upstreamBody, requestHeaders } from "../src/bridge.js";
import { runtimeArguments, runtimePath, childEnvironment } from "../src/runtime.js";

const native = {
  model: "claude-sonnet-4-6", max_tokens: 1024, stream: true,
  system: [{ type: "text", text: "ONLY OpenCode system instructions", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Inspect the image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "sig" }, { type: "tool_use", id: "tool_1", name: "read", input: { path: "hello" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", is_error: true, content: "Denied" }] },
  ],
  tools: [{ name: "read", description: "OpenCode read", input_schema: { type: "object" } }],
  thinking: { type: "adaptive" }, output_config: { effort: "high" },
};
const wire = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

test("native body is lossless; only CLI account attribution is retained", () => {
  assert.deepEqual(upstreamBody(native, { system: "BAD", tools: ["Bash"], messages: ["BAD"], metadata: { user_id: "account", other: "BAD" } }), {
    ...native, metadata: { user_id: "account" },
  });
  assert.deepEqual(upstreamBody(native, {}), native);
});

test("retains genuine runtime billing attribution, not Claude identity/instructions", () => {
  const billing = { type: "text", text: "x-anthropic-billing-header: cc_version=offline; cc_entrypoint=sdk-cli;" };
  assert.deepEqual(upstreamBody(native, { system: [billing,
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    { type: "text", text: "Transport only. Reply OK." },
  ] }), { ...native, system: [billing, ...native.system] });
  assert.deepEqual(upstreamBody({ ...native, system: "Native instructions" }, { system: [billing] }).system,
    [billing, { type: "text", text: "Native instructions" }]);
});

test("headers use CLI credentials and union native beta flags", () => {
  const result = requestHeaders({ authorization: "Bearer cli", host: "localhost", "content-length": "7", "anthropic-beta": "oauth,thinking" }, {
    authorization: "Bearer WRONG", "x-open-claude-token": "WRONG", "anthropic-beta": "thinking,tools",
  });
  assert.equal(result.get("authorization"), "Bearer cli");
  assert.equal(result.get("x-open-claude-token"), null);
  assert.equal(result.get("host"), null);
  assert.equal(result.get("content-length"), null);
  assert.equal(result.get("anthropic-beta"), "oauth,thinking,tools");
});

function fakeLaunch(baseURL: string) {
  // An actual subprocess exercises capability routing and lifecycle, without
  // ever using real credentials. It deliberately attempts a duplicate call.
  return spawn(process.execPath, ["--input-type=module", "-e", `
    const url = ${JSON.stringify(baseURL)} + '/v1/messages';
    const first = await fetch(url, {method:'POST',headers:{authorization:'Bearer fake-cli'},body:JSON.stringify({metadata:{user_id:'account'}})});
    await first.text();
    const second = await fetch(url, {method:'POST',body:'{}'});
    if (second.status !== 403) process.exitCode = 2;
  `], { stdio: ["pipe", "pipe", "pipe"] });
}

test("loopback authentication, validation, byte-exact SSE, and single dispatch", async () => {
  let calls = 0;
  const bridge = await startBridge({ cwd: process.cwd(), launch: fakeLaunch, upstream: async request => {
    calls++;
    assert.equal(request.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(request.headers.get("authorization"), "Bearer fake-cli");
    assert.deepEqual(await request.json(), { ...native, metadata: { user_id: "account" } });
    return new Response(wire, { headers: { "content-type": "text/event-stream", "request-id": "req-test" } });
  } });
  try {
    assert.equal((await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", body: "{}" })).status, 401);
    const headers = { "x-open-claude-token": bridge.secret };
    assert.equal((await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers, body: "{}" })).status, 400);
    assert.equal((await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: "{}" })).status, 415);
    const result = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers, body: JSON.stringify(native) });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("request-id"), "req-test");
    assert.equal(await result.text(), wire);
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test("upstream errors and retry-after are preserved, not retried internally", async () => {
  let calls = 0;
  const bridge = await startBridge({ cwd: process.cwd(), launch: fakeLaunch, upstream: async () => {
    calls++;
    return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}', { status: 429, headers: { "retry-after": "30" } });
  } });
  try {
    const result = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: JSON.stringify(native) });
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "30");
    assert.match(await result.text(), /quota/);
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test("runtime exit before dispatch produces an actionable failure", async () => {
  const bridge = await startBridge({ cwd: process.cwd(), launch: () => spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] }) });
  try {
    const result = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: JSON.stringify(native) });
    assert.equal(result.status, 502);
    assert.match(await result.text(), /Sign in/);
  } finally { await bridge.close(); }
});

test("real bundled runtime routes through the relay (offline, dummy key)", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-runtime-"));
  let calls = 0;
  const bridge = await startBridge({
    cwd: directory, timeoutMs: 45_000,
    launch: (baseURL, model) => spawn(runtimePath(), runtimeArguments(model), {
      cwd: directory,
      env: { ...childEnvironment(join(directory, "config")), ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: "offline-dummy-key" },
      stdio: ["pipe", "pipe", "pipe"],
    }),
    upstream: async request => {
      calls++;
      const system = (await request.json() as any).system;
      assert.deepEqual(system.filter((block: any) => !block.text?.startsWith("x-anthropic-billing-header:")), native.system);
      assert.ok(system.some((block: any) => block.text?.startsWith("x-anthropic-billing-header:")));
      assert.equal(request.headers.get("x-api-key"), "offline-dummy-key");
      return new Response(wire, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const response = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: JSON.stringify(native) });
    assert.equal(await response.text(), wire);
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  } finally {
    await bridge.close();
    // Only this test's uniquely-created temporary directory is removed.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bundled runtime subscription credential routing (offline, synthetic OAuth store)", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-claude-oauth-"));
  const config = join(directory, "config");
  await mkdir(config);
  await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "sk-ant-oat01-OFFLINE-FAKE-NOT-A-REAL-TOKEN", refreshToken: "OFFLINE-FAKE",
    expiresAt: Date.now() + 86400_000, scopes: ["user:inference", "user:profile"],
    subscriptionType: "max", rateLimitTier: "default_claude_max_20x",
  } }), { mode: 0o600 });
  let calls = 0;
  const bridge = await startBridge({
    cwd: directory, configDir: config, timeoutMs: 15_000,
    upstream: async request => {
      calls++;
      assert.equal(request.headers.get("authorization"), "Bearer sk-ant-oat01-OFFLINE-FAKE-NOT-A-REAL-TOKEN");
      return new Response(wire, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const response = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: JSON.stringify(native) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(text, wire);
    assert.equal(calls, 1);
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
