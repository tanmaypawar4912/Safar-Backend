import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../src/", import.meta.url);
const rootPath = new URL(root).pathname;
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && path.endsWith(".js")) files.push(path);
  }
}

await collect(rootPath);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`FAIL ${relative(rootPath, file)}\n${result.stderr || result.stdout}`);
  }
}
if (failed) process.exit(1);
console.log(`PASS syntax check for ${files.length} backend JavaScript files.`);
