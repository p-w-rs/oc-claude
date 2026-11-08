import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../src/bridge.js";
import { request as httpRequest } from "node:http";

test("24 concurrent requests do not cross histories or responses", async () => {
  const seen = new Set<string>();
  const bridge = await startBridge({ cwd: process.cwd(), maxConcurrent: 32,
    launch: baseURL => spawn(process.execPath, ["--input-type=module", "-e", `
      await(await fetch(${JSON.stringify(baseURL)}+'/v1/messages',{method:'POST',body:'{}'})).text();
    `], { stdio: ["pipe", "pipe", "pipe"] }),
    upstream: async request => {
      const native = await request.json() as { messages: { content: string }[] };
      const id = native.messages[0]!.content;
      assert.ok(!seen.has(id)); seen.add(id);
      await delay(Math.random() * 20);
      return new Response(JSON.stringify({ id }), { headers: { "content-type": "application/json" } });
    },
  });
  try {
    await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const id = `request-${i}`;
      const response = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: JSON.stringify({ model: "test", stream: false, messages: [{ role: "user", content: id }] }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id });
    }));
    assert.equal(seen.size, 24);
  } finally { await bridge.close(); }
});

test("close is idempotent with no active connections", async () => {
  const bridge = await startBridge({ cwd: process.cwd() });
  await Promise.all([bridge.close(), bridge.close()]);
  await bridge.close();
});

test("slow consumers apply backpressure and disconnect aborts upstream", async () => {
  let produced = 0;
  let aborted!: () => void;
  const upstreamAborted = new Promise<void>(resolve => { aborted = resolve; });
  const bridge = await startBridge({ cwd: process.cwd(),
    launch: baseURL => spawn(process.execPath, ["--input-type=module", "-e", `
      await(await fetch(${JSON.stringify(baseURL)}+'/v1/messages',{method:'POST',body:'{}'})).text();
    `], { stdio: ["pipe", "pipe", "pipe"] }),
    upstream: async request => {
      request.signal.addEventListener("abort", aborted, { once: true });
      return new Response(new ReadableStream({ pull(controller) {
        produced++;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (produced === 1024) controller.close();
      } }), { headers: { "content-type": "application/octet-stream" } });
    },
  });
  const request = httpRequest(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret } });
  request.on("error", () => {});
  try {
    const paused = new Promise<void>(resolve => request.once("response", response => { response.pause(); resolve(); }));
    request.end(JSON.stringify({ model: "test", messages: [] }));
    await paused;
    await delay(100);
    assert.ok(produced < 128, `Buffered too many upstream chunks: ${produced}`);
    request.destroy();
    await Promise.race([upstreamAborted, delay(2000).then(() => { throw new Error("Disconnect did not abort upstream"); })]);
  } finally { request.destroy(); await bridge.close(); }
});

test("incomplete request bodies occupy capacity without launching a runtime", async () => {
  let launches = 0;
  const bridge = await startBridge({ cwd: process.cwd(), maxConcurrent: 1, launch: () => { launches++; throw new Error("must not launch"); } });
  const first = httpRequest(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret, "content-length": "1000" } });
  first.on("error", () => {});
  try {
    first.write('{"model":');
    await delay(50);
    const second = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: '{}' });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "1");
    await second.text();
    assert.equal(launches, 0);
  } finally { first.destroy(); await bridge.close(); }
});
