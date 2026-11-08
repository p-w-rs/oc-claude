import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "open-claude-host-"));
const offline = process.argv.includes("--offline");
const suite = process.argv.includes("--suite");
const fault = process.argv.find(value => value.startsWith("--fault="))?.slice(8);
if (fault && !["truncated", "stalled", "disconnected"].includes(fault)) throw new Error("Unknown fault scenario");
const live = process.argv.includes("--live") || suite;
const mcpMarker = `MCP_${randomBytes(8).toString("hex")}`;
let child;
try {
  await mkdir(join(directory, "config"));
  const pluginArgument = process.argv.indexOf("--plugin");
  let plugin = pluginArgument >= 0 ? process.argv[pluginArgument + 1] : root;
  if (!plugin) throw new Error("--plugin requires a directory");
  if (offline) {
    await writeFile(join(directory, "probe.txt"), "OFFLINE-PROBE-OK\n");
    plugin = join(directory, "fixture");
    await mkdir(plugin);
    await writeFile(join(plugin, "server.ts"), `export {default} from ${JSON.stringify(join(root, "test/fixtures/host-plugin.ts"))};\n`);
  }
  if (fault) {
    plugin = join(directory, "fault-fixture");
    await mkdir(plugin);
    await writeFile(join(plugin, "server.ts"), `export {default} from ${JSON.stringify(join(root, "test/fixtures/fault-plugin.ts"))};\n`);
  }
  if (live) await writeFile(join(directory, "probe.txt"), "OPEN_CLAUDE_LIVE_TOOL_OK\n");
  await writeFile(join(directory, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", plugins: [plugin],
    ...(live ? { agents: { build: { steps: suite ? 10 : 4 } } } : {}),
    ...(suite ? { mcp: { servers: Object.fromEntries(["direct", "probe"].map(name => [name, {
      type: "local", command: [process.execPath, join(root, "test/fixtures/mcp.mjs")],
      codemode: name === "probe",
      environment: { PROBE_MARKER: mcpMarker, CALL_LOG: join(directory, "mcp-calls.jsonl"), SERVER_NAME: name },
    }])) } } : {}),
  }));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const password = randomBytes(24).toString("hex");
  child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), ...(!live ? { XDG_DATA_HOME: join(directory, "data") } : {}), XDG_STATE_HOME: join(directory, "state"), OPENCODE_DB: ":memory:", OPENCODE_PASSWORD: password, ...(fault ? { OPEN_CLAUDE_TEST_FAULT: fault } : {}) },
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-32000); });
  child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-32000); });
  const api = async (path, method = "GET", body) => {
    const url = new URL(`http://127.0.0.1:${port}${path}`);
    url.searchParams.set("location[directory]", directory);
    const response = await fetch(url, {
      method, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return { response, json: text ? JSON.parse(text) : undefined };
  };
  let models;
  let last;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`);
    try {
      const { response, json } = await api("/api/model");
      last = { status: response.status, shape: Object.keys(json), dataType: typeof json.data, length: json.data?.length };
      models = json.data?.filter(model => model.providerID === "open-claude");
      if (models?.length) break;
    } catch { /* server starting */ }
    await delay(250);
  }
  if (!models?.length) throw new Error(`Provider did not load: ${JSON.stringify(last)} ${logs}`);
  console.log(`Loaded ${models.length} Claude models in OpenCode.`);
  const integrations = await api("/api/integration/open-claude");
  if (!integrations.json.data?.methods?.some(method => method.type === "oauth")) throw new Error("OAuth method missing");
  console.log("Native /connect OAuth method registered.");
  if (fault) {
    const created = await api("/api/session", "POST", { location: { directory }, title: "Offline fault check", model: { providerID: "open-claude", id: "claude-sonnet-4-6" } });
    const id = created.json.data?.id;
    if (!id) throw new Error("Could not create fault-test session");
    await api(`/api/session/${id}/prompt`, "POST", { text: "Reply briefly" });
    let messages;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      messages = (await api(`/api/session/${id}/message`)).json.data;
      if (messages.some(message => message.type === "idle")) break;
      await delay(100);
    }
    const outcome = messages?.find(message => message.type === "idle")?.outcome;
    const error = messages?.find(message => message.type === "assistant" && message.error)?.error;
    if (outcome !== "failed" || !error) throw new Error(`Fault was not a visible session failure: ${JSON.stringify(messages)} ${logs}`);
    console.log(`PASS: native OpenCode reports ${fault} stream as failure (${error.type}), not silent success.`);
  } else if (suite) {
    const { runLiveSuite } = await import("./live-suite.mjs");
    await runLiveSuite({ api, directory, models, mcpMarker });
  } else if (offline || live) {
    const model = models.find(model => model.id === (live ? "claude-sonnet-5-5" : "claude-sonnet-4-6")) || models[0];
    const created = await api("/api/session", "POST", { location: { directory }, title: live ? "Live acceptance" : "Offline acceptance", model: { providerID: "open-claude", id: model.id } });
    const id = created.json.data?.id;
    if (!id) throw new Error(`Could not create session: ${JSON.stringify(created.json)}`);
    await api(`/api/session/${id}/prompt`, "POST", { text: live ? `Use the read tool to read ${join(directory, "probe.txt")}. Reply with exactly its text content. Do not use any other tools.` : "Use the offline probe." });
    let messages;
    const marker = live ? "OPEN_CLAUDE_LIVE_TOOL_OK" : "OFFLINE-HOST-ACCEPTANCE-OK";
    const succeeded = messages => messages?.data?.some(message => message.type === "assistant" && message.content?.some(part => part.type === "text" && part.text.includes(marker)));
    const deadline = Date.now() + (live ? 90_000 : 20_000);
    while (Date.now() < deadline) {
      messages = (await api(`/api/session/${id}/message`)).json;
      if (succeeded(messages)) break;
      if (messages.data?.some(message => message.type === "idle" && message.outcome === "failed")) break;
      await delay(100);
    }
    if (!succeeded(messages)) throw new Error(`Tool round trip failed: ${JSON.stringify(messages)} ${logs}`);
    if (!messages.data.some(message => message.type === "assistant" && message.content?.some(part => part.type === "tool" && part.name === "read" && part.state?.status === "completed"))) throw new Error("Expected completed native read tool call");
    console.log("PASS: OpenCode → native Anthropic protocol → bundled runtime → relay → tool execution → native continuation.");
  }
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
