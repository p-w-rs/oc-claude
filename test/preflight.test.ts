import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: installation bootstrap runs without TypeScript compilation.
import { checkHost } from "../scripts/preflight.mjs";

test("installation preflight accepts supported V2 and rejects old/missing hosts", () => {
  const check = (version: string) => checkHost({ platform: "darwin", arch: "arm64", run: () => ({ status: 0, stdout: version }) });
  for (const version of ["2.0.18", "opencode v2.0.18", "v2.0.26", "2.1.0", "2.0.27-beta.1"]) assert.equal(check(version).version, version);
  for (const version of ["1.9.0", "2.0.17", "3.0.0", "unexpected output"]) assert.throws(() => check(version), /requires OpenCode V2/);
  assert.throws(() => checkHost({ platform: "win32", arch: "x64" }), /Unsupported platform/);
  assert.throws(() => checkHost({ platform: "linux", arch: "arm", run: () => ({}) }), /Unsupported platform/);
  assert.throws(() => checkHost({ run: () => ({ status: null, error: new Error("ENOENT") }) }), /not available on PATH/);
});
