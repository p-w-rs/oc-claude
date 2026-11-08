import { startBridge } from "../dist/bridge.js";
import { authStatusAsync } from "../dist/runtime.js";

if (!(await authStatusAsync()).loggedIn) throw new Error("Sign into the bundled runtime first");
let attempts = 0;
let previous;
let credentialChanged = false;
const bridge = await startBridge({ cwd: process.cwd(), timeoutMs: 90_000, upstream: async request => {
  attempts++;
  const credential = request.headers.get("authorization");
  if (attempts === 1) {
    previous = credential;
    return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "OAuth token has expired. Please obtain a new token." } }), { status: 401, headers: { "content-type": "application/json" } });
  }
  credentialChanged = credential !== previous;
  previous = undefined;
  return fetch(request);
} });
try {
  const response = await fetch(`${bridge.baseURL}/v1/messages`, {
    method: "POST", headers: { "x-open-claude-token": bridge.secret, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 32, stream: false,
      system: [{ type: "text", text: "You are a helpful assistant." }], messages: [{ role: "user", content: "Reply exactly REFRESH_OK" }] }),
    signal: AbortSignal.timeout(95_000),
  });
  const body = await response.json();
  const passed = response.ok && attempts === 2 && credentialChanged && body.content?.some(block => block.type === "text" && block.text.includes("REFRESH_OK"));
  console.log(JSON.stringify({ status: response.status, attempts, credentialChanged, passed }));
  if (!passed) process.exitCode = 1;
} finally { previous = undefined; await bridge.close(); }
