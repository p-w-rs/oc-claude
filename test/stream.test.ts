import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamCompletion } from "../src/stream.js";

test("SSE completion handles every possible network boundary and UTF-8", () => {
  const wire = Buffer.from('event: content_block_delta\r\ndata: {"text":"漢字 🦊"}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n');
  for (let size = 1; size <= wire.length; size++) {
    const observer = new StreamCompletion();
    for (let i = 0; i < wire.length; i += size) observer.push(wire.subarray(i, i + size));
    assert.equal(observer.finish(), true, String(size));
  }
});

test("SSE truncation or a terminal word inside content is not success", () => {
  for (const wire of ['event: message_stop\n', 'event: message_stop\ndata: {}', 'event: content_block_delta\ndata: {"text":"message_stop"}\n\n']) {
    const observer = new StreamCompletion();
    observer.push(Buffer.from(wire));
    assert.equal(observer.finish(), false);
  }
});

test("in-band provider errors are terminal and not replaced", () => {
  const observer = new StreamCompletion();
  observer.push(Buffer.from('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n'));
  assert.equal(observer.finish(), true);
});

test("large SSE lines stay bounded and do not hide terminal events", () => {
  const observer = new StreamCompletion();
  observer.push(Buffer.from(`data: {"text":"${"x".repeat(2_000_000)}"}\n\nevent: message_stop\ndata: {}\n\n`));
  assert.equal(observer.finish(), true);
});
