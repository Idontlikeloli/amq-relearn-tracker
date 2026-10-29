/* Aggregate feature usage. Never pass player names, search text or media URLs here. */
(() => {
  "use strict";
  const w = window;
  const d = document;
  if (w.AMQAnalytics) return;
  const noop = () => {};
  w.AMQAnalytics = Object.freeze({ track: noop, view: noop });
  const host = location.hostname.toLowerCase();
  if (!/^https?:$/.test(location.protocol) || !host || host === "localhost"
      || host.endsWith(".localhost") || host.endsWith(".local")
      || host === "[::1]" || /^[\d.]+$/.test(host)) return;

  const views = {
    landing: ["Home"],
    overview: ["overview", "statsSummary", "weekly"],
    performance: ["Guess Rate", "Lives Taken / Saved", "Onlist/Offlist", "Rigs Missed", "Composite charts"],
    knowledge: ["Artist Familiarity", "Tag Familiarity", "Seasonal Comparison"],
    insights: ["Relearn Tracker", "By never correct", "By Wrong Guess", "Playlists"],
    social: ["Synergy", "Rivals", "Team Contributions", "Rig / List analysis"],
    otherTools: ["Search songs", "Search song frequency", "Player database", "Single Tour", "Changelog"]
  };
  const choices = {
    mode: ["watched", "usual", "all"],
    list: ["onlist", "offlist", "all"],
    format: ["zip", "csl"],
    source: ["relearn", "playlist", "search", "other"],
    clip: ["full", "sample", "Verse", "Pre-chorus", "Chorus"],
    feature: ["artist", "song", "song_frequency", "player_comparison", "synergy"],
    filter: ["tour_mode", "ant", "data_range", "trend", "comparison_view"],
    value: ["watched", "usual", "on", "off", "all", "week", "month", "2months", "3months", "6months", "10", "20", "50", "regular", "combined", "table", "chart"]
  };
  const fields = {
    $pageview: ["section", "view"],
    section_viewed: ["section", "view"],
    section_time: ["section", "view", "visible_seconds"],
    dashboard_opened: [],
    song_played: ["source", "clip"],
    songs_exported: ["source", "format", "mode", "list", "song_count"],
    search_submitted: ["feature", "player_count"],
    filter_changed: ["filter", "value"]
  };
  function cleanFields(name, properties = {}) {
    const clean = {};
    for (const key of [...(fields[name] || []), "section", "view"]) {
      const value = properties[key];
      if (key === "section" && Object.hasOwn(views, value)) clean[key] = value;
      else if (key === "view" && views[properties.section]?.includes(value)) clean[key] = value;
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

  let current = null;
  let pending = null;
  let timer = null;
  let visibleSince = null;
  function flushTime() {
    if (current && visibleSince !== null) {
      const seconds = Math.round((performance.now() - visibleSince) / 1000);
      if (seconds > 0) track("section_time", { ...current, visible_seconds: seconds });
    }
    visibleSince = null;
  }
  function showPending() {
    timer = null;
    if (!pending || d.visibilityState === "hidden") return;
    const next = pending;
    pending = null;
    if (current?.section === next.section && current?.view === next.view) return;
    flushTime();
    current = next;
    visibleSince = performance.now();
    track("section_viewed", current);
  }
  function view(section, name) {
    if (!views[section]?.includes(name)) return;
    pending = { section, view: name };
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
      persistence: "sessionStorage",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_session_recording: true,
      disable_surveys: true,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      advanced_disable_flags: true,
      advanced_disable_toolbar_metrics: true,
      before_send: beforeSend
    });
  } catch (_) { return; }
  w.AMQAnalytics = Object.freeze({ track, view });
  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "hidden") flushTime();
    else {
      showPending();
      if (current && visibleSince === null) visibleSince = performance.now();
    }
  });
  w.addEventListener("pagehide", flushTime);
  w.addEventListener("pageshow", () => {
    if (current && visibleSince === null && d.visibilityState !== "hidden") visibleSince = performance.now();
  });
  track("$pageview", page === "index.html" ? { section: "landing", view: "Home" } : {});
  if (page === "index.html") view("landing", "Home");
})();
