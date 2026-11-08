// Offline-only OpenCode host fixture, never part of the production entry.
import { spawn } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { setupWithBridge } from "../../dist/plugin.js";
import { startBridge } from "../../dist/bridge.js";
import { runtimePath, runtimeArguments, childEnvironment } from "../../dist/runtime.js";

function reply(model: string, content: Record<string, unknown>, reason: string): Response {
  const tool = content.type === "tool_use";
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content.text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 8 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

export default {
  id: "open-claude-offline-acceptance",
  async setup(ctx: any) {
    const cleanup = await setupWithBridge(ctx, options => startBridge({
      ...options,
      launch: (baseURL, model, cwd) => spawn(runtimePath(), runtimeArguments(model), {
        cwd, env: { ...childEnvironment(join(process.env.XDG_CONFIG_HOME!, "fake-claude")), ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: "offline-dummy" },
        stdio: ["pipe", "pipe", "pipe"],
      }),
      upstream: async request => {
        try {
        const body = await request.json() as any;
        assert.equal(request.headers.get("x-api-key"), "offline-dummy");
        assert.ok(!JSON.stringify(body.system).includes("Transport only. Reply OK."));
        const result = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.type === "tool_result");
        if (result) {
          assert.match(JSON.stringify(result), /OFFLINE-PROBE-OK/);
          return reply(body.model, { type: "text", text: "OFFLINE-HOST-ACCEPTANCE-OK" }, "end_turn");
        }
        const read = body.tools.find((tool: any) => tool.name === "read");
        assert.ok(read, "Native read tool missing");
        const key = read.input_schema.properties.path ? "path" : "filePath";
        return reply(body.model, { type: "tool_use", id: "toolu_offline", name: "read", input: { [key]: join(ctx.location.directory, "probe.txt") } }, "tool_use");
        } catch (error) {
          console.error("Offline fixture assertion:", error);
          throw error;
        }
      },
    }));
    return cleanup;
  },
};
