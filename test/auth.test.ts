import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Login, marker } from "../src/auth.js";
import { childEnvironment } from "../src/runtime.js";

test("child environment excludes external credentials and execution overrides", () => {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "DO-NOT-INHERIT";
    const env = childEnvironment();
    for (const key of keys) assert.equal(env[key], undefined, key);
    assert.equal(env.CLAUDE_CODE_SAFE_MODE, "1");
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("OAuth relays the CLI URL and code, storing only a nonsecret connection marker", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `
    process.stdout.write('https://claude.ai/oauth/');
    setTimeout(() => process.stdout.write('authorize?state=offline-test\\n'), 40);
    process.stdin.once('data', code => process.exit(code.toString().trim() === 'test-code' ? 0 : 2));
  `], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  try {
    const attempt = await login.authorize();
    assert.equal(attempt.url, "https://claude.ai/oauth/authorize?state=offline-test");
    await assert.rejects(login.authorize(), /already running/);
    const credential = await attempt.callback("test-code");
    assert.equal(credential.access, marker().access);
    assert.equal(credential.refresh, "managed-by-bundled-claude-code");
  } finally { login.cancel(); }
});

test("cancel stops login and rejects pending completion", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `
    console.log('https://claude.ai/oauth/authorize?state=offline-test');
    process.stdin.resume();
  `], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  const attempt = await login.authorize();
  login.cancel();
  await assert.rejects(attempt.callback("code"), /cancelled/);
});

test("failed CLI login is surfaced without leaking CLI output", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", "console.error('SECRET');process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  await assert.rejects(login.authorize(), error => error instanceof Error && /failed/.test(error.message) && !error.message.includes("SECRET"));
});

test("browser auto-completion can be confirmed without inventing a code", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `
    console.log('https://claude.ai/oauth/authorize?state=offline-test');
    setTimeout(()=>process.exit(0),40);
  `], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  const attempt = await login.authorize();
  const credential = await attempt.callback("");
  assert.equal(credential.access, "managed-by-bundled-claude-code");
  await assert.rejects(attempt.callback("again"), /already being verified/);
  await login.cancel();
});

test("expired login rejects pending completion and terminates its process", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `
    console.log('https://claude.ai/oauth/authorize?state=offline-test');
    setInterval(()=>{},1000);
  `], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch, 300);
  const attempt = await login.authorize();
  await assert.rejects(attempt.callback("test"), /expired/);
  await login.cancel();
});

test("invalid code errors are surfaced promptly without exposing CLI output", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `
    console.log('https://claude.ai/oauth/authorize?state=offline-test');
    process.stdin.once('data',()=>console.error('Invalid code SECRET'));
    setInterval(()=>{},1000);
  `], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  const attempt = await login.authorize();
  await assert.rejects(attempt.callback("wrong"), error => error instanceof Error && /rejected/.test(error.message) && !error.message.includes("SECRET"));
  await login.cancel();
});

test("authorization input cannot inject multiple terminal lines", async () => {
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `
    console.log('https://claude.ai/oauth/authorize?state=offline-test');
    setInterval(()=>{},1000);
  `], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  const attempt = await login.authorize();
  await assert.rejects(attempt.callback("one\ntwo"), /format/);
  await login.cancel();
});

test("loopback OAuth redirects use native auto mode instead of a code prompt", async () => {
  const url = "https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback";
  const launch: typeof spawn = (() => spawn(process.execPath, ["-e", `console.log(${JSON.stringify(url)});setTimeout(()=>process.exit(0),40);`], { stdio: ["pipe", "pipe", "pipe"] })) as typeof spawn;
  const login = new Login(launch);
  const attempt = await login.authorize();
  assert.equal(attempt.mode, "auto");
  assert.equal((await attempt.callback).access, "managed-by-bundled-claude-code");
  await login.cancel();
});
