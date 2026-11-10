import { startBridge } from "../dist/bridge.js";
import { authStatus } from "../dist/runtime.js";

if (!authStatus().loggedIn) throw new Error("Sign in first: /connect → OpenClaude, or pixi run login.");
const bridge = await startBridge({ cwd: process.cwd(), timeoutMs: 90_000 });
try {
  const response = await fetch(`${bridge.baseURL}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-open-claude-token": bridge.secret },
    body: JSON.stringify({ model: process.argv[2] || "claude-sonnet-5-5", max_tokens: 64, stream: false,
      system: [{ type: "text", text: "You are a helpful assistant." }],
      messages: [{ role: "user", content: "Reply with exactly OPEN_CLAUDE_LIVE_OK" }],
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Upstream rejected the transport (${response.status}): ${JSON.stringify(body.error || body)}`);
  if (!body.content?.some(block => block.type === "text" && block.text.includes("OPEN_CLAUDE_LIVE_OK"))) throw new Error("Unexpected upstream response");
  console.log("PASS: signed-in Claude Code → live Anthropic inference with replacement instructions.");
} finally { await bridge.close(); }
