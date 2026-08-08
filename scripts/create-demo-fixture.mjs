import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SOURCE_URL = "https://amq-stats-api.yarthepro.workers.dev/stats.json";
const sourceName = process.argv[2] || "I_dont_like_loli";
const demoName = process.argv[3] || "Demo";
const playerId = process.argv[4] || "364";
const dataDirectory = resolve("data");

console.log(`Downloading stats for ${sourceName}...`);
const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Could not download stats.json: HTTP ${response.status}`);
}

const allStats = await response.json();
const sourceKey = Object.keys(allStats).find(
  key => key.toLowerCase() === sourceName.toLowerCase()
);
if (!sourceKey || !Array.isArray(allStats[sourceKey])) {
  throw new Error(`No stats were found for '${sourceName}'.`);
}

await mkdir(dataDirectory, { recursive: true });
await Promise.all([
  writeFile(
    resolve(dataDirectory, "players.json"),
    `${JSON.stringify([
      {
        playerId,
        displayName: demoName,
        altnames: [sourceKey]
      }
    ], null, 2)}\n`
  ),
  writeFile(
    resolve(dataDirectory, "stats.json"),
    `${JSON.stringify({ [sourceKey]: allStats[sourceKey] }, null, 2)}\n`
  )
]);

console.log(`Created ${demoName} with ${allStats[sourceKey].length} records from ${sourceKey}.`);
