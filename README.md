# AMQ-Relearn-Tracker

AMQ Relearn tracker by Idontlikeloli

## Local demo

The project includes a small local data fixture so the dashboard can be tested
without calling the production API from the browser.

The fixture files are intentionally ignored by Git. Localhost uses `./data`,
while deployed sites use the Worker/R2 API.

1. Serve this directory with a local static server on port 4173.
2. Open `http://localhost:4173/`.
3. Log in with `Demo`.

`Demo` uses the local records for `I_dont_like_loli`. The fixture includes the
core stats, player-specific dashboard data, `song_key.json`, MAL artwork
metadata, and latest-rank data; optional views whose source file is not present
will show an empty state. Weekly and last-week summary data is also included.

To refresh the player-specific fixture for player ID 364, run:

```powershell
node scripts/download-player-fixture.mjs 364
```

To recreate the basic `Demo` login and `stats.json` fixture, run:

```powershell
node scripts/create-demo-fixture.mjs I_dont_like_loli Demo 364
```

To download the global datasets used by the local dashboard, run:

```powershell
node scripts/download-global-fixture.mjs
```

After adding or refreshing fixture files, regenerate the local file manifest:

```powershell
node scripts/create-local-manifest.mjs
```

For basic local request timings, open browser DevTools and run
`getAmqLocalDataRequestSummary()`. The full request list is available as
`window.__amqLocalDataRequests`.
