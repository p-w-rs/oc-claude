import { mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] || root);
const staging = await mkdtemp(join(tmpdir(), "open-claude-pack-"));
try {
  await mkdir(destination, { recursive: true });
  for (const entry of ["package.json", "server.ts", "README.md", "CHANGELOG.md", "dist", "docs"]) await cp(join(root, entry), join(staging, entry), { recursive: true });
  // Unlike package-lock.json, npm-shrinkwrap.json is honored inside a package
  // archive. Keep the full tested graph pinned without creating a competing
  // development lockfile in the working directory.
  await cp(join(root, "package-lock.json"), join(staging, "npm-shrinkwrap.json"));
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination, "--json"], { cwd: staging, encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  process.stdout.write(result.stdout);
} finally { await rm(staging, { recursive: true, force: true }); }
