import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSupervised, stopChild } from "../src/process.js";

test("supervised process preserves output, argument boundaries, and exit status", async () => {
  const child = spawnSupervised(process.execPath, ["-e", 'console.log(process.argv[1]);process.exitCode=7', "hello; not a shell command"], {});
  let text = "";
  child.stdout!.on("data", chunk => { text += chunk; });
  child.stderr!.resume();
  const [code] = await once(child, "exit");
  assert.equal(code, 7);
  assert.equal(text.trim(), "hello; not a shell command");
});

test("supervisor forwards interactive stdin separately from its liveness pipe", async () => {
  const child = spawnSupervised(process.execPath, ["-e", 'process.stdin.once("data",data=>{console.log(data.toString().trim());process.exit(0)})'], {});
  let text = "";
  child.stdout!.on("data", chunk => { text += chunk; });
  child.stderr!.resume();
  child.stdin!.write("AUTH-CODE-FIXTURE\n");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(text.trim(), "AUTH-CODE-FIXTURE");
});

test("stubborn supervised runtime is killed and reaped", async () => {
  const child = spawnSupervised(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log("READY");setInterval(()=>{},1000)'], {});
  child.stderr!.resume();
  await once(child.stdout!, "data");
  await stopChild(child, 50);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("supervisor terminates runtime after abrupt host SIGKILL", async () => {
  const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {spawnSupervised} from './src/process.ts';
    const child=spawnSupervised(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)'],{});
    child.stdout.pipe(process.stdout);child.stderr.resume();
  `], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  host.stderr!.resume();
  const [chunk] = await once(host.stdout!, "data");
  const pid = Number(chunk.toString().trim());
  assert.ok(pid > 1);
  try {
    host.kill("SIGKILL");
    await once(host, "exit");
    const deadline = Date.now() + 7000;
    let state = "";
    while (Date.now() < deadline) {
      try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { state = ""; }
      if (!state || state.startsWith("Z")) break;
      await delay(50);
    }
    assert.ok(!state || state.startsWith("Z"), `Runtime ${pid} survived host crash: ${state}`);
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    try { process.kill(pid, "SIGKILL"); } catch { /* test-owned process already gone */ }
  }
});
