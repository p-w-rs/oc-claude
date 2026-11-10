# Release checklist (1.0.0)

The target is a reliable public candidate with honest support boundaries, not a claim of universal compatibility. Do not mark a gate passed solely because a model says it worked. Missing hardware and long-duration coverage are disclosed limitations, not blockers for this candidate.

- [x] Dependency preparation is incremental and does not reinstall on routine commands.
- [x] Installations are immutable snapshots; updating does not rewrite the prior artifact.
- [x] Requests have separate startup, upstream-idle, and total deadlines.
- [x] Truncated SSE streams fail explicitly; valid response bytes remain unchanged.
- [x] Runtime failures are classified without logging prompts, stderr, or credentials.
- [x] Upstream 401 reaches the official runtime for one bounded refresh opportunity; inference failures are not secretly retried.
- [x] Cancellation/unload waits for bounded owned-process cleanup, including stubborn runtimes.
- [x] An abrupt host crash terminates the owned runtime in the tested POSIX supervisor path.
- [x] OAuth URL framing, cancellation, timeout, auto-completion, and invalid codes have regression tests.
- [x] Concurrent synthetic requests remain isolated, with capacity/backpressure tests.
- [x] Real host tests cover MCP/Code Mode, variants, images, compaction, and forks.
- [x] Production archive installation and rollback are tested.
- [x] Production dependency audit has no unresolved advisories; development advisories are triaged.
- [x] A reproducible offline release check and explicit live checks are documented.
- [x] Platform/version support and remaining external-host limitations are documented accurately.

## Evidence and scope

- `pixi run release-check`: type checking, offline unit/integration tests, native host round trip, truncated/stalled/disconnected stream failures, production-only archive, independent snapshot/update/rollback, clean source-download bootstrap through Pixi, and production audit.
- `test/concurrency.test.ts`: 24 isolated requests, capacity accounting during body upload, bounded upstream production with a paused consumer, and upstream cancellation on disconnect.
- `pixi run test-live`: independently observed tools/files/tests, recall/forks, compaction, both MCP paths, effort switching, and vision. The shell rejection-feedback host defect is reported separately, not counted as a pass.
- `pixi run smoke-refresh`: one injected 401, two attempts, changed credential, then successful real inference. No credential files inspected or copied.
- Five-minute soak: six successful real requests, including requests following the explicit refresh test.
- `pixi run doctor`: runtime matches SDK pin and isolated store is signed in.

Verified local environment: macOS arm64, OpenCode host 2.0.18, plugin types 2.0.26, Node 24, SDK 0.3.296 / Claude Code 2.1.296. Test reports are local under `test-results/` and are not package contents.

Linux x64: the full offline job passed in [CI run 42448218223](https://github.com/p-w-rs/oc-claude/actions/runs/42448218223), including 51 tests, actual bundled-runtime routing, native host faults, packaging, deployment/rollback, clean Pixi bootstrap and production audit. That run's overall cancellation came from GitHub rejecting the retired macOS runner before it started; it does not negate the completed Linux job. The workflow now targets macOS 15. Linux live-account OAuth/inference remains unverified.

**Release decision (1.0.0, 2026-11-10):** released after `pixi run release-check` (all offline gates, clean bootstrap, 0 production advisories), `pixi run test-live` (8 passed, 0 failed, 1 known host issue) and `pixi run smoke-refresh` (refresh with a changed credential, then success) on macOS arm64 with OpenCode 2.2.6. macOS arm64 is locally verified; other targets are not claimed verified merely because CI is configured. OpenCode configuration reload can interrupt active host sessions; independent snapshots prevent artifact mutation but do not guarantee uninterrupted host reloads.

Public-readiness additions in rc.2: Git-free installation instructions, supported-host preflight, safe uninstall, source archive/checksum generation, clean bootstrap acceptance, pinned read-only Linux/macOS CI, a bug-report template, and troubleshooting/release procedures. Existing license metadata remains unchanged at the owner's request.

Long-duration token renewal and other platforms require their own evidence. A short local test run cannot certify them.
