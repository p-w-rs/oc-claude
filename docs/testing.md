# Provider acceptance testing

## Automated live tests

```sh
pixi run test-live
```

This deliberately makes real Sonnet requests and consumes subscription allowance. It starts a separate OpenCode server with temporary configuration, an in-memory database, separate sessions, and synthetic temporary project files. It uses the production plugin and your already-signed-in bundled runtime. It does not control existing sessions or ask the model to edit this repository.

The suite checks observable results, not just whether the model says it succeeded:

- Read two fixture files, edit a bug, run shell tests, independently rerun the tests, and inspect the persisted fix.
- Deliver an actual failed file-read tool result, then recover using another file read.
- Recall a random token across turns, fork, change the branch's token, and verify the parent remains unchanged.
- Request a real manual compaction and verify recall from the resulting context.
- Reject a pending shell permission request with feedback, check the command did not complete, and check the model follows the feedback.
- Call a real local MCP fixture through both a native tool and Code Mode, verifying the fixture's independent call log and the model's answer.
- Switch high/low effort inside an existing conversation and verify subsequent context/response metadata.
- Attach a deterministic PNG and identify its color without file tools.

Each case is bounded by a step limit and deadlines. Results go to `test-results/live-suite.json` (ignored by Git). These are acceptance checks against a nondeterministic live service, not offline unit tests or proof of complete compatibility. A failure can be a model deviation, a harness issue, an OpenCode issue, or a plugin bug; inspect the evidence before attributing it.

### Observed live results

The first full Sonnet 5.5 run passed the first four cases above. Permission rejection prevented command completion, but feedback-following failed. A focused repeat showed the persisted shell error was `tool.execution: Unable to execute command`, without the rejection feedback. The assistant correctly described an execution error rather than producing the feedback-specific reply. OpenCode's shell-tool implementation wraps execution failures in this generic error; this appears to be a host error-propagation issue, not evidence of the relay dropping feedback. The expanded suite has also passed both MCP paths, effort switching, and vision.

The suite now recognizes **only this specific persisted shell-error shape** as `known-host-issue`, verifies that the command did not complete, and records the feedback failure explicitly. It is not counted as a passing test. Other errors or unexpected permission behavior still fail the suite.

To rerun only that case without repeating the successful live workflows:

```sh
pixi run node scripts/smoke-opencode.mjs --suite --case=permission
```

Focused results go to `test-results/live-suite-focused.json`, preserving the last full-suite report.

Other commands:

```sh
pixi run test              # no real inference; protocol/auth/lifecycle tests
pixi run e2e               # real host + runtime, simulated upstream
pixi run smoke-live        # one small real transport request
pixi run smoke-live-host   # one native read-tool workflow with real inference
pixi run smoke-refresh     # real runtime refresh, with a single injected 401
pixi run release-check     # reproducible offline release gates, no real inference
```

`pixi run soak` runs small real requests periodically for 10 minutes by default. For a different bounded duration, for example:

```sh
pixi run node scripts/soak.mjs --duration-ms=300000 --interval-ms=60000
```

The initial five-minute run completed six successful requests, including requests after an explicit credential-refresh test. A separate refresh test observed a changed bearer credential, then successful real inference, after returning one synthetic 401 to the official runtime. Neither test reads credential files. A short soak is **not** proof of natural token expiration or multi-day uptime.

## Useful manual UI tests

Use a separate disposable session with **Claude Code (OpenClaude)** selected. For any file-writing test, confine it to `scratch/plugin-check/`; do not let a test refactor the plugin itself.

### Interactive question

> Before doing any work, use OpenCode's question tool to ask whether I choose red or blue. Wait for my answer, then create scratch/plugin-check/choice.txt containing only my selection. Do not guess or ask the question only as plain text.

Check that the real question UI appears, input is accepted, the tool finishes once, and the file matches your selection.

### Stop and continue

> Explain how an HTTP streaming proxy works in considerable detail. Do not use tools or change files.

Stop it while it is visibly streaming. Then send:

> Ignore the unfinished explanation. Reply with exactly CONTINUE_OK.

Look for a prompt stop, no tokens appearing from the old answer afterward, no stuck spinner, and a normal subsequent response.

### Mid-response steering

Start the long explanation again, then while it runs send:

> Change of plan: stop explaining and summarize the key risk in one sentence. Do not use tools.

Check that the new input is not lost or executed twice. Note whether OpenCode steers immediately or queues it; that behavior is partly OpenCode's own delivery policy.

### Image attachment

Attach a screenshot with recognizable text or a distinctive visual feature:

> Describe this image and transcribe its visible heading. Do not read files or use shell.

Check that the image is actually interpreted, rather than a filename being guessed. Repeat after one tool call in the same conversation to exercise retained attachment history.

### Effort/model variants

Switch effort variants in the model picker during an existing conversation. Ask a small reasoning question, then request a file read. Check that both requests complete, variants remain selected, tool history stays intact, and the next answer has no signature/protocol error. A model's self-description is not evidence of which backend/variant was used.

### Permission UI

In a session where a tool action requires permission, reject it with feedback such as “do not retry; explain what you would have done.” Check that the action is not executed and the assistant responds to the rejection without repeatedly asking for the same approval.

## Reporting a failure

Record model/variant, approximate time, the exact synthetic prompt, whether there was a prior interruption/compaction/model switch, and the visible error. Avoid sharing account tokens, authorization codes, request headers, or private project content. Keep transport failures separate from model mistakes and UI-only glitches.
