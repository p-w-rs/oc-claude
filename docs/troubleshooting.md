# Troubleshooting

Start with:

```sh
opencode --version
pixi --version
pixi run doctor
```

`doctor` prints the bundled runtime version and a nonsecret sign-in status. Do not share credential files, browser authorization links/codes, prompts, or full OpenCode provider responses (they can contain the local relay capability).

| Symptom | Action |
| --- | --- |
| OpenCode missing or V1 detected | Install [OpenCode V2](https://opencode.ai/v2/docs/), ensure `opencode --version` reports 2.0.18 or newer in the 2.x family, then retry. Installation checks this before editing configuration. |
| Provider not visible | Use `/reload`, then `/models`. Check that the global `plugins` array contains the snapshot printed by the installer. Do not add a manual provider definition. Project config may override global settings. |
| Signed out / authentication failure | `/connect` → OpenClaude, and sign in. Ordinary `~/.claude` credentials are intentionally not used. Terminal fallback: `pixi run login`. |
| Abandoned browser login | `/claude-login-cancel`, then reconnect. |
| 429 / capacity or rate limit | Allow current work to finish and respect `retry-after`. Subscription limits and model entitlement are account-specific; this plugin does not bypass them. |
| Stream stalled / incomplete | The request failed explicitly. Retry from OpenCode when appropriate; inspect partial tool/file changes first. The plugin does not secretly restart generation. |
| Dependencies differ from lockfile | `pixi run deps-update`, then retry. This explicitly replaces development dependencies; active immutable snapshots are unaffected. |
| Update caused a regression | `pixi run rollback`, then `/reload` if needed. A previous managed installation is required. |
| Install/dependency lock remains after a crash | The error names the lock file. Confirm the recorded process is no longer running before removing that specific lock. Do not delete configuration or credential directories. |
| Shell permission rejection feedback missing | Known OpenCode host issue: rejection blocks the command, but its persisted error may omit your feedback. |

To remove the plugin safely, run `pixi run uninstall`. It removes only managed plugin entries and preserves settings, credentials, and prior snapshots. If the source folder is unavailable, remove the corresponding entry from the global OpenCode `plugins` array manually.

Report reproducible problems at <https://github.com/p-w-rs/oc-claude/issues> with OS/architecture, plugin version, OpenCode version, safe doctor output, and minimal reproduction steps. Windows is not supported. Linux/Intel macOS targets should be treated according to the actual CI/test evidence, not assumed equivalent to Apple Silicon.
