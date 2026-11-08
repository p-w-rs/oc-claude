import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { startBridge } from "../src/bridge.js";

const input = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hello" }] });
const idle = () => spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });

test("deadline terminates a runtime that never dispatches", async () => {
  let child!: ChildProcess;
  const bridge = await startBridge({ cwd: process.cwd(), timeoutMs: 100, launch: () => (child = idle()) });
  try {
    const response = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: input });
    assert.equal(response.status, 504);
    await response.text();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { await bridge.close(); }
});

test("OpenCode cancellation terminates the underlying runtime", async () => {
  let launched!: () => void;
  const started = new Promise<void>(resolve => { launched = resolve; });
  let child!: ChildProcess;
  const bridge = await startBridge({ cwd: process.cwd(), launch: () => { child = idle(); launched(); return child; } });
  try {
    const controller = new AbortController();
    const request = fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: input, signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(request, /abort/i);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { await bridge.close(); }
});

test("unload stops in-flight calls and closes the listener", async () => {
  let launched!: () => void;
  const started = new Promise<void>(resolve => { launched = resolve; });
  const bridge = await startBridge({ cwd: process.cwd(), launch: () => { launched(); return idle(); } });
  const request = fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: input });
  // Socket shutdown can deliver the 503 or reject fetch; neither may hang.
  void request.catch(() => {});
  await started;
  await bridge.close();
  await Promise.allSettled([request]);
  await assert.rejects(fetch(bridge.baseURL));
});

test("capacity limits concurrent requests without starting another runtime", async () => {
  let launched!: () => void;
  const started = new Promise<void>(resolve => { launched = resolve; });
  let count = 0;
  const bridge = await startBridge({ cwd: process.cwd(), maxConcurrent: 1, launch: () => { count++; launched(); return idle(); } });
  const controller = new AbortController();
  const request = fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: input, signal: controller.signal });
  void request.catch(() => {});
  try {
    await started;
    const second = await fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: input });
    assert.equal(second.status, 429);
    await second.text();
    assert.equal(count, 1);
  } finally { controller.abort(); await Promise.allSettled([request]); await bridge.close(); }
});

test("single-use runtime capability rejects a second model dispatch", async () => {
  let launched!: (baseURL: string) => void;
  const started = new Promise<string>(resolve => { launched = resolve; });
  let calls = 0;
  let end!: () => void;
  const stream = new ReadableStream({ start(controller) { end = () => controller.close(); } });
  const bridge = await startBridge({ cwd: process.cwd(), launch: baseURL => { launched(baseURL); return idle(); }, upstream: async () => {
    calls++;
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
  const output = fetch(`${bridge.baseURL}/v1/messages`, { method: "POST", headers: { "x-open-claude-token": bridge.secret }, body: input });
  try {
    const url = `${await started}/v1/messages`;
    const first = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(second.status, 403);
    await second.text();
    assert.equal(calls, 1);
    end();
    await (await output).text();
  } finally { await bridge.close(); }
});
