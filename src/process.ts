import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

const supervised = new WeakMap<ChildProcess, Writable>();

// The shell owns/reaps the runtime. Its guard holds a read end of an otherwise
// unused host pipe. EOF (including SIGKILL of the host) terminates the runtime.
// No daemon, PID scanning, or additional installed tool is needed on POSIX.
// The executable and arguments are positional parameters, never shell source.
// Save stdin before starting the asynchronous command: dash replaces fd 0 with
// /dev/null for background jobs, even when their redirect says <&0.
const SUPERVISOR = String.raw`
exec 4<&3
exec 5<&0
"$@" <&5 3<&- 4<&- 5<&- &
runtime=$!
exec 5<&-
(
  if ! IFS= read -r done <&4; then
    kill -TERM "$runtime" 2>/dev/null || exit 0
    sleep 2
    kill -KILL "$runtime" 2>/dev/null || :
  fi
) &
guard=$!
trap 'kill -TERM "$runtime" 2>/dev/null || :' TERM INT HUP
while :; do
  wait "$runtime"
  status=$?
  kill -0 "$runtime" 2>/dev/null || break
done
kill -TERM "$guard" 2>/dev/null || :
wait "$guard" 2>/dev/null || :
exit "$status"
`;

export function spawnSupervised(executable: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform === "win32") throw new Error("OpenClaude currently supports macOS and Linux, not Windows");
  const child = spawn("/bin/sh", ["-c", SUPERVISOR, "open-claude-runtime", executable, ...args], {
    ...options, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const heartbeat = child.stdio[3] as Writable;
  supervised.set(child, heartbeat);
  heartbeat.on("error", () => {});
  child.once("exit", () => heartbeat.end());
  child.stdin?.on("error", () => {});
  return child;
}

export function providePrompt(child: ChildProcess): void {
  child.stdin?.end("Reply OK.\n");
}

export function stopChild(child: ChildProcess, graceMs = 2000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (supervised.has(child) && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch { /* already exited */ }
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(force);
      clearTimeout(deadline);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    const force = setTimeout(() => signal("SIGKILL"), graceMs);
    const deadline = setTimeout(finish, graceMs + 1000);
    force.unref();
    deadline.unref();
    child.once("exit", finish);
    child.once("error", finish);
    signal("SIGTERM");
    child.stdin?.end();
    supervised.get(child)?.end();
  });
}
