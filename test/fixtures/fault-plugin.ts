import { join } from "node:path";
import { setupWithBridge } from "../../dist/plugin.js";
import { startBridge } from "../../dist/bridge.js";
import { runtimePath, runtimeArguments, childEnvironment } from "../../dist/runtime.js";
import { spawnSupervised } from "../../dist/process.js";

export default {
  id: "open-claude-fault-acceptance",
  async setup(ctx: any) {
    const cleanup = await setupWithBridge(ctx, options => startBridge({
      ...options, idleTimeoutMs: 150,
      launch: (baseURL, model, cwd) => spawnSupervised(runtimePath(), runtimeArguments(model), {
        cwd, env: { ...childEnvironment(join(process.env.XDG_CONFIG_HOME!, "fake-claude")), ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: "offline-dummy" },
      }),
      upstream: async request => {
        const model = (await request.json() as any).model;
        const prefix = [
          ["message_start", { type: "message_start", message: { id: "msg_fault", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "INCOMPLETE" } }],
        ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
        const fault = process.env.OPEN_CLAUDE_TEST_FAULT;
        if (fault === "truncated") return new Response(prefix, { headers: { "content-type": "text/event-stream" } });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from(prefix));
          if (fault === "disconnected") setTimeout(() => controller.error(new Error("Offline simulated disconnect")), 10);
          request.signal.addEventListener("abort", () => controller.error(new Error("Offline abort")), { once: true });
        } }), { headers: { "content-type": "text/event-stream" } });
      },
    }));
    await ctx.session.hook("retry", (event: any) => { event.decision = { retry: false }; }, { providerID: "open-claude" });
    return cleanup;
  },
};
