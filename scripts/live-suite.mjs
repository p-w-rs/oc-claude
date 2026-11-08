import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Real provider acceptance tests, not harness subagents. All model work runs
// through the isolated OpenCode server and only uses synthetic temporary files.
export async function runLiveSuite({ api, directory, models, mcpMarker }) {
  const selected = models.find(model => model.id === "claude-sonnet-5-5");
  assert.ok(selected, "Sonnet 5.5 missing");
  const results = [];
  const filter = process.argv.find(value => value.startsWith("--case="))?.slice(7);
  const request = async (path, method = "GET", body) => {
    const { response, json } = await api(path, method, body);
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
    return json?.data ?? json;
  };
  const create = async (name, extra = {}) => (await request("/api/session", "POST", {
    location: { directory }, title: `Live suite: ${name}`,
    model: { providerID: "open-claude", id: selected.id }, ...extra,
  })).id;
  const messages = id => request(`/api/session/${id}/message`);
  const parts = list => list.filter(item => item.type === "assistant").flatMap(item => item.content || []);
  const text = list => parts(list).filter(part => part.type === "text").map(part => part.text).join("\n");
  const tools = list => parts(list).filter(part => part.type === "tool");
  const poll = async (description, operation, predicate, timeout = 90_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await operation();
      if (predicate(value)) return value;
      await delay(150);
    }
    throw new Error(`Timed out waiting for ${description}`);
  };
  const wait = async (id, before) => {
    const list = await poll("session completion", () => messages(id), list => list.some(item => item.type === "idle" && !before.has(item.id)));
    const fresh = list.filter(item => !before.has(item.id));
    const failed = fresh.find(item => item.type === "idle" && item.outcome === "failed");
    assert.ok(!failed, JSON.stringify(failed?.error || fresh.find(item => item.error)?.error));
    return fresh;
  };
  const turn = async (id, prompt, extra = {}) => {
    const before = new Set((await messages(id)).map(item => item.id));
    await request(`/api/session/${id}/prompt`, "POST", { text: prompt, ...extra });
    return wait(id, before);
  };
  const test = async (name, run) => {
    if (filter && !name.includes(filter)) return;
    const started = Date.now();
    try {
      const evidence = await run();
      const status = evidence?.knownHostIssue ? "known-host-issue" : "pass";
      results.push({ name, status, durationMs: Date.now() - started, evidence });
      console.log(`${status === "pass" ? "PASS" : "KNOWN HOST ISSUE"}: ${name}`);
    } catch (error) {
      results.push({ name, status: "fail", durationMs: Date.now() - started, error: error.message });
      console.log(`FAIL: ${name}: ${error.message}`);
    }
  };

  await test("read → edit → shell test → persisted file", async () => {
    const folder = join(directory, "coding");
    await mkdir(folder);
    const source = join(folder, "sum.mjs");
    const tests = join(folder, "sum.test.mjs");
    await writeFile(source, "export const sum = (a, b) => a - b;\n");
    await writeFile(tests, 'import assert from "node:assert/strict";\nimport {sum} from "./sum.mjs";\nassert.equal(sum(2,3),5);\nassert.equal(sum(-2,7),5);\nconsole.log("SUM_TESTS_OK");\n');
    const id = await create("coding");
    const list = await turn(id, `Work only in ${folder}. Read sum.mjs and sum.test.mjs using read. Fix the sum bug using edit (do not modify the tests). Run ${JSON.stringify(process.execPath)} ${JSON.stringify(tests)} using shell. Do not install anything. Then briefly report the test result.`);
    const called = tools(list);
    for (const name of ["read", "edit", "shell"]) assert.ok(called.some(tool => tool.name === name && tool.state.status === "completed"), `Missing successful ${name}: ${JSON.stringify(called)}`);
    const check = spawnSync(process.execPath, [tests], { cwd: folder, encoding: "utf8", timeout: 10_000 });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /SUM_TESTS_OK/);
    assert.match(await readFile(source, "utf8"), /a\s*\+\s*b/);
    return { completedTools: called.map(tool => tool.name), independentTest: "SUM_TESTS_OK" };
  });

  await test("failed tool result → recovery with a second tool", async () => {
    const marker = `RECOVERY_${randomBytes(8).toString("hex")}`;
    await writeFile(join(directory, "fallback.txt"), marker);
    const id = await create("tool error recovery");
    const list = await turn(id, `First use read on ${join(directory, "intentionally-missing.txt")}; it does not exist. After the error, use read on ${join(directory, "fallback.txt")}. Do not create files or use shell. Reply with exactly the fallback file content.`);
    assert.ok(tools(list).some(tool => tool.name === "read" && tool.state.status === "error"), "Missing failed read result");
    assert.ok(tools(list).some(tool => tool.name === "read" && tool.state.status === "completed"), "Missing recovery read");
    assert.ok(text(list).includes(marker), "Recovered answer incorrect");
    return { failedRead: true, recoveredRead: true };
  });

  let historyID;
  let memory;
  await test("multi-turn memory and fork isolation", async () => {
    historyID = await create("history parent");
    memory = `PARENT_${randomBytes(8).toString("hex")}`;
    await turn(historyID, `Remember this exact project verification token: ${memory}. It must survive summaries. Do not use tools. Reply ACK.`);
    const recalled = await turn(historyID, "Without tools, reply with exactly the project verification token from my previous message.");
    assert.ok(text(recalled).includes(memory));
    const fork = await request(`/api/session/${historyID}/fork`, "POST", {});
    const branch = `BRANCH_${randomBytes(8).toString("hex")}`;
    await turn(fork.id, `In this branch only, replace the verification token with ${branch}. Do not use tools. Reply ACK.`);
    const branchAnswer = await turn(fork.id, "Without tools, reply with exactly the current verification token.");
    assert.ok(text(branchAnswer).includes(branch));
    const parentAnswer = await turn(historyID, "Without tools, reply with exactly the current verification token.");
    assert.ok(text(parentAnswer).includes(memory));
    assert.ok(!text(parentAnswer).includes(branch));
    return { recall: true, branchRecall: true, parentUnchanged: true };
  });

  await test("manual compaction → remembered context", async () => {
    if (!historyID) {
      historyID = await create("compaction context");
      memory = `CONTEXT_${randomBytes(8).toString("hex")}`;
      await turn(historyID, `Remember this exact project verification token, including in any summary: ${memory}. Reply ACK without tools.`);
    }
    const before = new Set((await messages(historyID)).map(item => item.id));
    await request(`/api/session/${historyID}/compact`, "POST", {});
    const compacted = await poll("manual compaction", () => messages(historyID), list => list.some(item => item.type === "compaction" && !before.has(item.id) && ["completed", "failed"].includes(item.status)));
    const item = compacted.find(item => item.type === "compaction" && !before.has(item.id));
    assert.equal(item.status, "completed", JSON.stringify(item.error));
    assert.ok(item.summary?.length > 0, "Empty compaction summary");
    const answer = await turn(historyID, "Without tools, reply with exactly the project verification token we agreed to preserve.");
    assert.ok(text(answer).includes(memory), "Memory lost after compaction");
    return { completedSummary: true, recallAfterCompaction: true };
  });

  await test("permission rejection → model obeys feedback", async () => {
    const id = await create("permission", { permissions: [{ action: "shell", resource: "*", effect: "ask" }] });
    const before = new Set((await messages(id)).map(item => item.id));
    await request(`/api/session/${id}/prompt`, "POST", { text: `Use shell to run ${JSON.stringify(process.execPath)} -e 'console.log("SHOULD_NOT_RUN")'. Ask permission and wait. Do not use other tools.` });
    const pending = await poll("permission prompt", () => request(`/api/session/${id}/permission`), list => list.length > 0, 45_000);
    await request(`/api/session/${id}/permission/${pending[0].id}/reply`, "POST", { decision: "reject", message: "Do not run any command or try another tool. Reply exactly PERMISSION_REJECTED." });
    const list = await wait(id, before);
    assert.ok(!tools(list).some(tool => tool.name === "shell" && tool.state.status === "completed"), "Rejected command executed");
    if (!text(list).includes("PERMISSION_REJECTED")) {
      assert.ok(tools(list).some(tool => tool.name === "shell" && tool.state.error?.type === "tool.execution" && tool.state.error.message.startsWith("Unable to execute command")), "Unexpected permission feedback failure");
      return { pendingPermission: true, commandNotExecuted: true, feedbackFollowed: false, knownHostIssue: "OpenCode's shell tool wraps rejection feedback in a generic execution error" };
    }
    return { pendingPermission: true, commandNotExecuted: true, feedbackFollowed: true };
  });

  for (const name of ["direct", "probe"]) await test(`MCP ${name === "direct" ? "native tool" : "Code Mode execute"} round trip`, async () => {
    await poll("MCP connection", () => request("/api/mcp"), servers => servers.some(server => server.name === name && server.status.status === "connected"));
    const id = await create(`MCP ${name}`);
    const value = `VALUE_${randomBytes(6).toString("hex")}`;
    const prompt = name === "direct"
      ? `Call the direct_echo_probe MCP tool with value ${JSON.stringify(value)}. Reply with exactly its returned text. Do not use any other tools.`
      : `Use the execute tool to call tools.probe.echo_probe({value:${JSON.stringify(value)}}) and return its result. Reply with exactly the returned text. Do not use shell, read or other tools.`;
    const list = await turn(id, prompt);
    assert.ok(text(list).includes(`${mcpMarker}:${value}`), "MCP result did not survive the model continuation");
    const calls = (await readFile(join(directory, "mcp-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.some(call => call.server === name && call.value === value), "MCP fixture was not actually called");
    assert.ok(tools(list).some(tool => tool.name === (name === "direct" ? "direct_echo_probe" : "execute") && tool.state.status === "completed"));
    return { actualMcpCall: true, nativeContinuation: true, codeMode: name === "probe" };
  });

  await test("effort variant switch within existing signed history", async () => {
    const high = selected.variants.find(variant => variant.id === "high");
    const low = selected.variants.find(variant => variant.id === "low");
    assert.ok(high && low, "Native high/low variants unavailable");
    const id = await create("variants", { model: { providerID: "open-claude", id: selected.id, variant: high.id } });
    const first = await turn(id, "Find the smallest positive integer that is 2 modulo 3, 3 modulo 5, and 2 modulo 7. Give only the number, without tools. Remember the result for my next message.");
    assert.match(text(first), /\b23\b/);
    assert.ok(first.some(item => item.type === "assistant" && item.model.variant === high.id));
    await request(`/api/session/${id}/model`, "POST", { model: { providerID: "open-claude", id: selected.id, variant: low.id } });
    const second = await turn(id, "Reply with exactly the number you found previously. No tools.");
    assert.match(text(second), /\b23\b/);
    assert.ok(second.some(item => item.type === "assistant" && item.model.variant === low.id));
    return { high: high.id, low: low.id, contextRetained: true, protocolErrors: false };
  });

  await test("image attachment → vision response without file tools", async () => {
    const { visionPng } = await import("../test/fixtures/image.mjs");
    const image = join(directory, "vision.png");
    await writeFile(image, visionPng());
    const id = await create("vision");
    const list = await turn(id, "What is the dominant color in this attached image? Reply with just the color name. Do not use tools.", { files: [{ uri: pathToFileURL(image).href }] });
    assert.match(text(list), /\bred\b/i);
    assert.equal(tools(list).length, 0);
    return { imageInterpreted: true, toolsNotNeeded: true };
  });

  const output = join(process.cwd(), "test-results");
  await mkdir(output, { recursive: true });
  const report = `live-suite${filter ? "-focused" : ""}.json`;
  await writeFile(join(output, report), JSON.stringify({ date: new Date().toISOString(), model: selected.id, results }, null, 2) + "\n");
  console.log(`Live suite: ${results.filter(result => result.status === "pass").length} passed, ${results.filter(result => result.status === "known-host-issue").length} known host issues, ${results.filter(result => result.status === "fail").length} failed. Report: test-results/${report}`);
  assert.ok(results.length > 0, "No live tests matched the case filter");
  assert.ok(results.every(result => result.status !== "fail"), "Live acceptance suite has unexpected failures");
}
