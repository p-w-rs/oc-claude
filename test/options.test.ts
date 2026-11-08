import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../src/options.js";

test("transport options are bounded integers and do not allow routing overrides", () => {
  assert.deepEqual(parseOptions({}), {});
  assert.deepEqual(parseOptions({ maxConcurrent: 4, idleTimeoutMs: 1000 }), { maxConcurrent: 4, idleTimeoutMs: 1000 });
  for (const options of [{ maxConcurrent: 0 }, { maxConcurrent: 65 }, { timeoutMs: Infinity }, { idleTimeoutMs: 1.5 }, { startupTimeoutMs: "1000" }, { upstream: "https://example.com" }]) {
    assert.throws(() => parseOptions(options));
  }
});
