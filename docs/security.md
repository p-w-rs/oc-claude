# Security and dependency notes

## Scope and trust

This is a private, single-user local provider, not a multi-tenant inference service or sandbox. The OpenCode server and the local OS account are trusted. Do not expose the relay to a network or reuse its capability as a remote authentication scheme.

- Bind only to IPv4 loopback; use independently random 256-bit capabilities for host and runtime routes.
- Do not accept a production upstream URL or executable from HTTP/plugin options.
- Never follow upstream redirects with authorization headers.
- Do not inherit host API credentials, `NODE_OPTIONS`, provider-mode flags, or ordinary Claude configuration.
- Do not log credentials, authorization codes, model prompts, stderr, or HTTP bodies. Only classified errors are surfaced by the relay.
- Runtime-owned bearer credentials are forwarded in memory to the fixed upstream. Authentication refresh stays with the official runtime.
- Keep ordinary Claude tools and customizations disabled; the actual model response is delivered only to OpenCode.
- Keep release snapshots separate from working-directory dependencies. Installation checksums detect accidental changes, not a malicious same-user attacker who can also rewrite the manifest/configuration.

## Development advisories

The current full development audit reports 24 moderate advisories and no high/critical advisories. The root issues are glob cancellation/DoS (`GHSA-3g3m-2fjr-6pw4`) and minimatch glob-parts amplification (`GHSA-g3hv-75wg-m249`), with transitive reports through OpenCode's utility/package-management graph; gaxios/rimraf also inherits a glob report.

These packages arrive through the **development-only** `@opencode/plugin` SDK. This implementation imports it for TypeScript types only; production JS has no import of that SDK/Effect/util stack. The vulnerable package-management/globbing APIs are not used by this plugin's development scripts or tests, and no attacker-supplied patterns are passed to them. Release snapshots omit development dependencies. The accepted private-RC risk is limited to this locked development graph; this is not a claim that the advisory itself is harmless or fixed.

Do not use `npm audit fix --force` or untested major-version overrides to conceal the reports. Reevaluate them when upgrading the SDK. `pixi run release-check` fails on **any production advisory**, while the complete development audit remains available with `pixi run npm audit`.

## Runtime upgrades

The runtime is pinned and its auto-updater is disabled. An upgrade must rerun offline fault/lifecycle tests, archive/deployment checks, the live suite, and the explicit refresh check. Runtime wire behavior and attribution requirements are not a stable vendor extension API.

The release-check report, live-suite reports, and periodic-request report are local test evidence. Do not publish real user/session content or credentials with them.
