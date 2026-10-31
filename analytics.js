/* Feature usage and session replay. Search text is allowed only for named search controls. */
(() => {
  "use strict";
  const w = window;
  const d = document;
  if (w.AMQAnalytics) return;
  const noop = () => {};
  w.AMQAnalytics = Object.freeze({ track: noop, view: noop, search: noop });
  const host = location.hostname.toLowerCase();
  if (!/^https?:$/.test(location.protocol) || !host || host === "localhost"
      || host.endsWith(".localhost") || host.endsWith(".local")
      || host === "[::1]" || /^[\d.]+$/.test(host)) return;

  const views = {
    landing: ["Home"],
    overview: ["overview", "latestTour", "statsSummary", "weekly", "siteGuide"],
    performance: ["Guess Rate", "Lives Taken / Saved", "Onlist/Offlist", "Rigs Missed", "Composite charts"],
    knowledge: ["Artist Familiarity", "Franchise Familiarity", "Tag Familiarity", "Seasonal Comparison"],
    insights: ["Relearn Tracker", "By never correct", "By Wrong Guess", "Playlists"],
    social: ["Synergy", "Rivals", "Team Contributions", "Rig / List analysis"],
    otherTools: ["Search songs", "Search song frequency", "Player database", "Single Tour", "Changelog"]
  };
  const searchInputs = {
    username: "dashboard_player",
    artistFamiliaritySearchInput: "artist",
    artistFamiliarityCompareSearchInput: "artist_comparison",
    searchSongsInput: "song",
    searchSongFrequencyInput: "song_frequency",
    playerDatabaseSearchInput: "player_comparison",
    socialSynergyPlayerSearchInput: "synergy",
    playlistSongSearchInput: "playlist_song",
    playlistLocalSearchInput: "playlist_filter",
    tagSearchInput: "tag",
    byEraSeasonSearchInput: "season",
    socialRivalSearchInput: "rival",
    socialTeamSearchInput: "team_date",
    originalTourSearchInput: "tour_date",
    originalTourSongSearchInput: "tour_song",
    playerDatabaseLabelSearchInput: "genre_tag",
    artistFamiliarityAttemptsFilterInput: "artist_song"
  };
  const liveSearchInputs = new Set([
    "playlistLocalSearchInput", "tagSearchInput", "byEraSeasonSearchInput",
    "socialRivalSearchInput", "socialTeamSearchInput", "originalTourSearchInput",
    "originalTourSongSearchInput", "playerDatabaseLabelSearchInput", "artistFamiliarityAttemptsFilterInput"
  ]);
  function isSearchInput(element) {
    return !!element && Object.hasOwn(searchInputs, element.id)
      && ["text", "search"].includes(String(element.type || "text").toLowerCase())
      && !element.closest?.('.ph-no-capture, .ph-mask, [data-ph-sensitive]');
  }
  function normalizeSearch(value) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 220) : "";
  }
  function maskReplayInput(value, element) {
    const text = String(value || "");
    return isSearchInput(element) ? text : "*".repeat(text.length);
  }
  const choices = {
    method: ["calendar", "search"],
    action: ["date_selected", "previous_month", "next_month", "query_changed"],
    mode: ["watched", "usual", "all"],
    list: ["onlist", "offlist", "all"],
    format: ["zip", "csl"],
    source: ["relearn", "playlist", "search", "other"],
    clip: ["full", "sample", "Verse", "Pre-chorus", "Chorus"],
    feature: Object.values(searchInputs),
    input_id: Object.keys(searchInputs),
    filter: ["tour_mode", "ant", "data_range", "trend", "comparison_view"],
    value: ["watched", "usual", "on", "off", "all", "week", "month", "2months", "3months", "6months", "10", "20", "50", "regular", "combined", "table", "chart"]
  };
  const fields = {
    $pageview: ["section", "view"],
    section_viewed: ["section", "view"],
    section_engaged: ["section", "view", "visible_seconds"],
    section_time: ["section", "view", "visible_seconds"],
    dashboard_opened: [],
    single_tour_navigation: ["method", "action"],
    song_played: ["source", "clip"],
    songs_export_clicked: ["source", "format", "mode", "list", "song_count"],
    songs_exported: ["source", "format", "mode", "list", "song_count"],
    search_submitted: ["feature", "input_id", "query", "player_count"],
    search_filtered: ["feature", "input_id", "query"],
    filter_changed: ["filter", "value"]
  };
  function cleanFields(name, properties = {}) {
    const clean = {};
    for (const key of [...(fields[name] || []), "section", "view"]) {
      const value = properties[key];
      if (key === "section" && Object.hasOwn(views, value)) clean[key] = value;
      else if (key === "view" && views[properties.section]?.includes(value)) clean[key] = value;
      else if (key === "query" && Object.hasOwn(searchInputs, properties.input_id)
          && searchInputs[properties.input_id] === properties.feature) {
        const query = normalizeSearch(value);
        if (query) clean[key] = query;
      }
      else if (choices[key]?.includes(value)) clean[key] = value;
      else if (["song_count", "player_count", "visible_seconds"].includes(key)
          && Number.isFinite(value) && value >= 0) clean[key] = Math.min(1000000, Math.round(value));
    }
    return clean;
  }
  // The SDK adds URL/referrer/person properties even to manual events. Rebuild
  // properties from an allowlist before sending, including on queued captures.
  const sdkFields = ["token", "distinct_id", "$device_id", "$session_id", "$window_id",
    "$lib", "$lib_version", "$browser", "$browser_version", "$os", "$os_version",
    "$device_type", "$screen_height", "$screen_width", "$viewport_height", "$viewport_width"];
  const page = /\/player\.html$/.test(location.pathname) ? "player.html" : "index.html";
  const safeUrl = new URL(page, location.href).origin + new URL(page, location.href).pathname;
  function beforeSend(event) {
    // Replay snapshots have already passed browser-side input masking. Preserve
    // their payload and metadata; the analytics allowlist would erase the replay.
    if (event?.event === "$snapshot") return event;
    if (!event || !Object.hasOwn(fields, event.event)) return null;
    const original = event.properties || {};
    const properties = cleanFields(event.event, original);
    sdkFields.forEach(key => {
      if (Object.hasOwn(original, key)) properties[key] = original[key];
    });
    properties.$current_url = safeUrl;
    properties.$pathname = new URL(safeUrl).pathname;
    properties.$process_person_profile = false;
    properties.$is_identified = false;
    return { ...event, properties };
  }
  function track(name, properties) {
    if (!Object.hasOwn(fields, name)) return;
    try { w.posthog?.capture(name, cleanFields(name, { ...current, ...properties })); } catch (_) { /* Analytics must never interrupt the app. */ }
  }
  function search(inputId, value, extra = {}) {
    const element = d.getElementById(inputId);
    if (!isSearchInput(element)) return;
    const query = normalizeSearch(value);
    if (!query) return;
    track("search_submitted", { feature: searchInputs[inputId], input_id: inputId, query, player_count: extra.player_count });
  }

  // Live filters have no submit button: capture once after a pause, Enter or
  // leaving the field. Delegation also covers dynamically rendered search bars.
  const searchTimers = new Map();
  const lastLiveQueries = new Map();
  function commitLiveSearch(element) {
    if (!isSearchInput(element) || !liveSearchInputs.has(element.id)) return;
    const id = element.id;
    w.clearTimeout(searchTimers.get(id));
    searchTimers.delete(id);
    const query = normalizeSearch(element.value);
    if (!query) { lastLiveQueries.delete(id); return; }
    if (lastLiveQueries.get(id) === query) return;
    lastLiveQueries.set(id, query);
    track("search_filtered", { feature: searchInputs[id], input_id: id, query });
    if (id === "originalTourSearchInput") {
      track("single_tour_navigation", { section: "otherTools", view: "Single Tour", method: "search", action: "query_changed" });
    }
  }

  const MIN_TAB_VIEW_MS = 5000;
  let current = null;
  let pending = null;
  let timer = null;
  let visibleSince = null;
  let visibleVisitMs = 0;
  let engagementTimer = null;
  let visitEngaged = false;
  function captureEngagedVisit() {
    engagementTimer = null;
    if (!current || visitEngaged) return;
    const elapsed = visibleVisitMs + (visibleSince === null ? 0 : Math.max(0, performance.now() - visibleSince));
    if (elapsed >= MIN_TAB_VIEW_MS) {
      visitEngaged = true;
      track("section_engaged", { ...current, visible_seconds: Math.floor(elapsed / 1000) });
    } else if (visibleSince !== null && d.visibilityState !== "hidden") {
      engagementTimer = w.setTimeout(captureEngagedVisit, MIN_TAB_VIEW_MS - elapsed);
    }
  }
  function startVisibleTime() {
    if (!current || visibleSince !== null || d.visibilityState === "hidden") return;
    visibleSince = performance.now();
    if (!visitEngaged) {
      engagementTimer = w.setTimeout(captureEngagedVisit, Math.max(0, MIN_TAB_VIEW_MS - visibleVisitMs));
    }
  }
  function flushTime() {
    if (engagementTimer !== null) w.clearTimeout(engagementTimer);
    engagementTimer = null;
    if (current && visibleSince !== null) {
      const elapsed = Math.max(0, performance.now() - visibleSince);
      visibleVisitMs += elapsed;
      visibleSince = null;
      const seconds = Math.round(elapsed / 1000);
      if (seconds > 0) track("section_time", { ...current, visible_seconds: seconds });
      // Also qualify visits when a busy page delayed the threshold timer.
      captureEngagedVisit();
    }
  }
  function showPending() {
    if (timer !== null) w.clearTimeout(timer);
    timer = null;
    if (!pending || d.visibilityState === "hidden") return;
    const next = pending;
    pending = null;
    if (current?.section === next.section && current?.view === next.view) {
      startVisibleTime();
      return;
    }
    flushTime();
    current = next;
    visibleVisitMs = 0;
    visitEngaged = false;
    track("section_viewed", current);
    startVisibleTime();
  }
  function view(section, name) {
    if (!views[section]?.includes(name)) return;
    pending = { section, view: name };
    // Stop the old clock at navigation, before rendering the new tab can block.
    if (current && (current.section !== section || current.view !== name)) flushTime();
    if (timer !== null) w.clearTimeout(timer);
    // Collapse synchronous navigation renders; background preloads never call view.
    timer = w.setTimeout(showPending, 0);
  }

  // PostHog's HTML queue bootstrap, limited to the capture API we use.
  !function(t,e){var p,r;e.__SV||(w.posthog&&w.posthog.__loaded)||(w.posthog=e,e._i=[],e.init=function(i,s,a){a=a||"posthog";p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=true,p.referrerPolicy="no-referrer",p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null;e.length=0;e.capture=noop},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));e.people=e.people||[];e.capture=function(){if(e.length<100)e.push(["capture"].concat(Array.prototype.slice.call(arguments,0)))};e._i.push([i,s,a])},e.__SV=1)}(d,w.posthog||[]);
  try {
    w.posthog.init("phc_zuVBFGWRDTZp8V32sSu9Xk8LhyUCLcgHtZmAkQEnFeid", {
      api_host: "https://us.i.posthog.com",
      defaults: "2026-05-30",
      person_profiles: "never",
      // Retain an anonymous browser identity across return visits; the SDK still
      // rotates session IDs for separate visits. Never identify the viewed player.
      persistence: "localStorage",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_session_recording: false,
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        maskInputFn: maskReplayInput,
        blockSelector: 'input[type="password"], #playlistsPasswordInput, #playlistSearchBannerEditorCanvas, #playlistCoverEditorCanvas',
        recordHeaders: false,
        recordBody: false,
        streamNetworkBody: false,
        captureCanvas: {
          recordCanvas: true,
          canvasFps: 2,
          canvasQuality: 0.6
        }
      },
      disable_surveys: true,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      advanced_disable_flags: false,
      advanced_disable_feature_flags: true,
      advanced_disable_toolbar_metrics: true,
      before_send: beforeSend
    });
  } catch (_) { return; }
  w.AMQAnalytics = Object.freeze({ track, view, search });
  d.addEventListener("input", event => {
    const element = event.target;
    if (!event.isTrusted || !isSearchInput(element) || !liveSearchInputs.has(element.id)) return;
    w.clearTimeout(searchTimers.get(element.id));
    searchTimers.set(element.id, w.setTimeout(() => commitLiveSearch(element), 1200));
  });
  d.addEventListener("focusout", event => {
    if (event.isTrusted) commitLiveSearch(event.target);
  });
  d.addEventListener("keydown", event => {
    if (event.isTrusted && event.key === "Enter") commitLiveSearch(event.target);
  });
  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "hidden") flushTime();
    else {
      showPending();
      startVisibleTime();
    }
  });
  w.addEventListener("pagehide", flushTime);
  w.addEventListener("pageshow", () => {
    startVisibleTime();
  });
  track("$pageview", page === "index.html" ? { section: "landing", view: "Home" } : {});
  if (page === "index.html") view("landing", "Home");
})();
