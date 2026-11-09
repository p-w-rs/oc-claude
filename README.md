# OpenClaude for OpenCode V2

[![Release checks](https://github.com/p-w-rs/open-claude/actions/workflows/ci.yml/badge.svg)](https://github.com/p-w-rs/open-claude/actions/workflows/ci.yml)

A local provider plugin that uses its **own pinned Claude Code binary** for sign-in and authenticated transport. OpenCode remains the only agent: its instructions, history, tools, permissions, compaction, forks, and model variants remain authoritative.

**Status: 0.2.0-rc.2 — public release candidate.** Ready for early adopters, with live verification on macOS arm64 and the full offline release gate passing on Linux x64 CI. Installation, crash/fault handling, packaging, and updates have offline regression coverage. Other platform/live-account combinations and natural long-duration token expiry remain disclosed limitations, not installation blockers. This is an unofficial integration dependent on Claude Code's current HTTP behavior, not a promised provider API or a vendor-endorsed way to use a subscription. Check the terms applicable to your account before using it.

## Install

Requires **[OpenCode V2](https://opencode.ai/v2/docs/) 2.0.18 or newer in the 2.x family**, **[Pixi](https://pixi.sh)**, and an account eligible to sign into Claude Code. macOS/Linux on arm64/x64 are supported installation targets; Windows is not supported. Install commands download dependencies and the pinned runtime, so internet access is required. No separate Node, npm, Bun, Python, or Claude Code installation is needed.

### Quick start

Download and extract the source ZIP from GitHub's **Code → Download ZIP**, open a terminal in the extracted folder, and run:

```sh
pixi run --locked install
```

This prepares the locked dependencies, compiles the plugin, and creates an independent production snapshot under `${XDG_DATA_HOME:-~/.local/share}/open-claude/releases/<version>-<hash>`. The snapshot has its own bundled runtime and production dependencies. OpenCode's **V2 `plugins` array** points to that snapshot, so subsequent development builds do not alter the active installation. Existing settings/comments are preserved; a private backup precedes configuration edits. Installation does not select a default model or publish anything.

If you already use Git, the equivalent is:

```sh
git clone https://github.com/p-w-rs/open-claude.git
cd open-claude
pixi run --locked install
```

For a fixed version, use a tagged source download from the [Releases page](https://github.com/p-w-rs/open-claude/releases) when available, rather than the moving `main` branch. A release source archive plus `SHA256SUMS` can also be built locally with `pixi run release-archive`.

To update, download/extract the new source (or `git pull --ff-only` in a clean checkout), then run `pixi run --locked install` there. If the lockfile changed, the dependency guard may request `pixi run deps-update` first. Installation builds and verifies a new snapshot before changing configuration; prior releases are retained. `pixi run rollback` switches to the previous managed snapshot while preserving unrelated settings. Rollback requires a previous managed installation. Snapshots detect accidental file changes with checksums; they are not cryptographically signed against same-user tampering. Configuration reload can interrupt active sessions, so update between tasks.

In OpenCode:

1. `/connect` → **Claude Code (OpenClaude)** → **Sign in with bundled Claude Code**.
2. Finish Claude Code's own browser OAuth/SSO flow; paste its authorization code if requested.
3. `/models` → choose a model under **Claude Code (OpenClaude)** (`open-claude/...`).

OpenCode reloads changed configuration automatically; use `/reload` if needed. `/claude-login-cancel` stops an abandoned login. The terminal fallback is `pixi run login`; it signs into the same bundled runtime and isolated store.

**Desktop users:** select an `open-claude/...` model after connecting; installing
the plugin does not change your default model. Desktop's bundled service and a
terminal `opencode --version` can be different versions. Check the Desktop version
in the app. On macOS, the installer detects Desktop's bundled CLI automatically;
otherwise a supported V2 CLI must be on PATH for preflight.
No separate Node/npm/Claude Code installation is required. After snapshot
installation, the downloaded source folder can be removed; keep Pixi and the
managed release directory. Install or update between active tasks because config
reload may interrupt work.

You can also install [open-enhance](https://github.com/p-w-rs/open-enhance#setup)
for opt-in checkpoints, Pixi policy and document evidence. Its macOS Apple Silicon
and OpenCode 2.2.6+ requirements are stricter than OpenClaude's. Both installers
preserve the other's config entry; you do not need to merge or replace your
configuration manually. Neither project is published to npm. Both remain release
candidates with disclosed limitations; `UNLICENSED` is not a license grant.

For a development link instead of an immutable installation, use `pixi run install-dev`, or configure a project directly after `pixi run build`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/open-claude"],
}
```

Do not add a manual provider definition. The plugin registers its provider, model catalog, and OAuth integration itself. To uninstall, run `pixi run uninstall`, or remove its snapshot/development-directory entry from `plugins` manually. Unrelated settings, credentials and prior snapshots are preserved. A development link intentionally follows builds in the linked directory.

Need help? See [troubleshooting](docs/troubleshooting.md) or [report a bug](https://github.com/p-w-rs/open-claude/issues).

## How it works

```text
OpenCode's native Anthropic provider
    → capability-protected loopback relay
    → bundled Claude Code authenticates a single transport request
    → relay substitutes OpenCode's exact Messages request
    → api.anthropic.com
    → unchanged native response streamed back to OpenCode
```

The runtime gets a terminal dummy response, **never the model's real output or tool calls**. It cannot execute OpenCode's tools. There is no MCP tool-name translation, XML/JSON conversation serialization, nested agent loop, persistent Claude conversation, or history reconciliation. Each call starts a fresh transport process (a latency tradeoff for isolation and correctness).

- OpenCode's system blocks **replace**, rather than append to, Claude Code's instructions at the HTTP boundary. The runtime's account attribution (`metadata.user_id`) and genuine `x-anthropic-billing-header:` system block are retained. Live tests succeeded with that billing block alone: neither the SDK identity prompt nor Claude Code's coding instructions are retained. Omitting billing attribution returned HTTP 429, even though ordinary inference worked.
- Messages, images/documents, signed thinking, tool schemas/choice/results, generation settings, and provider overlays pass through as native Anthropic JSON. Valid stream bytes, upstream errors, request IDs, and rate-limit headers are preserved. Premature EOF or a stalled stream produces an explicit native error, not silent success.
- OpenCode owns generation retries and cancellation. A capability allows one generation dispatch; an initial 401 is first returned to the official runtime for **one** credential-refresh opportunity. No rate-limit, generation, or partial-stream retry happens inside the plugin. Cancellation/unload aborts upstream work and waits for bounded process cleanup. A POSIX supervisor also terminates the owned runtime if the host crashes.
- Models, limits, dates, capabilities, and variants follow OpenCode's Anthropic catalog. Catalog presence **does not prove account entitlement**. Models have no API-price estimate; subscription usage is not free or unlimited.
- The provider is visible even before sign-in; inference while signed out gives an actionable error.

## Authentication and isolation

Claude Code performs OAuth, SSO, token storage, and refresh. Loopback browser redirects use OpenCode's native auto-completion mode; out-of-band redirects use its code-entry mode. OpenCode stores only the nonsecret marker `managed-by-bundled-claude-code`, not a subscription token. The relay necessarily handles authorization headers **in memory** while forwarding requests; it neither extracts credentials from disk nor logs them. The real refresh test confirmed a changed credential followed by successful live inference; it does not prove every future revocation/expiry scenario.

The runtime uses `${XDG_DATA_HOME:-~/.local/share}/open-claude/claude`. It does not use your normal `~/.claude` configuration. Host API keys, credential overrides, `NODE_OPTIONS`, and other provider-mode flags are excluded from its environment. Safe mode, an empty tool list, disabled skills, no session persistence, no settings sources, and an empty strict MCP configuration keep Claude customizations out of the inference path. Administrator-managed runtime policies may still apply.

The relay binds only to `127.0.0.1`, uses random 256-bit capabilities, caps request size/concurrency, fixes the upstream host to `https://api.anthropic.com`, and refuses redirects. There is no configurable upstream URL in production. Same-user processes can inspect one another's environment/configuration; loopback authentication is not a sandbox against your own OS account.

## Transport options

Optional, bounded integer settings go in the plugin entry's `options`; unknown keys are rejected. `maxConcurrent` defaults to 8 per plugin instance, `startupTimeoutMs` to 60,000, `idleTimeoutMs` to 120,000, and total `timeoutMs` to 900,000. Startup/idle deadlines are useful even when a total request is allowed to take longer. The body limit is 32 MiB, with a 30-second body-read deadline. Options cannot change the upstream host, executable, or credential source.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/path/printed/by/pixi-run-install",
    "options": { "maxConcurrent": 4, "idleTimeoutMs": 180000 },
  }],
}
```

## Development and checks

```sh
pixi run check       # strict TypeScript
pixi run test        # offline protocol, auth, lifecycle, and installer tests
pixi run smoke-host # production plugin in an isolated real OpenCode server
pixi run e2e        # real OpenCode + bundled runtime + native read tool round trip
pixi run smoke-package # install archive without dev deps, verify runtime + V2 loading
pixi run smoke-deployment # independent snapshots, update, rollback, real host loading
pixi run release-check # aggregate offline release gates + production dependency audit
pixi run doctor     # bundled version and sign-in state; no credentials printed
pixi run smoke-live # requires YOUR sign-in; makes one small real inference call
pixi run smoke-live-host # real OpenCode read-tool round trip with live inference
pixi run test-live  # broader live acceptance suite; consumes subscription allowance
pixi run smoke-refresh # inject one 401; official runtime refreshes its own token
pixi run soak      # periodic small real requests (10 minutes by default)
pixi run pack       # creates a local npm archive; nothing is published
pixi run release-archive # source download + SHA256SUMS, no Git required
pixi run smoke-bootstrap # clean source archive → Pixi install → real host loading
```

`pixi.lock` pins the toolchain; `package-lock.json` pins npm dependencies and integrity hashes. Dependencies are prepared incrementally by npm **inside Pixi**, with lifecycle scripts disabled. Routine commands do not reinstall them. A changed/inconsistent development installation requires explicit `pixi run deps-update`; immutable installed releases are unaffected. Local archives include an npm shrinkwrap generated from the tested lockfile. The SDK platform package supplies the native binary. Offline fixtures use dummy keys/synthetic credentials and never copy real credentials. Host tests require `opencode` on PATH and use temporary configuration and an in-memory database. Commands labeled live/soak/refresh use your real sign-in and allowance.

See [docs/testing.md](docs/testing.md) for live-suite coverage, manual UI prompts, and interpreting failures.
See [docs/releasing.md](docs/releasing.md) for CI and reproducible release preparation. CI never receives subscription credentials.

Validated locally on macOS arm64 / OpenCode **2.0.18**, with types from `@opencode/plugin` **2.0.26**, and bundled Claude Code **2.1.296** (`claude-agent-sdk` **0.3.296**). Linux x64 has passed the full offline CI gate, including actual bundled-runtime and native OpenCode host tests; live OAuth/inference there is not certified. Intel macOS and Linux arm64 remain declared Pixi targets without verification evidence. Newer V2 hosts use package exports; `server.ts` supports the early V2 directory loader.

## Release gates / known limitations

- Recheck browser sign-in and `pixi run smoke-live` on every runtime upgrade. Upstream may change its attribution requirements or otherwise restrict subscription requests. No fallback silently switches to API billing or another account.
- The live suite verifies editing plus independent shell tests, tool-error recovery, recall/fork isolation, compaction, native MCP, Code Mode, vision, and effort switching. The owner's separate UI tests verified questions, stop/resume, image transcription, and mid-tool steering. This does not certify every subagent, revert, long-context, or future-provider behavior.
- Permission rejection blocks the command, but OpenCode's shell tool loses rejection feedback inside a generic execution error. The suite records this narrowly identified behavior as `known-host-issue`, **not a pass**; other failures still fail the suite. See [testing notes](docs/testing.md#observed-live-results).
- Requests go through Anthropic's Messages endpoint only: no Bedrock, Vertex, enterprise inference gateway, WebSockets, or Claude remote-session transport.
- Fresh runtime processes add startup overhead. Managed runtime customizations and runtime/upstream changes need compatibility testing on every upgrade.
- Source is available publicly; the npm package remains private and is not published. Public visibility does not grant a license: this project is currently `UNLICENSED`. The pinned SDK/native runtime retains its own license. Production dependency auditing is a release gate. Development-only OpenCode SDK advisories are explicitly triaged in [docs/security.md](docs/security.md), not hidden with forced dependency overrides.
