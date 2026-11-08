import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../dist/bridge.js";
import { authStatusAsync } from "../dist/runtime.js";

const option = (name, fallback) => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const duration = option("duration-ms", 600_000);
const interval = option("interval-ms", 60_000);
if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 86_400_000 || !Number.isSafeInteger(interval) || interval < 60_000) throw new Error("Use a duration of 1 second–24 hours and an interval of at least 60 seconds");
if (!(await authStatusAsync()).loggedIn) throw new Error("Sign in with the bundled runtime first");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const bridge = await startBridge({ cwd: process.cwd(), timeoutMs: 90_000 });
const started = Date.now();
const results = [];
try {
  do {
    const tick = Date.now();
    const response = await fetch(`${bridge.baseURL}/v1/messages`, {
      method: "POST", headers: { "x-open-claude-token": bridge.secret, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 32, stream: false,
        system: [{ type: "text", text: "You are a helpful assistant." }], messages: [{ role: "user", content: "Reply with exactly SOAK_OK" }] }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
    });
    const body = await response.json();
    const passed = response.ok && body.content?.some(block => block.type === "text" && block.text.includes("SOAK_OK"));
    results.push({ elapsedMs: Date.now() - started, durationMs: Date.now() - tick, status: response.status, passed });
    console.log(`Soak request ${results.length}: ${passed ? "PASS" : "FAIL"} (${response.status}, ${Date.now() - tick} ms)`);
    if (!passed) throw new Error("Live soak request failed; no automatic generation retry was attempted");
    const remaining = duration - (Date.now() - started);
    if (remaining <= 0) break;
    await delay(Math.min(interval, remaining), undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch (error) {
  process.exitCode = controller.signal.aborted ? 130 : 1;
  console.error(controller.signal.aborted ? "Soak interrupted" : error.message);
} finally {
  await bridge.close();
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/soak.json", JSON.stringify({ date: new Date().toISOString(), elapsedMs: Date.now() - started, results, tokenExpiryVerified: false,
    note: "Successful periodic requests are not proof of token renewal unless expiry was independently observed. No credential files were inspected." }, null, 2) + "\n");
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
