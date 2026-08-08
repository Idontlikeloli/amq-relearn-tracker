import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE_URL = "https://amq-stats-api.yarthepro.workers.dev";
const localDataRoot = resolve("data");
const files = [
  "latest_rank_usual.json",
  "pcorrect/pcorrect_watched.json",
  "rank_estimator/rank_estimator.json",
  "rank_estimator/rank_training_data.csv",
  "rank_estimator/rank_transition_output.json",
  "recommendations_by_popularity__watched.json",
  "rig_analysis/list_difficulty__all.json",
  "rig_analysis/list_vintage__all.json",
  "stats_usual.json",
  "usefulness_estimator/usefulness_estimator.json",
  "usefulness_estimator/usefulness_training_data.csv",
  "usefulness_estimator/usefulness_transition_output.json",
  "changelog/data.txt",
  "changelog/index.json"
];

const downloaded = [];

async function download(relativePath) {
  const response = await fetch(`${API_BASE_URL}/${relativePath}`);
  if (!response.ok) {
    throw new Error(`${relativePath}: HTTP ${response.status}`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  const destination = resolve(localDataRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  downloaded.push({ path: relativePath, bytes: contents.length });
}

for (const file of files) {
  await download(file);
}

const changelogFiles = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    resolve(localDataRoot, "changelog/index.json"),
    "utf8"
  )
);
for (const fileName of changelogFiles) {
  if (typeof fileName === "string" && fileName.endsWith(".txt")) {
    await download(`changelog/${fileName}`);
  }
}

const totalBytes = downloaded.reduce((total, file) => total + file.bytes, 0);
console.log(`Downloaded ${downloaded.length} global fixture files (${totalBytes.toLocaleString()} bytes).`);
