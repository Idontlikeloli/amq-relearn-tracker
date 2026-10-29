PostHog is configured in `analytics.js` and loaded by `index.html` and `player.html`.
The `phc_` project token is a public browser token. No private API key is used.

After deploying all three files, visit the public site and navigate between tabs.
In PostHog's live events/activity view, look for `section_viewed` and `song_played`.
Localhost, file previews and local IP addresses deliberately send no events.

| Event | Meaning / useful breakdown |
| --- | --- |
| `$pageview` | One HTML page visit, with the URL query and fragment removed. |
| `section_viewed` | Actual selected section and subtab; background preloads are excluded. Break down by `section` and `view`. |
| `section_time` | Visible-tab seconds before navigating, hiding or leaving. Sum `visible_seconds` by `view`. This measures visible time, including idle reading, not attention. |
| `dashboard_opened` | A valid player was selected on the landing page. |
| `song_played` | Successful playback start/resume, including automatic playlist advances. Break down by `source` and `clip` (full, sample, Verse, Pre-chorus, Chorus). Automatic repeat of the same song is not counted again. |
| `songs_exported` | A ZIP or CSL file was handed to the browser for saving. Includes successfully exported `song_count`, format, source, and relearn filters; does not confirm the user saved the file. |
| `search_submitted` | Submitted player, song, artist and playlist searches, explicit autocomplete selection, comparison additions and synergy selection. Includes the searched `query`, `feature`, `input_id` and comparison player count when relevant. Empty searches are omitted. |
| `search_filtered` | Live search filters (tags, seasons, rivals, tour dates/songs, genre/tag picker and artist song filter). Includes the searched `query`, `feature` and `input_id`. Records after a 1.2-second pause, Enter or leaving the field, with repeated identical filter values deduplicated. |
| `filter_changed` | Intentional changes to watched/usual, ANT, data range, combined trend or comparison table/chart. Programmatic data-range changes are excluded. |

Start with a Trends insight for `section_viewed`, broken down by `view`, and another
for `song_played`, broken down by `source`. Default Overview loads count as visits;
they do not by themselves indicate preference. Counts measure usage, not satisfaction.

Search analytics deliberately include player names, artists, anime titles and other
text entered into the known search controls, as requested. Queries are trimmed,
whitespace-normalized and capped at 220 characters. Arbitrary input values, referrers,
titles and URL parameters remain excluded from ordinary analytics events. No
`identify()` calls are used. IDs are anonymous and stored in sessionStorage; unique
visitor counts are approximate browser-tab sessions, not returning people across days.

Session Replay is enabled in the SDK and uses the project's recording controls. Its
configuration request is enabled; feature-flag evaluation is disabled. Known search
inputs are readable in replays. Other input values are masked by default. Password
fields are explicitly blocked, including the playlist password field even if its
type changes. Replay captures visible page text, selected player information,
clicks, scrolling and DOM changes; it is broader than the ordinary event property
allowlist. Snapshot payloads are preserved after the recorder's browser-side masking.
Console recording, request headers/bodies, streamed request bodies, canvas capture,
autocapture, heatmaps, surveys, exceptions and performance capture are disabled.

After deploying, open PostHog's Session Replay page to verify new recordings. For
search popularity, use `search_submitted` (or `search_filtered` for live filters)
and break down by `query`; use `feature` to distinguish search controls. These
settings apply to future visits only. Earlier omitted query text cannot be recovered.

Analytics runs asynchronously and errors do not interrupt the site. Ad blockers or
network restrictions can prevent collection. No R2 data or upload pipeline changes
are involved. The original analytics event ingestion was confirmed in the live
project; replay and search-text ingestion must be verified after this update deploys.

Run the focused checks with `node tests/test_analytics.cjs`.
