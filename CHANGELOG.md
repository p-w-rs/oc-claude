# Changes

## 0.2.0-rc.2 — public installation and release tooling

- Public quickstart with Git-free download installation, update/uninstall instructions, and troubleshooting.
- Fail early on unsupported platforms, missing OpenCode, and incompatible host versions before editing configuration.
- Safe, idempotent uninstall preserving credentials, snapshots, and unrelated settings.
- Source download packaging with SHA-256 checksum and a clean-download Pixi bootstrap acceptance test.
- SHA-pinned, read-only GitHub Actions release checks on Linux/macOS with a pinned OpenCode V2 host; no subscription secrets in CI.
- Public bug-report template and maintainer release procedure.
- Await login cancellation before returning from its command.

Other-platform and naturally occurring long-duration token-expiry coverage remain disclosed limitations, not blockers for this public candidate. Existing license metadata is unchanged.

## 0.2.0-rc.1 — private release candidate

- Separate startup, upstream-idle, total, and request-body deadlines.
- Explicit native errors for truncated, stalled, or disconnected SSE streams.
- One bounded 401 credential-refresh opportunity through the official runtime; no hidden generation retries.
- Supervised runtime processes with host-crash cleanup and bounded shutdown.
- Improved sign-in cancellation, expiry, code validation, and asynchronous status checks.
- Bounded transport options and best-effort native connection status updates.
- Incremental dependency preparation; routine tasks do not run `npm ci`.
- Content-addressed production snapshots, integrity checks, configuration-preserving updates, and rollback.
- Expanded offline tests and live host checks for native tools, MCP, Code Mode, model variants, vision, forks, and compaction.
- Explicit reporting of OpenCode's shell permission-feedback limitation.

Validated platform: macOS arm64. This is not a claim of universal support or completed long-duration OAuth-renewal certification.

## 0.1.0 — working prototype

- Native V2 Anthropic protocol provider using a bundled Claude Code transport.
- Replacement instructions with minimal runtime attribution.
- Browser sign-in and verified live native-tool round trips.
