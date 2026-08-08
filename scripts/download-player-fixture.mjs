import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE_URL = "https://amq-stats-api.yarthepro.workers.dev";
const playerId = process.argv[2] || "364";
const localDataRoot = resolve("data");
const windows = ["all.json", "past_10_games.json", "past_20_games.json", "past_50_games.json"];
const overviewFiles = [
  "z-score.json",
  "z_score.json",
  "anime_type_count.json",
  "anime_type_count_all.json",
  "anime_type_count_past_10_games.json",
  "anime_type_count_past_20_games.json",
  "anime_type_count_past_50_games.json",
  "top_solos.json",
  "top_songs_by_rig.json",
  "top_doubles_general.json",
  "their_rig_you_blocked.json",
  "top_doubles_their_rig_you_blocked.json",
  "top_doubles_their_rig_blocked.json",
  "your_rig_they_blocked.json",
  "top_doubles_your_rig_they_blocked.json",
  "top_doubles_your_rig_blocked.json"
];
const sharedFiles = [
  "stat.json",
  "stat_usual.json",
  "weighted_guess_rate/weighted_guess_rate.json",
  "artists.json",
  "relearn_tracker/relearn_songs.json",
  "recommendations_by_wrong_guess/top_200.json",
  "recommendations_never_correct/top_30.json",
  "search_songs/search_songs.json",
  "synergy/synergy_count.json",
  "synergy/synergy_samesongsseen.json",
  "synergy/target_to_other_rig_top50.json",
  "synergy/other_to_target_rig_top50.json",
  "synergy/target_to_other_rig_top50_no_duplicates.json",
  "synergy/other_to_target_rig_top50_no_duplicates.json",
  "synergy/synergy_rigstats.json",
  ...windows.flatMap(windowFile => [
    `genres/${windowFile}`,
    `tags/${windowFile}`,
    `by_era/${windowFile}`
  ]),
  ...overviewFiles.map(file => `overview/${file}`)
];
const remotePaths = [
  `players/${playerId}/player.json`,
  `players/${playerId}/changelog/index.json`,
  ...["watched", "usual"].flatMap(mode =>
    sharedFiles.map(file => `players/${playerId}/${mode}/${file}`)
  ),
  ...sharedFiles.map(file => `players/${playerId}/${file}`)
];

const downloaded = [];
const missing = [];

async function download(remotePath) {
  const response = await fetch(`${API_BASE_URL}/${remotePath}`);
  if (response.status === 404) {
    missing.push(remotePath);
    return;
  }
  if (!response.ok) {
    throw new Error(`${remotePath}: HTTP ${response.status}`);
  }

  const destination = resolve(localDataRoot, remotePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  downloaded.push({ path: remotePath, bytes: Number(response.headers.get("content-length")) || 0 });
}

for (const remotePath of remotePaths) {
  await download(remotePath);
}

const changelogIndex = downloaded.find(file => file.path.endsWith("changelog/index.json"));
if (changelogIndex) {
  const indexPath = resolve(localDataRoot, changelogIndex.path);
  const fileNames = JSON.parse(await (await import("node:fs/promises")).readFile(indexPath, "utf8"));
  for (const fileName of fileNames) {
    if (typeof fileName === "string" && fileName.endsWith(".txt")) {
      await download(`players/${playerId}/changelog/${fileName}`);
    }
  }
}

const totalBytes = downloaded.reduce((total, file) => total + file.bytes, 0);
console.log(`Downloaded ${downloaded.length} files (${totalBytes.toLocaleString()} declared bytes) for player ${playerId}.`);
console.log(`${missing.length} known dashboard paths were not present.`);
