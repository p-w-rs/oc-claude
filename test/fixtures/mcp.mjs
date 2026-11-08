import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

// Minimal legacy MCP fixture. No network, vendor SDK, filesystem tools or user
// content; every response is synthetic and calls are independently recorded.
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "open-claude-test", version: "1.0.0" } };
      break;
    case "ping": result = {}; break;
    case "tools/list":
      result = { tools: [{ name: "echo_probe", description: "Return the test marker and the supplied value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] };
      break;
    case "tools/call":
      if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, JSON.stringify({ server: process.env.SERVER_NAME, value: request.params.arguments.value }) + "\n");
      result = { content: [{ type: "text", text: `${process.env.PROBE_MARKER}:${request.params.arguments.value}` }] };
      break;
    case "resources/list": result = { resources: [] }; break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n");
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
