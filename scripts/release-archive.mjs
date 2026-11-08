import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Source distribution: explicit allowlist prevents credentials, local reports,
// dependencies and mutable deployment state from becoming release artifacts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] || join(root, "test-results", "release"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const name = `open-claude-${pkg.version}`;
const directory = await mkdtemp(join(tmpdir(), "open-claude-release-"));
try {
  const staging = join(directory, name);
  await mkdir(staging);
  for (const entry of ["src", "scripts", "test", "docs", "server.ts", "README.md", "CHANGELOG.md", "package.json", "package-lock.json", "pixi.toml", "pixi.lock", "tsconfig.json", ".gitignore"]) {
    await cp(join(root, entry), join(staging, entry), { recursive: true });
  }
  await mkdir(destination, { recursive: true });
  const filename = `${name}.tar.gz`;
  const archive = join(destination, filename);
  const result = spawnSync("tar", ["-czf", archive, "-C", directory, name], { encoding: "utf8", timeout: 60_000, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(join(destination, "SHA256SUMS"), `${sha256}  ${filename}\n`);
  console.log(JSON.stringify({ archive, sha256 }));
} finally { await rm(directory, { recursive: true, force: true }); }
