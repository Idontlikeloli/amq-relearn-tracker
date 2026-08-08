import { readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const dataRoot = resolve("data");

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (entry.isFile() && entry.name !== "manifest.json") {
      files.push(relative(dataRoot, fullPath).split(sep).join("/"));
    }
  }
  return files;
}

const files = (await collectFiles(dataRoot)).sort();
const manifest = {
  version: 1,
  files
};

await writeFile(resolve(dataRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote data/manifest.json with ${files.length} files.`);
