import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startBridge } from "../src/bridge.js";

const native = { model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "test" }] };
const wire = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const launch = (baseURL: string) => spawn(process.execPath, ["--input-type=module", "-e", `
  const url=${JSON.stringify(baseURL)}+'/v1/messages';
  const first=await fetch(url,{method:'POST',headers:{authorization:'Bearer old'},body:'{}'});
  await first.text();
  if(first.status===401){
    const retry=await fetch(url,{method:'POST',headers:{authorization:'Bearer refreshed'},body:'{}'});
    await retry.text();
  }
`], { stdio: ["pipe", "pipe", "pipe"] });

async function run(upstream: (request: Request) => Promise<Response>, check: (response: Response) => Promise<void>, options = {}) {
  const bridge = await startBridge({ cwd: process.cwd(), launch, upstream, ...options });
  try {
    await check(await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: JSON.stringify(native) }));
  } finally { await bridge.close(); }
}

test("upstream 401 is offered to the runtime once for credential refresh", async () => {
  const credentials: (string | null)[] = [];
  await run(async request => {
    credentials.push(request.headers.get("authorization"));
    return credentials.length === 1
      ? new Response('{"type":"error","error":{"type":"authentication_error","message":"expired"}}', { status: 401, headers: { "content-type": "application/json" } })
      : new Response(wire, { headers: { "content-type": "text/event-stream" } });
  }, async response => {
    assert.equal(response.status, 200);
    assert.equal(await response.text(), wire);
  });
  assert.deepEqual(credentials, ["Bearer old", "Bearer refreshed"]);
});

test("failed refresh returns upstream authentication error with no third attempt", async () => {
  let calls = 0;
  await run(async () => { calls++; return new Response('{"type":"error","error":{"type":"authentication_error","message":"expired"}}', { status: 401 }); }, async response => {
    assert.equal(response.status, 401);
    assert.match(await response.text(), /expired/);
  });
  assert.equal(calls, 2);
});

test("runtime declining refresh returns original 401 instead of hanging", async () => {
  await run(async () => new Response('{"error":{"type":"authentication_error","message":"sign in"}}', { status: 401 }), async response => {
    assert.equal(response.status, 401);
    assert.match(await response.text(), /sign in/);
  }, { launch: (baseURL: string) => spawn(process.execPath, ["--input-type=module", "-e", `await(await fetch(${JSON.stringify(baseURL)}+'/v1/messages',{method:'POST',body:'{}'})).text()`], { stdio: ["pipe", "pipe", "pipe"] }) });
});

test("truncated upstream stream emits a native error instead of silent success", async () => {
  await run(async () => new Response('event: content_block_delta\ndata: {"type":"content_block_delta","text":"partial"}\n\n', { headers: { "content-type": "text/event-stream" } }), async response => {
    const text = await response.text();
    assert.match(text, /partial/);
    assert.match(text, /event: error/);
    assert.match(text, /response is incomplete/);
  });
});

test("provider in-band errors and nonstream responses pass through unchanged", async () => {
  const error = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
  await run(async () => new Response(error, { headers: { "content-type": "text/event-stream" } }), async response => assert.equal(await response.text(), error));
  const json = '{"type":"message","content":[{"type":"text","text":"OK"}]}';
  await run(async () => new Response(json, { headers: { "content-type": "application/json" } }), async response => assert.equal(await response.text(), json));
});

test("startup and upstream-idle deadlines are separate from total timeout", async () => {
  await run(async request => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")))), async response => {
    assert.equal(response.status, 504);
    assert.match(await response.text(), /stopped responding/);
  }, { idleTimeoutMs: 50, timeoutMs: 5000 });
  await run(async () => new Response(wire), async response => {
    assert.equal(response.status, 504);
    assert.match(await response.text(), /did not dispatch/);
  }, { startupTimeoutMs: 50, launch: () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }) });
});

test("lost connection after streaming begins emits an error, not a clean EOF", async () => {
  await run(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('event: content_block_delta\ndata: {"text":"hello"}\n\n'));
    setImmediate(() => controller.error(new Error("private error must not leak")));
  } }), { headers: { "content-type": "text/event-stream" } }), async response => {
    const text = await response.text();
    assert.match(text, /event: error/);
    assert.ok(!text.includes("private error"));
  });
});

test("stream idle timeout aborts fetch and reports a native error", async () => {
  let aborted = false;
  await run(async request => {
    request.signal.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('event: ping\ndata: {}\n\n'));
      request.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
    } }), { headers: { "content-type": "text/event-stream" } });
  }, async response => {
    assert.match(await response.text(), /upstream stream stalled/);
  }, { idleTimeoutMs: 50 });
  assert.equal(aborted, true);
});

test("runtime authentication failures are classified without exposing its output", async () => {
  await run(async () => { throw new Error("not dispatched"); }, async response => {
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.match(text, /authentication_error/);
    assert.ok(!text.includes("SECRET"));
  }, { launch: () => spawn(process.execPath, ["-e", 'console.error("Not logged in SECRET");process.exit(1)'], { stdio: ["pipe", "pipe", "pipe"] }) });
});
