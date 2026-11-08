# Releasing

The public source repository does not imply an npm publication. Keep `private: true` and the existing license metadata unless the owner explicitly changes that policy. Never include the vendor binary, credentials, local test reports, or deployment state in a source download.

## Before a release

1. Update `package.json`, `pixi.toml`, changelog and README version/status together; run `pixi run npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.
2. Run `pixi run release-check`. This includes a clean source-download bootstrap, not only the working-directory build.
3. Run `pixi run test-live` and `pixi run smoke-refresh` with an explicitly authorized signed-in test account. These consume subscription allowance. Never put personal subscription credentials into public CI.
4. Record actual results and known host issues in `docs/release-checklist.md`. New CI platform results count only after the jobs finish successfully; configured jobs are not verification evidence.
5. Run `pixi run release-archive`. It writes a self-contained source tree and `SHA256SUMS` under `test-results/release/`. Extracting this archive and running `pixi run --locked install` needs no Git checkout or separate Node/npm/Claude installation.
6. Commit the tested source, wait for CI, then tag that exact commit. If publishing a GitHub Release, attach the source archive and its matching `SHA256SUMS`, include the observed environment and limitations, and mark prereleases accordingly. Do not upload real-session evidence or npm-publish as a side effect.

The checksum detects corruption but is not a publisher signature. Source archives intentionally omit `.github`, generated `dist`, dependencies, and `.git`. Dependencies and the pinned vendor runtime are fetched from their original registries at install time; installation needs network access.

## CI

`.github/workflows/ci.yml` uses SHA-pinned actions, Pixi 0.81.0, the locked Node/npm graph and OpenCode V2 2.0.18. It runs the full offline gate on Linux and macOS with read-only repository permissions, then uploads source/evidence artifacts. It does not exercise real OAuth or live inference. The production audit is network-dependent and may detect advisories published after a previous successful release.
