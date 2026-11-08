// Type-only SDK imports: OpenCode V2 loads this as a native plugin definition;
// no second Effect runtime or OpenCode SDK is bundled into the server.
import type { Plugin, Provider, Model, Integration } from "@opencode/plugin";
import { startBridge } from "./bridge.js";
import { Login, marker, METHOD_ID, PROVIDER_ID } from "./auth.js";
import { authStatusAsync } from "./runtime.js";
import { parseOptions } from "./options.js";

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  return setupWithBridge(ctx, startBridge);
}

// Injectable boundary for offline host acceptance tests. The production entry
// never reads transport overrides from config, HTTP, or the host environment.
export async function setupWithBridge(ctx: Plugin.Context, factory: typeof startBridge): Promise<Plugin.Cleanup> {
  const bridge = await factory({ cwd: ctx.location.directory, ...parseOptions(ctx.options) });
  const login = new Login();
  try {
    await ctx.provider.transform(editor => {
      // Follow OpenCode's maintained catalog rather than guessing model IDs,
      // context limits, release dates or effort variants. No credential access.
      const source = editor.get("anthropic");
      const models: Model.Info[] = [...(source?.models.values() || [])].filter(model => model.capabilities.output.includes("text")).map(model => ({
        ...model, providerID: PROVIDER_ID as Provider.ID,
        package: "@opencode/ai/providers/anthropic",
        cost: [],
      }));
      if (!models.length) throw new Error("OpenClaude requires OpenCode's Anthropic model catalog.");
      editor.add({
        info: {
          id: PROVIDER_ID as Provider.ID, canonical: "anthropic" as Provider.ID,
          integrationID: PROVIDER_ID as Integration.ID,
          name: "Claude Code (OpenClaude)", activation: "enabled",
          package: "@opencode/ai/providers/anthropic",
          settings: { baseURL: `${bridge.baseURL}/v1`, apiKey: bridge.secret, encoding: "none", transport: "http", headerTimeout: false },
          headers: { "x-open-claude-token": bridge.secret },
        },
        models,
      });
    });
    await ctx.integration.transform(editor => {
      editor.update(PROVIDER_ID, draft => { draft.name = "Claude Code (OpenClaude)"; });
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Sign in with bundled Claude Code" },
        authorize: () => login.authorize(),
        refresh: async () => {
          if (!(await authStatusAsync()).loggedIn) throw new Error("Claude Code is signed out. Connect Claude Code (OpenClaude) again.");
          return marker();
        },
      });
    });
    await ctx.command.transform(editor => {
      editor.add({
        name: "claude-login-cancel", description: "Cancel the active bundled Claude Code sign-in",
        execute: async () => { await login.cancel(); },
      });
    });
    await ctx.session.hook("http.response", async event => {
      if (event.response.status !== 401 && !event.response.ok) return;
      try {
        const connection = await ctx.integration.connection.active(PROVIDER_ID);
        if (!connection || !ctx.integration.connection.status) return;
        await ctx.integration.connection.status({
          integrationID: PROVIDER_ID, connection,
          status: event.response.status === 401 ? { status: "needs_auth", message: "Bundled Claude Code needs sign-in. Reconnect Claude Code (OpenClaude)." } : undefined,
        });
      } catch { /* Connection status is best-effort UI metadata, not inference. */ }
    }, { providerID: PROVIDER_ID });
    return async () => { await login.cancel(); await bridge.close(); };
  } catch (error) {
    await login.cancel();
    await bridge.close();
    throw error;
  }
}

export default { id: "open-claude", setup } satisfies Plugin.Plugin;
