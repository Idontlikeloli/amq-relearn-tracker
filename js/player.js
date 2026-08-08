const isLocalDataContext =
  location.protocol === "file:"
  || location.hostname === ""
  || location.hostname === "localhost"
  || location.hostname === "127.0.0.1";

const DATA_BASE_URL = isLocalDataContext
  ? "./data"
  : "https://amq-stats-api.yarthepro.workers.dev";
let localDataManifestPromise = null;

function normalizeDataPath(path) {
  return String(path || "")
    .replace(/^data\//, "")
    .replace(/^\/+/, "");
}

async function getLocalDataManifest() {
  if (!isLocalDataContext) return null;
  if (!localDataManifestPromise) {
    localDataManifestPromise = fetch(dataUrl("manifest.json"))
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);
  }
  return localDataManifestPromise;
}

function recordLocalDataRequest(path, response, startedAt) {
  if (!isLocalDataContext || typeof window === "undefined") return;
  const requests = window.__amqLocalDataRequests || (window.__amqLocalDataRequests = []);
  requests.push({
    path: normalizeDataPath(path),
    status: response ? response.status : 0,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    timestamp: new Date().toISOString()
  });
  window.getAmqLocalDataRequestSummary = () => {
    const entries = window.__amqLocalDataRequests || [];
    const totalDurationMs = entries.reduce((total, entry) => total + entry.durationMs, 0);
    return {
      requests: entries.length,
      failures: entries.filter(entry => entry.status === 0 || entry.status >= 400).length,
      totalDurationMs: Math.round(totalDurationMs * 10) / 10,
      slowest: entries.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
    };
  };
}

async function fetchLocalDataIfAvailable(path, options) {
  const cleanPath = normalizeDataPath(path);
  const manifest = await getLocalDataManifest();
  if (manifest && Array.isArray(manifest.files) && !manifest.files.includes(cleanPath)) {
    return null;
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(dataUrl(cleanPath), options);
    recordLocalDataRequest(cleanPath, response, startedAt);
    return response;
  } catch (error) {
    recordLocalDataRequest(cleanPath, null, startedAt);
    throw error;
  }
}
const DATA_ASSET_VERSION = (() => {
  const modifiedTime = Date.parse(document.lastModified || "");
  return Number.isFinite(modifiedTime) ? String(modifiedTime) : "unversioned";
})();

function shouldVersionDataRequest(path) {
  const cleanPath = String(path || "").split("?")[0].toLowerCase();
  return /\.(json|csv|txt)$/.test(cleanPath);
}

function dataUrl(path) {
  const cleanPath = String(path || "")
    .replace(/^data\//, "")
    .replace(/^\/+/, "");
  const url = `${DATA_BASE_URL}/${cleanPath}`;
  if (!isLocalDataContext && shouldVersionDataRequest(cleanPath)) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${encodeURIComponent(DATA_ASSET_VERSION)}`;
  }
  return url;
}

function getActiveDataSourceMode() {
  return overviewDataSourceMode === "usual" ? "usual" : "watched";
}

function buildPlayerModePath(playerId, relativePath, mode = getActiveDataSourceMode()) {
  const cleanPlayerId = String(playerId || "").trim();
  const cleanRelative = String(relativePath || "").replace(/^\/+/, "");
  const resolvedMode = mode === "usual" ? "usual" : "watched";
  return `players/${cleanPlayerId}/${resolvedMode}/${cleanRelative}`;
}

async function fetchPlayerScopedResponse(playerId, relativePath, mode = getActiveDataSourceMode()) {
  const modePath = buildPlayerModePath(playerId, relativePath, mode);
  const legacyPath = `players/${String(playerId || "").trim()}/${String(relativePath || "").replace(/^\/+/, "")}`;
  const candidates = Array.from(new Set([modePath, legacyPath]));
  for (const candidate of candidates) {
    const res = await fetchLocalDataIfAvailable(candidate);
    if (res && res.ok) return res;
  }
  return null;
}

async function loadJSON(path) {
  const res = await fetch(dataUrl(path));
  if (!res.ok) {
    throw new Error(`Failed to load ${path}: ${res.status}`);
  }
  return res.json();
}

function applyDataAssetUrls(root = document) {
  root.querySelectorAll("[data-data-src]").forEach(el => {
    el.src = dataUrl(el.getAttribute("data-data-src"));
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => applyDataAssetUrls());
} else {
  applyDataAssetUrls();
}

const params = new URLSearchParams(window.location.search);
const username = params.get("user");
const sectionFromUrl = params.get("section") || "overview";

if (window.Chart) {
  Chart.defaults.animation = false;
  Chart.defaults.animations = false;
  if (Chart.defaults.transitions && Chart.defaults.transitions.active) {
    Chart.defaults.transitions.active.animation = { duration: 0 };
  }
  if (Chart.defaults.transitions && Chart.defaults.transitions.resize) {
    Chart.defaults.transitions.resize.animation = { duration: 0 };
  }

  const trendCrosshairPlugin = {
    id: "trendCrosshairPlugin",
    afterEvent(chart, args) {
      if (chart.config.type !== "line") return;
      const event = args && args.event;
      const chartArea = chart.chartArea;
      if (!event || !chartArea) return;

      if (!chart.$trendCrosshairState) {
        chart.$trendCrosshairState = { active: false, x: null, y: null };
      }
      const state = chart.$trendCrosshairState;

      if (event.type === "mouseout") {
        if (chart.tooltip && typeof chart.tooltip.setActiveElements === "function") {
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
        }
        if (state.active) {
          state.active = false;
          args.changed = true;
        }
        return;
      }

      const insideChartArea =
        event.x >= chartArea.left &&
        event.x <= chartArea.right &&
        event.y >= chartArea.top &&
        event.y <= chartArea.bottom;

      if (!insideChartArea) {
        if (chart.tooltip && typeof chart.tooltip.setActiveElements === "function") {
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
        }
        if (state.active) {
          state.active = false;
          args.changed = true;
        }
        return;
      }

      let crossX = event.x;
      let crossY = event.y;
      const snapTarget = this.findNearestVisiblePoint(chart, event.x, event.y, 16);
      if (snapTarget) {
        crossX = snapTarget.x;
        crossY = snapTarget.y;
        if (chart.tooltip && typeof chart.tooltip.setActiveElements === "function") {
          chart.tooltip.setActiveElements(
            [{ datasetIndex: snapTarget.datasetIndex, index: snapTarget.pointIndex }],
            { x: crossX, y: crossY }
          );
        }
      } else if (chart.tooltip && typeof chart.tooltip.setActiveElements === "function") {
        chart.tooltip.setActiveElements([], { x: event.x, y: event.y });
      }

      state.x = Math.max(chartArea.left, Math.min(chartArea.right, crossX));
      state.y = Math.max(chartArea.top, Math.min(chartArea.bottom, crossY));
      state.active = true;
      args.changed = true;
    },
    findNearestVisiblePoint(chart, x, y, thresholdPx) {
      const thresholdSquared = thresholdPx * thresholdPx;
      let bestPoint = null;
      let bestDistanceSquared = thresholdSquared;

      for (let datasetIndex = 0; datasetIndex < chart.data.datasets.length; datasetIndex += 1) {
        const dataset = chart.data.datasets[datasetIndex] || {};
        const datasetLabel = String(dataset.label || "").trim().toLowerCase();
        if (isTrendDatasetLabel(datasetLabel)) continue;
        const meta = chart.getDatasetMeta(datasetIndex);
        if (!meta || meta.hidden || meta.type !== "line") continue;
        const points = meta.data || [];
        for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
          const point = points[pointIndex];
          if (!point || point.skip) continue;
          const dx = point.x - x;
          const dy = point.y - y;
          const distanceSquared = (dx * dx) + (dy * dy);
          if (distanceSquared <= bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            bestPoint = {
              x: point.x,
              y: point.y,
              datasetIndex,
              pointIndex
            };
          }
        }
      }

      return bestPoint;
    },
    afterDatasetsDraw(chart) {
      if (chart.config.type !== "line") return;
      const xScale = chart.scales && chart.scales.x;
      const yScale = chart.scales && chart.scales.y;
      if (!xScale || !yScale) return;
      const state = chart.$trendCrosshairState;
      if (!state || !state.active) return;
      const { x, y } = state;
      const { left, right, top, bottom } = chart.chartArea;

      const ctx = chart.ctx;
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(88, 111, 138, 0.72)";

      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.restore();
    }
  };
  const overviewActivePointPlugin = {
    id: "overviewActivePointPlugin",
    afterDraw(chart) {
      if (!chart || !chart.canvas) return;
      const datasets = chart.data && Array.isArray(chart.data.datasets) ? chart.data.datasets : [];
      const hasTrendCompanion = datasets.length >= 2 && isTrendDatasetLabel(datasets[1] && datasets[1].label);
      if (!hasTrendCompanion) return;
      const tooltip = chart.tooltip;
      if (!tooltip || tooltip.opacity === 0) return;
      const activeElements = typeof tooltip.getActiveElements === "function"
        ? tooltip.getActiveElements()
        : [];
      if (!Array.isArray(activeElements) || !activeElements.length) return;
      const activeIndex = Number(activeElements[0] && activeElements[0].index);
      if (!Number.isFinite(activeIndex) || activeIndex < 0) return;

      const meta = chart.getDatasetMeta(0);
      const point = meta && Array.isArray(meta.data) ? meta.data[activeIndex] : null;
      if (!point || point.skip || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const primaryDataset = datasets[0] || {};
      const markerColor = String(
        primaryDataset.pointBackgroundColor
        || primaryDataset.borderColor
        || "#2563eb"
      );

      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = markerColor;
      ctx.fill();
      ctx.restore();
    }
  };
  const trendForegroundPlugin = {
    id: "trendForegroundPlugin",
    afterDatasetsDraw(chart) {
      if (!chart || chart.config.type !== "line") return;
      const area = chart.chartArea;
      if (!area) return;
      const datasets = chart.data && Array.isArray(chart.data.datasets) ? chart.data.datasets : [];
      if (!datasets.length) return;

      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      ctx.clip();

      for (let i = 0; i < datasets.length; i++) {
        const dataset = datasets[i];
        const label = String((dataset && dataset.label) || "").toLowerCase();
        if (!label.includes("trend")) continue;

        const meta = chart.getDatasetMeta(i);
        if (!meta || meta.hidden || !Array.isArray(meta.data) || !meta.data.length) continue;

        const options = (meta.dataset && meta.dataset.options) || {};
        const stroke = options.borderColor || dataset.borderColor || "#64748b";
        const width = Number(options.borderWidth ?? dataset.borderWidth ?? 2);
        const dash = options.borderDash || dataset.borderDash || [];
        const lineJoin = options.borderJoinStyle || dataset.borderJoinStyle || "round";
        const lineCap = options.borderCapStyle || dataset.borderCapStyle || "round";

        ctx.strokeStyle = stroke;
        ctx.lineWidth = Number.isFinite(width) ? width : 2;
        ctx.setLineDash(Array.isArray(dash) ? dash : []);
        ctx.lineJoin = lineJoin;
        ctx.lineCap = lineCap;
        ctx.beginPath();

        let drawing = false;
        for (const point of meta.data) {
          if (!point || point.skip || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            drawing = false;
            continue;
          }
          if (!drawing) {
            ctx.moveTo(point.x, point.y);
            drawing = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }
        ctx.stroke();
      }

      ctx.restore();
    }
  };

  Chart.register(trendCrosshairPlugin, overviewActivePointPlugin);
}

const sections = {
  overview: "overviewSection",
  performance: "performanceSection",
  knowledge: "knowledgeSection",
  insights: "insightsSection",
  social: "socialSection",
  otherTools: "otherToolsSection"
};

const sectionLabels = {
  overview: "Overview",
  performance: "Performance",
  knowledge: "Knowledge",
  insights: "Recommendations",
  social: "Social",
  otherTools: "Other tools"
};

const DATA_RANGE_OPTIONS = [
  { value: "all", label: "All tours" },
  { value: "week", label: "Past week" },
  { value: "month", label: "Past month" },
  { value: "2months", label: "Past 2 months" },
  { value: "3months", label: "Past 3 months" },
  { value: "6months", label: "Past 6 months" },
  { value: "10", label: "Past 10 tours" },
  { value: "20", label: "Past 20 tours" },
  { value: "50", label: "Past 50 tours" }
];

const DATA_RANGE_EXCLUDED_VALUES_FOR_NO_PAST_GAMES = new Set(["10", "20", "50"]);

const initialSection = sections[sectionFromUrl] ? sectionFromUrl : "overview";
const dataRangeSelect = document.getElementById("dataRangeSelect");
const overviewViewTabs = document.getElementById("overviewViewTabs");
const overviewMainView = document.getElementById("overviewMainView");
const overviewStatsSummaryView = document.getElementById("overviewStatsSummaryView");
const overviewWeeklyView = document.getElementById("overviewWeeklyView");
const tagSearchInput = document.getElementById("tagSearchInput");
const byEraDataToggle = document.getElementById("byEraDataToggle");
const byEraScaleToggle = document.getElementById("byEraScaleToggle");
const byEraSeasonDataToggle = document.getElementById("byEraSeasonDataToggle");
const overviewDataToggle = document.getElementById("overviewDataToggle");
const overviewDataSourceToggle = document.getElementById("overviewDataSourceToggle");
const overviewDataSourceWatchedBtn = document.getElementById("overviewDataSourceWatchedBtn");
const overviewDataSourceUsualBtn = document.getElementById("overviewDataSourceUsualBtn");
const overviewTopDoublesTypeToggle = document.getElementById("overviewTopDoublesTypeToggle");
const overviewTopDoublesTypeGeneralBtn = document.getElementById("overviewTopDoublesTypeGeneralBtn");
const overviewTopDoublesTypeTheirRigBtn = document.getElementById("overviewTopDoublesTypeTheirRigBtn");
const overviewTopDoublesTypeYourRigBtn = document.getElementById("overviewTopDoublesTypeYourRigBtn");
const overviewLanguageToggle = document.getElementById("overviewLanguageToggle");
const overviewLanguageEnBtn = document.getElementById("overviewLanguageEnBtn");
const overviewLanguageJpBtn = document.getElementById("overviewLanguageJpBtn");
const byEraSeasonSearchInput = document.getElementById("byEraSeasonSearchInput");
const socialRivalSearchInput = document.getElementById("socialRivalSearchInput");
const socialSynergyPlayerSearchInput = document.getElementById("socialSynergyPlayerSearchInput");
const socialSynergySelectBtn = document.getElementById("socialSynergySelectBtn");
const socialRivalsMetricSelect = document.getElementById("socialRivalsMetricSelect");
const artistFamiliaritySearchInput = document.getElementById("artistFamiliaritySearchInput");
const artistFamiliaritySearchBtn = document.getElementById("artistFamiliaritySearchBtn");
const artistFamiliaritySuggestions = document.getElementById("artistFamiliaritySuggestions");
const artistFamiliarityInlineSuggestion = document.getElementById("artistFamiliarityInlineSuggestion");
const artistFamiliarityRightModeToggle = document.getElementById("artistFamiliarityRightModeToggle");
const artistFamiliarityRightModeAttemptsBtn = document.getElementById("artistFamiliarityRightModeAttemptsBtn");
const artistFamiliarityRightModeCompareBtn = document.getElementById("artistFamiliarityRightModeCompareBtn");
const searchSongsSuggestions = document.getElementById("searchSongsSuggestions");
const searchSongsInlineSuggestion = document.getElementById("searchSongsInlineSuggestion");
const relearnAudioProgressDock = document.getElementById("relearnAudioProgressDock");
const relearnAudioDockToggleBtn = document.getElementById("relearnAudioDockToggleBtn");
const relearnAudioDockVolumeWrap = document.getElementById("relearnAudioDockVolumeWrap");
const relearnAudioDockVolumeBtn = document.getElementById("relearnAudioDockVolumeBtn");
const relearnAudioDockVolumePopover = document.getElementById("relearnAudioDockVolumePopover");
const relearnAudioDockVolumeSlider = document.getElementById("relearnAudioDockVolumeSlider");
const relearnAudioDockVolumePercent = document.getElementById("relearnAudioDockVolumePercent");
const relearnAudioProgressRange = document.getElementById("relearnAudioProgressRange");
const relearnAudioProgressCurrent = document.getElementById("relearnAudioProgressCurrent");
const relearnAudioProgressDuration = document.getElementById("relearnAudioProgressDuration");
let fullUserData = [];
let guessChart = null;
let opGuessChart = null;
let edGuessChart = null;
let inGuessChart = null;
let combinedGuessAreaChart = null;
let guessRateRollingChart = null;
let guessRateMixRadarChart = null;
let weightedGuessRateChart = null;
let guessRateVsAvg8Chart = null;
let takenLivesChart = null;
let savedLivesChart = null;
let rigAnalysisChart = null;
let onlistAnalysisChart = null;
let offlistAnalysisChart = null;
let opRigsMissedChart = null;
let edRigsMissedChart = null;
let inRigsMissedChart = null;
let socialRivalsChart = null;
let socialRivalsBubbleChart = null;
let socialTeamMetricCharts = [];
let overviewSongsPlayedChart = null;
let overviewGuessRateChart = null;
let overviewZScoreChart = null;
let genreRadarChart = null;
let tagRadarChart = null;
let byEraDecadeChart = null;
let byEraSeasonCompareChart = null;
let artistFamiliarityRadarChart = null;
let artistFamiliarityCompareRadarChart = null;
let artistFamiliarityBarsChart = null;
let artistRadarHoveredLabelIndex = -1;
const trendZoomCharts = new Set();
let activeSection = initialSection;
let overviewActiveView = "overview";
const activeSubSectionBySection = {};
let cachedGenreData = null;
let cachedTagData = null;
let cachedByEraData = null;
let cachedArtistsData = null;
let cachedOverviewZScoreData = null;
let cachedOverviewAnimeTypeRows = [];
let cachedOverviewGamesCounted = 0;
let cachedOverviewTopSolos = [];
let cachedOverviewTopDoublesGeneral = [];
let cachedOverviewTopDoublesTheirRigBlocked = [];
let cachedOverviewTopDoublesYourRigBlocked = [];
let cachedOverviewTopRigSongs = [];
let cachedRelearnSongs = [];
let cachedWrongGuessSongs = [];
let cachedNeverCorrectSongs = [];
let cachedPopularitySongs = [];
let cachedPCorrectSongs = [];
let cachedSearchSongs = [];
let cachedOverviewCombinedSearchSongs = [];
let cachedSearchSongFrequencyRows = [];
let cachedWeightedGuessRateSeriesByPlayerId = new Map();
let cachedMalImageCache = null;
let cachedMalImageCachePromise = null;
let cachedSongKeyById = null;
let cachedSongKeyByIdPromise = null;
let weightedGuessRateRequestId = 0;
let overviewLanguageRerenderHandle = null;
let cachedChangelogPosts = null;
let changelogLoadPromise = null;
let cachedChangelogDataText = null;
let changelogDataLoadPromise = null;
let overviewTopDoublesMode = "general";
let relearnAudioElement = null;
let relearnActiveToggleButton = null;
let relearnActiveClipStartTime = null;
let relearnActiveClipEndTime = null;
let isSeekingRelearnAudio = false;
let relearnAudioVolumePercentValue = 100;
let relearnAudioLastNonZeroPercentValue = 100;
let isRelearnVolumePopoverOpen = false;
let relearnVolumePopoverFadeTimer = null;
let relearnPageIndex = 0;
let relearnOnlistFilterMode = "all";
let wrongGuessPageIndex = 0;
let neverCorrectPageIndex = 0;
let popularityPageIndex = 0;
let pcorrectPageIndex = 0;
let searchSongsQuery = "";
let searchSongsExactMatch = false;
let searchSongsMode = "all";
let searchSongsPageIndex = 0;
let searchSongFrequencyQuery = "";
let searchSongFrequencyExactMatch = false;
let searchSongFrequencyPageIndex = 0;
let searchSongFrequencyLoaded = false;
let searchSongFrequencyLoadPromise = null;
let searchSongFrequencyLoadedMode = null;
let convertRankEstimator = null;
let convertUsefulnessEstimator = null;
let convertEstimatorsLoadPromise = null;
let convertEstimatorUIBound = false;
let convertRankClosestRows = [];
let convertUsefulnessClosestRows = [];
let convertExamplesLoadPromise = null;
const rigAnalysisCacheByMode = new Map();
const rigAnalysisLoadPromisesByMode = new Map();
const rigAnalysisAllowedModes = ["all", "10", "20", "50", "week", "month", "2months", "3months", "6months"];
let rigAnalysisPrefetchStarted = false;
let otherToolsRowsByTimestamp = null;
let otherToolsCalendarGames = [];
let otherToolsCalendarFilteredGames = [];
let otherToolsCalendarSearchQuery = "";
let otherToolsCalendarSelectedTimestamp = null;
let otherToolsCalendarAppliedTimestamp = null;
let otherToolsCalendarMonthCursor = null;
let originalTourColorMode = "extremes";
let socialTeamRowsByTimestamp = null;
let socialTeamGames = [];
let socialTeamFilteredGames = [];
let socialTeamSearchQuery = "";
let socialTeamSelectedTimestamp = null;
let socialTeamAppliedTimestamp = null;
let socialTeamMonthCursor = null;
let selectedTagNames = [];
let tagSearchQuery = "";
let byEraDataMode = "count";
let byEraScaleType = "linear";
let byEraSeasonDataMode = "count";
let overviewDataMode = "count";
let overviewDataSourceMode = "watched";
let isTourTypeToggleLocked = false;
let overviewLanguageMode = "en";
let selectedByEraSeasonLabels = [];
let byEraSeasonSearchQuery = "";
let byEraDataRequestSeq = 0;
let selectedSocialRivalKeys = [];
let socialRivalSearchQuery = "";
let socialSynergySingleSearchQuery = "";
let socialSynergySingleSelectedRivalKey = "";
let socialSynergySinglePendingRivalKey = "";
let socialSynergyTargetRigMode = "unique";
let socialSynergyOtherRigMode = "unique";
let socialRivalsMetricKey = "guess_rate";
let socialRivalsSelectionOwnerKey = "";
let socialSynergyRequestId = 0;
let overviewSynergyRequestId = 0;
const socialSynergyCacheByKey = new Map();
const socialSynergyCachePromiseByKey = new Map();
const socialSynergyMergedRowsCacheByKey = new Map();
let socialSubSectionRenderToken = 0;
let insightsSubSectionRenderToken = 0;
let insightsSubSectionLoadToken = 0;
let cachedSocialSynergyRows = [];
let cachedSocialSynergyRigTables = null;
let cachedSocialSynergyRigStats = null;
let currentDisplayName = null;
let currentPlayerId = null;
let currentStatKey = null;
let currentStatSourceKeys = [];
let currentLatestRankValue = null;
let currentLatestRankPercentile = null;
let currentLatestRankIsTopThree = false;
let usualUserData = [];
let currentUsualLatestRankValue = null;
let currentUsualLatestRankPercentile = null;
let currentUsualLatestRankIsTopThree = false;
let allPlayerStatsData = {};
let allPlayerUsualStatsData = {};
let allPlayerWeeklyStatsData = {};
let allPlayerUsualWeeklyStatsData = {};
let allPlayerLastWeekStatsData = {};
let allPlayerUsualLastWeekStatsData = {};
let weeklyPlayerTransitionCountsByMode = {
  watched: {},
  usual: {}
};
let lastWeekPlayerTransitionCountsByMode = {
  watched: {},
  usual: {}
};
let weeklyDateRangeByMode = {
  watched: null,
  usual: null
};
let artistFamiliarityEntries = [];
let artistFamiliaritySearchQuery = "";
let selectedArtistName = "";
let artistFamiliarityPageIndex = 0;
let artistFamiliarityAttemptsFilterQuery = "";
let artistFamiliarityAttemptsSortMode = "none";
let artistFamiliarityAttemptsShouldRefocusInput = false;
let artistFamiliarityRightMode = "attempts";
let selectedCompareArtistName = "";
let artistFamiliarityCompareSearchQuery = "";
let overviewLoadRequestId = 0;
let overviewZScoreLoadRequestId = 0;
let socialSynergyPageIndex = 0;
const latestRankByPlayerKeyByMode = {
  watched: null,
  usual: null
};
const latestRankPercentileByPlayerKeyByMode = {
  watched: null,
  usual: null
};
const latestRankTimestampByPlayerKeyByMode = {
  watched: null,
  usual: null
};
const latestRankLoadPromiseByMode = {
  watched: null,
  usual: null
};
let playersDirectoryPromise = null;
let playersDirectoryByLookup = new Map();
const preloadTaskStatus = new Set();
const MAX_SELECTED_TAGS = 8;
const MIN_SELECTED_TAGS = 3;
const MAX_SELECTED_BY_ERA_SEASONS = 6;
const MAX_SELECTED_SOCIAL_RIVALS = 4;
const RELEARN_PAGE_SIZE = 20;
const ARTIST_FAMILIARITY_PAGE_SIZE = 8;
const SEARCH_SONGS_PAGE_SIZE = 20;
const MOMENTUM_SHORT_WINDOW = 3;
const MOMENTUM_LONG_WINDOW = 10;
const CONSISTENCY_WINDOW = 10;
const SOCIAL_SYNERGY_PAGE_SIZE = 20;
const SOCIAL_TEAM_FIXED_TIER_COUNT = 4;
const MIN_VALID_RANK = 25;
function isValidRankForMode(rankValue, mode = getActiveDataSourceMode()) {
  const numericRank = Number(rankValue);
  if (!Number.isFinite(numericRank)) return false;
  return mode === "usual" ? true : numericRank >= MIN_VALID_RANK;
}
const SOCIAL_TEAM_CONTRIBUTION_METRICS = [
  "Lives taken",
  "Lives saved",
  "Usefulness",
  "Guess rate",
  "OP guess rate",
  "ED guess rate",
  "IN guess rate",
  "Onlist",
  "Offlist"
];
const RELEARN_AUDIO_VOLUME_ICONS = [
  "images/sound_1.jpg",
  "images/sound_2.jpg",
  "images/sound_3.jpg",
  "images/sound_4.jpg"
];
const SOCIAL_RIVALS_METRICS = {
  guess_rate: { label: "Guess rate", field: "Guess rate", isPercent: true, axisLabel: "Guess rate (%)" },
  op_guess_rate: { label: "OP guess rate", field: "OP guess rate", isPercent: true, axisLabel: "OP guess rate (%)" },
  ed_guess_rate: { label: "ED guess rate", field: "ED guess rate", isPercent: true, axisLabel: "ED guess rate (%)" },
  in_guess_rate: { label: "IN guess rate", field: "IN guess rate", isPercent: true, axisLabel: "IN guess rate (%)" },
  onlist_guess_rate: { label: "Onlist guess rate", field: "Onlist", isPercent: true, axisLabel: "Onlist guess rate (%)" },
  offlist_guess_rate: { label: "Offlist guess rate", field: "Offlist", isPercent: true, axisLabel: "Offlist guess rate (%)" },
  lives_taken: { label: "Lives taken", field: "Lives taken", isPercent: false, axisLabel: "Lives taken" },
  lives_saved: { label: "Lives saved", field: "Lives saved", isPercent: false, axisLabel: "Lives saved" }
};
const SOCIAL_RIVALS_USUAL_HIDDEN_METRICS = new Set(["onlist_guess_rate", "offlist_guess_rate"]);
const PERFORMANCE_LINE_PALETTES = {
  op: {
    line: "#2f6df6",
    fill: "rgba(47, 109, 246, 0.18)",
    trend: "#6b7f99"
  },
  ed: {
    line: "#10b981",
    fill: "rgba(16, 185, 129, 0.18)",
    trend: "#6b7f99"
  },
  insert: {
    line: "#f59e0b",
    fill: "rgba(245, 158, 11, 0.20)",
    trend: "#6b7f99"
  },
  taken: {
    line: "#ef4444",
    fill: "rgba(239, 68, 68, 0.16)",
    trend: "#7f8ea3"
  },
  saved: {
    line: "#06b6d4",
    fill: "rgba(6, 182, 212, 0.17)",
    trend: "#7f8ea3"
  },
  default: {
    line: "#2563eb",
    fill: "rgba(37, 99, 235, 0.15)",
    trend: "#dc2626"
  }
};
const TIME_SERIES_FULL_OPACITY_MAX_POINTS = 90;
const TIME_SERIES_DENSE_OPACITY_SCALE = 0.55;

function getTimeSeriesOpacityScale(pointCount) {
  return pointCount > TIME_SERIES_FULL_OPACITY_MAX_POINTS ? TIME_SERIES_DENSE_OPACITY_SCALE : 1;
}

function withSeriesOpacity(colorValue, opacityScale) {
  if (!colorValue || !Number.isFinite(opacityScale) || opacityScale >= 0.999) {
    return colorValue;
  }
  const colorText = String(colorValue).trim();
  let match = colorText.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (match) {
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    const alpha = Number.isFinite(Number(match[4])) ? Number(match[4]) : 1;
    const nextAlpha = Math.max(0, Math.min(1, alpha * opacityScale));
    return `rgba(${red}, ${green}, ${blue}, ${nextAlpha.toFixed(3)})`;
  }
  match = colorText.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (match) {
    let hex = match[1];
    if (hex.length === 3) {
      hex = hex.split("").map(ch => ch + ch).join("");
    }
    const red = parseInt(hex.slice(0, 2), 16);
    const green = parseInt(hex.slice(2, 4), 16);
    const blue = parseInt(hex.slice(4, 6), 16);
    const nextAlpha = Math.max(0, Math.min(1, opacityScale));
    return `rgba(${red}, ${green}, ${blue}, ${nextAlpha.toFixed(3)})`;
  }
  return colorValue;
}

function isTrendDatasetLabel(datasetLabel) {
  return /trend/i.test(String(datasetLabel || ""));
}

function withSeriesOpacityDeep(colorValue, opacityScale) {
  if (Array.isArray(colorValue)) {
    return colorValue.map(entry => withSeriesOpacity(entry, opacityScale));
  }
  return withSeriesOpacity(colorValue, opacityScale);
}

function ensureTrendZoomOpacityState(chart) {
  if (!chart || !chart.data || !Array.isArray(chart.data.datasets)) return;
  if (Array.isArray(chart.$trendZoomOpacityEntries)) return;
  const styleKeys = ["borderColor", "backgroundColor", "pointBackgroundColor", "pointBorderColor"];
  chart.$trendZoomOpacityEntries = chart.data.datasets
    .filter(dataset => dataset && !isTrendDatasetLabel(dataset.label))
    .map(dataset => {
      const baseStyles = {};
      const explicitBaseStyles = dataset && dataset._opacityBaseStyles && typeof dataset._opacityBaseStyles === "object"
        ? dataset._opacityBaseStyles
        : null;
      styleKeys.forEach(key => {
        if (explicitBaseStyles && explicitBaseStyles[key] !== undefined) {
          const rawValue = explicitBaseStyles[key];
          baseStyles[key] = Array.isArray(rawValue) ? rawValue.slice() : rawValue;
        } else if (dataset[key] !== undefined) {
          const rawValue = dataset[key];
          baseStyles[key] = Array.isArray(rawValue) ? rawValue.slice() : rawValue;
        }
      });
      return { dataset, baseStyles };
    });
}

function applyTrendZoomSelectionState(chart, selectedCount, totalCount, options = {}) {
  if (!chart) return;
  const safeSelected = Number.isFinite(selectedCount) ? Math.max(0, Math.floor(selectedCount)) : 0;
  const safeTotal = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0;
  const isZoomed = safeSelected > 0 && safeTotal > 0 && safeSelected < safeTotal;

  const metaElement = options && options.metaElement ? options.metaElement : null;
  if (metaElement) {
    const unit = options.metaUnit || "tours";
    const prefix = isZoomed ? "Selected" : "Found";
    const displayCount = isZoomed ? safeSelected : safeTotal;
    metaElement.innerText = `${prefix} ${displayCount} ${unit}`;
  }

  ensureTrendZoomOpacityState(chart);
  const opacityEntries = Array.isArray(chart.$trendZoomOpacityEntries) ? chart.$trendZoomOpacityEntries : [];
  if (opacityEntries.length) {
    const opacityScale = getTimeSeriesOpacityScale(isZoomed ? safeSelected : safeTotal);
    opacityEntries.forEach(entry => {
      if (!entry || !entry.dataset || !entry.baseStyles) return;
      Object.keys(entry.baseStyles).forEach(key => {
        entry.dataset[key] = withSeriesOpacityDeep(entry.baseStyles[key], opacityScale);
      });
    });
  }
}
const knowledgeWindowFileByRange = {
  all: "all.json",
  "10": "past_10_games.json",
  "20": "past_20_games.json",
  "50": "past_50_games.json",
  week: "past_week.json",
  month: "past_month.json",
  "2months": "past_2_months.json",
  "3months": "past_3_months.json",
  "6months": "past_6_months.json"
};

/* -------------------------
   SECONDARY NAV CONTENT
------------------------- */
const secondaryNavBySection = {
  overview: [],
  performance: ["Guess Rate", "Lives Taken / Saved", "Onlist/Offlist", "Rigs Missed", "Composite charts"],
  knowledge: ["Artist Familiarity", "Tag Familiarity", "Seasonal Comparison"],
  insights: ["Relearn Tracker", "By never correct", "By Wrong Guess", "By Popularity", "By % correct"],
  social: ["Synergy", "Rivals", "Team Contributions", "Rig / List analysis"],
  otherTools: ["Search songs", "Search song frequency", "Convert rank/usefulness", "Original Tour data(Calendar)", "Changelog"]
};

function scheduleBackgroundTask(taskKey, taskFn, delayMs = 0) {
  if (!taskKey || typeof taskFn !== "function") return;
  if (preloadTaskStatus.has(taskKey)) return;
  preloadTaskStatus.add(taskKey);

  const runTask = () => {
    Promise.resolve()
      .then(taskFn)
      .catch(err => {
        console.error(`[preload] ${taskKey} failed`, err);
      });
  };

  const launch = () => {
    if (delayMs > 0) {
      setTimeout(runTask, delayMs);
    } else {
      runTask();
    }
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => launch(), { timeout: 1200 });
  } else {
    setTimeout(() => launch(), 0);
  }
}

function preloadOverviewGeneralForUser(displayName, { immediate = false } = {}) {
  if (!displayName) return;
  const task = async () => {
    await Promise.allSettled([
      loadOverviewAnimeTypeDataForUser(displayName),
      loadOverviewTopSolosForUser(displayName),
      loadOverviewTopDoublesForUser(displayName, { kind: "general" }),
      loadOverviewTopDoublesForUser(displayName, { kind: "their_rig_you_blocked" }),
      loadOverviewTopDoublesForUser(displayName, { kind: "your_rig_they_blocked" }),
      loadOverviewTopRigSongsForUser(displayName)
    ]);
  };
  if (immediate) {
    task().catch(err => console.error("[preload] overview-general failed", err));
    return;
  }
  scheduleBackgroundTask(`overview-general:${displayName}`, task);
}

function preloadOverviewStatsSummaryForUser(displayName, { immediate = false } = {}) {
  if (!displayName) return;
  const task = async () => {
    await Promise.allSettled([
      loadOverviewZScoreDataForUser(displayName),
      loadGenreDataForUser(displayName),
      loadByEraDataForUser(displayName)
    ]);
  };
  if (immediate) {
    task().catch(err => console.error("[preload] overview-stats-summary failed", err));
    return;
  }
  scheduleBackgroundTask(`overview-stats-summary:${displayName}`, task);
}

function preloadFirstSubtabForSection(sectionKey, displayName) {
  if (!displayName || !sectionKey || sectionKey === "overview") return;
  const taskKey = `section-first:${sectionKey}:${displayName}`;
  scheduleBackgroundTask(taskKey, async () => {
    if (sectionKey === "performance") {
      const performanceRows = getPerformanceRowsForActiveMode();
      if (performanceRows.length) {
        renderPerformanceGuessRate(getVisibleUserData(performanceRows));
      }
      return;
    }
    if (sectionKey === "knowledge") {
      await loadArtistDataForUser(displayName);
      return;
    }
    if (sectionKey === "insights") {
      await loadRelearnDataForUser(displayName, { render: false });
      return;
    }
    if (sectionKey === "social") {
      await preloadSocialSynergyDataForUser(displayName);
      return;
    }
    if (sectionKey === "otherTools") {
      await loadSearchSongsDataForUser(displayName);
    }
  }, 60);
}

function preloadFirstSubtabsForAllSections(displayName) {
  if (!displayName) return;
  ["performance", "knowledge", "insights", "social", "otherTools"].forEach(sectionKey => {
    preloadFirstSubtabForSection(sectionKey, displayName);
  });
}

function preloadOtherSubtabsForSection(sectionKey, displayName) {
  if (!displayName || !sectionKey) return;
  const firstSubtab = (secondaryNavBySection[sectionKey] || [])[0];
  if (!firstSubtab) return;
  const activeSub = activeSubSectionBySection[sectionKey] || firstSubtab;
  if (activeSub !== firstSubtab) return;

  const taskKey = `section-rest:${sectionKey}:${displayName}`;
  scheduleBackgroundTask(taskKey, async () => {
    if (sectionKey === "performance") {
      const performanceRows = getPerformanceRowsForActiveMode();
      if (performanceRows.length) {
        const visible = getVisibleUserData(performanceRows);
        renderPerformanceLivesTakenSaved(visible);
        const watchedVisible = getVisibleUserData(fullUserData);
        renderPerformanceRigAnalysis(watchedVisible);
        renderPerformanceRigsMissed(watchedVisible);
        renderPerformanceCompositeCharts(watchedVisible);
      }
      return;
    }
    if (sectionKey === "knowledge") {
      await Promise.allSettled([
        loadTagDataForUser(displayName),
        loadByEraDataForUser(displayName)
      ]);
      return;
    }
    if (sectionKey === "insights") {
      await Promise.allSettled([
        loadWrongGuessDataForUser(displayName, { render: false }),
        loadNeverCorrectDataForUser(displayName, { render: false }),
        loadPopularityDataForUser(displayName, { render: false }),
        loadPCorrectDataForUser(displayName, { render: false })
      ]);
      return;
    }
    if (sectionKey === "social") {
      ensureSocialTeamContributionData();
      return;
    }
    if (sectionKey === "otherTools") {
      await Promise.allSettled([
        ensureSearchSongFrequencyData(),
        ensureRigAnalysisData(),
        ensureConvertEstimatorsLoaded(),
        ensureConvertExamplesLoaded(),
        ensureOriginalTourCalendarData(),
        renderOtherToolsChangelog()
      ]);
    }
  }, 140);
}

function loadInsightsDataForSubSection(subSection, displayName, options = {}) {
  const resolvedName = String(displayName || currentDisplayName || currentStatKey || "").trim();
  if (!resolvedName) return;

  if (subSection === "Relearn Tracker") {
    loadRelearnDataForUser(resolvedName, options);
    return;
  }
  if (subSection === "By never correct") {
    loadNeverCorrectDataForUser(resolvedName, options);
    return;
  }
  if (subSection === "By Wrong Guess") {
    loadWrongGuessDataForUser(resolvedName, options);
    return;
  }
  if (subSection === "By Popularity") {
    loadPopularityDataForUser(resolvedName, options);
    return;
  }
  if (subSection === "By % correct") {
    loadPCorrectDataForUser(resolvedName, options);
  }
}

function loadKnowledgeDataForSubSection(subSection, displayName) {
  const resolvedName = String(displayName || currentDisplayName || currentStatKey || "").trim();
  if (!resolvedName) return;

  if (subSection === "Artist Familiarity") {
    loadArtistDataForUser(resolvedName);
    return;
  }
  if (subSection === "Tag Familiarity") {
    loadTagDataForUser(resolvedName);
    return;
  }
  if (subSection === "Seasonal Comparison") {
    loadByEraDataForUser(resolvedName);
  }
}

function setSectionTitle(sectionKey, title) {
  const titleEl = document.querySelector(`#${sections[sectionKey]} .page-title`);
  if (titleEl) {
    titleEl.innerText = title;
  }
}

function buildChangelogTitleFromFileName(fileName) {
  const normalized = String(fileName || "").trim();
  const baseName = normalized.replace(/\.txt$/i, "");
  return `amq-relearn-tracker v${baseName}`;
}

function parseChangelogText(rawText) {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/);
  const firstNonEmptyIndex = lines.findIndex(line => String(line || "").trim().length > 0);
  if (firstNonEmptyIndex < 0) {
    return { customTitle: "", content: "" };
  }

  const firstNonEmptyLine = String(lines[firstNonEmptyIndex] || "").trim();
  const titleMatch = firstNonEmptyLine.match(/^title\s*:\s*(.+)$/i);
  if (!titleMatch) {
    return { customTitle: "", content: text.trim() };
  }

  const customTitle = String(titleMatch[1] || "").trim();
  const contentLines = lines.filter((_, idx) => idx !== firstNonEmptyIndex);
  return {
    customTitle,
    content: contentLines.join("\n").trim()
  };
}

function getChangelogBaseUrls() {
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return ["./data", DATA_BASE_URL];
  }
  return [DATA_BASE_URL, "./data"];
}

async function fetchChangelogFromAnyBase(path, options) {
  const cleanPath = String(path || "")
    .replace(/^data\//, "")
    .replace(/^\/+/, "");
  const bases = Array.from(new Set(getChangelogBaseUrls().filter(Boolean)));
  let lastError = null;

  for (const base of bases) {
    try {
      const cleanBase = String(base).replace(/\/+$/, "");
      const res = await fetch(`${cleanBase}/${cleanPath}`, options);
      if (res.ok) return res;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }
  return null;
}

async function fetchChangelogFileNames() {
  try {
    const indexRes = await fetchChangelogFromAnyBase("changelog/index.json");
    if (indexRes && indexRes.ok) {
      const indexPayload = await indexRes.json();
      const files = Array.isArray(indexPayload)
        ? indexPayload
        : (indexPayload && Array.isArray(indexPayload.files) ? indexPayload.files : []);
      return files
        .map(file => String(file || "").trim())
        .filter(file => /\.txt$/i.test(file) && !/^data\.txt$/i.test(file));
    }
  } catch (err) {
    console.warn("Unable to load changelog index.json", err);
  }

  try {
    const dirRes = await fetchChangelogFromAnyBase("changelog/");
    if (!dirRes || !dirRes.ok) return [];
    const html = await dirRes.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll("a[href]"));
    const fileSet = new Set();

    links.forEach(link => {
      const rawHref = String(link.getAttribute("href") || "").trim();
      if (!rawHref || rawHref.endsWith("/")) return;
      const cleanHref = rawHref.split("#")[0].split("?")[0];
      const fileName = decodeURIComponent(cleanHref.split("/").pop() || "");
      if (/\.txt$/i.test(fileName) && !/^data\.txt$/i.test(fileName)) {
        fileSet.add(fileName);
      }
    });

    return Array.from(fileSet);
  } catch (err) {
    console.warn("Unable to read changelog directory listing", err);
  }

  const playerScopedCandidates = [];
  if (currentPlayerId) {
    playerScopedCandidates.push(String(currentPlayerId));
  }
  try {
    const playerEntry = await getPlayerEntryByName(currentDisplayName || currentStatKey || username || "");
    if (playerEntry && playerEntry.playerId != null) {
      playerScopedCandidates.push(String(playerEntry.playerId));
    }
  } catch (err) {
    // Ignore; we can still proceed with other sources.
  }

  const uniquePlayerIds = Array.from(new Set(playerScopedCandidates.filter(Boolean)));
  for (const playerId of uniquePlayerIds) {
    try {
      const scopedIndexRes = await fetchChangelogFromAnyBase(`players/${playerId}/changelog/index.json`);
      if (scopedIndexRes && scopedIndexRes.ok) {
        const scopedIndexPayload = await scopedIndexRes.json();
        const files = Array.isArray(scopedIndexPayload)
          ? scopedIndexPayload
          : (scopedIndexPayload && Array.isArray(scopedIndexPayload.files) ? scopedIndexPayload.files : []);
        const parsed = files
          .map(file => String(file || "").trim())
          .filter(file => /\.txt$/i.test(file) && !/^data\.txt$/i.test(file));
        if (parsed.length) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`Unable to load player-scoped changelog index for player ${playerId}`, err);
    }

    try {
      const playerMetaRes = await fetchChangelogFromAnyBase(`players/${playerId}/player.json`);
      if (playerMetaRes && playerMetaRes.ok) {
        const playerMeta = await playerMetaRes.json();
        const rawFiles = Array.isArray(playerMeta && playerMeta.changelog)
          ? playerMeta.changelog
          : (Array.isArray(playerMeta && playerMeta.changelogFiles) ? playerMeta.changelogFiles : []);
        const parsed = rawFiles
          .map(item => {
            if (!item) return "";
            if (typeof item === "string") return item.trim();
            if (typeof item === "object") return String(item.file || item.path || item.name || "").trim();
            return "";
          })
          .map(file => file.split("/").pop() || "")
          .filter(file => /\.txt$/i.test(file) && !/^data\.txt$/i.test(file));
        if (parsed.length) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`Unable to load player metadata changelog for player ${playerId}`, err);
    }
  }

  // Final fallback for static hosts (like R2) where directory listing and index.json are disabled.
  // Use the canonical changelog files from local data/changelog.
  return ["1.0.txt", "1.1.txt", "1.2.txt", "1.3.txt", "1.4.txt"];
}

async function loadChangelogPosts(forceReload = false) {
  if (!forceReload && Array.isArray(cachedChangelogPosts)) {
    return cachedChangelogPosts;
  }
  if (!forceReload && changelogLoadPromise) {
    return changelogLoadPromise;
  }

  changelogLoadPromise = (async () => {
    const fileNames = await fetchChangelogFileNames();
    const sortedNames = [...fileNames].sort((a, b) => (
      b.replace(/\.txt$/i, "").localeCompare(a.replace(/\.txt$/i, ""), undefined, {
        numeric: true,
        sensitivity: "base"
      })
    ));

    const posts = await Promise.all(sortedNames.map(async fileName => {
      try {
        const candidatePaths = [`changelog/${encodeURIComponent(fileName)}`];
        if (currentPlayerId) {
          candidatePaths.push(`players/${encodeURIComponent(currentPlayerId)}/changelog/${encodeURIComponent(fileName)}`);
        }

        if (!currentPlayerId) {
          try {
            const playerEntry = await getPlayerEntryByName(currentDisplayName || currentStatKey || username || "");
            if (playerEntry && playerEntry.playerId != null) {
              candidatePaths.push(`players/${encodeURIComponent(String(playerEntry.playerId))}/changelog/${encodeURIComponent(fileName)}`);
            }
          } catch (err) {
            // Ignore lookup errors; remaining candidates still apply.
          }
        }

        let rawText = "";
        let found = false;
        for (const path of candidatePaths) {
          const res = await fetchChangelogFromAnyBase(path);
          if (!res || !res.ok) continue;
          rawText = await res.text();
          found = true;
          break;
        }
        if (!found) return null;

        const { customTitle, content } = parseChangelogText(rawText);
        const baseTitle = buildChangelogTitleFromFileName(fileName);
        return {
          fileName,
          title: customTitle ? `${baseTitle}—${customTitle}` : baseTitle,
          content: String(content || "").trim()
        };
      } catch (err) {
        console.warn(`Unable to load changelog file: ${fileName}`, err);
        return null;
      }
    }));

    cachedChangelogPosts = posts.filter(Boolean);
    return cachedChangelogPosts;
  })();

  try {
    return await changelogLoadPromise;
  } finally {
    changelogLoadPromise = null;
  }
}

function parseChangelogDataText(rawText) {
  return String(rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

async function loadChangelogDataText(forceReload = false) {
  if (!forceReload && cachedChangelogDataText != null) {
    return cachedChangelogDataText;
  }
  if (!forceReload && changelogDataLoadPromise) {
    return changelogDataLoadPromise;
  }

  changelogDataLoadPromise = (async () => {
    try {
      const res = await fetchChangelogFromAnyBase("changelog/data.txt");
      if (!res || !res.ok) {
        cachedChangelogDataText = "";
        return cachedChangelogDataText;
      }
      cachedChangelogDataText = parseChangelogDataText(await res.text());
      return cachedChangelogDataText;
    } catch (err) {
      console.warn("Unable to load changelog data.txt", err);
      cachedChangelogDataText = "";
      return cachedChangelogDataText;
    }
  })();

  try {
    return await changelogDataLoadPromise;
  } finally {
    changelogDataLoadPromise = null;
  }
}

async function renderOtherToolsChangelogData() {
  const contentEl = document.getElementById("otherToolsChangelogDataContent");
  if (!contentEl) return;

  const dataText = await loadChangelogDataText();
  if (dataText) {
    renderChangelogContent(contentEl, dataText);
  } else {
    contentEl.innerText = "No recent data information available.";
  }
}

async function renderOtherToolsChangelog() {
  const titleEl = document.getElementById("otherToolsChangelogTitle");
  const subtitleEl = document.getElementById("otherToolsChangelogSubtitle");
  const listEl = document.getElementById("otherToolsChangelogList");
  if (titleEl) {
    titleEl.innerText = "Welcome! This is where I post updates";
  }
  if (subtitleEl) {
    subtitleEl.innerHTML = "Feel free to dm me about any bugs or features you want added! (or use <a href=\"https://forms.gle/VqiTvvUPwTTyCTb96\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"text-decoration: underline;\">this link</a> to fill out a feedback form!)";
  }
  renderOtherToolsChangelogData();
  if (!listEl) return;

  const posts = await loadChangelogPosts();
  listEl.innerHTML = "";

  if (!posts.length) {
    const empty = document.createElement("div");
    empty.className = "changelog-post";
    const emptyTitle = document.createElement("div");
    emptyTitle.className = "changelog-post-title";
    emptyTitle.innerText = "No changelog posts yet";
    empty.appendChild(emptyTitle);
    listEl.appendChild(empty);
    return;
  }

  posts.forEach(post => {
    const postEl = document.createElement("div");
    postEl.className = "changelog-post";

    const postTitle = document.createElement("div");
    postTitle.className = "changelog-post-title";
    postTitle.innerText = post.title;

    const postContent = document.createElement("div");
    postContent.className = "changelog-post-content";
    renderChangelogContent(postContent, post.content);

    postEl.appendChild(postTitle);
    postEl.appendChild(postContent);
    listEl.appendChild(postEl);
  });
}

function renderChangelogContent(container, content) {
  container.innerHTML = "";
  const text = String(content || "");
  const highlightRegex = /__(.+?)__|_(.+?)_/g;
  let cursor = 0;
  let match = highlightRegex.exec(text);

  while (match) {
    if (match.index > cursor) {
      container.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }

    const highlighted = document.createElement("span");
    const yellowText = String(match[1] || "");
    const greenText = String(match[2] || "");
    if (yellowText) {
      highlighted.className = "changelog-highlight";
      highlighted.textContent = yellowText;
    } else {
      highlighted.className = "changelog-highlight-green";
      highlighted.textContent = greenText;
    }
    container.appendChild(highlighted);

    cursor = highlightRegex.lastIndex;
    match = highlightRegex.exec(text);
  }

  if (cursor < text.length) {
    container.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function updateSectionHeaderVisibility(sectionKey, subSection) {
  const sectionEl = document.getElementById(sections[sectionKey]);
  if (!sectionEl) return;
  const sectionHeader = sectionEl.querySelector(":scope > .page-title") || sectionEl.querySelector(".page-title");
  if (!sectionHeader) return;

  const hideForSeasonalComparison = sectionKey === "knowledge" && subSection === "Seasonal Comparison";
  sectionHeader.style.display = hideForSeasonalComparison ? "none" : "";
}

function renderInsightsSubSectionNow(subSection) {
  if (subSection === "Relearn Tracker") {
    renderInsightsRelearnTracker();
    return;
  }

  if (subSection === "By never correct") {
    renderInsightsNeverCorrect();
    return;
  }

  if (subSection === "By Wrong Guess") {
    renderInsightsWrongGuess();
    return;
  }

  if (subSection === "By Popularity") {
    renderInsightsPopularity();
    return;
  }

  if (subSection === "By % correct") {
    renderInsightsPCorrect();
  }
}

function scheduleInsightsSubSectionRender(subSection) {
  const renderToken = ++insightsSubSectionRenderToken;
  const runRender = () => {
    if (
      renderToken !== insightsSubSectionRenderToken
      || activeSection !== "insights"
      || activeSubSectionBySection.insights !== subSection
    ) {
      return;
    }

    renderInsightsSubSectionNow(subSection);
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(runRender, 0));
  } else {
    setTimeout(runRender, 0);
  }
}

function scheduleInsightsSubSectionLoad(subSection, displayName) {
  const loadToken = ++insightsSubSectionLoadToken;
  const runLoad = () => {
    if (
      loadToken !== insightsSubSectionLoadToken
      || activeSection !== "insights"
      || activeSubSectionBySection.insights !== subSection
    ) {
      return;
    }

    loadInsightsDataForSubSection(subSection, displayName, {
      shouldRender: () => (
        activeSection === "insights"
        && activeSubSectionBySection.insights === subSection
      )
    });
    setTimeout(retryFailedInsightCoverImages, 700);
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(runLoad, 0));
  } else {
    setTimeout(runLoad, 0);
  }
}

function scheduleSocialSubSectionRender(subSection) {
  const renderToken = ++socialSubSectionRenderToken;
  const runRender = () => {
    if (
      renderToken !== socialSubSectionRenderToken
      || activeSection !== "social"
      || activeSubSectionBySection.social !== subSection
    ) {
      return;
    }

    if (subSection === "Synergy") {
      renderSocialSynergyView();
      return;
    }

    if (subSection === "Rivals") {
      const availableEntries = getAvailableSocialRivalEntries();
      const autoClosestKeys = getClosestAvailableRivalKeys(
        currentStatKey,
        availableEntries,
        MAX_SELECTED_SOCIAL_RIVALS
      );
      selectedSocialRivalKeys = autoClosestKeys.slice(0, MAX_SELECTED_SOCIAL_RIVALS);
      renderSocialRivalFilter();
      renderSocialRivalsChart();
      return;
    }

    if (subSection === "Team Contributions") {
      renderSocialTeamContributionView();
      return;
    }

    if (subSection === "Rig / List analysis") {
      ensureRigAnalysisData();
      renderRigAnalysisView();
      prefetchRigAnalysisDataInBackground();
    }
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(runRender, 0));
  } else {
    setTimeout(runRender, 0);
  }
}

function renderSubSectionContent(sectionKey, subSection) {
  if (sectionKey === "performance") {
    const guessRateView = document.getElementById("performanceGuessRateView");
    const livesView = document.getElementById("performanceLivesView");
    const rigAnalysisView = document.getElementById("performanceRigAnalysisView");
    const rigsMissedView = document.getElementById("performanceRigsMissedView");
    const compositeChartsView = document.getElementById("performanceCompositeChartsView");
    const placeholderView = document.getElementById("performancePlaceholderView");

    if (subSection === "Guess Rate") {
      guessRateView.style.display = "grid";
      livesView.style.display = "none";
      rigAnalysisView.style.display = "none";
      rigsMissedView.style.display = "none";
      compositeChartsView.style.display = "none";
      placeholderView.style.display = "none";

      const performanceRows = getPerformanceRowsForActiveMode();
      if (performanceRows.length) {
        renderPerformanceGuessRate(getVisibleUserData(performanceRows));
      }
      return;
    }

    if (subSection === "Lives Taken / Saved") {
      guessRateView.style.display = "none";
      livesView.style.display = "grid";
      rigAnalysisView.style.display = "none";
      rigsMissedView.style.display = "none";
      compositeChartsView.style.display = "none";
      placeholderView.style.display = "none";

      const performanceRows = getPerformanceRowsForActiveMode();
      if (performanceRows.length) {
        renderPerformanceLivesTakenSaved(getVisibleUserData(performanceRows));
      }
      return;
    }

    if (subSection === "Onlist/Offlist") {
      guessRateView.style.display = "none";
      livesView.style.display = "none";
      rigAnalysisView.style.display = "grid";
      rigsMissedView.style.display = "none";
      compositeChartsView.style.display = "none";
      placeholderView.style.display = "none";

      if (fullUserData.length) {
        renderPerformanceRigAnalysis(getVisibleUserData(fullUserData));
      }
      return;
    }

    if (subSection === "Rigs Missed") {
      guessRateView.style.display = "none";
      livesView.style.display = "none";
      rigAnalysisView.style.display = "none";
      rigsMissedView.style.display = "grid";
      compositeChartsView.style.display = "none";
      placeholderView.style.display = "none";

      renderPerformanceRigsMissed(getVisibleUserData(fullUserData));
      return;
    }

    if (subSection === "Composite charts") {
      guessRateView.style.display = "none";
      livesView.style.display = "none";
      rigAnalysisView.style.display = "none";
      rigsMissedView.style.display = "none";
      compositeChartsView.style.display = "grid";
      placeholderView.style.display = "none";

      if (fullUserData.length) {
        renderPerformanceCompositeCharts(getVisibleUserData(fullUserData));
      }
      return;
    }

    guessRateView.style.display = "none";
    livesView.style.display = "none";
    rigAnalysisView.style.display = "none";
    rigsMissedView.style.display = "none";
    compositeChartsView.style.display = "none";
    placeholderView.style.display = "block";
    placeholderView.innerText = `${subSection} view coming soon.`;
    return;
  }

  if (sectionKey === "knowledge") {
    const artistView = document.getElementById("knowledgeArtistView");
    const genreView = document.getElementById("knowledgeGenreView");
    const byEraView = document.getElementById("knowledgeByEraView");
    const placeholderView = document.getElementById("knowledgePlaceholderView");

    if (subSection === "Artist Familiarity") {
      artistView.style.display = "block";
      genreView.style.display = "none";
      byEraView.style.display = "none";
      placeholderView.style.display = "none";
      renderArtistFamiliarityView();
      return;
    }

    if (subSection === "Tag Familiarity") {
      artistView.style.display = "none";
      genreView.style.display = "block";
      byEraView.style.display = "none";
      placeholderView.style.display = "none";
      renderKnowledgeTagRadar();
      return;
    }

    if (subSection === "Seasonal Comparison") {
      artistView.style.display = "none";
      genreView.style.display = "none";
      byEraView.style.display = "block";
      placeholderView.style.display = "none";
      renderKnowledgeByEraDecadeChart();
      return;
    }

    artistView.style.display = "none";
    genreView.style.display = "none";
    byEraView.style.display = "none";
    placeholderView.style.display = "block";
    placeholderView.innerText = `${subSection} view coming soon.`;
    return;
  }

  if (sectionKey === "insights") {
    const relearnView = document.getElementById("insightsRelearnTrackerView");
    const wrongGuessView = document.getElementById("insightsWrongGuessView");
    const neverCorrectView = document.getElementById("insightsNeverCorrectView");
    const popularityView = document.getElementById("insightsPopularityView");
    const pcorrectView = document.getElementById("insightsPCorrectView");
    const placeholderView = document.getElementById("insightsPlaceholderView");

    if (subSection === "Relearn Tracker") {
      relearnView.style.display = "block";
      wrongGuessView.style.display = "none";
      neverCorrectView.style.display = "none";
      popularityView.style.display = "none";
      pcorrectView.style.display = "none";
      placeholderView.style.display = "none";
      scheduleInsightsSubSectionRender(subSection);
      return;
    }

    if (subSection === "By never correct") {
      relearnView.style.display = "none";
      wrongGuessView.style.display = "none";
      neverCorrectView.style.display = "block";
      popularityView.style.display = "none";
      pcorrectView.style.display = "none";
      placeholderView.style.display = "none";
      scheduleInsightsSubSectionRender(subSection);
      return;
    }

    if (subSection === "By Wrong Guess") {
      relearnView.style.display = "none";
      wrongGuessView.style.display = "block";
      neverCorrectView.style.display = "none";
      popularityView.style.display = "none";
      pcorrectView.style.display = "none";
      placeholderView.style.display = "none";
      scheduleInsightsSubSectionRender(subSection);
      return;
    }

    if (subSection === "By Popularity") {
      relearnView.style.display = "none";
      wrongGuessView.style.display = "none";
      neverCorrectView.style.display = "none";
      popularityView.style.display = "block";
      pcorrectView.style.display = "none";
      placeholderView.style.display = "none";
      scheduleInsightsSubSectionRender(subSection);
      return;
    }

    if (subSection === "By % correct") {
      relearnView.style.display = "none";
      wrongGuessView.style.display = "none";
      neverCorrectView.style.display = "none";
      popularityView.style.display = "none";
      pcorrectView.style.display = "block";
      placeholderView.style.display = "none";
      scheduleInsightsSubSectionRender(subSection);
      return;
    }

    relearnView.style.display = "none";
    wrongGuessView.style.display = "none";
    neverCorrectView.style.display = "none";
    popularityView.style.display = "none";
    pcorrectView.style.display = "none";
    placeholderView.style.display = "block";
    placeholderView.innerText = `${subSection} view coming soon.`;
    return;
  }

  if (sectionKey !== "social") {
    socialSubSectionRenderToken += 1;
    stopSocialRivalsHeightSync();
  }

  if (sectionKey === "social") {
    const socialSectionEl = document.getElementById("socialSection");
    if (socialSectionEl) {
      socialSectionEl.setAttribute("data-social-subsection", String(subSection || ""));
    }
    const synergyView = document.getElementById("socialSynergyView");
    const synergyExtraGrid = document.getElementById("socialSynergyExtraGrid");
    const rivalsTopLayout = document.getElementById("socialRivalsTopLayout");
    const rivalsFilterView = document.getElementById("socialRivalsFilterView");
    const rivalsView = document.getElementById("socialRivalsView");
    const rivalsBubbleView = document.getElementById("socialRivalsBubbleView");
    const teamContributionView = document.getElementById("socialTeamContributionView");
    const rigAnalysisView = document.getElementById("otherToolsRigAnalysisView");
    const placeholderView = document.getElementById("socialPlaceholderView");

    if (subSection === "Synergy") {
      stopSocialRivalsHeightSync();
      synergyView.style.display = "block";
      if (synergyExtraGrid) synergyExtraGrid.style.display = "none";
      rivalsTopLayout.style.display = "none";
      rivalsFilterView.style.display = "none";
      rivalsView.style.display = "none";
      rivalsBubbleView.style.display = "none";
      teamContributionView.style.display = "none";
      rigAnalysisView.style.display = "none";
      placeholderView.style.display = "none";
      scheduleSocialSubSectionRender(subSection);
      return;
    }

    if (subSection === "Rivals") {
      synergyView.style.display = "none";
      if (synergyExtraGrid) synergyExtraGrid.style.display = "none";
      rivalsTopLayout.style.display = "grid";
      rivalsFilterView.style.display = "block";
      rivalsView.style.display = "block";
      rivalsBubbleView.style.display = "block";
      teamContributionView.style.display = "none";
      rigAnalysisView.style.display = "none";
      placeholderView.style.display = "none";
      startSocialRivalsHeightSync();
      scheduleSocialSubSectionRender(subSection);
      return;
    }

    if (subSection === "Team Contributions") {
      stopSocialRivalsHeightSync();
      synergyView.style.display = "none";
      if (synergyExtraGrid) synergyExtraGrid.style.display = "none";
      rivalsTopLayout.style.display = "none";
      rivalsFilterView.style.display = "none";
      rivalsView.style.display = "none";
      rivalsBubbleView.style.display = "none";
      teamContributionView.style.display = "block";
      rigAnalysisView.style.display = "none";
      placeholderView.style.display = "none";
      scheduleSocialSubSectionRender(subSection);
      return;
    }

    if (subSection === "Rig / List analysis") {
      stopSocialRivalsHeightSync();
      synergyView.style.display = "none";
      if (synergyExtraGrid) synergyExtraGrid.style.display = "none";
      rivalsTopLayout.style.display = "none";
      rivalsFilterView.style.display = "none";
      rivalsView.style.display = "none";
      rivalsBubbleView.style.display = "none";
      teamContributionView.style.display = "none";
      rigAnalysisView.style.display = "block";
      placeholderView.style.display = "none";
      scheduleSocialSubSectionRender(subSection);
      return;
    }

    synergyView.style.display = "none";
    if (synergyExtraGrid) synergyExtraGrid.style.display = "none";
    rivalsTopLayout.style.display = "none";
    rivalsFilterView.style.display = "none";
    rivalsView.style.display = "none";
    rivalsBubbleView.style.display = "none";
    teamContributionView.style.display = "none";
    rigAnalysisView.style.display = "none";
    placeholderView.style.display = "block";
    placeholderView.innerText = `${subSection} view coming soon.`;
    return;
  }

  if (sectionKey === "otherTools") {
    const searchSongsView = document.getElementById("otherToolsSearchSongsView");
    const searchSongFrequencyView = document.getElementById("otherToolsSearchSongFrequencyView");
    const convertView = document.getElementById("otherToolsConvertRankUsefulnessView");
    const originalTourView = document.getElementById("otherToolsOriginalTourCalendarView");
    const changelogView = document.getElementById("otherToolsChangelogView");
    const placeholderView = document.getElementById("otherToolsPlaceholderView");

    if (subSection === "Search songs") {
      searchSongsView.style.display = "block";
      searchSongFrequencyView.style.display = "none";
      convertView.style.display = "none";
      originalTourView.style.display = "none";
      changelogView.style.display = "none";
      placeholderView.style.display = "none";
      renderInsightsSearchSongs();
      return;
    }

    if (subSection === "Search song frequency") {
      searchSongsView.style.display = "none";
      searchSongFrequencyView.style.display = "block";
      convertView.style.display = "none";
      originalTourView.style.display = "none";
      changelogView.style.display = "none";
      placeholderView.style.display = "none";
      ensureSearchSongFrequencyData();
      renderSearchSongFrequency();
      return;
    }

    if (subSection === "Convert rank/usefulness") {
      searchSongsView.style.display = "none";
      searchSongFrequencyView.style.display = "none";
      convertView.style.display = "block";
      originalTourView.style.display = "none";
      changelogView.style.display = "none";
      placeholderView.style.display = "none";
      bindConvertEstimatorControlsOnce();
      ensureConvertEstimatorsLoaded();
      ensureConvertExamplesLoaded();
      return;
    }

    if (subSection === "Original Tour data(Calendar)") {
      searchSongsView.style.display = "none";
      searchSongFrequencyView.style.display = "none";
      convertView.style.display = "none";
      originalTourView.style.display = "block";
      changelogView.style.display = "none";
      placeholderView.style.display = "none";
      ensureOriginalTourCalendarData();
      renderOriginalTourCalendarView();
      return;
    }

    if (subSection === "Changelog") {
      searchSongsView.style.display = "none";
      searchSongFrequencyView.style.display = "none";
      convertView.style.display = "none";
      originalTourView.style.display = "none";
      changelogView.style.display = "block";
      placeholderView.style.display = "none";
      renderOtherToolsChangelog();
      return;
    }

    searchSongsView.style.display = "none";
    searchSongFrequencyView.style.display = "none";
    convertView.style.display = "none";
    originalTourView.style.display = "none";
    changelogView.style.display = "none";
    placeholderView.style.display = "block";
    placeholderView.innerText = `${subSection} view coming soon.`;
  }
}

function normalizeTourTypeLockRow(row) {
  if (!row || typeof row !== "object") return "";
  return [
    String(row.Timestamp || ""),
    String(row["Guess rate"] || ""),
    String(row["OP guess rate"] || ""),
    String(row["ED guess rate"] || ""),
    String(row["IN guess rate"] || ""),
    String(row["Rank"] || ""),
    String(row["Lives saved"] || ""),
    String(row["Lives taken"] || "")
  ].join("|");
}

function areRowsEquivalentForTourTypeLock(rowsA, rowsB) {
  if (!Array.isArray(rowsA) || !Array.isArray(rowsB)) return false;
  if (!rowsA.length || !rowsB.length) return false;
  if (rowsA.length !== rowsB.length) return false;

  const normalizedA = rowsA.map(normalizeTourTypeLockRow).sort();
  const normalizedB = rowsB.map(normalizeTourTypeLockRow).sort();
  for (let i = 0; i < normalizedA.length; i += 1) {
    if (normalizedA[i] !== normalizedB[i]) return false;
  }
  return true;
}

function selectWatchedTourTypeForLock() {
  overviewDataSourceMode = "watched";
  if (overviewDataSourceToggle) {
    overviewDataSourceToggle.classList.remove("is-usual");
  }
  if (overviewDataSourceWatchedBtn) {
    overviewDataSourceWatchedBtn.classList.add("active");
    overviewDataSourceWatchedBtn.setAttribute("aria-pressed", "true");
  }
  if (overviewDataSourceUsualBtn) {
    overviewDataSourceUsualBtn.classList.remove("active");
    overviewDataSourceUsualBtn.setAttribute("aria-pressed", "false");
  }
}

function updateDataRangeControlState(sectionKey, subSection) {
  if (!dataRangeSelect) return;
  const dataRangeWrap = dataRangeSelect.closest(".topbar-data-range");
  const dataRangeLockBadge = document.getElementById("dataRangeLockBadge");
  const tourTypeLockBadge = document.getElementById("tourTypeLockBadge");
  const isRecommendationsSection = sectionKey === "insights";
  const isOtherToolsSection = sectionKey === "otherTools";
  const isOverviewGeneral = sectionKey === "overview" && overviewActiveView === "overview";
  const isOverviewStatsSummary = sectionKey === "overview" && overviewActiveView === "statsSummary";
  const isPerformanceGuessRate = sectionKey === "performance" && subSection === "Guess Rate";
  const isPerformanceLives = sectionKey === "performance" && subSection === "Lives Taken / Saved";
  const isPerformanceOnlistOfflist = sectionKey === "performance" && subSection === "Onlist/Offlist";
  const isPerformanceRigsMissed = sectionKey === "performance" && subSection === "Rigs Missed";
  const isPerformanceCompositeCharts = sectionKey === "performance" && subSection === "Composite charts";
  const isKnowledgeSeasonalComparison = sectionKey === "knowledge" && subSection === "Seasonal Comparison";
  const isSocialRigAnalysis = sectionKey === "social" && subSection === "Rig / List analysis";
  const shouldUnlockUsingData =
    isOverviewGeneral
    || isOverviewStatsSummary
    || isPerformanceGuessRate
    || isPerformanceLives
    || isPerformanceOnlistOfflist
    || isPerformanceRigsMissed
    || isPerformanceCompositeCharts
    || isKnowledgeSeasonalComparison
    || isSocialRigAnalysis;

  const shouldHidePastGameOptions =
    (sectionKey === "overview" && (overviewActiveView === "statsSummary" || overviewActiveView === "weekly"))
    || (sectionKey === "knowledge" && (subSection === "Tag Familiarity" || subSection === "Seasonal Comparison" || subSection === "Artist Familiarity"))
    || isRecommendationsSection
    || isOtherToolsSection;

  const allowedOptions = shouldHidePastGameOptions
    ? DATA_RANGE_OPTIONS.filter(opt => !DATA_RANGE_EXCLUDED_VALUES_FOR_NO_PAST_GAMES.has(opt.value))
    : DATA_RANGE_OPTIONS;

  const previousValue = String(dataRangeSelect.value || "all");
  dataRangeSelect.innerHTML = allowedOptions
    .map(opt => `<option value="${opt.value}">${opt.label}</option>`)
    .join("");
  const hasPreviousValue = allowedOptions.some(opt => opt.value === previousValue);
  const nextValue = hasPreviousValue ? previousValue : "all";
  dataRangeSelect.value = nextValue;

  const shouldLockToAll = !shouldUnlockUsingData;
  const hasWatchedRows = Array.isArray(fullUserData) && fullUserData.length > 0;
  const hasUsualRows = Array.isArray(usualUserData) && usualUserData.length > 0;
  const noWatchedDataAvailable = hasUsualRows && !hasWatchedRows;
  const noUsualDataAvailable = hasWatchedRows && !hasUsualRows;
  const shouldLockTourType = isSocialRigAnalysis || isPerformanceOnlistOfflist || isPerformanceRigsMissed;
  const lockedTourTypeMode = "watched";
  isTourTypeToggleLocked = shouldLockTourType;
  if (shouldLockTourType) {
    selectWatchedTourTypeForLock();
  }
  dataRangeSelect.disabled = shouldLockToAll;
  if (dataRangeWrap) {
    dataRangeWrap.classList.toggle("locked", shouldLockToAll);
    dataRangeWrap.classList.toggle("tour-type-lock-mode", shouldLockTourType);
  }
  updateOverviewDataSourceToggleUI();
  if (dataRangeLockBadge) {
    dataRangeLockBadge.title = shouldLockToAll
      ? "Using data selection is locked."
      : "";
  }
  if (tourTypeLockBadge) {
    if (!shouldLockTourType) {
      tourTypeLockBadge.title = "";
    } else if (noWatchedDataAvailable) {
      tourTypeLockBadge.title = "Watched data is unavailable for this user.";
    } else if (noUsualDataAvailable) {
      tourTypeLockBadge.title = "Usual data is unavailable for this user.";
    } else {
      tourTypeLockBadge.title = `Tour type is fixed to ${lockedTourTypeMode === "usual" ? "Usual" : "Watched"} in this view.`;
    }
  }
  if (shouldLockToAll && dataRangeSelect.value !== "all") {
    dataRangeSelect.value = "all";
  }

  if (dataRangeSelect.value !== previousValue) {
    dataRangeSelect.dispatchEvent(new Event("change"));
  }
}

function setActiveSubSection(sectionKey, subSection) {
  activeSubSectionBySection[sectionKey] = subSection;
  setSectionTitle(sectionKey, subSection || sectionLabels[sectionKey]);
  updateSectionHeaderVisibility(sectionKey, subSection);

  document.querySelectorAll(".subnav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.item === subSection);
  });

  updateDataRangeControlState(sectionKey, subSection);
  renderSubSectionContent(sectionKey, subSection);
  if (sectionKey === "insights") {
    scheduleInsightsSubSectionLoad(subSection, currentDisplayName || currentStatKey || "");
  }
  preloadOtherSubtabsForSection(sectionKey, currentDisplayName || currentStatKey || "");
}

function buildSecondaryNav(sectionKey) {
  const subnav = document.getElementById("subnav");
  const subnavLinks = document.getElementById("subnavLinks");
  const items = secondaryNavBySection[sectionKey] || [];
  if (!subnav || !subnavLinks) return;

  if (items.length === 0) {
    subnav.style.display = "flex";
    subnavLinks.innerHTML = "";
    setSectionTitle(sectionKey, sectionLabels[sectionKey]);
    updateSectionHeaderVisibility(sectionKey, null);
    return;
  }

  subnav.style.display = "flex";
  subnavLinks.innerHTML = items.map(item => {
    return `<a href="#" class="subnav-link" data-item="${item}">${item}</a>`;
  }).join("");

  const savedSelection = activeSubSectionBySection[sectionKey];
  const selected = items.includes(savedSelection) ? savedSelection : items[0];

  subnavLinks.querySelectorAll(".subnav-link").forEach(link => {
    link.addEventListener("click", event => {
      event.preventDefault();
      setActiveSubSection(sectionKey, link.dataset.item);
    });
  });

  setActiveSubSection(sectionKey, selected);
}

function setActiveSection(targetSection) {
  if (!sections[targetSection]) return;
  const previousSection = activeSection;
  activeSection = targetSection;
  document.body.classList.add("unified-nav-mode");
  document.body.classList.toggle("performance-nav-mode", targetSection === "performance" || targetSection === "overview");
  document.body.classList.toggle("overview-section-active", targetSection === "overview");

  Object.values(sections).forEach(id => {
    document.getElementById(id).style.display = "none";
  });

  document.getElementById(sections[targetSection]).style.display = "block";

  document.querySelectorAll(".topbar-link").forEach(link => {
    link.classList.toggle("active", link.dataset.section === targetSection);
  });

  if (previousSection && previousSection !== targetSection && targetSection !== "insights") {
    stopAndResetRelearnAudio();
  }

  updateDataRangeControlState(targetSection, activeSubSectionBySection[targetSection] || "");
  buildSecondaryNav(targetSection);
  renderOverviewSubView();
  preloadFirstSubtabForSection(targetSection, currentDisplayName || currentStatKey || "");
}

function renderOverviewSubView() {
  if (!overviewMainView || !overviewStatsSummaryView || !overviewWeeklyView) return;

  const isOverviewSection = activeSection === "overview";
  const showOverviewMain = isOverviewSection && overviewActiveView === "overview";
  const showStatsSummary = isOverviewSection && overviewActiveView === "statsSummary";
  const showWeeklyPerformance = isOverviewSection && overviewActiveView === "weekly";

  overviewMainView.style.display = showOverviewMain ? "block" : "none";
  overviewStatsSummaryView.style.display = showStatsSummary ? "block" : "none";
  overviewWeeklyView.style.display = showWeeklyPerformance ? "block" : "none";
  if (isOverviewSection) {
    const title = showStatsSummary
      ? "Stats Summary"
      : (showWeeklyPerformance ? "Weekly Performance" : sectionLabels.overview);
    setSectionTitle("overview", title);
  }
  updateOverviewWeeklyRangeSubtitle(showWeeklyPerformance);
  if (showStatsSummary) {
    if (currentDisplayName) {
      preloadOverviewStatsSummaryForUser(currentDisplayName);
    }
    renderOverviewZScoreChart();
    renderKnowledgeGenreRadar();
    renderKnowledgeByEraDecadeChart();
    renderOverviewAnimeTypeCharts();
    renderOverviewSynergySummary();
  }
  if (showWeeklyPerformance) {
    renderWeeklyPerformanceView();
  }

  if (overviewViewTabs) {
    overviewViewTabs.querySelectorAll(".overview-view-tab").forEach(button => {
      button.classList.toggle("active", button.dataset.overviewView === overviewActiveView);
    });
  }
}

function addOverviewInfoButtons() {
  const placeholderText = "Temporary info text. Replace this with metric-specific details.";
  const allowedInfoTitles = new Set([
    "current rank",
    "average guess rate",
    "songs seen",
    "songs gotten",
    "momentum",
    "consistency",
    "type mix balance",
    "net lives contribution",
    "average rig",
    "average rig %"
  ]);
  const titleHelpByTitle = {
    "Current Rank": {
      meaning: "Shows your current rank on the percentile ladder.",
      calculation: ""
    },
    "Average Guess Rate": {
      meaning: "Calculated using the average of your guess rate from the last 10 tours.",
      calculation: ""
    },
    "Songs Seen": {
      meaning: "Total amount of songs you’ve seen in tours",
      calculation: ""
    },
    "Songs Gotten": {
      meaning: "Total amount of songs you got correct in tours, with duplicate songs counted.",
      calculation: ""
    },
    "Momentum": {
      meaning: "Displays your short term form.",
      calculation: "Calculated by comparing the average of your last 3 guess rate against the average of your last 10 guess rate."
    },
    "Consistency": {
      meaning: "Shows how stable your recent performance is.",
      calculation: "Calculated from variation in your last 10 games (lower is steadier)."
    },
    "Type Mix Balance": {
      meaning: "Shows how you perform across OP / ED / IN.",
      calculation: "The higher the number, the more balanced you perform."
    },
    "Net Lives Contribution": {
      meaning: "Shows your average team impact.",
      calculation: "Calculated as average of (lives saved + lives taken) over the last 10 games."
    },
    "Average Rig": {
      meaning: "Average rig amount over the last 10 games.",
      calculation: ""
    },
    "Average Rig %": {
      meaning: "Average rig % over the last 10 games.",
      calculation: ""
    },
    "Guess Rate P25": {
      meaning: "Shows your lower-end typical guess-rate level.",
      calculation: "Calculated as the 25th percentile from your last 10 tours/games."
    },
    "Guess Rate P75": {
      meaning: "Shows your upper-end typical guess-rate level.",
      calculation: "Calculated as the 75th percentile from your last 10 tours/games."
    },
    "Guess Rate Trend": {
      meaning: "Shows how your guess rate changes over time.",
      calculation: "Calculated per game in sequence and visualized with slope."
    },
    "Total Songs Played by Type": {
      meaning: "Shows how your played songs are distributed by type.",
      calculation: "Calculated by grouping total plays into OP, ED, and IN."
    },
    "Guess Rate by Type": {
      meaning: "Shows which song types you answer best.",
      calculation: "Calculated as guess-rate percentages for OP, ED, and IN."
    },
    "Top Solos": {
      meaning: "Shows songs where you most often got the solo correct answer.",
      calculation: "Calculated by ranking songs by solo count and taking the top 50."
    }
  };
  const titleNodes = document.querySelectorAll("#overviewSection .card-title, #overviewSection .chart-title");
  titleNodes.forEach(titleNode => {
    if (titleNode.querySelector(".info-hover-wrap")) return;

    const titleText = String(titleNode.textContent || "").trim();
    const normalizedTitle = titleText.toLowerCase();
    if (!allowedInfoTitles.has(normalizedTitle)) {
      return;
    }
    const parentCard = titleNode.closest(".card, .chart-card");
    const subtitleNode = parentCard ? parentCard.querySelector(".card-subtitle") : null;
    const subtitleText = subtitleNode ? String(subtitleNode.textContent || "").trim() : "";
    if (subtitleNode && subtitleText) {
      subtitleNode.style.display = "none";
    }
    const mappedInfo = titleHelpByTitle[titleText];
    const meaningText = mappedInfo && mappedInfo.meaning ? mappedInfo.meaning : placeholderText;
    const calculationText = mappedInfo && mappedInfo.calculation
      ? mappedInfo.calculation
      : "";
    const tooltipText = calculationText
      ? `${meaningText} ${calculationText}`
      : meaningText;

    const wrap = document.createElement("span");
    wrap.className = "info-hover-wrap";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "info-hover-btn";
    button.setAttribute("aria-label", "More info");
    button.innerText = "i";

    const tooltip = document.createElement("span");
    tooltip.className = "info-hover-tooltip";
    if (tooltipText.length >= 80) {
      tooltip.classList.add("fill-tooltip-text");
    }
    tooltip.innerText = tooltipText;

    wrap.appendChild(button);
    wrap.appendChild(tooltip);

    const placeTooltip = () => {
      wrap.classList.remove("open-left");
      const rectRight = tooltip.getBoundingClientRect().right;
      if (rectRight > window.innerWidth - 8) {
        wrap.classList.add("open-left");
      }
    };

    wrap.addEventListener("mouseenter", placeTooltip);
    wrap.addEventListener("focusin", placeTooltip);
    window.addEventListener("resize", placeTooltip);

    titleNode.appendChild(wrap);
  });
}

function getRankPoolSizeForMode(mode = "watched") {
  const cache = getLatestRankCacheForMode(mode);
  const rankMap = cache.map;
  if (!(rankMap instanceof Map) || !rankMap.size) {
    return null;
  }

  const values = Array.from(rankMap.values())
    .map(value => Number(value))
    .filter(value => isValidRankForMode(value, mode));
  return values.length;
}

function updateCurrentRankInfoTooltip(rankPoolSize) {
  const tooltip = document.querySelector("#currentRankCard .card-title .info-hover-tooltip");
  if (!tooltip) {
    return;
  }

  if (!tooltip.dataset.baseText) {
    tooltip.dataset.baseText = String(tooltip.textContent || "").trim();
  }

  const baseText = tooltip.dataset.baseText || "";
  tooltip.textContent = Number.isFinite(rankPoolSize) && rankPoolSize > 0
    ? `${baseText}\nRanked out of ${Math.round(rankPoolSize)} players`
    : baseText;
}

document.querySelectorAll(".topbar-link").forEach(link => {
  link.addEventListener("click", event => {
    event.preventDefault();
    setActiveSection(link.dataset.section);
  });
});

if (overviewViewTabs) {
  overviewViewTabs.querySelectorAll(".overview-view-tab").forEach(button => {
    button.addEventListener("click", () => {
      const requestedView = String(button.dataset.overviewView || "");
      const targetView = requestedView === "statsSummary"
        ? "statsSummary"
        : (requestedView === "weekly" ? "weekly" : "overview");
      overviewActiveView = targetView;
      updateDataRangeControlState(activeSection, activeSubSectionBySection[activeSection] || "");
      renderOverviewSubView();
    });
  });
}

setActiveSection(initialSection);
addOverviewInfoButtons();

const relearnPrevPageBtn = document.getElementById("relearnPrevPageBtn");
const relearnNextPageBtn = document.getElementById("relearnNextPageBtn");
const wrongGuessPrevPageBtn = document.getElementById("wrongGuessPrevPageBtn");
const wrongGuessNextPageBtn = document.getElementById("wrongGuessNextPageBtn");
const neverCorrectPrevPageBtn = document.getElementById("neverCorrectPrevPageBtn");
const neverCorrectNextPageBtn = document.getElementById("neverCorrectNextPageBtn");
const popularityPrevPageBtn = document.getElementById("popularityPrevPageBtn");
const popularityNextPageBtn = document.getElementById("popularityNextPageBtn");
const pcorrectPrevPageBtn = document.getElementById("pcorrectPrevPageBtn");
const pcorrectNextPageBtn = document.getElementById("pcorrectNextPageBtn");
const socialSynergyPrevPageBtn = document.getElementById("socialSynergyPrevPageBtn");
const socialSynergyNextPageBtn = document.getElementById("socialSynergyNextPageBtn");
if (relearnPrevPageBtn) {
  relearnPrevPageBtn.addEventListener("click", () => {
    relearnPageIndex = Math.max(0, relearnPageIndex - 1);
    renderInsightsRelearnTracker();
  });
}
if (relearnNextPageBtn) {
  relearnNextPageBtn.addEventListener("click", () => {
    relearnPageIndex += 1;
    renderInsightsRelearnTracker();
  });
}
document.querySelectorAll("[data-relearn-onlist-filter]").forEach(button => {
  button.addEventListener("click", () => {
    const nextMode = button.dataset.relearnOnlistFilter;
    relearnOnlistFilterMode = ["all", "onlist", "offlist"].includes(nextMode) ? nextMode : "all";
    relearnPageIndex = 0;
    renderInsightsRelearnTracker();
  });
});
if (wrongGuessPrevPageBtn) {
  wrongGuessPrevPageBtn.addEventListener("click", () => {
    wrongGuessPageIndex = Math.max(0, wrongGuessPageIndex - 1);
    renderInsightsWrongGuess();
  });
}
if (wrongGuessNextPageBtn) {
  wrongGuessNextPageBtn.addEventListener("click", () => {
    wrongGuessPageIndex += 1;
    renderInsightsWrongGuess();
  });
}
if (neverCorrectPrevPageBtn) {
  neverCorrectPrevPageBtn.addEventListener("click", () => {
    neverCorrectPageIndex = Math.max(0, neverCorrectPageIndex - 1);
    renderInsightsNeverCorrect();
  });
}
if (neverCorrectNextPageBtn) {
  neverCorrectNextPageBtn.addEventListener("click", () => {
    neverCorrectPageIndex += 1;
    renderInsightsNeverCorrect();
  });
}
if (popularityPrevPageBtn) {
  popularityPrevPageBtn.addEventListener("click", () => {
    popularityPageIndex = Math.max(0, popularityPageIndex - 1);
    renderInsightsPopularity();
  });
}
if (popularityNextPageBtn) {
  popularityNextPageBtn.addEventListener("click", () => {
    popularityPageIndex += 1;
    renderInsightsPopularity();
  });
}
if (pcorrectPrevPageBtn) {
  pcorrectPrevPageBtn.addEventListener("click", () => {
    pcorrectPageIndex = Math.max(0, pcorrectPageIndex - 1);
    renderInsightsPCorrect();
  });
}
if (pcorrectNextPageBtn) {
  pcorrectNextPageBtn.addEventListener("click", () => {
    pcorrectPageIndex += 1;
    renderInsightsPCorrect();
  });
}
if (socialSynergyPrevPageBtn) {
  socialSynergyPrevPageBtn.addEventListener("click", () => {
    socialSynergyPageIndex = Math.max(0, socialSynergyPageIndex - 1);
    renderSocialSynergyTableRows(cachedSocialSynergyRows);
  });
}
if (socialSynergyNextPageBtn) {
  socialSynergyNextPageBtn.addEventListener("click", () => {
    socialSynergyPageIndex += 1;
    renderSocialSynergyTableRows(cachedSocialSynergyRows);
  });
}

if (tagSearchInput) {
  tagSearchInput.addEventListener("input", event => {
    tagSearchQuery = String(event.target.value || "").toLowerCase();
    renderKnowledgeTagRadar();
  });
}

if (socialRivalSearchInput) {
  socialRivalSearchInput.addEventListener("input", event => {
    socialRivalSearchQuery = String(event.target.value || "").toLowerCase();
    renderSocialRivalFilter();
  });
}

if (socialSynergyPlayerSearchInput) {
  socialSynergyPlayerSearchInput.addEventListener("input", event => {
    socialSynergySingleSearchQuery = String(event.target.value || "").toLowerCase();
    renderSocialSynergySinglePicker(cachedSocialSynergyRows, currentDisplayName || currentStatKey || "You");
  });
}

if (socialSynergySelectBtn) {
  socialSynergySelectBtn.addEventListener("click", () => {
    if (!socialSynergySinglePendingRivalKey || socialSynergySinglePendingRivalKey === socialSynergySingleSelectedRivalKey) return;
    socialSynergySingleSelectedRivalKey = socialSynergySinglePendingRivalKey;
    renderSocialSynergySinglePicker(cachedSocialSynergyRows, currentDisplayName || currentStatKey || "You");
    renderSocialSynergyRigTables();
  });
}

const socialTargetRigUniqueBtn = document.getElementById("socialTargetRigUniqueBtn");
const socialTargetRigSharedBtn = document.getElementById("socialTargetRigSharedBtn");
const socialOtherRigUniqueBtn = document.getElementById("socialOtherRigUniqueBtn");
const socialOtherRigSharedBtn = document.getElementById("socialOtherRigSharedBtn");

if (socialTargetRigUniqueBtn) {
  socialTargetRigUniqueBtn.addEventListener("click", () => setSocialSynergyRigMode("target", "unique"));
}
if (socialTargetRigSharedBtn) {
  socialTargetRigSharedBtn.addEventListener("click", () => setSocialSynergyRigMode("target", "shared"));
}
if (socialOtherRigUniqueBtn) {
  socialOtherRigUniqueBtn.addEventListener("click", () => setSocialSynergyRigMode("other", "unique"));
}
if (socialOtherRigSharedBtn) {
  socialOtherRigSharedBtn.addEventListener("click", () => setSocialSynergyRigMode("other", "shared"));
}

if (socialRivalsMetricSelect) {
  syncSocialRivalsMetricOptionsForMode();
  socialRivalsMetricSelect.addEventListener("change", event => {
    const nextValue = String(event.target.value || "guess_rate");
    socialRivalsMetricKey = isSocialRivalsMetricAvailableForActiveMode(nextValue)
      ? nextValue
      : "guess_rate";
    syncSocialRivalsMetricOptionsForMode();
    if (activeSection === "social" && activeSubSectionBySection.social === "Rivals") {
      scheduleSocialSubSectionRender("Rivals");
    }
  });
}

const searchSongsInput = document.getElementById("searchSongsInput");
const searchSongsExactMatchInput = document.getElementById("searchSongsExactMatch");
const searchSongsApplyBtn = document.getElementById("searchSongsApplyBtn");
const searchSongsModeSelect = document.getElementById("searchSongsModeSelect");
const searchSongsPrevPageBtn = document.getElementById("searchSongsPrevPageBtn");
const searchSongsNextPageBtn = document.getElementById("searchSongsNextPageBtn");
const searchSongFrequencyInput = document.getElementById("searchSongFrequencyInput");
const searchSongFrequencyExactMatchInput = document.getElementById("searchSongFrequencyExactMatch");
const searchSongFrequencyApplyBtn = document.getElementById("searchSongFrequencyApplyBtn");
const searchSongFrequencyPrevPageBtn = document.getElementById("searchSongFrequencyPrevPageBtn");
const searchSongFrequencyNextPageBtn = document.getElementById("searchSongFrequencyNextPageBtn");
const originalTourSearchInput = document.getElementById("originalTourSearchInput");
const originalTourPrevMonthBtn = document.getElementById("originalTourPrevMonthBtn");
const originalTourNextMonthBtn = document.getElementById("originalTourNextMonthBtn");
const originalTourSelectBtn = document.getElementById("originalTourSelectBtn");
const originalTourColorModeSelect = document.getElementById("originalTourColorModeSelect");
const socialTeamSearchInput = document.getElementById("socialTeamSearchInput");
const socialTeamPrevMonthBtn = document.getElementById("socialTeamPrevMonthBtn");
const socialTeamNextMonthBtn = document.getElementById("socialTeamNextMonthBtn");
const socialTeamSelectBtn = document.getElementById("socialTeamSelectBtn");

function applySearchSongsFilters() {
  searchSongsQuery = String(searchSongsInput && searchSongsInput.value || "");
  searchSongsExactMatch = Boolean(searchSongsExactMatchInput && searchSongsExactMatchInput.checked);
  searchSongsPageIndex = 0;
  if (searchSongsModeSelect) {
    searchSongsMode = String(searchSongsModeSelect.value || "all");
  }
  renderSearchSongsInlineSuggestion();
  hideSearchSongsSuggestions();
  renderInsightsSearchSongs();
}

if (searchSongsInput) {
  searchSongsInput.addEventListener("input", event => {
    searchSongsQuery = String(event.target.value || "");
    renderSearchSongsSuggestions();
  });
  searchSongsInput.addEventListener("focus", () => {
    renderSearchSongsSuggestions();
  });
  searchSongsInput.addEventListener("blur", () => {
    setTimeout(() => {
      renderSearchSongsInlineSuggestion();
      hideSearchSongsSuggestions();
    }, 0);
  });
  searchSongsInput.addEventListener("keydown", event => {
    if (event.key === "Tab" && !event.shiftKey) {
      const typed = String(searchSongsInput.value || "");
      const suggestion = getSearchSongsPrefixSuggestion(typed);
      if (suggestion) {
        event.preventDefault();
        searchSongsInput.value = suggestion.value;
        searchSongsQuery = suggestion.value;
        renderSearchSongsInlineSuggestion();
        hideSearchSongsSuggestions();
      }
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    applySearchSongsFilters();
  });
}
if (searchSongsExactMatchInput) {
  searchSongsExactMatchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applySearchSongsFilters();
  });
}
if (searchSongsApplyBtn) {
  searchSongsApplyBtn.addEventListener("click", () => {
    applySearchSongsFilters();
  });
}
if (searchSongsModeSelect) {
  searchSongsModeSelect.addEventListener("change", event => {
    searchSongsMode = String(event.target.value || "all");
    renderSearchSongsSuggestions();
    applySearchSongsFilters();
  });
}
if (searchSongsPrevPageBtn) {
  searchSongsPrevPageBtn.addEventListener("click", () => {
    searchSongsPageIndex = Math.max(0, searchSongsPageIndex - 1);
    renderInsightsSearchSongs();
  });
}
if (searchSongsNextPageBtn) {
  searchSongsNextPageBtn.addEventListener("click", () => {
    searchSongsPageIndex += 1;
    renderInsightsSearchSongs();
  });
}

function applySearchSongFrequencyFilters() {
  searchSongFrequencyQuery = String(searchSongFrequencyInput && searchSongFrequencyInput.value || "");
  searchSongFrequencyExactMatch = Boolean(searchSongFrequencyExactMatchInput && searchSongFrequencyExactMatchInput.checked);
  searchSongFrequencyPageIndex = 0;
  renderSearchSongFrequency();
}

if (searchSongFrequencyInput) {
  searchSongFrequencyInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applySearchSongFrequencyFilters();
  });
}
if (searchSongFrequencyExactMatchInput) {
  searchSongFrequencyExactMatchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applySearchSongFrequencyFilters();
  });
}
if (searchSongFrequencyApplyBtn) {
  searchSongFrequencyApplyBtn.addEventListener("click", () => {
    applySearchSongFrequencyFilters();
  });
}
if (searchSongFrequencyPrevPageBtn) {
  searchSongFrequencyPrevPageBtn.addEventListener("click", () => {
    searchSongFrequencyPageIndex = Math.max(0, searchSongFrequencyPageIndex - 1);
    renderSearchSongFrequency();
  });
}
if (searchSongFrequencyNextPageBtn) {
  searchSongFrequencyNextPageBtn.addEventListener("click", () => {
    searchSongFrequencyPageIndex += 1;
    renderSearchSongFrequency();
  });
}

if (originalTourSearchInput) {
  originalTourSearchInput.addEventListener("input", event => {
    otherToolsCalendarSearchQuery = String(event.target.value || "");
    filterOriginalTourGames();
    renderOriginalTourCalendarView();
  });
}
if (originalTourPrevMonthBtn) {
  originalTourPrevMonthBtn.addEventListener("click", () => {
    if (!(otherToolsCalendarMonthCursor instanceof Date)) return;
    otherToolsCalendarMonthCursor = new Date(
      otherToolsCalendarMonthCursor.getFullYear(),
      otherToolsCalendarMonthCursor.getMonth() - 1,
      1
    );
    renderOriginalTourCalendarView();
  });
}
if (originalTourNextMonthBtn) {
  originalTourNextMonthBtn.addEventListener("click", () => {
    if (!(otherToolsCalendarMonthCursor instanceof Date)) return;
    otherToolsCalendarMonthCursor = new Date(
      otherToolsCalendarMonthCursor.getFullYear(),
      otherToolsCalendarMonthCursor.getMonth() + 1,
      1
    );
    renderOriginalTourCalendarView();
  });
}
if (originalTourSelectBtn) {
  originalTourSelectBtn.addEventListener("click", () => {
    otherToolsCalendarAppliedTimestamp = otherToolsCalendarSelectedTimestamp;
    renderOriginalTourCalendarView();
  });
}
if (originalTourColorModeSelect) {
  originalTourColorModeSelect.addEventListener("change", event => {
    const nextMode = String(event.target.value || "gradient");
    originalTourColorMode = nextMode === "extremes" ? "extremes" : "gradient";
    originalTourColorModeSelect.value = originalTourColorMode;
    renderOriginalTourRawDataTable();
  });
}

if (socialTeamSearchInput) {
  socialTeamSearchInput.addEventListener("input", event => {
    socialTeamSearchQuery = String(event.target.value || "");
    filterSocialTeamContributionGames();
    renderSocialTeamContributionView();
  });
}
if (socialTeamPrevMonthBtn) {
  socialTeamPrevMonthBtn.addEventListener("click", () => {
    if (!(socialTeamMonthCursor instanceof Date)) return;
    socialTeamMonthCursor = new Date(
      socialTeamMonthCursor.getFullYear(),
      socialTeamMonthCursor.getMonth() - 1,
      1
    );
    renderSocialTeamContributionView();
  });
}
if (socialTeamNextMonthBtn) {
  socialTeamNextMonthBtn.addEventListener("click", () => {
    if (!(socialTeamMonthCursor instanceof Date)) return;
    socialTeamMonthCursor = new Date(
      socialTeamMonthCursor.getFullYear(),
      socialTeamMonthCursor.getMonth() + 1,
      1
    );
    renderSocialTeamContributionView();
  });
}

window.addEventListener("resize", () => {
  updateOriginalTourRawStickyColumnOffsets();
  syncSocialRivalsBubbleHeight();
});
if (socialTeamSelectBtn) {
  socialTeamSelectBtn.addEventListener("click", () => {
    socialTeamAppliedTimestamp = socialTeamSelectedTimestamp;
    renderSocialTeamContributionView();
  });
}

function updateSocialTeamSelectButtonState() {
  if (!socialTeamSelectBtn) return;
  const hasSelected = Boolean(socialTeamSelectedTimestamp);
  const hasPendingSelection = socialTeamSelectedTimestamp !== socialTeamAppliedTimestamp;
  socialTeamSelectBtn.disabled = !hasSelected || !hasPendingSelection;
}

function updateSocialSynergySelectButtonState() {
  if (!socialSynergySelectBtn) return;
  const hasPendingSelection = Boolean(socialSynergySinglePendingRivalKey);
  const hasChangedSelection = socialSynergySinglePendingRivalKey !== socialSynergySingleSelectedRivalKey;
  socialSynergySelectBtn.disabled = !hasPendingSelection || !hasChangedSelection;
}

function updateByEraDataToggleLabel() {
  if (!byEraDataToggle) return;
  byEraDataToggle.innerText = byEraDataMode === "count"
    ? "Data: Count"
    : "Data: Percentage";
}

if (byEraDataToggle) {
  updateByEraDataToggleLabel();
  byEraDataToggle.addEventListener("click", () => {
    byEraDataMode = byEraDataMode === "count" ? "percentage" : "count";
    updateByEraDataToggleLabel();
    renderKnowledgeByEraDecadeChart();
  });
}

function updateByEraScaleToggleLabel() {
  if (!byEraScaleToggle) return;
  byEraScaleToggle.innerText = byEraScaleType === "linear"
    ? "Scaling: Linear"
    : "Scaling: Log";
}

if (byEraScaleToggle) {
  updateByEraScaleToggleLabel();
  byEraScaleToggle.addEventListener("click", () => {
    byEraScaleType = byEraScaleType === "linear" ? "logarithmic" : "linear";
    updateByEraScaleToggleLabel();
    renderKnowledgeByEraDecadeChart();
  });
}

function updateByEraSeasonDataToggleLabel() {
  if (!byEraSeasonDataToggle) return;
  byEraSeasonDataToggle.innerText = byEraSeasonDataMode === "count"
    ? "Data: Count"
    : "Data: Percentage";
}

if (byEraSeasonDataToggle) {
  updateByEraSeasonDataToggleLabel();
  byEraSeasonDataToggle.addEventListener("click", () => {
    byEraSeasonDataMode = byEraSeasonDataMode === "count" ? "percentage" : "count";
    updateByEraSeasonDataToggleLabel();
    renderByEraSeasonComparison();
  });
}

function updateOverviewDataToggleLabel() {
  if (!overviewDataToggle) return;
  overviewDataToggle.innerText = overviewDataMode === "count"
    ? "Data: Count"
    : "Data: Percentage";
}

if (overviewDataToggle) {
  updateOverviewDataToggleLabel();
  overviewDataToggle.addEventListener("click", () => {
    overviewDataMode = overviewDataMode === "count" ? "percentage" : "count";
    updateOverviewDataToggleLabel();
    renderOverviewAnimeTypeCharts();
    const performanceRows = getPerformanceRowsForActiveMode();
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Guess Rate" && performanceRows.length) {
      renderPerformanceGuessRate(getVisibleUserData(performanceRows));
    }
  });
}

function updateOverviewLanguageToggleUI() {
  if (overviewLanguageToggle) {
    const isJp = overviewLanguageMode === "jp";
    overviewLanguageToggle.classList.toggle("is-jp", isJp);
  }
  if (overviewLanguageEnBtn) {
    const isActive = overviewLanguageMode === "en";
    overviewLanguageEnBtn.classList.toggle("active", isActive);
    overviewLanguageEnBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  if (overviewLanguageJpBtn) {
    const isActive = overviewLanguageMode === "jp";
    overviewLanguageJpBtn.classList.toggle("active", isActive);
    overviewLanguageJpBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function getOverviewRowsForActiveMode() {
  if (overviewDataSourceMode === "usual" && Array.isArray(usualUserData) && usualUserData.length) {
    return usualUserData;
  }
  return Array.isArray(fullUserData) ? fullUserData : [];
}

function getPerformanceRowsForActiveMode() {
  if (overviewDataSourceMode === "usual" && Array.isArray(usualUserData) && usualUserData.length) {
    return usualUserData;
  }
  return Array.isArray(fullUserData) ? fullUserData : [];
}

function getOverviewRankMetaForActiveMode() {
  if (overviewDataSourceMode === "usual" && Array.isArray(usualUserData) && usualUserData.length) {
    return {
      rank: currentUsualLatestRankValue,
      percentile: currentUsualLatestRankPercentile,
      isTopThree: currentUsualLatestRankIsTopThree
    };
  }
  return {
    rank: currentLatestRankValue,
    percentile: currentLatestRankPercentile,
    isTopThree: currentLatestRankIsTopThree
  };
}

function renderOverviewForActiveMode() {
  const sourceRows = getOverviewRowsForActiveMode();
  if (!Array.isArray(sourceRows) || !sourceRows.length) {
    const rankEl = document.getElementById("rank");
    const guessEl = document.getElementById("guess");
    const foundEl = document.getElementById("foundGames");
    const slopeEl = document.getElementById("slopeInfo");
    const momentumEl = document.getElementById("overviewMomentum");
    const consistencyEl = document.getElementById("overviewConsistency");
    const typeMixEl = document.getElementById("overviewTypeMixBalance");
    const netLivesEl = document.getElementById("overviewNetLivesContribution");
    if (rankEl) rankEl.innerText = "-";
    if (guessEl) guessEl.innerText = "-";
    if (foundEl) foundEl.innerText = "Found 0 tours";
    if (slopeEl) slopeEl.innerText = "Slope: -";
    if (momentumEl) momentumEl.innerText = "N/A";
    if (consistencyEl) consistencyEl.innerText = "N/A";
    if (typeMixEl) typeMixEl.innerText = "N/A";
    if (netLivesEl) netLivesEl.innerText = "N/A";

    if (guessChart) {
      if (typeof guessChart.$trendZoomBrushCleanup === "function") {
        guessChart.$trendZoomBrushCleanup();
      }
      guessChart.destroy();
      guessChart = null;
    }

    applyCurrentRankCardStyle(null, false, "");
    return;
  }
  const visibleRecords = getVisibleUserData(sourceRows);
  const rankMeta = getOverviewRankMetaForActiveMode();
  renderOverview(
    visibleRecords,
    rankMeta.rank,
    rankMeta.percentile,
    rankMeta.isTopThree,
    sourceRows
  );
}

function getWeeklyStatsMapForActiveMode() {
  if (overviewDataSourceMode === "usual") {
    return allPlayerUsualWeeklyStatsData && typeof allPlayerUsualWeeklyStatsData === "object"
      ? allPlayerUsualWeeklyStatsData
      : {};
  }
  return allPlayerWeeklyStatsData && typeof allPlayerWeeklyStatsData === "object"
    ? allPlayerWeeklyStatsData
    : {};
}

function getLastWeekStatsMapForActiveMode() {
  if (overviewDataSourceMode === "usual") {
    return allPlayerUsualLastWeekStatsData && typeof allPlayerUsualLastWeekStatsData === "object"
      ? allPlayerUsualLastWeekStatsData
      : {};
  }
  return allPlayerLastWeekStatsData && typeof allPlayerLastWeekStatsData === "object"
    ? allPlayerLastWeekStatsData
    : {};
}

function normalizeTransitionCountsMap(payload) {
  if (!payload || typeof payload !== "object") return {};
  const source = payload.playerTransitionCounts;
  return source && typeof source === "object" ? source : {};
}

function getWeeklyTransitionCountsMapForActiveMode() {
  const modeKey = overviewDataSourceMode === "usual" ? "usual" : "watched";
  const map = weeklyPlayerTransitionCountsByMode[modeKey];
  return map && typeof map === "object" ? map : {};
}

function getLastWeekTransitionCountsMapForActiveMode() {
  const modeKey = overviewDataSourceMode === "usual" ? "usual" : "watched";
  const map = lastWeekPlayerTransitionCountsByMode[modeKey];
  return map && typeof map === "object" ? map : {};
}

function getTransitionCountsForIdentity(countsMap, identityKeys) {
  if (!countsMap || typeof countsMap !== "object") {
    return { songsRelearned: null, songsLearnedNew: null, songsForgotten: null };
  }
  for (const [playerKey, counts] of Object.entries(countsMap)) {
    if (!weeklyIdentitySetHas(identityKeys, String(playerKey || ""))) continue;
    return {
      songsRelearned: Number.parseInt(counts && counts.songsRelearned, 10) || 0,
      songsLearnedNew: Number.parseInt(
        counts && (counts.songsLearned ?? counts.songsLearnedNew),
        10
      ) || 0,
      songsForgotten: Number.parseInt(counts && counts.songsForgotten, 10) || 0
    };
  }
  return { songsRelearned: null, songsLearnedNew: null, songsForgotten: null };
}

function getWeeklyDateRangeLabelForActiveMode() {
  const modeKey = overviewDataSourceMode === "usual" ? "usual" : "watched";
  const dateRange = weeklyDateRangeByMode[modeKey];
  if (!dateRange || typeof dateRange !== "object") return "";
  const start = formatWeeklySubtitleDate(String(dateRange.start || "").trim());
  const end = formatWeeklySubtitleDate(String(dateRange.end || "").trim());
  if (!start && !end) return "";
  if (start && end) return `Data range: ${start} to ${end}`;
  return `Data range: ${start || end}`;
}

function getOrdinalDaySuffix(day) {
  const n = Number(day);
  if (!Number.isFinite(n)) return "";
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  const mod10 = n % 10;
  if (mod10 === 1) return "st";
  if (mod10 === 2) return "nd";
  if (mod10 === 3) return "rd";
  return "th";
}

function formatWeeklySubtitleDate(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";

  let date = null;
  const ymdMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const monthIndex = Number(ymdMatch[2]) - 1;
    const day = Number(ymdMatch[3]);
    date = new Date(Date.UTC(year, monthIndex, day));
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }

  if (!date || Number.isNaN(date.getTime())) return raw;

  const month = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  return `${month} ${day}${getOrdinalDaySuffix(day)}, ${year}`;
}

function updateOverviewWeeklyRangeSubtitle(showWeeklyPerformance) {
  const subtitleEl = document.getElementById("overviewWeeklyRangeSubtitle");
  if (!subtitleEl) return;
  if (!showWeeklyPerformance) {
    subtitleEl.style.setProperty("display", "none", "important");
    subtitleEl.textContent = "";
    return;
  }
  const rangeLabel = getWeeklyDateRangeLabelForActiveMode();
  subtitleEl.textContent = rangeLabel;
  subtitleEl.style.setProperty("display", rangeLabel ? "block" : "none", "important");
}

function normalizeWeeklyIdentityToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function weeklyIdentitySetHas(identityKeys, value) {
  if (!(identityKeys instanceof Set)) return false;
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized && identityKeys.has(normalized)) return true;
  const compact = normalizeWeeklyIdentityToken(value);
  return !!compact && identityKeys.has(compact);
}

function normalizeWeeklyIdentityKeys() {
  const keys = new Set();
  const add = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) keys.add(normalized);
    const compact = normalizeWeeklyIdentityToken(value);
    if (compact) keys.add(compact);
  };
  add(username);
  add(currentDisplayName);
  add(currentStatKey);
  if (Array.isArray(currentStatSourceKeys)) {
    currentStatSourceKeys.forEach(add);
  }
  return keys;
}

function averageMetricFromRows(rows, key) {
  const values = rows
    .map(row => Number.parseFloat(row && row[key]))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageSolosFromRows(rows) {
  const values = rows
    .map(row => {
      const erigs = Number.parseFloat(row && row.erigs);
      const offlistErigs = Number.parseFloat(row && row["Offlist erigs"]);
      if (!Number.isFinite(erigs)) return null;
      if (!Number.isFinite(offlistErigs)) return erigs;
      return erigs + offlistErigs;
    })
    .filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weeklySortByTimestampAsc(rows) {
  return [...rows].sort((a, b) => {
    const aTs = new Date(String(a && a.Timestamp || "")).getTime();
    const bTs = new Date(String(b && b.Timestamp || "")).getTime();
    if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return aTs - bTs;
    return 0;
  });
}

function rowMatchesWeeklyIdentity(row, identityKeys) {
  if (!row || typeof row !== "object" || !(identityKeys instanceof Set)) return false;
  const name = String(row["Player name"] || row.player || row.name || "").trim().toLowerCase();
  return !!name && weeklyIdentitySetHas(identityKeys, name);
}

function collectWeeklyRowsForIdentity(statsMap, identityKeys) {
  if (!statsMap || typeof statsMap !== "object") return [];
  const out = [];
  for (const [playerKey, rows] of Object.entries(statsMap)) {
    if (!Array.isArray(rows)) continue;
    const keyMatch = weeklyIdentitySetHas(identityKeys, playerKey);
    rows.forEach(row => {
      if (!row || typeof row !== "object") return;
      if (keyMatch || rowMatchesWeeklyIdentity(row, identityKeys)) out.push(row);
    });
  }
  return out;
}

function averageLastTwoUsefulness(rows) {
  const sortedRows = weeklySortByTimestampAsc(Array.isArray(rows) ? rows : []);
  const usefulnessValues = sortedRows
    .map(row => Number.parseFloat(row && row.Usefulness))
    .filter(Number.isFinite);
  if (usefulnessValues.length < 2) return null;
  const lastTwo = usefulnessValues.slice(-2);
  return (lastTwo[0] + lastTwo[1]) / 2;
}

function formatMetricWithDelta(currentValue, previousValue, decimals = 2, suffix = "", improveIsPositive = true) {
  if (!Number.isFinite(currentValue)) return "-";
  const currentText = `${currentValue.toFixed(decimals)}${suffix}`;
  if (!Number.isFinite(previousValue)) {
    return `${currentText} <span class="weekly-delta flat">(N/A)</span>`;
  }
  const delta = currentValue - previousValue;
  const absDelta = Math.abs(delta).toFixed(decimals);
  if (Math.abs(delta) < 1e-9) {
    return `${currentText} <span class="weekly-delta flat">(+${absDelta}${suffix})</span>`;
  }
  const isImprovement = improveIsPositive ? delta > 0 : delta < 0;
  const directionClass = isImprovement ? "up" : "down";
  const sign = delta > 0 ? "+" : "-";
  return `${currentText} <span class="weekly-delta ${directionClass}">(${sign}${absDelta}${suffix})</span>`;
}

function formatMetricWithHoverDelta(currentValue, previousValue, decimals = 2, suffix = "") {
  if (!Number.isFinite(currentValue)) return "-";
  const currentText = `${currentValue.toFixed(decimals)}${suffix}`;
  let deltaLabel = `<span class="weekly-delta flat">N/A</span>`;
  if (Number.isFinite(previousValue)) {
    const delta = currentValue - previousValue;
    const absDelta = Math.abs(delta).toFixed(decimals);
    if (Math.abs(delta) < 1e-9) {
      deltaLabel = `<span class="weekly-delta flat">+${absDelta}${suffix}</span>`;
    } else {
      const directionClass = delta > 0 ? "up" : "down";
      const sign = delta > 0 ? "+" : "-";
      deltaLabel = `<span class="weekly-delta ${directionClass}">${sign}${absDelta}${suffix}</span>`;
    }
  }
  return `<span class="weekly-hover-tooltip">${currentText}<span class="weekly-hover-tooltip-box">Delta: ${deltaLabel}</span></span>`;
}

function formatRankWithDelta(currentRank, totalPlayers, previousRank) {
  if (!Number.isFinite(currentRank) || !Number.isFinite(totalPlayers) || totalPlayers <= 0) return "-";
  const base = `#${currentRank}`;
  return base;
}

function getLastNumericMetric(rows, key) {
  const sortedRows = weeklySortByTimestampAsc(Array.isArray(rows) ? rows : []);
  for (let index = sortedRows.length - 1; index >= 0; index -= 1) {
    const value = Number.parseFloat(sortedRows[index] && sortedRows[index][key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function buildWeeklyEntry(playerKey, rows) {
  const validRows = Array.isArray(rows) ? rows.filter(row => row && typeof row === "object") : [];
  return {
    key: String(playerKey || ""),
    rows: validRows,
    games: validRows.length,
    lastTwoUsefulness: averageLastTwoUsefulness(validRows),
    avgUsefulness: averageMetricFromRows(validRows, "Usefulness"),
    avgGuess: averageMetricFromRows(validRows, "Guess rate"),
    avgOp: averageMetricFromRows(validRows, "OP guess rate"),
    avgEd: averageMetricFromRows(validRows, "ED guess rate"),
    avgIn: averageMetricFromRows(validRows, "IN guess rate"),
    avgTaken: averageMetricFromRows(validRows, "Lives taken"),
    avgSaved: averageMetricFromRows(validRows, "Lives saved"),
    avgSolos: averageSolosFromRows(validRows),
    lastGameRank: getLastNumericMetric(validRows, "Rank")
  };
}

function formatMvpDelta(deltaValue, decimals, suffix, improveIsPositive = true) {
  if (!Number.isFinite(deltaValue)) return `<span class="weekly-mvp-delta flat">N/A</span>`;
  if (Math.abs(deltaValue) < 1e-9) return `<span class="weekly-mvp-delta flat">+0${suffix}</span>`;
  const isPositive = deltaValue > 0;
  const displayClass = improveIsPositive
    ? (isPositive ? "up" : "down")
    : (isPositive ? "down" : "up");
  const sign = isPositive ? "+" : "-";
  const magnitude = Math.abs(deltaValue).toFixed(decimals);
  return `<span class="weekly-mvp-delta ${displayClass}">${sign}${magnitude}${suffix}</span>`;
}

function renderWeeklyMvpGrid(containerEl, weeklyByKey, lastWeekByKey, mode = "top") {
  if (!containerEl) return;
  const isBottomMode = mode === "bottom";
  const categories = [
    { label: "Usefulness", key: "avgUsefulness", decimals: 3, suffix: "", improveIsPositive: true },
    { label: "Rank", key: "lastGameRank", decimals: 3, suffix: "", improveIsPositive: true },
    { label: "Solos", key: "avgSolos", decimals: 2, suffix: "", improveIsPositive: true },
    { label: "Guess Rate", key: "avgGuess", decimals: 2, suffix: "%", improveIsPositive: true },
    { label: "OP Guess Rate", key: "avgOp", decimals: 2, suffix: "%", improveIsPositive: true },
    { label: "ED Guess Rate", key: "avgEd", decimals: 2, suffix: "%", improveIsPositive: true },
    { label: "IN Guess Rate", key: "avgIn", decimals: 2, suffix: "%", improveIsPositive: true },
    { label: "Lives Taken", key: "avgTaken", decimals: 2, suffix: "", improveIsPositive: true },
    { label: "Lives Saved", key: "avgSaved", decimals: 2, suffix: "", improveIsPositive: true },
    { label: "Games Played", key: "games", decimals: 0, suffix: "", improveIsPositive: true }
  ];

  const cardsHtml = categories.map((category, categoryIndex) => {
    const candidates = [];
    for (const [playerKey, currentEntry] of weeklyByKey.entries()) {
      if (!currentEntry) continue;
      const previousEntry = lastWeekByKey.get(playerKey);
      if (!previousEntry) continue;
      if (currentEntry.games < 2 || previousEntry.games < 2) continue;
      const currentValue = Number(currentEntry[category.key]);
      const previousValue = Number(previousEntry[category.key]);
      if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) continue;
      const delta = category.invertDelta
        ? (previousValue - currentValue)
        : (currentValue - previousValue);
      const currentUsefulness = Number(currentEntry.avgUsefulness);
      const previousUsefulness = Number(previousEntry.avgUsefulness);
      const usefulnessDelta = (Number.isFinite(currentUsefulness) && Number.isFinite(previousUsefulness))
        ? (currentUsefulness - previousUsefulness)
        : null;
      candidates.push({ playerKey, delta, currentValue, previousValue, usefulnessDelta });
    }

    candidates.sort((a, b) => {
      if (a.delta !== b.delta) return isBottomMode ? (a.delta - b.delta) : (b.delta - a.delta);
      const aUsefulnessDelta = Number(a.usefulnessDelta);
      const bUsefulnessDelta = Number(b.usefulnessDelta);
      const aHasUsefulnessDelta = Number.isFinite(aUsefulnessDelta);
      const bHasUsefulnessDelta = Number.isFinite(bUsefulnessDelta);
      if (aHasUsefulnessDelta && bHasUsefulnessDelta && aUsefulnessDelta !== bUsefulnessDelta) {
        return isBottomMode
          ? (aUsefulnessDelta - bUsefulnessDelta)
          : (bUsefulnessDelta - aUsefulnessDelta);
      }
      if (aHasUsefulnessDelta !== bHasUsefulnessDelta) {
        return aHasUsefulnessDelta ? -1 : 1;
      }
      return a.playerKey.localeCompare(b.playerKey);
    });
    const topThree = candidates.slice(0, 3);
    const categoryTitle = category.label;

    const rowsHtml = topThree.length
      ? topThree.map((item, index) => {
          const deltaHtml = formatMvpDelta(
            item.delta,
            category.decimals,
            category.suffix,
            category.improveIsPositive
          );
          const rankClass = `rank-${index + 1}`;
          return `<p class="weekly-mvp-row ${rankClass}"><span class="weekly-mvp-player-wrap">${index + 1}.&nbsp;<span class="weekly-mvp-player">${escapeHtml(item.playerKey)}</span></span>${deltaHtml}</p>`;
        }).join("")
      : `<p class="weekly-mvp-empty">Not enough data.</p>`;

    return `<div class="weekly-mvp-item mvp-item-${categoryIndex + 1}"><h4 class="weekly-mvp-title">${escapeHtml(categoryTitle)}</h4>${rowsHtml}</div>`;
  });

  const categoryHtml =
    cardsHtml.slice(0, 3).join("") +
    '<div class="weekly-mvp-hard-line line-1" aria-hidden="true"></div>' +
    cardsHtml.slice(3, 7).join("") +
    '<div class="weekly-mvp-hard-line line-2" aria-hidden="true"></div>' +
    cardsHtml.slice(7).join("");

  containerEl.innerHTML = categoryHtml;
}

function renderWeeklyPerformanceView() {
  const rankStripEl = document.getElementById("weeklyRankStrip");
  const usefulnessSolosGroupEl = document.getElementById("weeklyUsefulnessSolosGroupValue");
  const guessRateGroupEl = document.getElementById("weeklyGuessRateGroupValue");
  const livesGroupEl = document.getElementById("weeklyLivesGroupValue");
  const songTransitionGroupEl = document.getElementById("weeklySongTransitionGroupValue");
  const metaEl = document.getElementById("weeklyLeaderboardMeta");
  const bodyEl = document.getElementById("weeklyLeaderboardBody");
  const emptyEl = document.getElementById("weeklyPerformanceEmpty");
  const mvpGridEl = document.getElementById("weeklyMvpGrid");
  const reverseMvpGridEl = document.getElementById("weeklyReverseMvpGrid");
  if (
    !rankStripEl || !usefulnessSolosGroupEl || !guessRateGroupEl || !livesGroupEl || !songTransitionGroupEl
    || !metaEl || !bodyEl || !emptyEl || !mvpGridEl || !reverseMvpGridEl
  ) return;

  const weeklyMap = getWeeklyStatsMapForActiveMode();
  const lastWeekMap = getLastWeekStatsMapForActiveMode();
  const weeklyTransitionCountsMap = getWeeklyTransitionCountsMapForActiveMode();
  const lastWeekTransitionCountsMap = getLastWeekTransitionCountsMapForActiveMode();

  const weeklyEntries = Object.entries(weeklyMap).map(([playerKey, rows]) => buildWeeklyEntry(playerKey, rows));
  const lastWeekEntries = Object.entries(lastWeekMap).map(([playerKey, rows]) => buildWeeklyEntry(playerKey, rows));
  const weeklyByKey = new Map(weeklyEntries.map(entry => [entry.key, entry]));
  const lastWeekByKey = new Map(lastWeekEntries.map(entry => [entry.key, entry]));

  const leaderboard = weeklyEntries
    .filter(entry => entry.games >= 2 && Number.isFinite(entry.lastTwoUsefulness))
    .sort((a, b) => {
      if (b.lastTwoUsefulness !== a.lastTwoUsefulness) return b.lastTwoUsefulness - a.lastTwoUsefulness;
      if (b.games !== a.games) return b.games - a.games;
      return a.key.localeCompare(b.key);
    });

  const lastWeekLeaderboard = lastWeekEntries
    .filter(entry => entry.games >= 2 && Number.isFinite(entry.lastTwoUsefulness))
    .sort((a, b) => {
      if (b.lastTwoUsefulness !== a.lastTwoUsefulness) return b.lastTwoUsefulness - a.lastTwoUsefulness;
      if (b.games !== a.games) return b.games - a.games;
      return a.key.localeCompare(b.key);
    });

  metaEl.innerText = "";
  if (!leaderboard.length) {
    rankStripEl.innerHTML = '<span class="rank-item"><span class="rank-main">Rank: -</span><span class="rank-sub">Out of 0 players</span></span>';
    usefulnessSolosGroupEl.innerHTML = '<p class="card-line">Usefulness: -</p><p class="card-line">Solos: -</p>';
    guessRateGroupEl.innerHTML = '<p class="card-line">Overall: -</p><p class="card-line">OP: - | ED: - | IN: -</p>';
    livesGroupEl.innerHTML = '<p class="card-line">Taken: -</p><p class="card-line">Saved: -</p>';
    songTransitionGroupEl.innerHTML = '<p class="card-line">Learned/New: -</p><p class="card-line">Relearned: - &nbsp;&nbsp; Forgotten: -</p>';
    bodyEl.innerHTML = "";
    mvpGridEl.innerHTML = '<div class="weekly-mvp-item"><p class="weekly-mvp-empty">No weekly data available.</p></div>';
    reverseMvpGridEl.innerHTML = '<div class="weekly-mvp-item"><p class="weekly-mvp-empty">No weekly data available.</p></div>';
    emptyEl.style.display = "block";
    return;
  }

  const identityKeys = normalizeWeeklyIdentityKeys();
  const playerRows = collectWeeklyRowsForIdentity(weeklyMap, identityKeys);
  const playerLastWeekRows = collectWeeklyRowsForIdentity(lastWeekMap, identityKeys);
  const playerAvgGuess = averageMetricFromRows(playerRows, "Guess rate");
  const playerAvgUsefulness = averageMetricFromRows(playerRows, "Usefulness");
  const playerAvgOpGr = averageMetricFromRows(playerRows, "OP guess rate");
  const playerAvgEdGr = averageMetricFromRows(playerRows, "ED guess rate");
  const playerAvgInGr = averageMetricFromRows(playerRows, "IN guess rate");
  const playerAvgLivesTaken = averageMetricFromRows(playerRows, "Lives taken");
  const playerAvgLivesSaved = averageMetricFromRows(playerRows, "Lives saved");
  const playerAvgSolos = averageSolosFromRows(playerRows);

  const playerPrevAvgGuess = averageMetricFromRows(playerLastWeekRows, "Guess rate");
  const playerPrevAvgUsefulness = averageMetricFromRows(playerLastWeekRows, "Usefulness");
  const playerPrevAvgOpGr = averageMetricFromRows(playerLastWeekRows, "OP guess rate");
  const playerPrevAvgEdGr = averageMetricFromRows(playerLastWeekRows, "ED guess rate");
  const playerPrevAvgInGr = averageMetricFromRows(playerLastWeekRows, "IN guess rate");
  const playerPrevAvgLivesTaken = averageMetricFromRows(playerLastWeekRows, "Lives taken");
  const playerPrevAvgLivesSaved = averageMetricFromRows(playerLastWeekRows, "Lives saved");
  const playerPrevAvgSolos = averageSolosFromRows(playerLastWeekRows);
  const playerTransitionCounts = getTransitionCountsForIdentity(weeklyTransitionCountsMap, identityKeys);
  const playerLastWeekTransitionCounts = getTransitionCountsForIdentity(lastWeekTransitionCountsMap, identityKeys);

  const isCurrentEntry = (entry) => {
    if (weeklyIdentitySetHas(identityKeys, String(entry && entry.key || ""))) return true;
    if (!entry || !Array.isArray(entry.rows)) return false;
    return entry.rows.some(row => rowMatchesWeeklyIdentity(row, identityKeys));
  };
  const currentEntry = leaderboard.find(isCurrentEntry);
  const playerRank = currentEntry
    ? (leaderboard.findIndex(entry => entry.key === currentEntry.key) + 1)
    : null;
  const previousEntry = lastWeekLeaderboard.find(isCurrentEntry);
  const previousRank = previousEntry
    ? (lastWeekLeaderboard.findIndex(entry => entry.key === previousEntry.key) + 1)
    : null;

  const usefulnessText = formatMetricWithDelta(playerAvgUsefulness, playerPrevAvgUsefulness, 3, "");
  const solosText = formatMetricWithDelta(playerAvgSolos, playerPrevAvgSolos, 2, "");
  const overallGuessText = formatMetricWithDelta(playerAvgGuess, playerPrevAvgGuess, 2, "%");
  const opGuessText = formatMetricWithHoverDelta(playerAvgOpGr, playerPrevAvgOpGr, 2, "%");
  const edGuessText = formatMetricWithHoverDelta(playerAvgEdGr, playerPrevAvgEdGr, 2, "%");
  const inGuessText = formatMetricWithHoverDelta(playerAvgInGr, playerPrevAvgInGr, 2, "%");
  const livesTakenText = formatMetricWithDelta(playerAvgLivesTaken, playerPrevAvgLivesTaken, 2, "");
  const livesSavedText = formatMetricWithDelta(playerAvgLivesSaved, playerPrevAvgLivesSaved, 2, "");
  const rankText = formatRankWithDelta(playerRank, leaderboard.length, previousRank);
  const songsRelearnedText = formatMetricWithDelta(
    playerTransitionCounts.songsRelearned,
    playerLastWeekTransitionCounts.songsRelearned,
    0,
    ""
  );
  const songsLearnedNewText = formatMetricWithDelta(
    playerTransitionCounts.songsLearnedNew,
    playerLastWeekTransitionCounts.songsLearnedNew,
    0,
    ""
  );
  const songsForgottenText = formatMetricWithDelta(
    playerTransitionCounts.songsForgotten,
    playerLastWeekTransitionCounts.songsForgotten,
    0,
    "",
    false
  );

  rankStripEl.innerHTML = `<span class="rank-item"><span class="rank-main">Rank: ${rankText}</span><span class="rank-sub">Out of ${leaderboard.length} players</span></span>`;
  usefulnessSolosGroupEl.innerHTML = `<p class="card-line">Usefulness: ${usefulnessText}</p><p class="card-line">Solos: ${solosText}</p>`;
  guessRateGroupEl.innerHTML = `<p class="card-line">Overall: ${overallGuessText}</p><p class="card-line">OP: ${opGuessText} | ED: ${edGuessText} | IN: ${inGuessText}</p>`;
  livesGroupEl.innerHTML = `<p class="card-line">Taken: ${livesTakenText}</p><p class="card-line">Saved: ${livesSavedText}</p>`;
  songTransitionGroupEl.innerHTML = `<p class="card-line">Learned/New: ${songsLearnedNewText}</p><p class="card-line">Relearned: ${songsRelearnedText} &nbsp;&nbsp; Forgotten: ${songsForgottenText}</p>`;

  const topRows = leaderboard.slice(0, 10);
  const hasCurrentInTopRows = topRows.some(isCurrentEntry);
  let rowsToRender = topRows;
  if (!hasCurrentInTopRows && currentEntry) {
    rowsToRender = [...rowsToRender, currentEntry];
  }

  bodyEl.innerHTML = rowsToRender.map(entry => {
    const rank = leaderboard.findIndex(item => item.key === entry.key) + 1;
    const rowClass = isCurrentEntry(entry) ? "current-player-row" : "";
    const actualRankText = Number.isFinite(entry.lastGameRank) ? entry.lastGameRank.toFixed(3) : "-";
    return `<tr class="${rowClass}">
      <td>${rank}</td>
      <td>${escapeHtml(entry.key)}</td>
      <td>${actualRankText}</td>
      <td>${entry.lastTwoUsefulness.toFixed(3)}</td>
      <td>${Number.isFinite(entry.avgGuess) ? `${entry.avgGuess.toFixed(2)}%` : "-"}</td>
      <td>${entry.games}</td>
    </tr>`;
  }).join("");
  emptyEl.style.display = "none";
  renderWeeklyMvpGrid(mvpGridEl, weeklyByKey, lastWeekByKey, "top");
  renderWeeklyMvpGrid(reverseMvpGridEl, weeklyByKey, lastWeekByKey, "bottom");
}

function updateOverviewDataSourceToggleUI() {
  if (overviewDataSourceToggle) {
    const isUsual = overviewDataSourceMode === "usual";
    overviewDataSourceToggle.classList.toggle("is-usual", isUsual);
  }
  if (overviewDataSourceWatchedBtn) {
    const isActive = overviewDataSourceMode === "watched";
    overviewDataSourceWatchedBtn.classList.toggle("active", isActive);
    overviewDataSourceWatchedBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
    overviewDataSourceWatchedBtn.disabled = isTourTypeToggleLocked;
    overviewDataSourceWatchedBtn.setAttribute("aria-disabled", isTourTypeToggleLocked ? "true" : "false");
  }
  if (overviewDataSourceUsualBtn) {
    const isActive = overviewDataSourceMode === "usual";
    overviewDataSourceUsualBtn.classList.toggle("active", isActive);
    overviewDataSourceUsualBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
    overviewDataSourceUsualBtn.disabled = isTourTypeToggleLocked;
    overviewDataSourceUsualBtn.setAttribute("aria-disabled", isTourTypeToggleLocked ? "true" : "false");
  }
}

function refreshOverviewModeScopedCards(displayName) {
  const resolvedName = String(displayName || currentDisplayName || "").trim();
  if (!resolvedName) return;

  loadOverviewTopSolosForUser(resolvedName);
  loadOverviewTopRigSongsForUser(resolvedName);
  loadOverviewTopDoublesForUser(resolvedName, { kind: "general" });
  loadOverviewTopDoublesForUser(resolvedName, { kind: "their_rig_you_blocked" });
  loadOverviewTopDoublesForUser(resolvedName, { kind: "your_rig_they_blocked" });

  if (overviewActiveView === "statsSummary") {
    loadOverviewAnimeTypeDataForUser(resolvedName);
    loadOverviewZScoreDataForUser(resolvedName);
    loadGenreDataForUser(resolvedName);
    loadTagDataForUser(resolvedName);
    loadByEraDataForUser(resolvedName);
    loadArtistDataForUser(resolvedName);
  }
}

if (overviewLanguageEnBtn && overviewLanguageJpBtn) {
  updateOverviewLanguageToggleUI();
  overviewLanguageEnBtn.addEventListener("click", () => {
    if (overviewLanguageMode === "en") return;
    overviewLanguageMode = "en";
    updateOverviewLanguageToggleUI();
    scheduleLanguageRerender();
  });
  overviewLanguageJpBtn.addEventListener("click", () => {
    if (overviewLanguageMode === "jp") return;
    overviewLanguageMode = "jp";
    updateOverviewLanguageToggleUI();
    scheduleLanguageRerender();
  });
}

if (overviewDataSourceWatchedBtn && overviewDataSourceUsualBtn) {
  updateOverviewDataSourceToggleUI();
  overviewDataSourceWatchedBtn.addEventListener("click", () => {
    if (isTourTypeToggleLocked) return;
    if (overviewDataSourceMode === "watched") return;
    overviewDataSourceMode = "watched";
    updateOverviewDataSourceToggleUI();
    refreshOverviewModeScopedCards(currentDisplayName);
    renderOverviewForActiveMode();
    if (activeSection === "overview" && overviewActiveView === "weekly") {
      renderWeeklyPerformanceView();
    }
    const performanceRows = getPerformanceRowsForActiveMode();
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Guess Rate" && performanceRows.length) {
      renderPerformanceGuessRate(getVisibleUserData(performanceRows));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Lives Taken / Saved" && performanceRows.length) {
      renderPerformanceLivesTakenSaved(getVisibleUserData(performanceRows));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Rigs Missed") {
      renderPerformanceRigsMissed(getVisibleUserData(fullUserData));
    }
    if (activeSection === "social") {
      scheduleSocialSubSectionRender(activeSubSectionBySection.social || "");
    }
    if (activeSection === "knowledge") {
      loadKnowledgeDataForSubSection(activeSubSectionBySection.knowledge || "", currentDisplayName || currentStatKey || "");
    }
    if (activeSection === "insights") {
      scheduleInsightsSubSectionLoad(activeSubSectionBySection.insights || "", currentDisplayName || currentStatKey || "");
    }
    if (activeSection === "otherTools" && activeSubSectionBySection.otherTools === "Search songs") {
      loadSearchSongsDataForUser(currentDisplayName || currentStatKey || "");
    }
    if (activeSection === "otherTools" && activeSubSectionBySection.otherTools === "Search song frequency") {
      ensureSearchSongFrequencyData();
      renderSearchSongFrequency();
    }
    if (activeSection === "otherTools" && activeSubSectionBySection.otherTools === "Original Tour data(Calendar)") {
      ensureOriginalTourCalendarData();
      renderOriginalTourCalendarView();
    }
  });
  overviewDataSourceUsualBtn.addEventListener("click", () => {
    if (isTourTypeToggleLocked) return;
    if (overviewDataSourceMode === "usual") return;
    overviewDataSourceMode = "usual";
    updateOverviewDataSourceToggleUI();
    refreshOverviewModeScopedCards(currentDisplayName);
    renderOverviewForActiveMode();
    if (activeSection === "overview" && overviewActiveView === "weekly") {
      renderWeeklyPerformanceView();
    }
    const performanceRows = getPerformanceRowsForActiveMode();
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Guess Rate" && performanceRows.length) {
      renderPerformanceGuessRate(getVisibleUserData(performanceRows));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Lives Taken / Saved" && performanceRows.length) {
      renderPerformanceLivesTakenSaved(getVisibleUserData(performanceRows));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Rigs Missed") {
      renderPerformanceRigsMissed(getVisibleUserData(fullUserData));
    }
    if (activeSection === "social") {
      scheduleSocialSubSectionRender(activeSubSectionBySection.social || "");
    }
    if (activeSection === "knowledge") {
      loadKnowledgeDataForSubSection(activeSubSectionBySection.knowledge || "", currentDisplayName || currentStatKey || "");
    }
    if (activeSection === "insights") {
      scheduleInsightsSubSectionLoad(activeSubSectionBySection.insights || "", currentDisplayName || currentStatKey || "");
    }
    if (activeSection === "otherTools" && activeSubSectionBySection.otherTools === "Search songs") {
      loadSearchSongsDataForUser(currentDisplayName || currentStatKey || "");
    }
    if (activeSection === "otherTools" && activeSubSectionBySection.otherTools === "Search song frequency") {
      ensureSearchSongFrequencyData();
      renderSearchSongFrequency();
    }
    if (activeSection === "otherTools" && activeSubSectionBySection.otherTools === "Original Tour data(Calendar)") {
      ensureOriginalTourCalendarData();
      renderOriginalTourCalendarView();
    }
  });
}

function updateOverviewTopDoublesTypeToggleUI() {
  const buttons = [
    overviewTopDoublesTypeGeneralBtn,
    overviewTopDoublesTypeTheirRigBtn,
    overviewTopDoublesTypeYourRigBtn
  ];
  buttons.forEach(button => {
    if (!button) return;
    const mode = String(button.dataset.mode || "");
    const isActive = mode === overviewTopDoublesMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

if (overviewTopDoublesTypeToggle) {
  updateOverviewTopDoublesTypeToggleUI();
  overviewTopDoublesTypeToggle.addEventListener("click", event => {
    const button = event.target instanceof HTMLElement
      ? event.target.closest(".overview-top-doubles-type-btn")
      : null;
    if (!button) return;
    const nextMode = String(button.dataset.mode || "");
    if (!nextMode || nextMode === overviewTopDoublesMode) return;
    overviewTopDoublesMode = nextMode;
    updateOverviewTopDoublesTypeToggleUI();
    renderOverviewTopDoubles();
  });
}

function parseSeasonLabel(label) {
  const match = String(label || "").trim().match(/^(Winter|Spring|Summer|Fall)\s+(\d{1,4})$/i);
  if (!match) {
    return { year: Number.POSITIVE_INFINITY, seasonIndex: Number.POSITIVE_INFINITY };
  }
  const seasonName = match[1].toLowerCase();
  const year = Number(match[2]);
  const seasonIndexByName = { winter: 0, spring: 1, summer: 2, fall: 3 };
  return {
    year: Number.isFinite(year) ? year : Number.POSITIVE_INFINITY,
    seasonIndex: seasonIndexByName[seasonName] ?? Number.POSITIVE_INFINITY
  };
}

function compareSeasonLabels(aLabel, bLabel) {
  const a = parseSeasonLabel(aLabel);
  const b = parseSeasonLabel(bLabel);
  if (a.year !== b.year) return a.year - b.year;
  if (a.seasonIndex !== b.seasonIndex) return a.seasonIndex - b.seasonIndex;
  return String(aLabel).localeCompare(String(bLabel));
}

function compareSeasonGroupLabels(aLabel, bLabel) {
  const a = parseSeasonLabel(aLabel);
  const b = parseSeasonLabel(bLabel);
  if (a.seasonIndex !== b.seasonIndex) return a.seasonIndex - b.seasonIndex;
  if (a.year !== b.year) return a.year - b.year;
  return String(aLabel).localeCompare(String(bLabel));
}

function getLanguageAwareAnimeName(song) {
  const english = String(song && (song.animeName || song.anime) ? (song.animeName || song.anime) : "").trim();
  const romaji = String(song && song.animeRomaji ? song.animeRomaji : "").trim();
  if (overviewLanguageMode === "jp") {
    return romaji || english || "—";
  }
  return english || romaji || "—";
}

function rerenderRecommendationsForLanguage() {
  if (activeSection === "overview") {
    if (overviewActiveView === "overview") {
      renderOverviewTopSolos();
      renderOverviewTopDoubles();
      renderOverviewTopRigSongs();
    }
    return;
  }

  if (activeSection === "insights") {
    const activeSubSection = activeSubSectionBySection.insights || "";
    if (activeSubSection === "Relearn Tracker") {
      rerenderInsightsRelearnTrackerLanguageOnly();
      return;
    }
    if (activeSubSection === "By never correct") {
      rerenderInsightsNeverCorrectLanguageOnly();
      return;
    }
    if (activeSubSection === "By Wrong Guess") {
      rerenderInsightsWrongGuessLanguageOnly();
      return;
    }
    if (activeSubSection === "By Popularity") {
      rerenderInsightsPopularityLanguageOnly();
      return;
    }
    if (activeSubSection === "By % correct") {
      rerenderInsightsPCorrectLanguageOnly();
      return;
    }
    return;
  }

  if (activeSection === "otherTools") {
    const activeSubSection = activeSubSectionBySection.otherTools || "";
    if (activeSubSection === "Search songs") {
      rerenderInsightsSearchSongsLanguageOnly();
      return;
    }
    if (activeSubSection === "Search song frequency") {
      renderSearchSongFrequency();
      return;
    }
  }

  if (activeSection === "knowledge") {
    const activeSubSection = activeSubSectionBySection.knowledge || "";
    if (activeSubSection === "Artist Familiarity") {
      renderArtistFamiliarityView();
    }
    return;
  }

  if (activeSection === "social") {
    const activeSubSection = activeSubSectionBySection.social || "";
    if (activeSubSection === "Synergy") {
      renderSocialSynergySinglePicker(cachedSocialSynergyRows, currentDisplayName || currentStatKey || "You");
      renderSocialSynergyRigTables();
    }
  }
}

function rerenderInsightsRelearnTrackerLanguageOnly() {
  const tbody = document.getElementById("relearnSongsTableBody");
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll("tr"));
  if (!rows.length) {
    renderInsightsRelearnTracker();
    return;
  }

  const songs = getFilteredRelearnSongs();
  const start = relearnPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);
  if (!pageSongs.length || rows.length !== pageSongs.length) {
    renderInsightsRelearnTracker();
    return;
  }

  rows.forEach((row, index) => {
    const animeCell = row.children[1];
    if (!animeCell) return;
    animeCell.innerText = getLanguageAwareAnimeName(pageSongs[index]);
  });
}

function rerenderTableAnimeColumnLanguageOnly({
  tbodyId,
  fallbackRender,
  pageSongs,
  animeColumnIndex
}) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll("tr"));
  if (!rows.length || !Array.isArray(pageSongs) || !pageSongs.length || rows.length !== pageSongs.length) {
    fallbackRender();
    return;
  }

  rows.forEach((row, index) => {
    const animeCell = row.children[animeColumnIndex];
    if (!animeCell) return;
    animeCell.innerText = getLanguageAwareAnimeName(pageSongs[index]);
  });
}

function rerenderInsightsWrongGuessLanguageOnly() {
  const songs = Array.isArray(cachedWrongGuessSongs) ? cachedWrongGuessSongs : [];
  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  const normalizedPageIndex = Math.min(Math.max(0, wrongGuessPageIndex), pageCount - 1);
  const start = normalizedPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);

  rerenderTableAnimeColumnLanguageOnly({
    tbodyId: "wrongGuessSongsTableBody",
    fallbackRender: renderInsightsWrongGuess,
    pageSongs,
    animeColumnIndex: 2
  });
}

function rerenderInsightsNeverCorrectLanguageOnly() {
  const songs = Array.isArray(cachedNeverCorrectSongs) ? cachedNeverCorrectSongs : [];
  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  const normalizedPageIndex = Math.min(Math.max(0, neverCorrectPageIndex), pageCount - 1);
  const start = normalizedPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);

  rerenderTableAnimeColumnLanguageOnly({
    tbodyId: "neverCorrectSongsTableBody",
    fallbackRender: renderInsightsNeverCorrect,
    pageSongs,
    animeColumnIndex: 2
  });
}

function rerenderInsightsPopularityLanguageOnly() {
  const songs = Array.isArray(cachedPopularitySongs) ? cachedPopularitySongs : [];
  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  const normalizedPageIndex = Math.min(Math.max(0, popularityPageIndex), pageCount - 1);
  const start = normalizedPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);

  rerenderTableAnimeColumnLanguageOnly({
    tbodyId: "popularitySongsTableBody",
    fallbackRender: renderInsightsPopularity,
    pageSongs,
    animeColumnIndex: 2
  });
}

function rerenderInsightsPCorrectLanguageOnly() {
  const songs = Array.isArray(cachedPCorrectSongs) ? cachedPCorrectSongs : [];
  const eligibleSongs = songs.filter(song => {
    const attempts = Number(song && song.attempts);
    return Number.isFinite(attempts) && attempts >= 8;
  });
  const pageCount = Math.max(1, Math.ceil(eligibleSongs.length / RELEARN_PAGE_SIZE));
  const normalizedPageIndex = Math.min(Math.max(0, pcorrectPageIndex), pageCount - 1);
  const start = normalizedPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = eligibleSongs.slice(start, end);

  rerenderTableAnimeColumnLanguageOnly({
    tbodyId: "pcorrectSongsTableBody",
    fallbackRender: renderInsightsPCorrect,
    pageSongs,
    animeColumnIndex: 2
  });
}

function getFilteredSearchSongsRows() {
  const songs = Array.isArray(cachedSearchSongs) ? cachedSearchSongs : [];
  const normalizedQuery = String(searchSongsQuery || "").trim().toLowerCase();
  const normalizedQueryCompact = normalizeSearchSongText(normalizedQuery);
  const rawMode = String(searchSongsMode || "all").toLowerCase();
  const activeMode = rawMode === "off" ? "all" : rawMode;

  if (!normalizedQuery) return songs;

  return songs.filter(song => {
    const candidates = getSearchSongCandidatesByMode(song, activeMode);
    const compactCandidates = candidates.map(value => normalizeSearchSongText(value));
    if (searchSongsExactMatch) {
      return candidates.some(value => value === normalizedQuery)
        || compactCandidates.some(value => value === normalizedQueryCompact);
    }
    return candidates.some(value => value.includes(normalizedQuery))
      || compactCandidates.some(value => value.includes(normalizedQueryCompact));
  });
}

function rerenderInsightsSearchSongsLanguageOnly() {
  renderInsightsSearchSongs();
}

function scheduleLanguageRerender() {
  overviewLanguageRerenderHandle = null;
  rerenderRecommendationsForLanguage();
}

function getByEraSeasonEntries() {
  if (!cachedByEraData || !Array.isArray(cachedByEraData.seasonals)) return [];
  return cachedByEraData.seasonals
    .filter(item => item && typeof item.label === "string")
    .map(item => ({
      label: item.label,
      correct: Number(item.correct || 0),
      wrong: Number(item.wrong || 0),
      count: Number(item.count || 0),
      correctPct: Number(item.correctPct || 0)
    }));
}

function renderByEraSeasonSelectionMeta() {
  const meta = document.getElementById("byEraSeasonSelectionMeta");
  if (!meta) return;
  const selectedCount = selectedByEraSeasonLabels.length;
  meta.innerText = selectedCount >= MAX_SELECTED_BY_ERA_SEASONS
    ? `Selected ${selectedCount} seasons (maximum)`
    : `Selected ${selectedCount} seasons`;
}

function renderByEraSelectedSeasonButtons() {
  const wrap = document.getElementById("byEraSelectedSeasonsInline");
  if (!wrap) return;

  if (!selectedByEraSeasonLabels.length) {
    wrap.innerHTML = '<div class="by-era-season-empty">No selected seasons</div>';
    return;
  }

  wrap.innerHTML = "";
  selectedByEraSeasonLabels.forEach(labelText => {
    const chip = document.createElement("div");
    chip.className = "by-era-selected-season-chip";

    const text = document.createElement("span");
    text.innerText = labelText;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "by-era-selected-season-remove";
    removeBtn.innerText = "−";
    removeBtn.title = `Deselect ${labelText}`;
    removeBtn.addEventListener("click", () => {
      selectedByEraSeasonLabels = selectedByEraSeasonLabels.filter(label => label !== labelText);
      const checkboxWrap = document.getElementById("byEraSeasonCheckboxList");
      if (checkboxWrap) {
        checkboxWrap.querySelectorAll('input[type="checkbox"]').forEach(input => {
          if (input.value === labelText) {
            input.checked = false;
          }
        });
      }
      drawByEraSeasonComparisonChart();
      renderByEraSeasonSelectionMeta();
      renderByEraSelectedSeasonButtons();
    });

    chip.appendChild(text);
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

function renderByEraSeasonComparison() {
  const checkboxWrap = document.getElementById("byEraSeasonCheckboxList");
  if (!checkboxWrap) return;

  const seasonEntries = getByEraSeasonEntries();
  const seasonEntriesChrono = [...seasonEntries].sort((a, b) => compareSeasonLabels(a.label, b.label));
  const seasonEntriesGrouped = [...seasonEntries].sort((a, b) => compareSeasonGroupLabels(a.label, b.label));
  selectedByEraSeasonLabels = selectedByEraSeasonLabels.filter(label => seasonEntries.some(entry => entry.label === label));
  if (!selectedByEraSeasonLabels.length && seasonEntriesChrono.length) {
    selectedByEraSeasonLabels = seasonEntriesChrono.slice(-MAX_SELECTED_BY_ERA_SEASONS).map(entry => entry.label);
  }
  selectedByEraSeasonLabels.sort(compareSeasonLabels);

  const normalizedSearch = String(byEraSeasonSearchQuery || "").trim().toLowerCase();
  const visibleEntries = normalizedSearch
    ? seasonEntriesGrouped.filter(entry => entry.label.toLowerCase().includes(normalizedSearch))
    : seasonEntriesGrouped;

  checkboxWrap.innerHTML = "";
  visibleEntries.forEach(entry => {
    const label = document.createElement("label");
    label.className = "by-era-season-checkbox-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = entry.label;
    input.checked = selectedByEraSeasonLabels.includes(entry.label);

    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${entry.label}`));
    checkboxWrap.appendChild(label);
  });

  if (!visibleEntries.length) {
    checkboxWrap.innerHTML = '<div class="by-era-season-empty">No seasons match your search.</div>';
  }

  checkboxWrap.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener("change", event => {
      const changedLabel = String(event.target.value || "");
      const isChecked = Boolean(event.target.checked);

      if (isChecked) {
        if (selectedByEraSeasonLabels.includes(changedLabel)) return;
        if (selectedByEraSeasonLabels.length >= MAX_SELECTED_BY_ERA_SEASONS) {
          event.target.checked = false;
          return;
        }
        selectedByEraSeasonLabels = [...selectedByEraSeasonLabels, changedLabel];
        selectedByEraSeasonLabels.sort(compareSeasonLabels);
      } else {
        selectedByEraSeasonLabels = selectedByEraSeasonLabels.filter(label => label !== changedLabel);
        selectedByEraSeasonLabels.sort(compareSeasonLabels);
      }

      drawByEraSeasonComparisonChart();
      renderByEraSeasonSelectionMeta();
      renderByEraSelectedSeasonButtons();
    });
  });

  drawByEraSeasonComparisonChart();
  renderByEraSeasonSelectionMeta();
  renderByEraSelectedSeasonButtons();
}

function drawByEraSeasonComparisonChart() {
  if (byEraSeasonCompareChart) {
    byEraSeasonCompareChart.destroy();
    byEraSeasonCompareChart = null;
  }

  const seasonEntries = getByEraSeasonEntries();
  const selectedEntries = selectedByEraSeasonLabels
    .map(label => seasonEntries.find(entry => entry.label === label))
    .filter(Boolean)
    .sort((a, b) => compareSeasonLabels(a.label, b.label));

  if (!selectedEntries.length) return;

  const seasonLabels = selectedEntries.map(entry => entry.label);
  const isPercentageMode = byEraSeasonDataMode === "percentage";

  const correctData = selectedEntries.map(entry => entry.correct);
  const wrongData = selectedEntries.map(entry => entry.wrong);
  const totalData = selectedEntries.map(entry => entry.count);
  const maxTotal = totalData.length ? Math.max(...totalData) : 0;
  const linearTargetTickCount = 6;
  const rawLinearStep = maxTotal > 0 ? maxTotal / linearTargetTickCount : 5;
  const linearStep = Math.max(5, Math.ceil(rawLinearStep / 5) * 5);
  const linearMax = Math.max(linearStep, Math.ceil(maxTotal / linearStep) * linearStep);

  byEraSeasonCompareChart = new Chart(document.getElementById("byEraSeasonCompareChart"), {
    type: "bar",
    data: {
      labels: seasonLabels,
      datasets: [
        {
          label: "Right",
          data: correctData,
          stack: "seasonTotals",
          backgroundColor: "rgba(34, 197, 94, 0.62)",
          borderColor: "#16a34a",
          borderWidth: 1.4,
          borderRadius: 5
        },
        {
          label: "Wrong",
          data: wrongData,
          stack: "seasonTotals",
          hidden: true,
          backgroundColor: "rgba(239, 68, 68, 0.62)",
          borderColor: "#dc2626",
          borderWidth: 1.4,
          borderRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#333",
            font: { size: 12 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const raw = Number(context.raw || 0);
              if (!isPercentageMode) {
                return `${context.dataset.label}: ${Math.round(raw)}`;
              }
              const index = Number(context.dataIndex || 0);
              const total = Number(totalData[index] || 0);
              const pct = total > 0 ? (raw / total) * 100 : 0;
              return `${context.dataset.label}: ${pct.toFixed(2)}%`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            color: "#555",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: false
          },
          grid: { color: "#e5e7eb" }
        },
        y: {
          type: "linear",
          stacked: true,
          beginAtZero: true,
          min: 0,
          max: linearMax,
          title: {
            display: true,
            text: "Entries",
            color: "#333",
            font: { size: 13, weight: "bold" }
          },
          ticks: {
            color: "#555",
            stepSize: linearStep,
            precision: 0
          },
          grid: {
            color: "#e5e7eb"
          }
        }
      }
    }
  });

  syncByEraSeasonControlsToZeroAxis();
}

let byEraSeasonControlsResizeBound = false;
function syncByEraSeasonControlsToZeroAxis() {
  const controlsPane = document.querySelector("#knowledgeByEraView .by-era-season-controls-pane");
  const chartWrap = document.querySelector("#knowledgeByEraView .by-era-season-chart-wrap");
  const canvas = document.getElementById("byEraSeasonCompareChart");
  if (!controlsPane || !chartWrap || !canvas || !byEraSeasonCompareChart || !byEraSeasonCompareChart.chartArea) return;

  const chartAreaBottom = Number(byEraSeasonCompareChart.chartArea.bottom || 0);
  if (!Number.isFinite(chartAreaBottom) || chartAreaBottom <= 0) return;

  const axisBottomY = chartWrap.offsetTop + canvas.offsetTop + chartAreaBottom;
  const paneTopY = controlsPane.offsetTop;
  const targetHeight = Math.max(220, Math.round(axisBottomY - paneTopY));
  controlsPane.style.setProperty("height", `${targetHeight}px`, "important");

  if (!byEraSeasonControlsResizeBound) {
    window.addEventListener("resize", () => {
      window.requestAnimationFrame(syncByEraSeasonControlsToZeroAxis);
    });
    byEraSeasonControlsResizeBound = true;
  }
}

if (byEraSeasonSearchInput) {
  byEraSeasonSearchInput.addEventListener("input", event => {
    byEraSeasonSearchQuery = String(event.target.value || "").toLowerCase();
    renderByEraSeasonComparison();
  });
}

function normalizeArtistSearchValue(value) {
  return String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function hideArtistSuggestions() {
  if (!artistFamiliaritySuggestions) return;
  artistFamiliaritySuggestions.style.display = "none";
  artistFamiliaritySuggestions.innerHTML = "";
}

function getArtistSuggestionsForQuery(query) {
  const normalizedQuery = normalizeArtistSearchValue(query);
  const matches = normalizedQuery
    ? artistFamiliarityEntries.filter(entry => String(entry.name || "").toLowerCase().includes(normalizedQuery))
    : artistFamiliarityEntries;
  return matches.slice(0, 12);
}

function getArtistSuggestions() {
  return getArtistSuggestionsForQuery(artistFamiliaritySearchQuery);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getArtistPrefixSuggestion(rawTypedText) {
  const normalizedTyped = normalizeArtistSearchValue(rawTypedText);
  if (!normalizedTyped) return null;
  return artistFamiliarityEntries.find(entry =>
    String(entry.name || "").toLowerCase().startsWith(normalizedTyped)
  ) || null;
}

function renderArtistInlineSuggestion() {
  if (!artistFamiliarityInlineSuggestion || !artistFamiliaritySearchInput) return;
  const typed = String(artistFamiliaritySearchInput.value || "");
  const active = document.activeElement === artistFamiliaritySearchInput;
  if (!active || !typed.trim()) {
    artistFamiliarityInlineSuggestion.innerHTML = "";
    return;
  }

  const suggestionEntry = getArtistPrefixSuggestion(typed);
  if (!suggestionEntry) {
    artistFamiliarityInlineSuggestion.innerHTML = "";
    return;
  }

  const suggestionName = String(suggestionEntry.name || "");
  if (!suggestionName || suggestionName.toLowerCase() === typed.toLowerCase()) {
    artistFamiliarityInlineSuggestion.innerHTML = "";
    return;
  }
  if (!suggestionName.toLowerCase().startsWith(typed.toLowerCase())) {
    artistFamiliarityInlineSuggestion.innerHTML = "";
    return;
  }

  const tail = suggestionName.slice(typed.length);
  if (!tail) {
    artistFamiliarityInlineSuggestion.innerHTML = "";
    return;
  }

  artistFamiliarityInlineSuggestion.innerHTML = `<span class="artist-inline-typed">${escapeHtml(typed)}</span><span class="artist-inline-rest">${escapeHtml(tail)}</span>`;
}

function renderArtistSuggestions() {
  if (!artistFamiliaritySuggestions) return;
  const suggestions = getArtistSuggestions();
  renderArtistInlineSuggestion();
  if (!suggestions.length || !document.activeElement || document.activeElement !== artistFamiliaritySearchInput) {
    hideArtistSuggestions();
    return;
  }

  artistFamiliaritySuggestions.innerHTML = "";
  suggestions.forEach(entry => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artist-familiarity-suggestion-item";
    button.innerText = `${entry.name} (${entry.total || 0})`;
    button.addEventListener("mousedown", event => {
      event.preventDefault();
      applySelectedArtist(entry.name);
    });
    artistFamiliaritySuggestions.appendChild(button);
  });
  artistFamiliaritySuggestions.style.display = "block";
}

function getArtistEntryByNameFromCache(artistName) {
  if (!artistName) return null;
  return artistFamiliarityEntries.find(entry => entry.name === artistName) || null;
}

function applySelectedArtist(artistName) {
  const entry = getArtistEntryByNameFromCache(artistName);
  if (!entry) return;
  selectedArtistName = entry.name;
  artistFamiliarityPageIndex = 0;
  artistFamiliaritySearchQuery = entry.name;
  if (artistFamiliaritySearchInput) {
    artistFamiliaritySearchInput.value = entry.name;
  }
  renderArtistInlineSuggestion();
  hideArtistSuggestions();
  renderArtistFamiliarityView();
}

function applySelectedCompareArtist(artistName) {
  const entry = getArtistEntryByNameFromCache(artistName);
  if (!entry) return;
  selectedCompareArtistName = entry.name;
  renderArtistFamiliarityView();
}

function submitArtistSearch(typedValue) {
  const typed = String(typedValue || "").trim();
  if (!typed) {
    hideArtistSuggestions();
    return;
  }
  const prefixSuggestion = getArtistPrefixSuggestion(typed);
  if (prefixSuggestion && prefixSuggestion.name) {
    applySelectedArtist(prefixSuggestion.name);
    return;
  }
  const suggestions = getArtistSuggestions();
  if (suggestions.length) {
    applySelectedArtist(suggestions[0].name);
  } else if (artistFamiliarityEntries.length) {
    applySelectedArtist(artistFamiliarityEntries[0].name);
  }
}

function submitArtistCompareSearch(compareInput, compareInlineSuggestion) {
  if (!compareInput) return;
  const typed = String(compareInput.value || "").trim();
  if (!typed) {
    hideArtistCompareSuggestions();
    return;
  }
  const prefixSuggestion = getArtistPrefixSuggestion(typed);
  if (prefixSuggestion && prefixSuggestion.name) {
    artistFamiliarityCompareSearchQuery = prefixSuggestion.name;
    applySelectedCompareArtist(prefixSuggestion.name);
    return;
  }
  const suggestions = getArtistSuggestionsForQuery(typed);
  if (suggestions.length) {
    const exactMatch = suggestions.find(
      entry => String(entry.name || "").toLowerCase() === typed.toLowerCase()
    );
    const chosenName = (exactMatch || suggestions[0]).name;
    artistFamiliarityCompareSearchQuery = chosenName;
    applySelectedCompareArtist(chosenName);
    return;
  }
  if (compareInlineSuggestion) compareInlineSuggestion.innerHTML = "";
}

function hideArtistCompareSuggestions() {
  const suggestions = document.getElementById("artistFamiliarityCompareSuggestions");
  if (!suggestions) return;
  suggestions.style.display = "none";
  suggestions.innerHTML = "";
}

function renderArtistCompareInlineSuggestion(inputEl, inlineEl) {
  if (!inputEl || !inlineEl) return;
  const typed = String(inputEl.value || "");
  const active = document.activeElement === inputEl;
  if (!active || !typed.trim()) {
    inlineEl.innerHTML = "";
    return;
  }
  const suggestionEntry = getArtistPrefixSuggestion(typed);
  if (!suggestionEntry) {
    inlineEl.innerHTML = "";
    return;
  }
  const suggestionName = String(suggestionEntry.name || "");
  if (!suggestionName || suggestionName.toLowerCase() === typed.toLowerCase()) {
    inlineEl.innerHTML = "";
    return;
  }
  if (!suggestionName.toLowerCase().startsWith(typed.toLowerCase())) {
    inlineEl.innerHTML = "";
    return;
  }
  const tail = suggestionName.slice(typed.length);
  if (!tail) {
    inlineEl.innerHTML = "";
    return;
  }
  inlineEl.innerHTML = `<span class="artist-inline-typed">${escapeHtml(typed)}</span><span class="artist-inline-rest">${escapeHtml(tail)}</span>`;
}

function renderArtistCompareSuggestions(inputEl, suggestionsEl, inlineEl) {
  if (!inputEl || !suggestionsEl) return;
  const suggestions = getArtistSuggestionsForQuery(artistFamiliarityCompareSearchQuery);
  renderArtistCompareInlineSuggestion(inputEl, inlineEl);
  if (!suggestions.length || document.activeElement !== inputEl) {
    hideArtistCompareSuggestions();
    return;
  }
  suggestionsEl.innerHTML = "";
  suggestions.forEach(entry => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artist-familiarity-suggestion-item";
    button.innerText = `${entry.name} (${entry.total || 0})`;
    button.addEventListener("mousedown", event => {
      event.preventDefault();
      applySelectedCompareArtist(entry.name);
    });
    suggestionsEl.appendChild(button);
  });
  suggestionsEl.style.display = "block";
}

function collectArtistEvents(entry) {
  if (!entry || typeof entry !== "object") return [];
  const events = Array.isArray(entry.events) ? entry.events : [];
  const songKeyById = cachedSongKeyById && typeof cachedSongKeyById === "object"
    ? cachedSongKeyById
    : {};
  const normalizeArtistSongType = raw => {
    const text = String(raw || "").trim().toLowerCase();
    if (!text) return "";
    if (text === "op" || text === "opening") return "op";
    if (text === "ed" || text === "ending") return "ed";
    if (text === "in" || text === "insert" || text === "insert song") return "in";
    return "";
  };
  return events
    .map((event, index) => {
      if (Array.isArray(event)) {
        const numericSongId = Number(event[1]);
        const hasSongIdField = Number.isFinite(numericSongId) && numericSongId > 0;
        if (hasSongIdField) {
          const songid = Math.trunc(numericSongId);
          const keyRow = songKeyById[String(songid)] || null;
          return {
            timestamp: String(event[0] || ""),
            songid,
            songName: String((keyRow && keyRow.songName) || "Unknown song"),
            animeName: String((keyRow && (keyRow.animeEnglish || keyRow.animeName || keyRow.anime)) || ""),
            animeRomaji: String((keyRow && keyRow.animeRomaji) || ""),
            correct: Number(event[2] || 0) > 0,
            rig: Number(event[3] || 0) > 0,
            songType: normalizeArtistSongType((keyRow && keyRow.type) || event[4]),
            index
          };
        }

        const hasAnimeField = typeof event[2] === "string" || event[2] == null;
        const correctValue = hasAnimeField ? event[3] : event[2];
        const rigValue = hasAnimeField ? event[4] : event[3];
        const typeCandidates = hasAnimeField
          ? [event[5], event[6], event[7]]
          : [event[4], event[5], event[6]];
        let songType = "";
        for (const candidate of typeCandidates) {
          songType = normalizeArtistSongType(candidate);
          if (songType) break;
        }
        return {
          timestamp: String(event[0] || ""),
          songName: String(event[1] || "Unknown song"),
          animeName: hasAnimeField ? String(event[2] || "") : "",
          animeRomaji: "",
          correct: Number(correctValue || 0) > 0,
          rig: Number(rigValue || 0) > 0,
          songType,
          index
        };
      }
      if (event && typeof event === "object") {
        const numericSongId = Number(event.songid != null ? event.songid : event.songId);
        const hasSongIdField = Number.isFinite(numericSongId) && numericSongId > 0;
        const songid = hasSongIdField ? Math.trunc(numericSongId) : null;
        const keyRow = songid != null ? (songKeyById[String(songid)] || null) : null;
        const songType = normalizeArtistSongType(
          event.songType
          || event.type
          || event.song_type
          || event.songTypeShort
          || event.kind
          || (keyRow && keyRow.type)
        );
        return {
          timestamp: String(event.timestamp || event.date || ""),
          songid,
          songName: String(event.songName || event.song || (keyRow && keyRow.songName) || "Unknown song"),
          animeName: String(event.animeName || event.anime || (keyRow && (keyRow.animeEnglish || keyRow.animeName || keyRow.anime)) || ""),
          animeRomaji: String(event.animeRomaji || (keyRow && keyRow.animeRomaji) || ""),
          correct: Number(event.correct || 0) > 0,
          rig: Number(event.rig || 0) > 0,
          songType,
          index
        };
      }
      return null;
    })
    .filter(Boolean);
}

function getArtistRowAnimeName(row) {
  const english = String(row && row.animeName || "").trim();
  const romaji = String(row && row.animeRomaji || "").trim();
  if (overviewLanguageMode === "jp") {
    return romaji || english;
  }
  return english || romaji;
}

function getArtistRowLabel(row) {
  const song = String(row && row.songName || "Unknown song");
  const anime = getArtistRowAnimeName(row);
  return anime ? `${song} [${anime}]` : song;
}

function buildArtistSongBars(entry) {
  const grouped = new Map();
  const events = collectArtistEvents(entry);
  events.forEach(event => {
    const songName = String(event.songName || "Unknown song");
    const animeName = String(event.animeName || "");
    const animeRomaji = String(event.animeRomaji || "");
    const groupedKey = `${songName}||${animeName}||${animeRomaji}`;
    if (!grouped.has(groupedKey)) {
      grouped.set(groupedKey, {
        songName,
        animeName,
        animeRomaji,
        marks: [],
        rigMarks: [],
        attemptTimestamps: [],
        rigCount: 0,
        opCount: 0,
        edCount: 0,
        inCount: 0,
        correctCount: 0,
        total: 0
      });
    }
    const row = grouped.get(groupedKey);
    row.marks.push(event.correct ? "✅" : "❌");
    row.rigMarks.push(event.rig ? "✅" : "❌");
    row.attemptTimestamps.push(String(event.timestamp || ""));
    row.total += 1;
    if (event.correct) row.correctCount += 1;
    if (event.rig) row.rigCount += 1;
    if (event.songType === "op") row.opCount += 1;
    if (event.songType === "ed") row.edCount += 1;
    if (event.songType === "in") row.inCount += 1;
  });

  return [...grouped.values()].sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    const nameA = `${a.songName} ${getArtistRowAnimeName(a)}`;
    const nameB = `${b.songName} ${getArtistRowAnimeName(b)}`;
    return nameA.localeCompare(nameB);
  });
}

function normalizeArtistAttemptsFilterValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getArtistRowLatestTimestampMs(row) {
  if (!row || !Array.isArray(row.attemptTimestamps) || !row.attemptTimestamps.length) return 0;
  let latest = 0;
  row.attemptTimestamps.forEach((timestampText, index) => {
    const ts = parseArtistEventTimestampMs(timestampText, row.attemptTimestamps.length - index);
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  });
  return latest;
}

function getArtistRowInstability(row) {
  const marks = Array.isArray(row && row.marks) ? row.marks : [];
  if (marks.length <= 1) {
    return { flipCount: 0, flipRate: 0 };
  }
  let flips = 0;
  for (let i = 1; i < marks.length; i++) {
    if (marks[i] !== marks[i - 1]) flips += 1;
  }
  return {
    flipCount: flips,
    flipRate: flips / (marks.length - 1)
  };
}

function filterAndSortArtistSongRows(rows, filterQuery, sortMode) {
  const normalizedFilter = normalizeArtistAttemptsFilterValue(filterQuery);
  const filteredRows = normalizedFilter
    ? rows.filter(row => {
      const songText = String(row && row.songName || "").toLowerCase();
      const animeText = String(row && row.animeName || "").toLowerCase();
      const animeRomajiText = String(row && row.animeRomaji || "").toLowerCase();
      return songText.includes(normalizedFilter) || animeText.includes(normalizedFilter) || animeRomajiText.includes(normalizedFilter);
    })
    : rows.slice();

  const mode = String(sortMode || "none");
  if (mode === "none") return filteredRows;

  filteredRows.sort((a, b) => {
    const aWrong = Math.max(0, Number(a.total || 0) - Number(a.correctCount || 0));
    const bWrong = Math.max(0, Number(b.total || 0) - Number(b.correctCount || 0));
    const aRig = Number(a.rigCount || 0);
    const bRig = Number(b.rigCount || 0);
    const aInstability = getArtistRowInstability(a);
    const bInstability = getArtistRowInstability(b);
    const aLatest = getArtistRowLatestTimestampMs(a);
    const bLatest = getArtistRowLatestTimestampMs(b);

    if (mode === "least_recent") {
      if (aLatest !== bLatest) return aLatest - bLatest;
    } else if (mode === "most_correct") {
      if (a.correctCount !== b.correctCount) return b.correctCount - a.correctCount;
    } else if (mode === "most_wrong") {
      if (aWrong !== bWrong) return bWrong - aWrong;
    } else if (mode === "most_instability") {
      if (aInstability.flipRate !== bInstability.flipRate) return bInstability.flipRate - aInstability.flipRate;
      if (aInstability.flipCount !== bInstability.flipCount) return bInstability.flipCount - aInstability.flipCount;
    } else if (mode === "has_rig") {
      const aHasRig = aRig > 0 ? 1 : 0;
      const bHasRig = bRig > 0 ? 1 : 0;
      if (aHasRig !== bHasRig) return bHasRig - aHasRig;
      if (aRig !== bRig) return bRig - aRig;
    } else if (mode === "no_rig") {
      const aNoRig = aRig === 0 ? 1 : 0;
      const bNoRig = bRig === 0 ? 1 : 0;
      if (aNoRig !== bNoRig) return bNoRig - aNoRig;
      if (aRig !== bRig) return aRig - bRig;
    } else {
      if (aLatest !== bLatest) return bLatest - aLatest;
    }

    if (a.total !== b.total) return b.total - a.total;
    const nameA = `${String(a.songName || "")} ${getArtistRowAnimeName(a)}`;
    const nameB = `${String(b.songName || "")} ${getArtistRowAnimeName(b)}`;
    return nameA.localeCompare(nameB);
  });

  return filteredRows;
}

function renderArtistPatternRigMatrix(rows, pageIndex, pageSize) {
  const safePageSize = Math.max(1, Number(pageSize || ARTIST_FAMILIARITY_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
  const safePageIndex = Math.min(Math.max(0, Number(pageIndex || 0)), totalPages - 1);
  const start = safePageIndex * safePageSize;
  const pagedRows = rows.slice(start, start + safePageSize);

  const firstPageRows = rows.slice(0, safePageSize);
  const maxAttempts = firstPageRows.reduce((maxValue, row) => Math.max(maxValue, Number(row.total || 0)), 0);
  const safeMaxAttempts = Math.max(1, maxAttempts);
  const tickStep = safeMaxAttempts <= 20 ? 1 : (safeMaxAttempts <= 60 ? 5 : 10);

  const headerTicks = [];
  for (let i = 1; i <= safeMaxAttempts; i += tickStep) {
    headerTicks.push(`<span>${i}</span>`);
  }

  const rowsHtml = pagedRows.map(row => {
    const songLabelHtml = buildArtistSongLabelHtml(row);

    const patternCells = row.marks.map(mark => {
      const cls = mark === "✅" ? "pattern-correct" : "pattern-wrong";
      return `<div class="artist-familiarity-track-cell ${cls}" title="${mark === "✅" ? "Correct" : "Wrong"}"></div>`;
    }).join("");

    const rigCells = row.rigMarks.map(mark => {
      const cls = mark === "✅" ? "rig-yes" : "rig-no";
      return `<div class="artist-familiarity-track-cell ${cls}" title="${mark === "✅" ? "Rig" : "Non-rig"}"></div>`;
    }).join("");

    return `
      <div class="artist-familiarity-matrix-row">
        <div class="artist-familiarity-matrix-label">
          <span class="song">${songLabelHtml}</span>
          <span class="meta">Songs played ${row.total} | Rig ${row.rigCount}</span>
        </div>
        <div class="artist-familiarity-matrix-track">
          <div class="artist-familiarity-track-line" style="grid-template-columns: repeat(${safeMaxAttempts}, minmax(8px, 1fr));">${patternCells}</div>
          <div class="artist-familiarity-track-line" style="grid-template-columns: repeat(${safeMaxAttempts}, minmax(8px, 1fr));">${rigCells}</div>
        </div>
      </div>
    `;
  }).join("");

  return {
    safePageIndex,
    totalPages,
    html: `
    <div class="artist-familiarity-matrix">
      <div class="artist-familiarity-matrix-header">
        <span>Song (Y-axis)</span>
        <span>Attempts (X-axis) ${headerTicks.join(" ")}</span>
      </div>
      ${rowsHtml}
    </div>
    <div class="artist-familiarity-track-legend">
      <span><span class="dot rig-yes"></span>Rig</span>
      <span><span class="dot rig-no"></span>Non-rig</span>
    </div>
    <div class="artist-familiarity-pagination">
      <button id="artistFamiliarityPrevPageBtn" class="artist-familiarity-page-button" type="button" aria-label="Previous page">◀</button>
      <span id="artistFamiliarityPageMeta" class="artist-familiarity-page-meta">Page 1/1</span>
      <button id="artistFamiliarityNextPageBtn" class="artist-familiarity-page-button" type="button" aria-label="Next page">▶</button>
    </div>
  `
  };
}

function getArtistSongRowsPage(rows, pageIndex, pageSize) {
  const safePageSize = Math.max(1, Number(pageSize || ARTIST_FAMILIARITY_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
  const safePageIndex = Math.min(Math.max(0, Number(pageIndex || 0)), totalPages - 1);
  const start = safePageIndex * safePageSize;
  const pagedRows = rows.slice(start, start + safePageSize);
  return {
    safePageIndex,
    totalPages,
    pagedRows
  };
}

function buildArtistSongLabel(row) {
  return getArtistRowLabel(row);
}

function buildArtistSongLabelHtml(row) {
  const song = String(row && row.songName || "Unknown song");
  const anime = getArtistRowAnimeName(row);
  if (!anime) {
    return escapeHtml(song);
  }
  const animeEscaped = escapeHtml(anime);
  return `${escapeHtml(song)} <span class="anime-part" data-full-title="${animeEscaped}">[${animeEscaped}]</span>`;
}

function bindArtistAnimeHoverTooltip() {
  const host = document.getElementById("knowledgeArtistView");
  if (!host) return;
  let tooltip = document.getElementById("artistAnimeHoverTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "artistAnimeHoverTooltip";
    host.appendChild(tooltip);
  }

  const hideTooltip = () => {
    tooltip.style.opacity = "0";
    tooltip.style.visibility = "hidden";
  };

  const placeTooltip = node => {
    const margin = 10;
    const gap = 6;
    const anchorRect = node.getBoundingClientRect();
    const clipRect = node.closest(".song")?.getBoundingClientRect();
    const visibleLeft = clipRect ? Math.max(anchorRect.left, clipRect.left) : anchorRect.left;
    const visibleRight = clipRect ? Math.min(anchorRect.right, clipRect.right) : anchorRect.right;
    const rect = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const anchorX = visibleLeft + Math.max(0, visibleRight - visibleLeft) / 2;
    const left = Math.min(Math.max(margin, anchorX - rect.width / 2), maxLeft);
    let top = anchorRect.top - rect.height - gap;
    if (top < margin) {
      top = Math.min(window.innerHeight - rect.height - margin, anchorRect.bottom + gap);
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  };

  const animeNodes = document.querySelectorAll("#knowledgeArtistView .artist-familiarity-matrix-label .anime-part");
  animeNodes.forEach(node => {
    const labelNode = node.closest(".artist-familiarity-matrix-label");
    if (labelNode) {
      labelNode.querySelectorAll("[title]").forEach(el => el.removeAttribute("title"));
      labelNode.removeAttribute("title");
    }
    node.removeAttribute("title");
    const songNode = node.closest(".song");
    if (songNode) songNode.removeAttribute("title");
    node.addEventListener("mouseenter", () => {
      let current = node;
      while (current && current !== host) {
        if (typeof current.removeAttribute === "function") current.removeAttribute("title");
        current = current.parentElement;
      }
      const fullTitle = String(node.getAttribute("data-full-title") || "").trim();
      if (!fullTitle) return;
      tooltip.textContent = fullTitle;
      tooltip.style.opacity = "1";
      tooltip.style.visibility = "visible";
      placeTooltip(node);
    });
    node.addEventListener("mouseleave", hideTooltip);
  });
}

function truncateArtistSongLabel(label, maxLength = 54) {
  const normalized = String(label || "");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}\u2026`;
}

function destroyArtistFamiliarityBarsChart() {
  if (!artistFamiliarityBarsChart) return;
  artistFamiliarityBarsChart.destroy();
  artistFamiliarityBarsChart = null;
}

function destroyArtistFamiliarityCompareRadarChart() {
  if (!artistFamiliarityCompareRadarChart) return;
  artistFamiliarityCompareRadarChart.destroy();
  artistFamiliarityCompareRadarChart = null;
}

function renderArtistFamiliarityBarsChart(rows) {
  destroyArtistFamiliarityBarsChart();
  const canvas = document.getElementById("artistFamiliarityAttemptsChart");
  if (!canvas || !rows.length) return;

  const rowParts = rows.map(row => {
    const song = truncateArtistSongLabel(String(row && row.songName || "Unknown song"), 32);
    const anime = truncateArtistSongLabel(getArtistRowAnimeName(row), 36);
    return { song, anime };
  });
  const trackRows = [];
  const labels = [];
  rows.forEach((row, rowIndex) => {
    trackRows.push({ rowIndex, track: "pattern" });
    labels.push(rowParts[rowIndex].song);
    trackRows.push({ rowIndex, track: "rig" });
    labels.push("");
  });

  const maxAttempts = Math.max(1, ...rows.map(row => Number(row.total || 0)));
  const datasets = [];
  for (let attemptIdx = 0; attemptIdx < maxAttempts; attemptIdx++) {
    const patternValues = trackRows.map(trackRow => {
      const row = rows[trackRow.rowIndex] || {};
      const total = Number(row.total || 0);
      if (trackRow.track !== "pattern") return null;
      return attemptIdx < total ? 1 : null;
    });
    const patternColors = trackRows.map(trackRow => {
      const row = rows[trackRow.rowIndex] || {};
      const total = Number(row.total || 0);
      if (trackRow.track !== "pattern") return "rgba(0,0,0,0)";
      if (attemptIdx >= total) return "rgba(0,0,0,0)";
      const mark = row.marks && row.marks[attemptIdx];
      return mark === "✅" ? "rgba(22, 163, 74, 0.88)" : "rgba(220, 38, 38, 0.84)";
    });
    const rigValues = trackRows.map(trackRow => {
      const row = rows[trackRow.rowIndex] || {};
      const total = Number(row.total || 0);
      if (trackRow.track !== "rig") return null;
      return attemptIdx < total ? 1 : null;
    });
    const rigColors = trackRows.map(trackRow => {
      const row = rows[trackRow.rowIndex] || {};
      const total = Number(row.total || 0);
      if (trackRow.track !== "rig") return "rgba(0,0,0,0)";
      if (attemptIdx >= total) return "rgba(0,0,0,0)";
      const rigMark = row.rigMarks && row.rigMarks[attemptIdx];
      return rigMark === "✅" ? "rgba(37, 99, 235, 0.86)" : "rgba(148, 163, 184, 0.84)";
    });

    datasets.push({
      label: `Pattern Attempt ${attemptIdx + 1}`,
      afTrack: "pattern",
      afAttemptIdx: attemptIdx,
      data: patternValues,
      backgroundColor: patternColors,
      borderColor: "rgba(255,255,255,0)",
      borderWidth: 0,
      borderSkipped: false,
      barThickness: 9,
      categoryPercentage: 1.0,
      barPercentage: 1.0,
      stack: "pattern-attempts"
    });
    datasets.push({
      label: `Rig Attempt ${attemptIdx + 1}`,
      afTrack: "rig",
      afAttemptIdx: attemptIdx,
      data: rigValues,
      backgroundColor: rigColors,
      borderColor: "rgba(255,255,255,0)",
      borderWidth: 0,
      borderSkipped: false,
      barThickness: 9,
      categoryPercentage: 1.0,
      barPercentage: 1.0,
      stack: "rig-attempts"
    });
  }

  const artistFamiliarityYLabelsPlugin = {
    id: "artistFamiliarityYLabels",
    afterDraw(chart, args, opts) {
      const yScale = chart.scales && chart.scales.y;
      if (!yScale) return;
      const rowsMeta = opts && opts.trackRows || [];
      const songMeta = opts && opts.rowParts || [];
      const ctx = chart.ctx;
      const x = yScale.left - 8;
      ctx.save();
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 0; i < rowsMeta.length; i++) {
        const rowMeta = rowsMeta[i] || {};
        if (rowMeta.track !== "pattern") continue;
        const patternY = yScale.getPixelForTick(i);
        const rigY = i + 1 < rowsMeta.length ? yScale.getPixelForTick(i + 1) : patternY;
        const y = (patternY + rigY) / 2;
        const labelMeta = songMeta[rowMeta.rowIndex] || {};
        const songText = String(labelMeta.song || "");
        const animeText = String(labelMeta.anime || "");
        ctx.fillStyle = "#1f2937";
        ctx.font = '400 11px "Segoe UI", "Avenir Next", sans-serif';
        ctx.fillText(songText, x, y - 4);
        if (animeText) {
          ctx.fillStyle = "#64748b";
          ctx.font = '400 10px "Segoe UI", "Avenir Next", sans-serif';
          ctx.fillText(animeText, x, y + 7);
        }
      }
      ctx.restore();
    }
  };

  artistFamiliarityBarsChart = new Chart(canvas, {
    type: "bar",
    plugins: [artistFamiliarityYLabelsPlugin],
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            title: context => {
              const ctx = context && context[0];
              const index = Number(ctx && ctx.dataIndex || 0);
              const trackRow = trackRows[index] || {};
              const row = rows[trackRow.rowIndex] || {};
              const datasetAttemptIndex = Number(ctx && ctx.dataset && ctx.dataset.afAttemptIdx);
              const attemptIndex = Number.isFinite(datasetAttemptIndex)
                ? datasetAttemptIndex
                : Math.floor(Number(ctx && ctx.datasetIndex || 0) / 2);
              const timestamp = row.attemptTimestamps && row.attemptTimestamps[attemptIndex];
              return timestamp ? String(timestamp) : "Unknown timestamp";
            },
            label: context => {
              const index = Number(context.dataIndex || 0);
              const trackRow = trackRows[index] || {};
              const row = rows[trackRow.rowIndex] || {};
              const datasetAttemptIndex = Number(context.dataset && context.dataset.afAttemptIdx);
              const attemptIndex = Number.isFinite(datasetAttemptIndex)
                ? datasetAttemptIndex
                : Math.floor(Number(context.datasetIndex || 0) / 2);
              if (trackRow.track === "rig") {
                const rigMark = row.rigMarks && row.rigMarks[attemptIndex];
                return rigMark === "✅" ? "Rig" : "Non-rig";
              }
              const patternMark = row.marks && row.marks[attemptIndex];
              return patternMark === "✅" ? "Correct" : "Incorrect";
            }
          }
        },
        artistFamiliarityYLabels: {
          trackRows,
          rowParts
        }
      },
      layout: {
        padding: {
          left: 218
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          max: maxAttempts,
          stacked: true,
          ticks: {
            color: "#475569",
            precision: 0,
            stepSize: 1
          },
          grid: {
            color: "rgba(148, 163, 184, 0.28)"
          },
          title: {
            display: true,
            text: "Attempts (order)",
            color: "#475569",
            font: {
              size: 12,
              weight: "600"
            }
          }
        },
        y: {
          stacked: true,
          offset: true,
          ticks: {
            display: true,
            color: "#1f2937",
            font: {
              size: 11,
              weight: "600"
            }
          },
          grid: {
            display: false
          }
        }
      }
    }
  });
}

function parseArtistEventTimestampMs(timestampText, fallbackIndex = 0) {
  const parsed = new Date(String(timestampText || "")).getTime();
  if (Number.isFinite(parsed)) return parsed;
  return Date.now() - Math.max(0, fallbackIndex) * 86400000;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function calculateArtistRadarMetrics(events) {
  const total = events.length;
  if (!total) {
    return {
      nonRigAccuracy: 0,
      rigAccuracy: 0,
      diversity: 0,
      coverage: 0,
      stability: 0,
      consistency: 0,
      hasNonRigAccuracy: false,
      hasRigAccuracy: false,
      hasDiversity: false,
      hasCoverage: false,
      hasStability: false,
      hasConsistency: false
    };
  }

  let nonRigTotal = 0;
  let nonRigCorrect = 0;
  let rigTotal = 0;
  let rigCorrect = 0;
  const songCounts = new Map();
  const songGotAtLeastOnce = new Map();

  events.forEach(event => {
    const songKey = String(event.songName || "Unknown song");
    songCounts.set(songKey, (songCounts.get(songKey) || 0) + 1);
    if (!songGotAtLeastOnce.has(songKey)) songGotAtLeastOnce.set(songKey, false);
    if (event.correct) songGotAtLeastOnce.set(songKey, true);

    if (event.rig) {
      rigTotal += 1;
      if (event.correct) rigCorrect += 1;
    } else {
      nonRigTotal += 1;
      if (event.correct) nonRigCorrect += 1;
    }
  });

  const nonRigAccuracy = nonRigTotal > 0 ? nonRigCorrect / nonRigTotal : 0;
  const rigAccuracy = rigTotal > 0 ? rigCorrect / rigTotal : 0;

  const uniqueSongs = songCounts.size;
  const songsGot = [...songGotAtLeastOnce.values()].filter(Boolean).length;
  const coverage = uniqueSongs > 0 ? songsGot / uniqueSongs : 0;

  let entropy = 0;
  for (const count of songCounts.values()) {
    const p = count / total;
    if (p > 0) entropy += -p * Math.log(p);
  }
  const maxEntropy = uniqueSongs > 1 ? Math.log(uniqueSongs) : 1;
  const diversity = uniqueSongs > 1 ? entropy / maxEntropy : 0;

  const songMarks = new Map();
  events.forEach(event => {
    const songKey = `${String(event.animeName || "Unknown anime")}||${String(event.songName || "Unknown song")}`;
    if (!songMarks.has(songKey)) songMarks.set(songKey, []);
    songMarks.get(songKey).push(Boolean(event.correct));
  });
  let stabilityTransitions = 0;
  let stabilityFlips = 0;
  songMarks.forEach(marks => {
    if (!Array.isArray(marks) || marks.length <= 1) return;
    stabilityTransitions += marks.length - 1;
    for (let i = 1; i < marks.length; i++) {
      if (marks[i] !== marks[i - 1]) stabilityFlips += 1;
    }
  });
  const stability = stabilityTransitions > 0 ? 1 - (stabilityFlips / stabilityTransitions) : 0;

  const consistencyScores = events.map(event => {
    if (!event.correct) return 0;
    return event.rig ? 0.7 : 1.0;
  });
  const rollingWindow = 5;
  const rollingAccuracies = [];
  for (let i = 0; i < consistencyScores.length; i++) {
    const start = Math.max(0, i - rollingWindow + 1);
    const windowValues = consistencyScores.slice(start, i + 1);
    const avg = windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length;
    rollingAccuracies.push(avg);
  }
  const rollingMean = rollingAccuracies.reduce((sum, value) => sum + value, 0) / rollingAccuracies.length;
  const variance = rollingAccuracies.reduce((sum, value) => sum + (value - rollingMean) ** 2, 0) / rollingAccuracies.length;
  const consistency = 1 - Math.min(1, variance / 0.25);

  return {
    nonRigAccuracy: clamp01(nonRigAccuracy),
    rigAccuracy: clamp01(rigAccuracy),
    diversity: clamp01(diversity),
    coverage: clamp01(coverage),
    stability: clamp01(stability),
    consistency: clamp01(consistency),
    hasNonRigAccuracy: nonRigTotal > 0,
    hasRigAccuracy: rigTotal > 0,
    hasDiversity: uniqueSongs > 1,
    hasCoverage: uniqueSongs > 0,
    hasStability: stabilityTransitions > 0,
    hasConsistency: rollingAccuracies.length > 0
  };
}

function buildArtistFamiliarityRadarConfig(metrics) {
  const metricRows = [
    {
      label: metrics.hasNonRigAccuracy === false
        ? ["Non-rig Accuracy", "(does not exist)"]
        : "Non-rig Accuracy",
      value: Number(metrics.nonRigAccuracy || 0) * 100,
      include: true,
      hidePoint: metrics.hasNonRigAccuracy === false,
      missingLabelColor: "#c2410c"
    },
    {
      label: metrics.hasRigAccuracy === false
        ? ["Rig Accuracy", "(does not exist)"]
        : "Rig Accuracy",
      value: Number(metrics.rigAccuracy || 0) * 100,
      include: true,
      hidePoint: metrics.hasRigAccuracy === false,
      missingLabelColor: "#b45353"
    },
    { label: "Diversity", value: Number(metrics.diversity || 0) * 100, include: metrics.hasDiversity !== false },
    { label: "Coverage", value: Number(metrics.coverage || 0) * 100, include: metrics.hasCoverage !== false },
    { label: "Stability", value: Number(metrics.stability || 0) * 100, include: metrics.hasStability !== false },
    { label: "Consistency", value: Number(metrics.consistency || 0) * 100, include: metrics.hasConsistency !== false }
  ].filter(row => row.include);

  const labels = metricRows.map(row => row.label);
  const values = metricRows.map(row => row.value);
  const pointRadius = metricRows.map(row => row.hidePoint ? 0 : 2);
  const pointBackgroundColor = metricRows.map(row => row.hidePoint ? "rgba(2, 132, 199, 0)" : "#0284c7");
  const pointBorderColor = metricRows.map(row => row.hidePoint ? "rgba(2, 132, 199, 0)" : "#0284c7");

  return {
    type: "radar",
    data: {
      labels,
      datasets: [
        {
          label: "Artist Metrics (%)",
          data: values,
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14, 165, 233, 0.22)",
          pointBackgroundColor,
          pointBorderColor,
          pointRadius,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#334155",
            font: { size: 12 }
          }
        },
        tooltip: {
          callbacks: {
            label: context => `${context.dataset.label}: ${Number(context.raw || 0).toFixed(1)}%`
          }
        }
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 20,
            color: "#64748b",
            backdropColor: "transparent",
            callback: value => `${Math.round(Number(value))}%`
          },
          grid: { color: "#e5e7eb", circular: false },
          angleLines: { color: "#dbe4f2" },
          pointLabels: {
            color: context => {
              const row = metricRows[Number(context?.index)];
              if (context?.chart?.canvas?.id === "artistFamiliarityRadarChart" && Number(context?.index) === artistRadarHoveredLabelIndex) {
                return "#f97316";
              }
              if (row?.hidePoint) return row.missingLabelColor || "#b45353";
              return "#334155";
            },
            font: { size: 11 }
          }
        }
      }
    }
  };
}

const artistRadarMetricDefinitions = {
  "Non-rig Accuracy": "nonRigCorrect / nonRigTotal for this artist's non-rig rounds.",
  "Rig Accuracy": "rigCorrect / rigTotal for this artist's rig rounds.",
  "Diversity": "Shannon diversity over this artist's song-attempt distribution: (-Σ p·ln p) / ln(uniqueSongs), where p = songAttempts / totalAttempts.",
  "Coverage": "songsGotAtLeastOnce / uniqueSongs for this artist.",
  "Stability": "1 - (stabilityFlips / stabilityTransitions), where a flip is correct↔wrong between adjacent attempts on the same song.",
  "Consistency": "1 - min(1, variance(rollingAvg5(weightedCorrect)) / 0.25), where weightedCorrect = 1 for non-rig correct, 0.7 for rig correct, 0 for wrong."
};

function getRadarLabelText(rawLabel) {
  if (Array.isArray(rawLabel)) {
    return rawLabel.map(part => String(part || "").trim()).filter(Boolean).join(" ");
  }
  return String(rawLabel || "").trim();
}

function getArtistRadarDefinition(labelText) {
  const normalized = String(labelText || "").toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("non-rig") && normalized.includes("accuracy")) return artistRadarMetricDefinitions["Non-rig Accuracy"];
  if (normalized.includes("rig") && normalized.includes("accuracy")) return artistRadarMetricDefinitions["Rig Accuracy"];
  if (normalized.includes("diversity")) return artistRadarMetricDefinitions["Diversity"];
  if (normalized.includes("coverage")) return artistRadarMetricDefinitions["Coverage"];
  if (normalized.includes("stability")) return artistRadarMetricDefinitions["Stability"];
  if (normalized.includes("consistency")) return artistRadarMetricDefinitions["Consistency"];
  return artistRadarMetricDefinitions[labelText] || "";
}

function hideArtistRadarLabelTooltip() {
  const tooltip = document.getElementById("artistFamiliarityRadarLabelTooltip");
  if (tooltip) tooltip.textContent = "Metric Definitions (hover over metric to view)";
  artistRadarHoveredLabelIndex = -1;
  if (artistFamiliarityRadarChart) artistFamiliarityRadarChart.update("none");
}

function bindArtistRadarLabelHover(chartInstance) {
  if (!chartInstance || chartInstance.canvas?.id !== "artistFamiliarityRadarChart") return;
  const canvas = chartInstance.canvas;
  const tooltip = document.getElementById("artistFamiliarityRadarLabelTooltip");
  if (!canvas || !tooltip) return;

  const onMove = event => {
    const scale = chartInstance.scales?.r;
    const labelItems = scale?._pointLabelItems;
    if (!Array.isArray(labelItems) || !labelItems.length) {
      hideArtistRadarLabelTooltip();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    let hoveredIndex = -1;
    for (let i = 0; i < labelItems.length; i++) {
      const item = labelItems[i];
      if (!item) continue;
      if (x >= item.left && x <= item.right && y >= item.top && y <= item.bottom) {
        hoveredIndex = i;
        break;
      }
    }

    if (hoveredIndex < 0) {
      hideArtistRadarLabelTooltip();
      return;
    }

    artistRadarHoveredLabelIndex = hoveredIndex;
    const rawLabel = chartInstance.data?.labels?.[hoveredIndex];
    const labelText = getRadarLabelText(rawLabel);
    const definition = getArtistRadarDefinition(labelText);
    if (definition) {
      tooltip.textContent = `${labelText}: ${definition}`;
    } else {
      tooltip.textContent = "Metric Definitions (hover over metric to view)";
    }
    chartInstance.update("none");
  };

  const onLeave = () => hideArtistRadarLabelTooltip();
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);
}

function renderArtistFamiliarityRadarOnCanvas(metrics, canvasId, existingChart) {
  if (existingChart) existingChart.destroy();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const chartInstance = new Chart(canvas, buildArtistFamiliarityRadarConfig(metrics));
  if (canvasId === "artistFamiliarityRadarChart") bindArtistRadarLabelHover(chartInstance);
  return chartInstance;
}

function renderArtistFamiliarityRadar(metrics) {
  artistFamiliarityRadarChart = renderArtistFamiliarityRadarOnCanvas(
    metrics,
    "artistFamiliarityRadarChart",
    artistFamiliarityRadarChart
  );
}

function renderArtistFamiliarityCompareRadar(metrics) {
  artistFamiliarityCompareRadarChart = renderArtistFamiliarityRadarOnCanvas(
    metrics,
    "artistFamiliarityCompareRadarChart",
    artistFamiliarityCompareRadarChart
  );
}

function renderArtistFamiliarityRightModeButtons() {
  if (artistFamiliarityRightModeToggle) {
    artistFamiliarityRightModeToggle.classList.toggle("is-compare", artistFamiliarityRightMode === "compare_radar");
  }
  if (artistFamiliarityRightModeAttemptsBtn) {
    artistFamiliarityRightModeAttemptsBtn.classList.toggle("active", artistFamiliarityRightMode === "attempts");
  }
  if (artistFamiliarityRightModeCompareBtn) {
    artistFamiliarityRightModeCompareBtn.classList.toggle("active", artistFamiliarityRightMode === "compare_radar");
  }
}

function renderArtistCompareRadarPanel(rightPanelHost, primaryEntry) {
  if (!rightPanelHost) return;
  destroyArtistFamiliarityBarsChart();
  rightPanelHost.innerHTML = `
    <div class="artist-familiarity-compare-radar-group">
      <div class="artist-familiarity-radar-title artist-familiarity-compare-title">Compare another artist</div>
      <div class="artist-familiarity-toolbar">
        <div class="artist-familiarity-search-row">
          <div class="artist-familiarity-search-wrap">
            <div id="artistFamiliarityCompareInlineSuggestion" class="artist-familiarity-inline-suggestion"></div>
            <input id="artistFamiliarityCompareSearchInput" class="artist-familiarity-search-input" type="text" placeholder="Search artist...">
          </div>
          <button id="artistFamiliarityCompareSearchBtn" class="artist-familiarity-search-btn" type="button">Search</button>
        </div>
        <div id="artistFamiliarityCompareSuggestions" class="artist-familiarity-suggestions"></div>
        <div id="artistFamiliarityCompareSelected" class="artist-familiarity-selected">No artist selected</div>
      </div>
      <div class="chart-wrap artist-radar-wrap"><canvas id="artistFamiliarityCompareRadarChart"></canvas></div>
    </div>
  `;

  const compareInput = document.getElementById("artistFamiliarityCompareSearchInput");
  const compareSearchBtn = document.getElementById("artistFamiliarityCompareSearchBtn");
  const compareSuggestions = document.getElementById("artistFamiliarityCompareSuggestions");
  const compareInlineSuggestion = document.getElementById("artistFamiliarityCompareInlineSuggestion");
  const compareSelected = document.getElementById("artistFamiliarityCompareSelected");
  if (!compareInput || !compareSearchBtn || !compareSuggestions || !compareInlineSuggestion || !compareSelected) return;

  if (!selectedCompareArtistName || !getArtistEntryByNameFromCache(selectedCompareArtistName)) {
    const fallbackCompareEntry = artistFamiliarityEntries.find(entry => entry.name !== String(primaryEntry?.name || ""))
      || artistFamiliarityEntries[0]
      || null;
    selectedCompareArtistName = fallbackCompareEntry ? fallbackCompareEntry.name : "";
  }

  compareInput.value = artistFamiliarityCompareSearchQuery;

  const selectedCompareEntry = getArtistEntryByNameFromCache(selectedCompareArtistName);
  if (!selectedCompareEntry) {
    compareSelected.innerText = "No artist selected";
    renderArtistFamiliarityCompareRadar({
      nonRigAccuracy: 0,
      rigAccuracy: 0,
      diversity: 0,
      coverage: 0,
      stability: 0,
      consistency: 0
    });
  } else {
    const compareEvents = collectArtistEvents(selectedCompareEntry.value || selectedCompareEntry);
    const compareRows = buildArtistSongBars(selectedCompareEntry.value || selectedCompareEntry);
    const compareMetrics = calculateArtistRadarMetrics(compareEvents);
    renderArtistFamiliarityCompareRadar(compareMetrics);
    compareSelected.innerText = `Selected artist: ${selectedCompareEntry.name} | Total plays: ${selectedCompareEntry.total || 0} | Songs: ${compareRows.length}`;
  }

  renderArtistCompareInlineSuggestion(compareInput, compareInlineSuggestion);

  compareInput.addEventListener("input", event => {
    artistFamiliarityCompareSearchQuery = String(event.target.value || "");
    renderArtistCompareSuggestions(compareInput, compareSuggestions, compareInlineSuggestion);
  });
  compareInput.addEventListener("focus", () => {
    renderArtistCompareSuggestions(compareInput, compareSuggestions, compareInlineSuggestion);
  });
  compareInput.addEventListener("blur", () => {
    setTimeout(() => {
      renderArtistCompareInlineSuggestion(compareInput, compareInlineSuggestion);
    }, 0);
  });
  compareInput.addEventListener("keydown", event => {
    if (event.key === "Tab" && !event.shiftKey) {
      const typed = String(compareInput.value || "");
      const suggestion = getArtistPrefixSuggestion(typed);
      if (suggestion && suggestion.name && suggestion.name.toLowerCase() !== typed.toLowerCase()) {
        event.preventDefault();
        compareInput.value = suggestion.name;
        artistFamiliarityCompareSearchQuery = suggestion.name;
        renderArtistCompareSuggestions(compareInput, compareSuggestions, compareInlineSuggestion);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitArtistCompareSearch(compareInput, compareInlineSuggestion);
      return;
    }
    if (event.key === "Escape") {
      compareInlineSuggestion.innerHTML = "";
      hideArtistCompareSuggestions();
    }
  });
  compareSearchBtn.addEventListener("click", () => {
    submitArtistCompareSearch(compareInput, compareInlineSuggestion);
  });
}

function renderArtistFamiliarityView() {
  const barsWrap = document.getElementById("artistFamiliarityBars");
  const meta = document.getElementById("artistFamiliarityMeta");
  const selected = document.getElementById("artistFamiliaritySelected");
  const attemptsDisclaimer = document.getElementById("artistFamiliarityAttemptsDisclaimer");
  if (!barsWrap || !meta || !selected) return;
  renderArtistFamiliarityRightModeButtons();

  if (!artistFamiliarityEntries.length) {
    destroyArtistFamiliarityBarsChart();
    destroyArtistFamiliarityCompareRadarChart();
    meta.innerText = "";
    selected.innerText = "No artist selected";
    if (attemptsDisclaimer) attemptsDisclaimer.style.display = "";
    barsWrap.innerHTML = '<div class="artist-familiarity-empty">No artist familiarity data found.</div>';
    renderArtistFamiliarityRadar({
      nonRigAccuracy: 0,
      rigAccuracy: 0,
      diversity: 0,
      coverage: 0,
      stability: 0,
      consistency: 0
    });
    return;
  }

  if (!selectedArtistName || !getArtistEntryByNameFromCache(selectedArtistName)) {
    selectedArtistName = artistFamiliarityEntries[0].name;
    if (artistFamiliaritySearchInput && !String(artistFamiliaritySearchInput.value || "").trim()) {
      artistFamiliaritySearchInput.value = selectedArtistName;
      artistFamiliaritySearchQuery = selectedArtistName;
    }
  }

  const selectedEntry = getArtistEntryByNameFromCache(selectedArtistName);
  if (!selectedEntry) {
    destroyArtistFamiliarityBarsChart();
    destroyArtistFamiliarityCompareRadarChart();
    meta.innerText = "";
    selected.innerText = "No artist selected";
    barsWrap.innerHTML = '<div class="artist-familiarity-empty">Select an artist from suggestions.</div>';
    renderArtistFamiliarityRadar({
      nonRigAccuracy: 0,
      rigAccuracy: 0,
      diversity: 0,
      coverage: 0,
      stability: 0,
      consistency: 0
    });
    return;
  }

  const selectedEvents = collectArtistEvents(selectedEntry.value || selectedEntry);
  const rows = buildArtistSongBars(selectedEntry.value || selectedEntry);
  const filteredRows = filterAndSortArtistSongRows(
    rows,
    artistFamiliarityAttemptsFilterQuery,
    artistFamiliarityAttemptsSortMode
  );
  const radarMetrics = calculateArtistRadarMetrics(selectedEvents);
  renderArtistFamiliarityRadar(radarMetrics);
  selected.innerText = `Selected artist: ${selectedEntry.name} | Total plays: ${selectedEntry.total || 0} | Unique songs: ${rows.length} | Showing: ${filteredRows.length}`;
  const attemptsTitleText = `All attempts for ${selectedEntry.name}`;
  meta.innerText = "";

  if (artistFamiliarityRightMode === "compare_radar") {
    if (attemptsDisclaimer) attemptsDisclaimer.style.display = "none";
    renderArtistCompareRadarPanel(barsWrap, selectedEntry);
    return;
  }

  if (attemptsDisclaimer) attemptsDisclaimer.style.display = "";
  destroyArtistFamiliarityCompareRadarChart();

  if (!rows.length) {
    destroyArtistFamiliarityBarsChart();
    barsWrap.innerHTML = '<div class="artist-familiarity-empty">No song events found for this artist.</div>';
    return;
  }

  if (!filteredRows.length) {
    destroyArtistFamiliarityBarsChart();
    barsWrap.innerHTML = `
      <div class="artist-familiarity-attempts-title">${escapeHtml(attemptsTitleText)}</div>
      <div class="artist-familiarity-attempts-toolbar">
        <input
          id="artistFamiliarityAttemptsFilterInput"
          class="artist-familiarity-attempts-filter-input"
          type="text"
          placeholder="Search song or anime..."
          value="${escapeHtml(artistFamiliarityAttemptsFilterQuery)}"
        >
        <select id="artistFamiliarityAttemptsSortSelect" class="artist-familiarity-attempts-sort-select">
          <option value="none"${artistFamiliarityAttemptsSortMode === "none" ? " selected" : ""}>Sort: None</option>
          <option value="most_recent"${artistFamiliarityAttemptsSortMode === "most_recent" ? " selected" : ""}>Sort: Most recent</option>
          <option value="least_recent"${artistFamiliarityAttemptsSortMode === "least_recent" ? " selected" : ""}>Sort: Least recent</option>
          <option value="most_correct"${artistFamiliarityAttemptsSortMode === "most_correct" ? " selected" : ""}>Sort: Most correct</option>
          <option value="most_wrong"${artistFamiliarityAttemptsSortMode === "most_wrong" ? " selected" : ""}>Sort: Most wrong</option>
          <option value="most_instability"${artistFamiliarityAttemptsSortMode === "most_instability" ? " selected" : ""}>Sort: Most instability</option>
          <option value="has_rig"${artistFamiliarityAttemptsSortMode === "has_rig" ? " selected" : ""}>Sort: Has rig</option>
          <option value="no_rig"${artistFamiliarityAttemptsSortMode === "no_rig" ? " selected" : ""}>Sort: No rig</option>
        </select>
      </div>
      <div class="artist-familiarity-empty">No songs matched your current search.</div>
    `;
    const filterInput = document.getElementById("artistFamiliarityAttemptsFilterInput");
    const sortSelect = document.getElementById("artistFamiliarityAttemptsSortSelect");
    if (filterInput) {
      filterInput.addEventListener("input", event => {
        artistFamiliarityAttemptsFilterQuery = String(event.target.value || "");
        artistFamiliarityAttemptsShouldRefocusInput = true;
        artistFamiliarityPageIndex = 0;
        renderArtistFamiliarityView();
      });
    }
    if (sortSelect) {
      sortSelect.addEventListener("change", event => {
        artistFamiliarityAttemptsSortMode = String(event.target.value || "none");
        artistFamiliarityPageIndex = 0;
        renderArtistFamiliarityView();
      });
    }
    if (artistFamiliarityAttemptsShouldRefocusInput && filterInput) {
      filterInput.focus();
      const length = filterInput.value.length;
      filterInput.setSelectionRange(length, length);
      artistFamiliarityAttemptsShouldRefocusInput = false;
    }
    return;
  }

  const pageResult = getArtistSongRowsPage(filteredRows, artistFamiliarityPageIndex, ARTIST_FAMILIARITY_PAGE_SIZE);
  artistFamiliarityPageIndex = pageResult.safePageIndex;
  destroyArtistFamiliarityBarsChart();
  barsWrap.innerHTML = `
    <div class="artist-familiarity-attempts-title">${escapeHtml(attemptsTitleText)}</div>
    <div class="artist-familiarity-attempts-toolbar">
      <input
        id="artistFamiliarityAttemptsFilterInput"
        class="artist-familiarity-attempts-filter-input"
        type="text"
        placeholder="Search song or anime..."
        value="${escapeHtml(artistFamiliarityAttemptsFilterQuery)}"
      >
      <select id="artistFamiliarityAttemptsSortSelect" class="artist-familiarity-attempts-sort-select">
        <option value="none"${artistFamiliarityAttemptsSortMode === "none" ? " selected" : ""}>Sort: None</option>
        <option value="most_recent"${artistFamiliarityAttemptsSortMode === "most_recent" ? " selected" : ""}>Sort: Most recent</option>
        <option value="least_recent"${artistFamiliarityAttemptsSortMode === "least_recent" ? " selected" : ""}>Sort: Least recent</option>
        <option value="most_correct"${artistFamiliarityAttemptsSortMode === "most_correct" ? " selected" : ""}>Sort: Most correct</option>
        <option value="most_wrong"${artistFamiliarityAttemptsSortMode === "most_wrong" ? " selected" : ""}>Sort: Most wrong</option>
        <option value="most_instability"${artistFamiliarityAttemptsSortMode === "most_instability" ? " selected" : ""}>Sort: Most instability</option>
        <option value="has_rig"${artistFamiliarityAttemptsSortMode === "has_rig" ? " selected" : ""}>Sort: Has rig</option>
        <option value="no_rig"${artistFamiliarityAttemptsSortMode === "no_rig" ? " selected" : ""}>Sort: No rig</option>
      </select>
    </div>
    <div class="artist-familiarity-matrix">
      <div class="artist-familiarity-matrix-header">
        <span>Song (Y-axis)</span>
        <span>Attempts pattern (X-axis)</span>
      </div>
      <div id="artistFamiliarityPatternRows"></div>
    </div>
    <div class="artist-familiarity-pagination">
      <button id="artistFamiliarityPrevPageBtn" class="artist-familiarity-page-button" type="button" aria-label="Previous page">◀</button>
      <span id="artistFamiliarityPageMeta" class="artist-familiarity-page-meta">Page 1/1</span>
      <button id="artistFamiliarityNextPageBtn" class="artist-familiarity-page-button" type="button" aria-label="Next page">▶</button>
    </div>
  `;
  const patternRowsHost = document.getElementById("artistFamiliarityPatternRows");
  if (patternRowsHost) {
    pageResult.pagedRows.forEach(row => {
      const label = document.createElement("div");
      label.className = "artist-familiarity-matrix-label";
      label.innerHTML = `
        <span class="song">${buildArtistSongLabelHtml(row)}</span>
        <span class="meta">Songs played ${row.total} | Rig ${row.rigCount}</span>
      `;

      const trackWrap = document.createElement("div");
      trackWrap.className = "artist-familiarity-pattern-track";
      trackWrap.appendChild(buildPatternSquareNode((row.marks || []).join(""), { maxPerRow: 28 }));

      const rowEl = document.createElement("div");
      rowEl.className = "artist-familiarity-matrix-row";
      rowEl.appendChild(label);
      rowEl.appendChild(trackWrap);
      patternRowsHost.appendChild(rowEl);
    });
  }

  const filterInput = document.getElementById("artistFamiliarityAttemptsFilterInput");
  const sortSelect = document.getElementById("artistFamiliarityAttemptsSortSelect");
  if (filterInput) {
    filterInput.addEventListener("input", event => {
      artistFamiliarityAttemptsFilterQuery = String(event.target.value || "");
      artistFamiliarityAttemptsShouldRefocusInput = true;
      artistFamiliarityPageIndex = 0;
      renderArtistFamiliarityView();
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener("change", event => {
      artistFamiliarityAttemptsSortMode = String(event.target.value || "none");
      artistFamiliarityPageIndex = 0;
      renderArtistFamiliarityView();
    });
  }
  if (artistFamiliarityAttemptsShouldRefocusInput && filterInput) {
    filterInput.focus();
    const length = filterInput.value.length;
    filterInput.setSelectionRange(length, length);
    artistFamiliarityAttemptsShouldRefocusInput = false;
  }

  bindArtistAnimeHoverTooltip();

  const prevBtn = document.getElementById("artistFamiliarityPrevPageBtn");
  const nextBtn = document.getElementById("artistFamiliarityNextPageBtn");
  const pageMeta = document.getElementById("artistFamiliarityPageMeta");
  if (pageMeta) {
    pageMeta.innerText = `Page ${pageResult.safePageIndex + 1}/${pageResult.totalPages}`;
  }
  if (prevBtn) {
    prevBtn.disabled = pageResult.safePageIndex <= 0;
    prevBtn.addEventListener("click", () => {
      artistFamiliarityPageIndex = Math.max(0, artistFamiliarityPageIndex - 1);
      renderArtistFamiliarityView();
    });
  }
  if (nextBtn) {
    nextBtn.disabled = pageResult.safePageIndex >= pageResult.totalPages - 1;
    nextBtn.addEventListener("click", () => {
      artistFamiliarityPageIndex = Math.min(pageResult.totalPages - 1, artistFamiliarityPageIndex + 1);
      renderArtistFamiliarityView();
    });
  }
}

function getVisibleUserData(userData) {
  if (!dataRangeSelect || dataRangeSelect.value === "all") {
    return userData;
  }

  if (/^\d+$/.test(dataRangeSelect.value)) {
    const selectedCount = Number(dataRangeSelect.value);

    if (!Number.isFinite(selectedCount) || selectedCount <= 0) {
      return userData;
    }

    return userData.slice(-selectedCount);
  }

  const latestRecordDate = new Date(
    userData[userData.length - 1].Timestamp.replace(" ", "T")
  );

  if (Number.isNaN(latestRecordDate.getTime())) {
    return userData;
  }

  const daysByRange = {
    week: 7,
    month: 30,
    "2months": 60,
    "3months": 90,
    "6months": 180
  };

  const days = daysByRange[dataRangeSelect.value];

  if (!days) {
    return userData;
  }

  const cutoff = new Date(latestRecordDate);
  cutoff.setDate(cutoff.getDate() - days);

  return userData.filter(row => {
    const rowDate = new Date(row.Timestamp.replace(" ", "T"));
    return !Number.isNaN(rowDate.getTime()) && rowDate >= cutoff;
  });
}

function getCurrentUserRecords() {
  if (Array.isArray(fullUserData) && fullUserData.length) {
    return fullUserData;
  }
  return Array.isArray(currentStatKey && allPlayerStatsData[currentStatKey])
    ? allPlayerStatsData[currentStatKey]
    : [];
}

function getSocialStatsDataForActiveMode() {
  if (overviewDataSourceMode === "usual" && allPlayerUsualStatsData && typeof allPlayerUsualStatsData === "object") {
    return allPlayerUsualStatsData;
  }
  return allPlayerStatsData && typeof allPlayerStatsData === "object" ? allPlayerStatsData : {};
}

function getCurrentUserRecordsForActiveMode() {
  if (overviewDataSourceMode === "usual") {
    if (Array.isArray(usualUserData) && usualUserData.length) {
      return usualUserData;
    }
    const usualStats = getSocialStatsDataForActiveMode();
    return Array.isArray(currentStatKey && usualStats[currentStatKey])
      ? usualStats[currentStatKey]
      : [];
  }
  return getCurrentUserRecords();
}

function getCurrentUserIdentitySet() {
  const identitySet = new Set();
  const addIdentity = value => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) identitySet.add(normalized);
  };

  addIdentity(username);
  addIdentity(currentDisplayName);
  addIdentity(currentStatKey);
  if (Array.isArray(currentStatSourceKeys)) {
    currentStatSourceKeys.forEach(addIdentity);
  }
  return identitySet;
}

function getCurrentUserStatsRowsForSelectedMode() {
  const currentRows = Array.isArray(fullUserData) && fullUserData.length
    ? fullUserData
    : getCurrentUserRecords();
  const dedupeSeenKeys = new Set();
  const dedupedRows = currentRows.filter(row => {
    if (!row || typeof row !== "object") return false;
    const dedupeKey = [
      String(row.Timestamp || ""),
      String(row["Guess rate"] || ""),
      String(row["OP guess rate"] || ""),
      String(row["ED guess rate"] || ""),
      String(row["IN guess rate"] || ""),
      String(row["Rank"] || ""),
      String(row["Lives saved"] || ""),
      String(row["Lives taken"] || "")
    ].join("|");
    if (dedupeSeenKeys.has(dedupeKey)) return false;
    dedupeSeenKeys.add(dedupeKey);
    return true;
  });
  const sortedRows = sortRecordsByTimestamp(dedupedRows);
  return getVisibleUserData(sortedRows);
}

function getSelectedDataModeLabel() {
  const modeValue = String(dataRangeSelect && dataRangeSelect.value ? dataRangeSelect.value : "all");
  const labels = {
    all: "all target-in games",
    "10": "past 10 target-in games",
    "20": "past 20 target-in games",
    "50": "past 50 target-in games",
    week: "past week (target-in games)",
    month: "past month (target-in games)",
    "2months": "past 2 months (target-in games)",
    "3months": "past 3 months (target-in games)",
    "6months": "past 6 months (target-in games)"
  };
  return labels[modeValue] || "selected mode (target-in games)";
}

function isCurrentUserStatKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return false;
  if (String(currentStatKey || "").trim().toLowerCase() === normalized) return true;
  return Array.isArray(currentStatSourceKeys)
    && currentStatSourceKeys.some(sourceKey => String(sourceKey || "").trim().toLowerCase() === normalized);
}

function getSortableTimestampValue(value) {
  const timestamp = String(value || "").trim();
  if (!timestamp) return Number.NEGATIVE_INFINITY;

  // Legacy historical rows can be DD-MM-YYYY (optionally with HH:mm[:ss]).
  const legacyDmyMatch = timestamp.match(
    /^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (legacyDmyMatch) {
    const day = Number(legacyDmyMatch[1]);
    const month = Number(legacyDmyMatch[2]);
    const year = Number(legacyDmyMatch[3]);
    const hour = Number(legacyDmyMatch[4] || 0);
    const minute = Number(legacyDmyMatch[5] || 0);
    const second = Number(legacyDmyMatch[6] || 0);
    const parsedLegacy = new Date(year, month - 1, day, hour, minute, second);
    return Number.isNaN(parsedLegacy.getTime()) ? Number.NEGATIVE_INFINITY : parsedLegacy.getTime();
  }

  const parsedDate = new Date(timestamp.replace(" ", "T"));
  return Number.isNaN(parsedDate.getTime()) ? Number.NEGATIVE_INFINITY : parsedDate.getTime();
}

function sortRecordsByTimestamp(records) {
  return [...records].sort((a, b) => {
    const timeA = getSortableTimestampValue(a && a.Timestamp);
    const timeB = getSortableTimestampValue(b && b.Timestamp);
    if (timeA !== timeB) return timeA - timeB;
    return String(a && a.Timestamp || "").localeCompare(String(b && b.Timestamp || ""));
  });
}

function formatDateKeyNoZeroPadding(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return "";
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  return `${year}/${month}/${day}`;
}

function normalizeDateQuery(query) {
  const raw = String(query || "").trim();
  if (!raw) {
    return { kind: "empty", value: "" };
  }

  const normalizedSlash = raw.replace(/-/g, "/");
  const parts = normalizedSlash.split("/").map(part => part.trim()).filter(Boolean);
  if (parts.length === 3 && /^\d{4}$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1]) && /^\d{1,2}$/.test(parts[2])) {
    return {
      kind: "ymd",
      value: `${Number(parts[0])}/${Number(parts[1])}/${Number(parts[2])}`
    };
  }
  if (parts.length === 2 && /^\d{1,2}$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1])) {
    return {
      kind: "md",
      value: `${Number(parts[0])}/${Number(parts[1])}`
    };
  }
  return { kind: "text", value: normalizedSlash.toLowerCase() };
}

function buildRowsByTimestampIndex() {
  const index = new Map();
  const activeStatsData = getSocialStatsDataForActiveMode();
  if (!activeStatsData || typeof activeStatsData !== "object") return index;

  Object.values(activeStatsData).forEach(rows => {
    if (!Array.isArray(rows)) return;
    rows.forEach(row => {
      if (!row || typeof row !== "object") return;
      const ts = String(row.Timestamp || "");
      if (!ts) return;
      if (!index.has(ts)) {
        index.set(ts, []);
      }
      index.get(ts).push(row);
    });
  });

  return index;
}

function ensureOriginalTourCalendarData() {
  const activeStatsData = getSocialStatsDataForActiveMode();
  const targetRows = getCurrentUserRecordsForActiveMode();

  otherToolsRowsByTimestamp = buildRowsByTimestampIndex();
  otherToolsCalendarGames = sortRecordsByTimestamp(targetRows)
    .map(row => {
      const ts = String(row && row.Timestamp || "");
      const dateObj = new Date(ts.replace(" ", "T"));
      return {
        timestamp: ts,
        dateObj,
        dateKey: formatDateKeyNoZeroPadding(dateObj)
      };
    })
    .filter(game => game.timestamp && game.dateKey);

  filterOriginalTourGames();

  const defaultGame = otherToolsCalendarFilteredGames.length
    ? otherToolsCalendarFilteredGames[otherToolsCalendarFilteredGames.length - 1]
    : null;
  if (defaultGame) {
    if (!otherToolsCalendarSelectedTimestamp || !otherToolsCalendarFilteredGames.some(game => game.timestamp === otherToolsCalendarSelectedTimestamp)) {
      otherToolsCalendarSelectedTimestamp = defaultGame.timestamp;
    }
    if (!otherToolsCalendarAppliedTimestamp || !otherToolsCalendarFilteredGames.some(game => game.timestamp === otherToolsCalendarAppliedTimestamp)) {
      otherToolsCalendarAppliedTimestamp = otherToolsCalendarSelectedTimestamp;
    }
    const selectedGame = otherToolsCalendarFilteredGames.find(game => game.timestamp === otherToolsCalendarSelectedTimestamp) || defaultGame;
    otherToolsCalendarMonthCursor = new Date(selectedGame.dateObj.getFullYear(), selectedGame.dateObj.getMonth(), 1);
  } else {
    otherToolsCalendarSelectedTimestamp = null;
    otherToolsCalendarAppliedTimestamp = null;
    otherToolsCalendarMonthCursor = new Date();
  }
}

function filterOriginalTourGames() {
  const normalized = normalizeDateQuery(otherToolsCalendarSearchQuery);
  if (normalized.kind === "empty") {
    otherToolsCalendarFilteredGames = [...otherToolsCalendarGames];
    return;
  }

  otherToolsCalendarFilteredGames = otherToolsCalendarGames.filter(game => {
    const key = String(game.dateKey || "");
    if (!key) return false;
    if (normalized.kind === "ymd") return key === normalized.value;
    if (normalized.kind === "md") {
      const keyParts = key.split("/");
      if (keyParts.length < 3) return false;
      const monthDay = `${keyParts[1]}/${keyParts[2]}`;
      return monthDay.startsWith(normalized.value);
    }
    return key.toLowerCase().includes(normalized.value);
  });
}

function getSelectedOriginalTourRows() {
  if (!otherToolsRowsByTimestamp || !(otherToolsRowsByTimestamp instanceof Map)) return [];
  if (!otherToolsCalendarAppliedTimestamp) return [];
  return otherToolsRowsByTimestamp.get(otherToolsCalendarAppliedTimestamp) || [];
}

function getOriginalTourAppliedDateLabel() {
  const appliedTimestamp = String(otherToolsCalendarAppliedTimestamp || "").trim();
  if (!appliedTimestamp) return "selected date";
  const matchingGame = otherToolsCalendarGames.find(game => game.timestamp === appliedTimestamp);
  if (matchingGame && matchingGame.dateKey) return matchingGame.dateKey;

  const parsedDate = new Date(appliedTimestamp.replace(" ", "T"));
  const dateKey = formatDateKeyNoZeroPadding(parsedDate);
  if (dateKey) return dateKey;

  return appliedTimestamp.split(/[ T]/)[0] || "selected date";
}

function getTeamLabelFromRow(row) {
  if (!row || typeof row !== "object") return "Unknown";
  const explicitTeam = Number(row.Team ?? row.team);
  return Number.isFinite(explicitTeam) ? String(explicitTeam) : "Unknown";
}

function renderOriginalTourPlayersPanel() {
  const wrap = document.getElementById("originalTourPlayers");
  if (!wrap) return;

  const rows = getSelectedOriginalTourRows();
  if (!rows.length) {
    wrap.innerHTML = `
      <div class="original-tour-players-title">Players</div>
      <div class="relearn-empty">Select a date/game, then press Select.</div>
    `;
    return;
  }

  const grouped = new Map();
  rows.forEach(row => {
    const team = getTeamLabelFromRow(row);
    if (!grouped.has(team)) grouped.set(team, []);
    grouped.get(team).push(row);
  });

  const teamMetrics = [...grouped.entries()].map(([teamName, teamRows]) => {
    const totals = teamRows.reduce((acc, row) => {
      const wins = Number(row && row.WIN);
      const ties = Number(row && row.TIE);
      const losses = Number(row && row.LOSE);
      acc.wins += Number.isFinite(wins) ? wins : 0;
      acc.ties += Number.isFinite(ties) ? ties : 0;
      acc.losses += Number.isFinite(losses) ? losses : 0;
      return acc;
    }, { wins: 0, ties: 0, losses: 0 });

    const size = Math.max(1, teamRows.length);
    const wins = Math.round(totals.wins / size);
    const ties = Math.round(totals.ties / size);
    const losses = Math.round(totals.losses / size);
    const totalGames = Math.max(1, wins + ties + losses);
    const ratioScore = (wins + ties * 0.5) / totalGames;
    return { teamName, wins, ties, losses, ratioScore };
  });

  const teamNames = teamMetrics
    .sort((a, b) => {
      if (a.wins !== b.wins) return b.wins - a.wins;
      if (a.ties !== b.ties) return b.ties - a.ties;
      if (a.losses !== b.losses) return a.losses - b.losses;
      if (a.ratioScore !== b.ratioScore) return b.ratioScore - a.ratioScore;
      return Number(a.teamName) - Number(b.teamName);
    })
    .map(item => item.teamName);

  const metricByTeam = new Map(teamMetrics.map(item => [item.teamName, item]));
  wrap.innerHTML = '<div class="original-tour-players-title">Players</div>';
  teamNames.forEach(teamName => {
    const teamRows = grouped.get(teamName)
      .slice()
      .sort((a, b) => {
        const rankA = Number(a && a.Rank);
        const rankB = Number(b && b.Rank);
        if (Number.isFinite(rankA) && Number.isFinite(rankB) && rankA !== rankB) return rankB - rankA;
        return String(a && a["Player name"] || "").localeCompare(String(b && b["Player name"] || ""));
      });
    const metric = metricByTeam.get(teamName) || { wins: 0, ties: 0, losses: 0, ratioScore: 0 };
    const ratioText = `W-T-L ${metric.wins}-${metric.ties}-${metric.losses} | ${(metric.ratioScore * 100).toFixed(1)}%`;

    const teamWrap = document.createElement("div");
    teamWrap.className = "original-tour-player-team";

    const line = document.createElement("div");
    line.className = "original-tour-player-row";
    line.innerText = teamRows
      .slice(0, 4)
      .map(row => {
        const playerName = String(row && row["Player name"] || "Unknown");
        const rank = Number(row && row.Rank);
        const rankText = Number.isFinite(rank) ? rank.toFixed(3) : "N/A";
        return `${playerName}(${rankText})`;
      })
      .join(" ");
    line.innerText = `${line.innerText}  |  ${ratioText}`;
    teamWrap.appendChild(line);

    wrap.appendChild(teamWrap);
  });
}

function renderOriginalTourGameList() {
  const list = document.getElementById("originalTourGameList");
  if (!list) return;

  list.innerHTML = "";
  const gamesDesc = [...otherToolsCalendarFilteredGames].sort((a, b) => b.dateObj - a.dateObj);
  if (!gamesDesc.length) {
    list.innerHTML = '<div class="relearn-empty" style="padding:10px;">No games match the date search.</div>';
    return;
  }

  gamesDesc.forEach(game => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "original-tour-game-item";
    if (game.timestamp === otherToolsCalendarSelectedTimestamp) {
      btn.classList.add("active");
    }
    btn.innerText = `${game.dateKey} ${game.timestamp.split(" ")[1] || ""}`.trim();
    btn.addEventListener("click", () => {
      otherToolsCalendarSelectedTimestamp = game.timestamp;
      otherToolsCalendarMonthCursor = new Date(game.dateObj.getFullYear(), game.dateObj.getMonth(), 1);
      renderOriginalTourCalendarView();
    });
    list.appendChild(btn);
  });
}

function renderOriginalTourCalendarGrid() {
  const grid = document.getElementById("originalTourCalendarGrid");
  const monthLabel = document.getElementById("originalTourMonthLabel");
  if (!grid || !monthLabel) return;
  if (!(otherToolsCalendarMonthCursor instanceof Date) || Number.isNaN(otherToolsCalendarMonthCursor.getTime())) {
    otherToolsCalendarMonthCursor = new Date();
  }

  const year = otherToolsCalendarMonthCursor.getFullYear();
  const month = otherToolsCalendarMonthCursor.getMonth();
  monthLabel.innerText = `${year}/${String(month + 1).padStart(2, "0")}`;

  const gamesByDateKey = new Map();
  otherToolsCalendarFilteredGames.forEach(game => {
    if (!gamesByDateKey.has(game.dateKey)) gamesByDateKey.set(game.dateKey, []);
    gamesByDateKey.get(game.dateKey).push(game);
  });

  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  grid.innerHTML = weekdayLabels.map(label => `<div class="original-tour-calendar-weekday">${label}</div>`).join("");

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const leadingBlankDays = firstDay.getDay();
  for (let i = 0; i < leadingBlankDays; i++) {
    const blank = document.createElement("div");
    blank.className = "original-tour-day";
    blank.style.visibility = "hidden";
    grid.appendChild(blank);
  }

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const dateObj = new Date(year, month, day);
    const dateKey = formatDateKeyNoZeroPadding(dateObj);
    const games = gamesByDateKey.get(dateKey) || [];
    const cell = document.createElement("div");
    cell.className = "original-tour-day";
    cell.innerHTML = `<div>${day}</div>`;

    if (games.length) {
      cell.classList.add("has-game");
      const count = document.createElement("div");
      count.className = "original-tour-day-count";
      count.innerText = String(games.length);
      cell.appendChild(count);

      if (games.some(game => game.timestamp === otherToolsCalendarSelectedTimestamp)) {
        cell.classList.add("selected");
      }

      cell.addEventListener("click", () => {
        const preferred = games.find(game => game.timestamp === otherToolsCalendarSelectedTimestamp);
        const selectedGame = preferred || games[games.length - 1];
        otherToolsCalendarSelectedTimestamp = selectedGame.timestamp;
        renderOriginalTourCalendarView();
      });
    }

    grid.appendChild(cell);
  }
}

function renderOriginalTourRawDataTable() {
  const wrap = document.getElementById("originalTourRawDataWrap");
  const statsCard = document.getElementById("originalTourStatsSheetCard");
  const statsTitle = document.getElementById("originalTourStatsTitle");
  if (!wrap) return;

  const rows = getSelectedOriginalTourRows();
  if (!rows.length) {
    if (statsCard) statsCard.style.display = "none";
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  if (statsTitle) {
    statsTitle.innerText = `Export Stats for ${getOriginalTourAppliedDateLabel()}`;
  }

  const parseNumericCellValue = (value) => {
    if (value == null || value === "") return null;
    const normalized = String(value).replace(/,/g, "").replace(/%/g, "").trim();
    if (!normalized) return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const derivedRows = rows.map(row => {
    if (!row || typeof row !== "object") return row;
    const nextRow = { ...row };
    if (nextRow["size vs rig rate"] == null || nextRow["size vs rig rate"] === "") {
      const size = parseNumericCellValue(nextRow.size);
      const rigRate = parseNumericCellValue(nextRow["Rig %"]);
      nextRow["size vs rig rate"] = size == null || rigRate == null || rigRate === 0
        ? null
        : Number((size / rigRate).toFixed(3));
    }
    return nextRow;
  });

  const columnSet = new Set();
  derivedRows.forEach(row => {
    Object.keys(row || {}).forEach(key => columnSet.add(key));
  });
  const columns = [...columnSet];
  const sizeVsRigRateColumnIndex = columns.indexOf("size vs rig rate");
  if (sizeVsRigRateColumnIndex >= 0) {
    columns.splice(sizeVsRigRateColumnIndex, 1);
  }
  if (sizeVsRigRateColumnIndex >= 0 || derivedRows.some(row => row && (row.size != null || row["Rig %"] != null))) {
    columns.push("size vs rig rate");
  }
  if (!columns.length) {
    if (statsCard) statsCard.style.display = "none";
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }

  const sortedRows = derivedRows.slice().sort((a, b) => {
    const guessRateCandidates = ["Guess rate", "Guess Rate", "Guess rate (%)", "Guess Rate (%)"];
    const getGuessRateValue = (row) => {
      for (const key of guessRateCandidates) {
        const value = parseNumericCellValue(row && row[key]);
        if (value != null) return value;
      }
      return null;
    };

    const guessRateA = getGuessRateValue(a);
    const guessRateB = getGuessRateValue(b);
    if (guessRateA != null && guessRateB != null && guessRateA !== guessRateB) {
      return guessRateB - guessRateA;
    }

    const rankA = Number(a && a.Rank);
    const rankB = Number(b && b.Rank);
    if (Number.isFinite(rankA) && Number.isFinite(rankB) && rankA !== rankB) return rankA - rankB;
    return String(a && a["Player name"] || "").localeCompare(String(b && b["Player name"] || ""));
  });

  const noHeatKeywords = [
    "rank",
    "total songs",
    "tie",
    "rigs hit",
    "rigs missed",
    "avg/8 of your rigs",
    "team"
  ];
  const forceHeatKeywords = [
    "offlist erigs",
    "lives lost on rig",
    "lives lost on rigs",
    "lived lost on rig",
    "op rigs missed",
    "ed rigs missed",
    "in rigs missed"
  ];
  const shouldSkipHeatForColumn = (columnName) => {
    const normalized = String(columnName || "").trim().toLowerCase();
    if (forceHeatKeywords.some(keyword => normalized.includes(keyword))) return false;
    if (normalized === "size") return true;
    if (normalized === "rigs") return true;
    if (normalized.includes("rig %") || normalized.includes("rig%")) return true;
    return noHeatKeywords.some(keyword => normalized.includes(keyword));
  };
  const inverseHeatKeywords = [
    "0/8s",
    "7/8s",
    "avg/8",
    "lose",
    "missed solos",
    "rigs missed",
    "lives lost on rig",
    "lives lost on rigs",
    "lived lost on rig",
    "size vs rig rate",
    "op rigs missed",
    "ed rigs missed",
    "in rigs missed"
  ];
  const shouldInvertHeatForColumn = (columnName) => {
    const normalized = String(columnName || "").trim().toLowerCase();
    return inverseHeatKeywords.some(keyword => normalized.includes(keyword));
  };
  const shouldSkipExtremeColorForColumn = (columnName) => {
    const normalized = String(columnName || "").trim().toLowerCase();
    if (!normalized) return true;
    if (["win", "lose", "tie", "size", "list size"].includes(normalized)) return true;
    return [
      "player",
      "player name",
      "name",
      "rank",
      "team",
      "total hit",
      "total hits",
      "total song",
      "total songs",
      "timestamp",
      "date",
      "tourid",
      "tour id",
      "json",
      "sheet",
      "url"
    ].some(keyword => normalized === keyword || normalized.includes(keyword));
  };
  const displayColumnName = (columnName) => {
    const original = String(columnName || "");
    const normalized = original.trim().toLowerCase();
    return normalized === "size" ? "list size" : original;
  };
  const computeMedian = (values) => {
    if (!Array.isArray(values) || !values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  };
  const getColumnNumericValues = (col) => sortedRows
    .map(row => parseNumericCellValue(row && row[col]))
    .filter(value => value != null);
  const getExtremeStats = (values, invert) => {
    if (!Array.isArray(values) || values.length < 3) return null;
    const bestSorted = values.slice().sort((a, b) => invert ? a - b : b - a);
    const worstSorted = values.slice().sort((a, b) => invert ? b - a : a - b);
    const bestCutoff = bestSorted[Math.min(2, bestSorted.length - 1)];
    const worstCutoff = worstSorted[Math.min(2, worstSorted.length - 1)];
    return { bestCutoff, worstCutoff };
  };

  const numericStatsByColumn = new Map();
  const extremeStatsByColumn = new Map();
  columns.forEach(col => {
    const values = getColumnNumericValues(col);
    if (!values.length) return;

    if (!shouldSkipHeatForColumn(col)) {
      const median = computeMedian(values);
      if (median != null) {
        const maxAbsDelta = Math.max(...values.map(value => Math.abs(value - median)));
        numericStatsByColumn.set(col, { median, maxAbsDelta });
      }
    }

    if (!shouldSkipExtremeColorForColumn(col)) {
      const stats = getExtremeStats(values, shouldInvertHeatForColumn(col));
      if (stats) extremeStatsByColumn.set(col, stats);
    }
  });

  const toGradientHeatStyle = (col, rawValue) => {
    if (shouldSkipHeatForColumn(col)) return "";
    const stats = numericStatsByColumn.get(col);
    if (!stats || !Number.isFinite(stats.maxAbsDelta) || stats.maxAbsDelta <= 0) return "";
    const numericValue = parseNumericCellValue(rawValue);
    if (numericValue == null) return "";

    const delta = numericValue - stats.median;
    const effectiveDelta = shouldInvertHeatForColumn(col) ? -delta : delta;
    const strength = Math.min(1, Math.abs(effectiveDelta) / stats.maxAbsDelta);
    if (strength <= 0) return "";
    // Spread from white to the same endpoint colors used by Top/Bottom 3.
    const easedStrength = 0.18 + 0.82 * Math.pow(strength, 1.05);
    const [targetR, targetG, targetB] = effectiveDelta >= 0 ? [90, 189, 138] : [237, 122, 115];
    const r = Math.round(255 + (targetR - 255) * easedStrength);
    const g = Math.round(255 + (targetG - 255) * easedStrength);
    const b = Math.round(255 + (targetB - 255) * easedStrength);
    return `background-color: rgb(${r}, ${g}, ${b}) !important;`;
  };
  const toExtremeHeatStyle = (col, rawValue) => {
    const stats = extremeStatsByColumn.get(col);
    if (!stats) return "";
    const numericValue = parseNumericCellValue(rawValue);
    if (numericValue == null) return "";
    const invert = shouldInvertHeatForColumn(col);
    const isBest = invert
      ? numericValue <= stats.bestCutoff
      : numericValue >= stats.bestCutoff;
    const isWorst = invert
      ? numericValue >= stats.worstCutoff
      : numericValue <= stats.worstCutoff;
    if (isBest && !isWorst) return "background-color: #5abd8a !important;";
    if (isWorst && !isBest) return "background-color: #ed7a73 !important;";
    return "";
  };
  const toCellStyle = (col, rawValue, rowIndex) => {
    const heatStyle = originalTourColorMode === "extremes"
      ? toExtremeHeatStyle(col, rawValue)
      : toGradientHeatStyle(col, rawValue);
    if (heatStyle) return ` style="${heatStyle}"`;
    if (originalTourColorMode === "extremes" && rowIndex % 2 === 1) {
      return ' style="background-color: #E8E8E8 !important;"';
    }
    return "";
  };

  const thead = `<thead><tr>${columns.map(col => `<th>${escapeHtml(displayColumnName(col))}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${sortedRows.map((row, rowIndex) => `<tr>${columns.map(col => {
    const value = String(row && row[col] != null ? row[col] : "");
    return `<td${toCellStyle(col, value, rowIndex)}>${value}</td>`;
  }).join("")}</tr>`).join("")}</tbody>`;
  wrap.innerHTML = `<table class="original-tour-raw-table">${thead}${tbody}</table>`;
  if (statsCard) statsCard.style.display = "block";
  wrap.style.display = "block";
  updateOriginalTourRawStickyColumnOffsets(wrap);
}

function updateOriginalTourRawStickyColumnOffsets(wrapEl = null) {
  const wrap = wrapEl || document.getElementById("originalTourRawDataWrap");
  if (!wrap || wrap.style.display === "none") return;
  const table = wrap.querySelector(".original-tour-raw-table");
  if (!table) return;

  const measureColumnWidth = (index) => {
    const selector = `tr > *:nth-child(${index})`;
    const cells = table.querySelectorAll(selector);
    let maxWidth = 0;
    cells.forEach(cell => {
      const cellWidth = Math.ceil(cell.getBoundingClientRect().width);
      if (cellWidth > maxWidth) maxWidth = cellWidth;
    });
    return maxWidth;
  };

  const col1Width = measureColumnWidth(1);
  const col2Width = measureColumnWidth(2);
  if (col1Width > 0) {
    wrap.style.setProperty("--original-tour-sticky-col1-width", `${col1Width}px`);
  }
  if (col2Width > 0) {
    wrap.style.setProperty("--original-tour-sticky-col2-width", `${col2Width}px`);
  }
}

function renderOriginalTourCalendarView() {
  const meta = document.getElementById("originalTourMeta");

  if (!otherToolsCalendarFilteredGames.some(game => game.timestamp === otherToolsCalendarSelectedTimestamp)) {
    const fallback = otherToolsCalendarFilteredGames.length
      ? otherToolsCalendarFilteredGames[otherToolsCalendarFilteredGames.length - 1]
      : null;
    otherToolsCalendarSelectedTimestamp = fallback ? fallback.timestamp : null;
    if (fallback) {
      otherToolsCalendarMonthCursor = new Date(fallback.dateObj.getFullYear(), fallback.dateObj.getMonth(), 1);
    }
  }

  if (meta) {
    meta.innerText = `Found ${otherToolsCalendarFilteredGames.length} games`;
  }
  if (!otherToolsCalendarFilteredGames.some(game => game.timestamp === otherToolsCalendarAppliedTimestamp)) {
    otherToolsCalendarAppliedTimestamp = otherToolsCalendarSelectedTimestamp;
  }

  renderOriginalTourGameList();
  renderOriginalTourPlayersPanel();
  renderOriginalTourCalendarGrid();
  renderOriginalTourRawDataTable();
  updateOriginalTourSelectButtonState();
}

function updateOriginalTourSelectButtonState() {
  if (!originalTourSelectBtn) return;
  const hasSelected = Boolean(otherToolsCalendarSelectedTimestamp);
  const hasPendingSelection = otherToolsCalendarSelectedTimestamp !== otherToolsCalendarAppliedTimestamp;
  originalTourSelectBtn.disabled = !hasSelected || !hasPendingSelection;
}

function resolveNumericMetricValue(row, key) {
  if (!row || typeof row !== "object" || !key) return null;
  const aliasByMetric = {
    Onlist: ["Onlist", "On list", "onlist", "on list"],
    Offlist: ["Offlist", "Off list", "offlist", "off list"]
  };
  const candidateKeys = aliasByMetric[key] || [key];
  const resolvedKey = candidateKeys.find(candidate => row[candidate] != null && row[candidate] !== "");
  const raw = resolvedKey ? row[resolvedKey] : null;
  if (raw == null || raw === "") return null;
  const normalized = String(raw).replace(/%/g, "").trim();
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatMetricValueByName(metricName, value) {
  const numeric = Number(value || 0);
  const isRate = /rate|%/i.test(String(metricName || ""));
  return isRate ? `${formatMetricNumber(numeric)}%` : formatMetricNumber(numeric);
}

function ensureSocialTeamContributionData() {
  const activeStatsData = getSocialStatsDataForActiveMode();
  const targetRows = getCurrentUserRecordsForActiveMode();

  socialTeamRowsByTimestamp = buildRowsByTimestampIndex();
  socialTeamGames = sortRecordsByTimestamp(targetRows)
    .map(row => {
      const ts = String(row && row.Timestamp || "");
      const dateObj = new Date(ts.replace(" ", "T"));
      return {
        timestamp: ts,
        dateObj,
        dateKey: formatDateKeyNoZeroPadding(dateObj)
      };
    })
    .filter(game => game.timestamp && game.dateKey);

  filterSocialTeamContributionGames();

  const latestVisibleGame = socialTeamFilteredGames.length
    ? socialTeamFilteredGames[socialTeamFilteredGames.length - 1]
    : null;

  if (!socialTeamSelectedTimestamp || !socialTeamFilteredGames.some(game => game.timestamp === socialTeamSelectedTimestamp)) {
    socialTeamSelectedTimestamp = latestVisibleGame ? latestVisibleGame.timestamp : null;
  }

  if (!socialTeamAppliedTimestamp || !socialTeamFilteredGames.some(game => game.timestamp === socialTeamAppliedTimestamp)) {
    socialTeamAppliedTimestamp = socialTeamSelectedTimestamp;
  }

  const hasValidCursor = socialTeamMonthCursor instanceof Date && !Number.isNaN(socialTeamMonthCursor.getTime());
  if (!hasValidCursor) {
    const cursorSource = socialTeamGames.find(game => game.timestamp === socialTeamSelectedTimestamp) || latestVisibleGame;
    if (cursorSource) {
      socialTeamMonthCursor = new Date(cursorSource.dateObj.getFullYear(), cursorSource.dateObj.getMonth(), 1);
    } else {
      socialTeamMonthCursor = new Date();
    }
  }
}

function filterSocialTeamContributionGames() {
  const normalized = normalizeDateQuery(socialTeamSearchQuery);
  if (normalized.kind === "empty") {
    socialTeamFilteredGames = [...socialTeamGames];
    return;
  }

  socialTeamFilteredGames = socialTeamGames.filter(game => {
    const key = String(game.dateKey || "");
    if (!key) return false;
    if (normalized.kind === "ymd") return key === normalized.value;
    if (normalized.kind === "md") {
      const keyParts = key.split("/");
      if (keyParts.length < 3) return false;
      const monthDay = `${keyParts[1]}/${keyParts[2]}`;
      return monthDay.startsWith(normalized.value);
    }
    return key.toLowerCase().includes(normalized.value);
  });
}

function getRowsForSocialTeamTimestamp(timestamp) {
  if (!socialTeamRowsByTimestamp || !(socialTeamRowsByTimestamp instanceof Map)) return [];
  if (!timestamp) return [];
  return socialTeamRowsByTimestamp.get(timestamp) || [];
}

function getSocialTeamPlayersForTimestamp(timestamp) {
  const rows = getRowsForSocialTeamTimestamp(timestamp);
  const byPlayer = new Map();
  rows.forEach(row => {
    const playerName = String(row && row["Player name"] || "").trim();
    if (!playerName) return;
    byPlayer.set(playerName, row);
  });
  return [...byPlayer.values()];
}

function getCurrentSocialTeamPlayerRow(players, timestamp) {
  if (!Array.isArray(players) || !players.length) return null;

  const candidateNames = new Set();
  const addCandidateName = value => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) candidateNames.add(normalized);
  };
  addCandidateName(currentDisplayName);
  addCandidateName(currentStatKey);

  const currentRecords = getCurrentUserRecordsForActiveMode();
  const exactCurrentRecord = currentRecords.find(row => String(row && row.Timestamp || "").trim() === String(timestamp || "").trim());
  if (exactCurrentRecord) {
    addCandidateName(exactCurrentRecord["Player name"]);
  }

  return players.find(row => {
    const normalized = String(row && row["Player name"] || "").trim().toLowerCase();
    return candidateNames.has(normalized);
  }) || null;
}

function renderSocialTeamContributionSummaryCards() {
  const wrap = document.getElementById("socialTeamSummaryCards");
  if (!wrap) return;

  const players = getSocialTeamPlayersForTimestamp(socialTeamAppliedTimestamp);
  if (!socialTeamAppliedTimestamp || !players.length) {
    wrap.innerHTML = "";
    return;
  }

  const currentPlayerRow = getCurrentSocialTeamPlayerRow(players, socialTeamAppliedTimestamp);
  if (!currentPlayerRow) {
    wrap.innerHTML = "";
    return;
  }

  const rigsHit = resolveNumericMetricValue(currentPlayerRow, "Rigs hit");
  const totalSongs = resolveNumericMetricValue(currentPlayerRow, "Total songs");
  const rigCarriedPercent = Number.isFinite(rigsHit) && Number.isFinite(totalSongs) && totalSongs > 0
    ? (rigsHit / totalSongs) * 100
    : null;
  const rigCarriedValue = rigCarriedPercent == null ? "N/A" : `${rigCarriedPercent.toFixed(2)}%`;

  const livesTaken = resolveNumericMetricValue(currentPlayerRow, "Lives taken");
  const livesSaved = resolveNumericMetricValue(currentPlayerRow, "Lives saved");
  const hasUniqueValues = Number.isFinite(livesTaken) || Number.isFinite(livesSaved);
  const uniqueContrib = hasUniqueValues ? (Number(livesTaken || 0) + Number(livesSaved || 0)) : null;
  const uniqueValue = uniqueContrib == null
    ? "N/A"
    : formatCompactNumber(uniqueContrib);

  wrap.innerHTML = `
    <div class="social-team-summary-card">
      <div class="social-team-summary-title">Rig carried</div>
      <div class="social-team-summary-value">${escapeHtml(rigCarriedValue)}</div>
    </div>
    <div class="social-team-summary-card">
      <div class="social-team-summary-title">Solo carried</div>
      <div class="social-team-summary-value">${escapeHtml(uniqueValue)}</div>
    </div>
  `;
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return "N/A";
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

function getSocialTeamTierInfo(index, totalCount) {
  const safeTotal = Math.max(1, Number(totalCount || 0));
  const tierCount = SOCIAL_TEAM_FIXED_TIER_COUNT;
  const bucketSize = Math.max(1, Math.ceil(safeTotal / tierCount));
  const tierIndex = Math.min(tierCount, Math.floor(index / bucketSize) + 1);
  const tierStartIndex = (tierIndex - 1) * bucketSize;
  const withinTierIndex = Math.max(0, Number(index || 0) - tierStartIndex);
  const remainingInTier = safeTotal - tierStartIndex;
  const tierSize = Math.max(1, Math.min(bucketSize, remainingInTier));

  let slotLabel = "average";
  if (tierSize <= 1) {
    slotLabel = "high";
  } else if (tierSize === 2) {
    slotLabel = withinTierIndex === 0 ? "high" : "low";
  } else {
    let highCount = Math.max(1, Math.floor((tierSize + 1) / 3));
    let lowCount = Math.max(1, Math.floor((tierSize + 1) / 3));
    if (highCount + lowCount > tierSize) {
      lowCount = Math.max(1, tierSize - highCount);
    }
    if (withinTierIndex < highCount) {
      slotLabel = "high";
    } else if (withinTierIndex >= tierSize - lowCount) {
      slotLabel = "low";
    }
  }

  return {
    tierLabel: `T${tierIndex}`,
    slotLabel,
    tierIndex,
    tierCount,
    withinTierIndex: Math.min(withinTierIndex, Math.max(0, tierSize - 1)),
    tierSize
  };
}

function getSocialTeamTierPalette(tierIndex, tierCount) {
  if (tierIndex === 1) {
    return {
      bright: ["#b2ecff", "#47c9ff", "#1a88ff"],
      normal: ["#9edfff", "#2faef6", "#2167db"],
      dark: ["#75b8e8", "#2286cf", "#184f9e"]
    };
  }
  if (tierIndex === 2) {
    return {
      bright: ["#fff0b3", "#f2c35f", "#d79426"],
      normal: ["#ffe39a", "#d9a441", "#b7791f"],
      dark: ["#e0c174", "#aa7a27", "#7b531a"]
    };
  }
  if (tierIndex === 3) {
    return {
      bright: ["#f8fbff", "#dbe2ef", "#b8c4d8"],
      normal: ["#edf2fa", "#c5cedf", "#97a3bb"],
      dark: ["#d5dce9", "#9aa6bd", "#6f7a92"]
    };
  }
  if (tierIndex === tierCount) {
    return {
      bright: ["#fff1e2", "#dfa87c", "#b66b40"],
      normal: ["#f6e2cf", "#c9855a", "#9e5a37"],
      dark: ["#e4c7ad", "#a96f4c", "#744225"]
    };
  }
  return {
    bright: ["#eceff4", "#cfd6e4", "#a7b2c5"],
    normal: ["#e2e8f0", "#b8c1d5", "#8a96ad"],
    dark: ["#cfd8e3", "#9eabc0", "#6d778b"]
  };
}

function getSocialTeamBarTone(entry) {
  const tierSlot = String(entry && entry.tierSlot || "").trim().toLowerCase();
  if (tierSlot === "high") return "bright";
  if (tierSlot === "low") return "dark";
  return "normal";
}

function getSocialTeamBarVisual(entry) {
  const tierIndex = Number(entry && entry.tierIndex || 1);
  const tierCount = Number(entry && entry.tierCount || 1);
  const tone = getSocialTeamBarTone(entry);
  const palette = getSocialTeamTierPalette(tierIndex, tierCount);
  const stops = palette[tone] || palette.normal;
  return {
    stops,
    border: stops[2] || stops[stops.length - 1] || "#334155"
  };
}

function createSocialTeamBarGradient(chart, entry) {
  const visual = getSocialTeamBarVisual(entry);
  const ctx = chart && chart.ctx;
  const chartArea = chart && chart.chartArea;
  if (!ctx || !chartArea) return visual.stops[1] || visual.stops[0] || "#94a3b8";
  const gradient = ctx.createLinearGradient(chartArea.right, chartArea.top, chartArea.left, chartArea.top);
  gradient.addColorStop(0, visual.stops[0]);
  gradient.addColorStop(0.55, visual.stops[1]);
  gradient.addColorStop(1, visual.stops[2]);
  return gradient;
}

function parseSocialTeamRankNumber(value) {
  const parsed = Number(String(value == null ? "" : value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function resolveSocialTeamRankFromStatsRow(playerName, timestamp) {
  const normalizedName = String(playerName || "").trim().toLowerCase();
  if (!normalizedName) return Number.NEGATIVE_INFINITY;
  const activeStatsData = getSocialStatsDataForActiveMode();
  if (!activeStatsData || typeof activeStatsData !== "object") return Number.NEGATIVE_INFINITY;

  const matchedKey = Object.keys(activeStatsData).find(key => String(key || "").trim().toLowerCase() === normalizedName);
  if (!matchedKey) return Number.NEGATIVE_INFINITY;

  const records = Array.isArray(activeStatsData[matchedKey]) ? activeStatsData[matchedKey] : [];
  if (!records.length) return Number.NEGATIVE_INFINITY;

  const targetTimestamp = String(timestamp || "").trim();
  if (targetTimestamp) {
    const exactRow = records.find(row => String(row && row.Timestamp || "").trim() === targetTimestamp);
    if (exactRow) {
      const exactRank = parseSocialTeamRankNumber(exactRow.Rank ?? exactRow.rank);
      if (Number.isFinite(exactRank)) return exactRank;
    }
  }

  let bestTimestamp = Number.NEGATIVE_INFINITY;
  let bestRank = Number.NEGATIVE_INFINITY;
  records.forEach(row => {
    const rankValue = parseSocialTeamRankNumber(row && (row.Rank ?? row.rank));
    if (!Number.isFinite(rankValue)) return;
    const timestampValue = getSortableTimestampValue(row && row.Timestamp);
    if (timestampValue >= bestTimestamp) {
      bestTimestamp = timestampValue;
      bestRank = rankValue;
    }
  });

  return Number.isFinite(bestRank) ? bestRank : Number.NEGATIVE_INFINITY;
}

function resolveSocialTeamRankValue(row) {
  if (!row || typeof row !== "object") return Number.NEGATIVE_INFINITY;
  const playerName = String(row["Player name"] || "").trim();
  const timestamp = String(row.Timestamp || "").trim();
  const statsRank = resolveSocialTeamRankFromStatsRow(playerName, timestamp);
  if (Number.isFinite(statsRank)) return statsRank;
  return parseSocialTeamRankNumber(row.Rank ?? row.rank);
}

function getSocialPlacementSlotLabel(index, totalCount) {
  const total = Math.max(1, Number(totalCount || 0));
  const safeIndex = Math.min(Math.max(0, Number(index || 0)), total - 1);
  if (total === 1) return "high";
  if (total === 2) return safeIndex === 0 ? "high" : "low";

  let highCount = Math.max(1, Math.floor(total / 3));
  let lowCount = Math.max(1, Math.floor(total / 3));
  if (highCount + lowCount >= total) {
    if (highCount >= lowCount && highCount > 1) {
      highCount -= 1;
    } else if (lowCount > 1) {
      lowCount -= 1;
    }
  }

  if (safeIndex < highCount) return "high";
  if (safeIndex >= total - lowCount) return "low";
  return "average";
}

function getSocialTeamOriginalPlacementLevel(timestamp) {
  const players = getSocialTeamPlayersForTimestamp(timestamp);
  if (!players.length) return null;

  const candidateNames = new Set();
  const addCandidateName = value => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) candidateNames.add(normalized);
  };
  addCandidateName(currentDisplayName);
  addCandidateName(currentStatKey);

  const currentRecords = getCurrentUserRecordsForActiveMode();
  const exactCurrentRecord = currentRecords.find(row => String(row && row.Timestamp || "").trim() === String(timestamp || "").trim());
  if (exactCurrentRecord) {
    addCandidateName(exactCurrentRecord["Player name"]);
  }

  const currentRow = players.find(row => {
    const normalized = String(row && row["Player name"] || "").trim().toLowerCase();
    return candidateNames.has(normalized);
  });
  if (!currentRow) return null;
  const currentRowName = String(currentRow["Player name"] || "").trim().toLowerCase();
  if (!currentRowName) return null;

  const playersWithTeam = players.filter(row => Number.isFinite(Number(row.Team ?? row.team)));
  if (!playersWithTeam.length) return null;

  const byTeam = new Map();
  playersWithTeam.forEach(row => {
    const teamValue = Number(row.Team ?? row.team);
    if (!byTeam.has(teamValue)) byTeam.set(teamValue, []);
    byTeam.get(teamValue).push(row);
  });

  const nativeTierByPlayerName = new Map();
  byTeam.forEach(teamRows => {
    const sortedTeamRows = [...teamRows].sort((a, b) => {
      const rankA = resolveSocialTeamRankValue(a);
      const rankB = resolveSocialTeamRankValue(b);
      if (rankA !== rankB) return rankB - rankA;
      return String(a && a["Player name"] || "").localeCompare(String(b && b["Player name"] || ""));
    });

    sortedTeamRows.forEach((row, index) => {
      const name = String(row && row["Player name"] || "").trim().toLowerCase();
      if (!name) return;
      nativeTierByPlayerName.set(name, getSocialTeamTierInfo(index, sortedTeamRows.length).tierIndex);
    });
  });

  const targetNativeTier = nativeTierByPlayerName.get(currentRowName);
  if (!Number.isFinite(targetNativeTier) || targetNativeTier < 1) return null;

  const sameNativeTierRows = playersWithTeam
    .filter(row => {
      const name = String(row && row["Player name"] || "").trim().toLowerCase();
      return nativeTierByPlayerName.get(name) === targetNativeTier;
    })
    .sort((a, b) => {
      const rankA = resolveSocialTeamRankValue(a);
      const rankB = resolveSocialTeamRankValue(b);
      if (rankA !== rankB) return rankB - rankA;
      return String(a && a["Player name"] || "").localeCompare(String(b && b["Player name"] || ""));
    });

  const targetIndex = sameNativeTierRows.findIndex(row =>
    String(row && row["Player name"] || "").trim().toLowerCase() === currentRowName
  );
  if (targetIndex < 0) return null;

  const slotLabel = getSocialPlacementSlotLabel(targetIndex, sameNativeTierRows.length);
  return `${slotLabel} T${targetNativeTier}`;
}

function renderSocialTeamOriginalPlacementText() {
  const placementEl = document.getElementById("socialTeamOriginalPlacement");
  if (!placementEl) return;

  if (!socialTeamAppliedTimestamp) {
    placementEl.innerText = "For this tour, you were placed at -.";
    return;
  }

  const currentRecords = getCurrentUserRecordsForActiveMode();
  const hasCurrentRecordAtTimestamp = ts =>
    !!String(ts || "").trim()
    && currentRecords.some(row => String(row && row.Timestamp || "").trim() === String(ts || "").trim());

  let placementTimestamp = socialTeamAppliedTimestamp;
  if (!hasCurrentRecordAtTimestamp(placementTimestamp) && hasCurrentRecordAtTimestamp(socialTeamSelectedTimestamp)) {
    placementTimestamp = socialTeamSelectedTimestamp;
  }
  if (!hasCurrentRecordAtTimestamp(placementTimestamp) && currentRecords.length) {
    const sortedCurrentRecords = sortRecordsByTimestamp(currentRecords);
    placementTimestamp = String(sortedCurrentRecords[sortedCurrentRecords.length - 1] && sortedCurrentRecords[sortedCurrentRecords.length - 1].Timestamp || "");
  }

  const levelText = getSocialTeamOriginalPlacementLevel(placementTimestamp);
  if (!levelText) {
    placementEl.innerText = "For this tour, you were placed at an unknown level.";
    return;
  }

  placementEl.innerText = `For this tour, you were placed at a ${levelText} level.`;
}

function buildSocialTeamContributionRanking(players, metricKey) {
  const isLegacyTieBreakMetric = metricKey === "Lives taken"
    || metricKey === "Lives saved"
    || metricKey === "Usefulness";

  const entries = players
    .map(row => {
      const primaryValue = resolveNumericMetricValue(row, metricKey);
      if (!Number.isFinite(primaryValue)) return null;
      const livesTaken = resolveNumericMetricValue(row, "Lives taken") || 0;
      const livesSaved = resolveNumericMetricValue(row, "Lives saved") || 0;
      const usefulness = resolveNumericMetricValue(row, "Usefulness") || 0;
      return {
        playerName: String(row && row["Player name"] || "Unknown"),
        team: getTeamLabelFromRow(row),
        primaryValue,
        tieMetric: livesTaken + livesSaved,
        usefulness
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.primaryValue !== b.primaryValue) return b.primaryValue - a.primaryValue;
      if (isLegacyTieBreakMetric) {
        if (a.tieMetric !== b.tieMetric) return b.tieMetric - a.tieMetric;
        if (a.usefulness !== b.usefulness) return b.usefulness - a.usefulness;
      } else {
        if (a.usefulness !== b.usefulness) return b.usefulness - a.usefulness;
      }
      return a.playerName.localeCompare(b.playerName);
    });

  return entries.map((entry, index) => {
    const tierInfo = getSocialTeamTierInfo(index, entries.length);
    return {
      ...entry,
      position: index + 1,
      tier: tierInfo.tierLabel,
      tierSlot: tierInfo.slotLabel,
      tierIndex: tierInfo.tierIndex,
      tierCount: tierInfo.tierCount,
      withinTierIndex: tierInfo.withinTierIndex,
      tierSize: tierInfo.tierSize
    };
  });
}

function formatMetricNumber(value) {
  if (!Number.isFinite(value)) return "N/A";
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function renderSocialTeamContributionGameList() {
  const list = document.getElementById("socialTeamGameList");
  if (!list) return;

  list.innerHTML = "";
  const gamesDesc = [...socialTeamFilteredGames].sort((a, b) => b.dateObj - a.dateObj);
  if (!gamesDesc.length) {
    list.innerHTML = '<div class="social-team-empty" style="padding:8px;">No games match the date search.</div>';
    return;
  }

  gamesDesc.forEach(game => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "social-team-game-item";
    if (game.timestamp === socialTeamSelectedTimestamp) {
      btn.classList.add("active");
    }
    btn.innerText = `${game.dateKey} ${game.timestamp.split(" ")[1] || ""}`.trim();
    btn.addEventListener("click", () => {
      socialTeamSelectedTimestamp = game.timestamp;
      socialTeamMonthCursor = new Date(game.dateObj.getFullYear(), game.dateObj.getMonth(), 1);
      renderSocialTeamContributionView();
    });
    list.appendChild(btn);
  });
}

function renderSocialTeamContributionCalendarGrid() {
  const grid = document.getElementById("socialTeamCalendarGrid");
  const monthLabel = document.getElementById("socialTeamMonthLabel");
  if (!grid || !monthLabel) return;
  if (!(socialTeamMonthCursor instanceof Date) || Number.isNaN(socialTeamMonthCursor.getTime())) {
    socialTeamMonthCursor = new Date();
  }

  const year = socialTeamMonthCursor.getFullYear();
  const month = socialTeamMonthCursor.getMonth();
  monthLabel.innerText = `${year}/${String(month + 1).padStart(2, "0")}`;

  const gamesByDateKey = new Map();
  socialTeamFilteredGames.forEach(game => {
    if (!gamesByDateKey.has(game.dateKey)) gamesByDateKey.set(game.dateKey, []);
    gamesByDateKey.get(game.dateKey).push(game);
  });

  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  grid.innerHTML = weekdayLabels.map(label => `<div class="social-team-calendar-weekday">${label}</div>`).join("");

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const leadingBlankDays = firstDay.getDay();
  for (let i = 0; i < leadingBlankDays; i++) {
    const blank = document.createElement("div");
    blank.className = "social-team-day";
    blank.style.visibility = "hidden";
    grid.appendChild(blank);
  }

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const dateObj = new Date(year, month, day);
    const dateKey = formatDateKeyNoZeroPadding(dateObj);
    const games = gamesByDateKey.get(dateKey) || [];
    const cell = document.createElement("div");
    cell.className = "social-team-day";
    cell.innerHTML = `<div>${day}</div>`;

    if (games.length) {
      cell.classList.add("has-game");
      const count = document.createElement("div");
      count.className = "social-team-day-count";
      count.innerText = String(games.length);
      cell.appendChild(count);

      if (games.some(game => game.timestamp === socialTeamSelectedTimestamp)) {
        cell.classList.add("selected");
      }

      cell.addEventListener("click", () => {
        const preferred = games.find(game => game.timestamp === socialTeamSelectedTimestamp);
        const selectedGame = preferred || games[games.length - 1];
        socialTeamSelectedTimestamp = selectedGame.timestamp;
        renderSocialTeamContributionView();
      });
    }

    grid.appendChild(cell);
  }
}

function renderSocialTeamContributionRankings() {
  const wrap = document.getElementById("socialTeamRankingsWrap");
  const selectedGameEl = document.getElementById("socialTeamSelectedGame");
  if (!wrap || !selectedGameEl) return;

  socialTeamMetricCharts.forEach(chart => {
    if (chart && typeof chart.destroy === "function") {
      chart.destroy();
    }
  });
  socialTeamMetricCharts = [];

  const players = getSocialTeamPlayersForTimestamp(socialTeamAppliedTimestamp);
  if (!socialTeamAppliedTimestamp || !players.length) {
    selectedGameEl.innerText = "Selected game: none";
    wrap.innerHTML = '<div class="social-team-empty">Select a game to generate team contribution tiers.</div>';
    return;
  }

  selectedGameEl.innerText = `Selected game: ${socialTeamAppliedTimestamp}`;
  const availableMetrics = SOCIAL_TEAM_CONTRIBUTION_METRICS.filter(metric =>
    players.some(row => Number.isFinite(resolveNumericMetricValue(row, metric)))
  );

  if (!availableMetrics.length) {
    wrap.innerHTML = '<div class="social-team-empty">No metric values found for this game.</div>';
    return;
  }

  wrap.innerHTML = "";
  const targetIdentitySet = getCurrentUserIdentitySet();
  const isCurrentUserEntry = entry => {
    const normalizedName = String(entry && entry.playerName || "").trim().toLowerCase();
    if (!normalizedName) return false;
    if (targetIdentitySet.has(normalizedName)) return true;

    const directoryEntry = getPlayerEntryFromCacheByName(normalizedName);
    if (!directoryEntry || typeof directoryEntry !== "object") return false;

    const candidateKeys = [
      directoryEntry.username,
      directoryEntry.playerName,
      directoryEntry.displayName,
      ...(Array.isArray(directoryEntry.altnames) ? directoryEntry.altnames : [])
    ];
    return candidateKeys.some(value => targetIdentitySet.has(String(value || "").trim().toLowerCase()));
  };
  const metricCards = availableMetrics.map((metric, metricIndex) => {
    const ranking = buildSocialTeamContributionRanking(players, metric);
    const canvasId = `socialTeamMetricChart_${metricIndex}`;

    const currentPlayerEntry = ranking.find(item => isCurrentUserEntry(item));
    const targetDataIndex = ranking.findIndex(item => isCurrentUserEntry(item));

    const summaryText = currentPlayerEntry
      ? `You performed at a <span class="tier">${currentPlayerEntry.tierSlot} ${currentPlayerEntry.tier}</span> level.`
      : "You were not found in the selected game rows.";
    const chartRowHeight = 22;
    const chartHeight = Math.max(320, ranking.length * chartRowHeight);

    const card = document.createElement("div");
    card.className = "social-team-metric-card";
    card.innerHTML = `
      <div class="social-team-metric-title">${escapeHtml(metric)}</div>
      <div class="social-team-metric-summary">${summaryText}</div>
      <div class="social-team-metric-chart-wrap" style="height:${chartHeight}px !important;">
        <canvas id="${canvasId}"></canvas>
      </div>
    `;
    wrap.appendChild(card);

    const labels = ranking.map((item, index) => {
      const marker = index === targetDataIndex ? "◆ " : "";
      return `${item.position}. ${marker}${item.playerName} (${item.tierSlot} ${item.tier})`;
    });
    const values = ranking.map(item => item.primaryValue);
    const targetRowHighlightPlugin = {
      id: `socialTeamTargetRowHighlight_${metricIndex}`,
      beforeDatasetsDraw(chart) {
        if (targetDataIndex < 0) return;
        const yScale = chart && chart.scales && chart.scales.y;
        const chartArea = chart && chart.chartArea;
        if (!yScale || !chartArea) return;

        const y = yScale.getPixelForValue(targetDataIndex);
        const spacing = yScale.ticks.length > 1
          ? Math.abs(yScale.getPixelForValue(1) - yScale.getPixelForValue(0))
          : 24;
        const halfHeight = Math.max(9, spacing * 0.42);
        const left = Math.max(0, yScale.left - 170);
        const right = chartArea.left - 8;
        const width = right - left;
        if (!(width > 0)) return;

        const ctx = chart.ctx;
        ctx.save();

        const bandGradient = ctx.createLinearGradient(left, 0, right, 0);
        bandGradient.addColorStop(0, "rgba(56, 189, 248, 0.10)");
        bandGradient.addColorStop(0.55, "rgba(14, 165, 233, 0.20)");
        bandGradient.addColorStop(1, "rgba(14, 165, 233, 0)");
        ctx.fillStyle = bandGradient;
        ctx.fillRect(left, y - halfHeight, width, halfHeight * 2);
        ctx.restore();
      }
    };

    const chart = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: metric,
            data: values,
            backgroundColor: function(context) {
              const entry = ranking[Number(context.dataIndex || 0)];
              return createSocialTeamBarGradient(context.chart, entry);
            },
            borderColor: function(context) {
              const entry = ranking[Number(context.dataIndex || 0)];
              return getSocialTeamBarVisual(entry).border;
            },
            borderWidth: 1.6,
            borderRadius: 5
          }
        ]
      },
      plugins: [targetRowHighlightPlugin],
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                const entry = ranking[Number(context.dataIndex || 0)];
                if (!entry) return `${metric}: ${formatMetricValueByName(metric, Number(context.raw || 0))}`;
                return `${metric}: ${formatMetricValueByName(metric, entry.primaryValue)} | ${entry.tierSlot} ${entry.tier}`;
              },
              afterLabel: function(context) {
                const entry = ranking[Number(context.dataIndex || 0)];
                if (!entry) return "";
                const isLegacyTieBreakMetric = metric === "Lives taken"
                  || metric === "Lives saved"
                  || metric === "Usefulness";
                if (isLegacyTieBreakMetric) {
                  return `Tie-break: ${formatMetricNumber(entry.tieMetric)} | Usefulness: ${formatMetricNumber(entry.usefulness)}`;
                }
                return `Tie-break: Usefulness ${formatMetricNumber(entry.usefulness)}`;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: {
              color: "#475569",
              callback: function(value) {
                const isRateMetric = /rate|%/i.test(String(metric || ""));
                return isRateMetric ? `${Number(value).toFixed(0)}%` : value;
              }
            },
            grid: { color: "#e5e7eb" }
          },
          y: {
            ticks: {
              autoSkip: false,
              color: function(context) {
                return Number(context.index || -1) === targetDataIndex ? "#075985" : "#334155";
              },
              font: function(context) {
                if (Number(context.index || -1) === targetDataIndex) {
                  return { size: 12, weight: "800" };
                }
                return { size: 11, weight: "600" };
              }
            },
            grid: { color: "#f1f5f9" }
          }
        }
      }
    });
    socialTeamMetricCharts.push(chart);
    return card;
  });

  if (!metricCards.length) {
    wrap.innerHTML = '<div class="social-team-empty">No ranking charts available for this game.</div>';
  }
}

function renderSocialTeamContributionView() {
  const meta = document.getElementById("socialTeamContributionMeta");
  if (!meta) return;

  ensureSocialTeamContributionData();

  if (!socialTeamFilteredGames.some(game => game.timestamp === socialTeamSelectedTimestamp)) {
    const fallback = socialTeamFilteredGames.length
      ? socialTeamFilteredGames[socialTeamFilteredGames.length - 1]
      : null;
    socialTeamSelectedTimestamp = fallback ? fallback.timestamp : null;
    if (fallback) {
      socialTeamMonthCursor = new Date(fallback.dateObj.getFullYear(), fallback.dateObj.getMonth(), 1);
    }
  }

  if (socialTeamSearchInput && socialTeamSearchInput.value !== socialTeamSearchQuery) {
    socialTeamSearchInput.value = socialTeamSearchQuery;
  }

  meta.innerText = `Found ${socialTeamFilteredGames.length} games`;
  renderSocialTeamContributionGameList();
  renderSocialTeamContributionCalendarGrid();
  renderSocialTeamOriginalPlacementText();
  renderSocialTeamContributionSummaryCards();
  renderSocialTeamContributionRankings();
  updateSocialTeamSelectButtonState();
}

function getLatestRankForPlayer(playerKeyOrRecords, recordsMaybe = null, mode = getActiveDataSourceMode()) {
  const hasExplicitKey = typeof playerKeyOrRecords === "string";
  const playerKey = hasExplicitKey ? String(playerKeyOrRecords || "") : "";
  const records = hasExplicitKey ? recordsMaybe : playerKeyOrRecords;

  const primaryMode = mode === "usual" ? "usual" : "watched";
  const tryRankMap = (resolvedMode) => {
    const cache = getLatestRankCacheForMode(resolvedMode);
    const rankMap = cache.map;
    if (!(playerKey && rankMap instanceof Map)) return null;
    const mappedRank = Number(rankMap.get(playerKey.toLowerCase()));
    return Number.isFinite(mappedRank) ? mappedRank : null;
  };

  const primaryMappedRank = tryRankMap(primaryMode);
  if (Number.isFinite(primaryMappedRank)) return primaryMappedRank;

  if (!Array.isArray(records) || !records.length) return null;
  const sorted = sortRecordsByTimestamp(records);
  const latest = sorted[sorted.length - 1];
  const rank = Number(latest && latest["Rank"]);
  return Number.isFinite(rank) ? rank : null;
}

function getLatestValidRankForPlayer(playerKeyOrRecords, recordsMaybe = null, mode = getActiveDataSourceMode()) {
  const rankValue = Number(getLatestRankForPlayer(playerKeyOrRecords, recordsMaybe, mode));
  return isValidRankForMode(rankValue, mode) ? rankValue : null;
}

function getLatestRankSnapshotForRows(records, playerKey = "", playerEntry = null, mode = getActiveDataSourceMode()) {
  if (!Array.isArray(records) || !records.length) {
    return { latestRank: null, latestTimestamp: Number.NEGATIVE_INFINITY };
  }

  const primaryMode = mode === "usual" ? "usual" : "watched";
  const tryResolveFromMode = (resolvedMode) => {
    const cache = getLatestRankCacheForMode(resolvedMode);
    const rankMapForSnapshot = cache.map;
    if (!(rankMapForSnapshot instanceof Map && rankMapForSnapshot.size)) return null;
    const canonicalName = String(
      playerEntry && playerEntry.displayName
        ? playerEntry.displayName
        : playerKey || ""
    ).trim();
    const altNames = Array.isArray(playerEntry && playerEntry.altnames)
      ? playerEntry.altnames
      : [];
    const mappedRank = resolveLatestRankFromMap(rankMapForSnapshot, canonicalName, playerKey, altNames, resolvedMode);
    if (isValidRankForMode(mappedRank, resolvedMode)) {
      return {
        latestRank: mappedRank,
        latestTimestamp: Number.POSITIVE_INFINITY
      };
    }
    return null;
  };

  const primarySnapshot = tryResolveFromMode(primaryMode);
  if (primarySnapshot) return primarySnapshot;

  let latestTimestamp = Number.NEGATIVE_INFINITY;
  let latestRank = null;
  records.forEach(row => {
    const timestampValue = getSortableTimestampValue(row && row.Timestamp);
    if (!Number.isFinite(timestampValue)) return;
    const rankValueRaw = Number(row && row["Rank"]);
    const rankValue = isValidRankForMode(rankValueRaw, primaryMode)
      ? rankValueRaw
      : null;
    if (timestampValue > latestTimestamp) {
      latestTimestamp = timestampValue;
      latestRank = rankValue;
      return;
    }
    if (timestampValue === latestTimestamp && Number.isFinite(rankValue) && !Number.isFinite(latestRank)) {
      latestRank = rankValue;
    }
  });

  if (!Number.isFinite(latestRank)) {
    latestRank = getLatestValidRankForPlayer(records, null, mode);
  }
  return {
    latestRank: Number.isFinite(latestRank) ? latestRank : null,
    latestTimestamp
  };
}

function getClosestRivalKeys(targetKey, count = 4) {
  const activeStatsData = getSocialStatsDataForActiveMode();
  if (!targetKey || !activeStatsData || typeof activeStatsData !== "object") return [];
  const activeMode = getActiveDataSourceMode();
  const targetRecordsFromMap = Array.isArray(activeStatsData[targetKey]) ? activeStatsData[targetKey] : [];
  const targetRecords = targetRecordsFromMap.length
    ? targetRecordsFromMap
    : (targetKey === currentStatKey ? getCurrentUserRecordsForActiveMode() : []);
  const targetPlayerEntry = getPlayerEntryFromCacheByName(targetKey);
  const targetRankSnapshot = getLatestRankSnapshotForRows(targetRecords, targetKey, targetPlayerEntry, activeMode);
  const targetRowLatestRank = getLatestValidRankForPlayer(targetRecords, null, activeMode);
  const fallbackTargetRank = getLatestValidRankForPlayer(targetKey, targetRecords, activeMode);
  const targetRank = Number.isFinite(targetRowLatestRank)
    ? targetRowLatestRank
    : (Number.isFinite(targetRankSnapshot.latestRank)
      ? targetRankSnapshot.latestRank
      : fallbackTargetRank);
  if (!Number.isFinite(targetRank)) return [];

  const rivals = Object.entries(activeStatsData)
    .filter(([key, rows]) => (
      key !== targetKey
      && !isCurrentUserStatKey(key)
      && Array.isArray(rows)
      && rows.length
    ))
    .map(([key, rows]) => {
      const playerEntry = getPlayerEntryFromCacheByName(key);
      const rankSnapshot = getLatestRankSnapshotForRows(rows, key, playerEntry, activeMode);
      const latestRank = rankSnapshot.latestRank;
      return {
        key,
        latestRank,
        latestTimestamp: rankSnapshot.latestTimestamp,
        rankDistance: Number.isFinite(latestRank) ? Math.abs(latestRank - targetRank) : Number.POSITIVE_INFINITY
      };
    })
    .filter(item => Number.isFinite(item.latestRank));

  const dedupedByIdentity = new Map();
  rivals.forEach(item => {
    const playerEntry = getPlayerEntryFromCacheByName(item.key);
    const playerId = String(playerEntry && playerEntry.playerId || "").trim();
    const identityKey = playerId ? `id:${playerId}` : `key:${item.key.toLowerCase()}`;
    const existing = dedupedByIdentity.get(identityKey);
    if (!existing) {
      dedupedByIdentity.set(identityKey, item);
      return;
    }
    const shouldReplace =
      item.latestTimestamp > existing.latestTimestamp
      || (
        item.latestTimestamp === existing.latestTimestamp
        && item.rankDistance < existing.rankDistance
      )
      || (
        item.latestTimestamp === existing.latestTimestamp
        && item.rankDistance === existing.rankDistance
        && item.latestRank < existing.latestRank
      )
      || (
        item.latestTimestamp === existing.latestTimestamp
        && item.rankDistance === existing.rankDistance
        && item.latestRank === existing.latestRank
        && item.key.localeCompare(existing.key) < 0
      );
    if (shouldReplace) {
      dedupedByIdentity.set(identityKey, item);
    }
  });

  const dedupedRivals = Array.from(dedupedByIdentity.values()).sort((a, b) => {
    if (a.rankDistance !== b.rankDistance) return a.rankDistance - b.rankDistance;
    if (a.latestRank !== b.latestRank) return a.latestRank - b.latestRank;
    return a.key.localeCompare(b.key);
  });

  const closestKeys = dedupedRivals.slice(0, count).map(item => item.key);
  if (closestKeys.length >= count) return closestKeys;

  const seen = new Set(closestKeys);
  for (let i = 0; i < dedupedRivals.length && closestKeys.length < count; i += 1) {
    const key = dedupedRivals[i] && dedupedRivals[i].key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    closestKeys.push(key);
  }
  return closestKeys;
}

function getClosestAvailableRivalKeys(targetKey, availableEntries, count = 4) {
  const entries = Array.isArray(availableEntries) ? availableEntries : [];
  if (!targetKey || !entries.length) return [];
  const activeMode = getActiveDataSourceMode();
  const activeStatsData = getSocialStatsDataForActiveMode();

  const targetRecordsFromMap = Array.isArray(activeStatsData && activeStatsData[targetKey])
    ? activeStatsData[targetKey]
    : [];
  const targetRecords = targetRecordsFromMap.length
    ? targetRecordsFromMap
    : (targetKey === currentStatKey ? getCurrentUserRecordsForActiveMode() : []);
  const targetPlayerEntry = getPlayerEntryFromCacheByName(targetKey);
  const targetRankSnapshot = getLatestRankSnapshotForRows(targetRecords, targetKey, targetPlayerEntry, activeMode);
  const targetRowLatestRank = getLatestValidRankForPlayer(targetRecords, null, activeMode);
  const fallbackTargetRank = getLatestValidRankForPlayer(targetKey, targetRecords, activeMode);
  const targetRank = Number.isFinite(targetRowLatestRank)
    ? targetRowLatestRank
    : (Number.isFinite(targetRankSnapshot.latestRank)
      ? targetRankSnapshot.latestRank
      : fallbackTargetRank);
  if (!Number.isFinite(targetRank)) return [];

  return entries
    .filter(entry => Number.isFinite(entry && entry.latestRank))
    .map(entry => ({
      key: entry.key,
      latestRank: entry.latestRank,
      rankDistance: Math.abs(entry.latestRank - targetRank)
    }))
    .sort((a, b) => {
      if (a.rankDistance !== b.rankDistance) return a.rankDistance - b.rankDistance;
      if (a.latestRank !== b.latestRank) return a.latestRank - b.latestRank;
      return a.key.localeCompare(b.key);
    })
    .slice(0, count)
    .map(entry => entry.key);
}

function formatSocialRankLabel(rankValue) {
  return Number.isFinite(rankValue) ? rankValue.toFixed(3) : "N/A";
}

function parseSocialRatingSearchQuery(rawQuery) {
  const match = String(rawQuery || "").trim().match(/^(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return null;
  return { operator: match[1], value };
}

function matchesSocialRatingFilter(rankValue, parsedFilter) {
  if (!parsedFilter || !Number.isFinite(rankValue)) return false;
  const value = parsedFilter.value;
  switch (parsedFilter.operator) {
    case "<":
      return rankValue < value;
    case "<=":
      return rankValue <= value;
    case ">":
      return rankValue > value;
    case ">=":
      return rankValue >= value;
    case "=":
      return Math.abs(rankValue - value) < 1e-9;
    default:
      return false;
  }
}

async function loadSocialSynergyData(playerId, modeOverride = null) {
  const targetPlayerId = String(playerId || "").trim();
  if (!targetPlayerId) return null;
  const activeMode = modeOverride === "usual" ? "usual" : (modeOverride === "watched" ? "watched" : getActiveDataSourceMode());
  const cacheKey = `${targetPlayerId}:${activeMode}`;

  if (socialSynergyCacheByKey.has(cacheKey)) {
    return socialSynergyCacheByKey.get(cacheKey);
  }
  if (socialSynergyCachePromiseByKey.has(cacheKey)) {
    return socialSynergyCachePromiseByKey.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      const [classicRes, sharedRes] = await Promise.allSettled([
        fetchPlayerScopedResponse(targetPlayerId, "synergy/synergy_count.json", activeMode),
        fetchPlayerScopedResponse(targetPlayerId, "synergy/synergy_samesongsseen.json", activeMode)
      ]);
      const [targetToOtherRigRes, otherToTargetRigRes, targetToOtherRigNoDuplicatesRes, otherToTargetRigNoDuplicatesRes, rigStatsRes] = activeMode === "watched"
        ? await Promise.allSettled([
            fetchPlayerScopedResponse(targetPlayerId, "synergy/target_to_other_rig_top50.json", activeMode),
            fetchPlayerScopedResponse(targetPlayerId, "synergy/other_to_target_rig_top50.json", activeMode),
            fetchPlayerScopedResponse(targetPlayerId, "synergy/target_to_other_rig_top50_no_duplicates.json", activeMode),
            fetchPlayerScopedResponse(targetPlayerId, "synergy/other_to_target_rig_top50_no_duplicates.json", activeMode),
            fetchPlayerScopedResponse(targetPlayerId, "synergy/synergy_rigstats.json", activeMode)
          ])
        : [null, null, null, null, null];
      const parsePayload = async (result) => {
        if (!result || result.status !== "fulfilled" || !result.value) return null;
        const payload = await result.value.json();
        return payload && typeof payload === "object" ? payload : null;
      };
      const classicPayload = await parsePayload(classicRes);
      const sharedPayload = await parsePayload(sharedRes);
      const targetToOtherRigPayload = await parsePayload(targetToOtherRigRes);
      const otherToTargetRigPayload = await parsePayload(otherToTargetRigRes);
      const targetToOtherRigNoDuplicatesPayload = await parsePayload(targetToOtherRigNoDuplicatesRes);
      const otherToTargetRigNoDuplicatesPayload = await parsePayload(otherToTargetRigNoDuplicatesRes);
      const rigStatsPayload = await parsePayload(rigStatsRes);
      const payload = {
        classic: classicPayload,
        shared: sharedPayload,
        targetToOtherRig: targetToOtherRigPayload,
        otherToTargetRig: otherToTargetRigPayload,
        targetToOtherRigNoDuplicates: targetToOtherRigNoDuplicatesPayload,
        otherToTargetRigNoDuplicates: otherToTargetRigNoDuplicatesPayload,
        rigStats: rigStatsPayload
      };
      socialSynergyCacheByKey.set(cacheKey, payload);
      return payload;
    } catch (err) {
      console.error("Failed loading social synergy data", err);
      socialSynergyCacheByKey.delete(cacheKey);
      return null;
    } finally {
      socialSynergyCachePromiseByKey.delete(cacheKey);
    }
  })();

  socialSynergyCachePromiseByKey.set(cacheKey, requestPromise);
  return requestPromise;
}

function getSocialSynergyMergedRowsFromCache(playerId, modeOverride, synergyPayload) {
  const targetPlayerId = String(playerId || "").trim();
  const activeMode = modeOverride === "usual" ? "usual" : (modeOverride === "watched" ? "watched" : getActiveDataSourceMode());
  const cacheKey = `${targetPlayerId}:${activeMode}`;
  if (targetPlayerId && socialSynergyMergedRowsCacheByKey.has(cacheKey)) {
    return socialSynergyMergedRowsCacheByKey.get(cacheKey);
  }
  const mergedRows = buildMergedSocialSynergyRows(synergyPayload, activeMode);
  if (targetPlayerId) {
    socialSynergyMergedRowsCacheByKey.set(cacheKey, mergedRows);
  }
  return mergedRows;
}

async function preloadSocialSynergyDataForUser(displayName, modeOverride = null) {
  const requestedName = String(displayName || currentDisplayName || currentStatKey || "").trim();
  if (!requestedName) return null;
  const activeMode = modeOverride === "usual" ? "usual" : (modeOverride === "watched" ? "watched" : getActiveDataSourceMode());
  const currentName = String(currentDisplayName || currentStatKey || "").trim();
  let targetPlayerId = requestedName === currentName ? String(currentPlayerId || "").trim() : "";

  if (!targetPlayerId) {
    const playerEntry = await getPlayerEntryByName(requestedName);
    if (playerEntry && playerEntry.playerId) {
      targetPlayerId = String(playerEntry.playerId);
      if (requestedName === currentName) {
        currentPlayerId = targetPlayerId;
        if (!currentDisplayName) {
          currentDisplayName = String(playerEntry.displayName || currentStatKey || requestedName);
        }
      }
    }
  }

  if (!targetPlayerId) return null;
  const synergyPayload = await loadSocialSynergyData(targetPlayerId, activeMode);
  getSocialSynergyMergedRowsFromCache(targetPlayerId, activeMode, synergyPayload);
  return synergyPayload;
}

function preloadSocialSynergyDataForCurrentPlayer(modeOverride = null) {
  return preloadSocialSynergyDataForUser(currentDisplayName || currentStatKey || "", modeOverride);
}

function getSongRowsFromRigSongIds(songIds, songKeyById) {
  if (!Array.isArray(songIds) || !songKeyById || typeof songKeyById !== "object") return [];
  const fallbackMalByAnime = new Map();
  Object.values(songKeyById).forEach((row) => {
    if (!row || typeof row !== "object") return;
    const malIdValue = row.malId != null ? String(row.malId).trim() : "";
    if (!malIdValue) return;
    const animeEnglish = String(row.animeEnglish || "").trim().toLowerCase();
    const animeRomaji = String(row.animeRomaji || "").trim().toLowerCase();
    if (animeEnglish && !fallbackMalByAnime.has(animeEnglish)) fallbackMalByAnime.set(animeEnglish, malIdValue);
    if (animeRomaji && !fallbackMalByAnime.has(animeRomaji)) fallbackMalByAnime.set(animeRomaji, malIdValue);
  });

  const rows = songIds
    .map((songId, index) => {
      const numericId = Number(songId);
      if (!Number.isFinite(numericId)) return null;
      const keyRow = songKeyById[Math.trunc(numericId)];
      if (!keyRow || typeof keyRow !== "object") return null;
      const animeEnglish = String(keyRow.animeEnglish || "");
      const animeRomaji = String(keyRow.animeRomaji || "");
      const directMalId = keyRow.malId != null ? String(keyRow.malId).trim() : "";
      const fallbackMalId = fallbackMalByAnime.get(animeEnglish.trim().toLowerCase())
        || fallbackMalByAnime.get(animeRomaji.trim().toLowerCase())
        || "";
      return {
        rank: index + 1,
        malId: directMalId || fallbackMalId || null,
        anime: String(animeEnglish || animeRomaji || ""),
        animeName: String(animeEnglish || animeRomaji || ""),
        animeEnglish,
        animeRomaji,
        songName: String(keyRow.songName || ""),
        type: String(keyRow.type || ""),
        correctPct: Number(keyRow.correctPct)
      };
    })
    .filter(Boolean);
  return rows;
}

function renderSocialSynergyRigStripById(config) {
  const { cardId, stripId, rows, emptyMessage } = config || {};
  const card = document.getElementById(cardId);
  const strip = document.getElementById(stripId);
  if (!card || !strip) return;

  const safeRows = Array.isArray(rows) ? rows : [];
  card.style.display = "";
  if (!safeRows.length) {
    strip.innerHTML = `<div class="overview-rig-top-songs-empty">${escapeHtml(emptyMessage || "No data found.")}</div>`;
    return;
  }

  strip.innerHTML = "";
  safeRows.forEach((row, index) => {
    const cardNode = document.createElement("div");
    cardNode.className = "overview-rig-top-song-card";

    const rank = document.createElement("p");
    rank.className = "overview-rig-top-song-rank";
    rank.innerText = `#${Number(row.rank) || (index + 1)}`;
    cardNode.appendChild(rank);

    const coverNode = buildInsightsCoverNode(row);
    coverNode.classList.add("overview-rig-top-song-cover");
    cardNode.appendChild(coverNode);

    const anime = document.createElement("p");
    anime.className = "overview-rig-top-song-anime";
    anime.innerText = getLanguageAwareAnimeName(row);
    cardNode.appendChild(anime);

    const songName = document.createElement("p");
    songName.className = "overview-rig-top-song-name";
    songName.innerText = String(row && row.songName ? row.songName : "—");
    cardNode.appendChild(songName);

    const type = document.createElement("p");
    type.className = "overview-rig-top-song-type";
    type.innerText = String(row && row.type ? row.type : "—");
    cardNode.appendChild(type);

    const sub = document.createElement("p");
    sub.className = "overview-rig-top-song-submeta";
    sub.innerText = Number.isFinite(row.correctPct) ? `${row.correctPct.toFixed(1)}% correct` : "—";
    cardNode.appendChild(sub);

    strip.appendChild(cardNode);
  });
}

function syncSocialSynergyRigModeButtons() {
  const targetUniqueActive = socialSynergyTargetRigMode === "unique";
  const otherUniqueActive = socialSynergyOtherRigMode === "unique";
  const buttonPairs = [
    ["socialTargetRigUniqueBtn", targetUniqueActive],
    ["socialTargetRigSharedBtn", !targetUniqueActive],
    ["socialOtherRigUniqueBtn", otherUniqueActive],
    ["socialOtherRigSharedBtn", !otherUniqueActive]
  ];
  buttonPairs.forEach(([id, isActive]) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.classList.toggle("active", Boolean(isActive));
  });
}

function setSocialSynergyRigMode(side, mode, options = {}) {
  const nextMode = mode === "shared" ? "shared" : "unique";
  const normalizedSide = side === "other" ? "other" : "target";
  if (normalizedSide === "target") {
    socialSynergyTargetRigMode = nextMode;
  } else {
    socialSynergyOtherRigMode = nextMode;
  }
  syncSocialSynergyRigModeButtons();
  if (options && options.rerender === false) return;
  renderSocialSynergyRigTables();
}

async function renderSocialSynergyRigTables(modeOverride = null) {
  const extraGrid = document.getElementById("socialSynergyExtraGrid");
  const targetCard = document.getElementById("socialTargetToOtherRigCard");
  const otherCard = document.getElementById("socialOtherToTargetRigCard");
  if (!extraGrid || !targetCard || !otherCard) return;
  const socialSectionEl = document.getElementById("socialSection");
  const activeSocialSubsection = socialSectionEl ? String(socialSectionEl.getAttribute("data-social-subsection") || "") : "";
  if (activeSocialSubsection !== "Synergy") {
    extraGrid.style.display = "none";
    targetCard.style.display = "none";
    otherCard.style.display = "none";
    return;
  }
  syncSocialSynergyRigModeButtons();

  const activeMode = modeOverride === "usual" ? "usual" : (modeOverride === "watched" ? "watched" : getActiveDataSourceMode());
  if (activeMode !== "watched") {
    extraGrid.style.display = "none";
    targetCard.style.display = "none";
    otherCard.style.display = "none";
    return;
  }

  extraGrid.style.display = "";
  targetCard.style.display = "";
  otherCard.style.display = "";

  const noSelection = '<div class="overview-rig-top-songs-empty">Select a player to see songs.</div>';
  const targetStrip = document.getElementById("socialTargetToOtherRigStrip");
  const otherStrip = document.getElementById("socialOtherToTargetRigStrip");
  if (!targetStrip || !otherStrip) return;

  if (!socialSynergySingleSelectedRivalKey || !cachedSocialSynergyRigTables) {
    targetStrip.innerHTML = noSelection;
    otherStrip.innerHTML = noSelection;
    return;
  }

  const selectedRow = (Array.isArray(cachedSocialSynergyRows) ? cachedSocialSynergyRows : [])
    .find(row => getSocialSynergyComparableKey(row) === socialSynergySingleSelectedRivalKey);
  if (!selectedRow) {
    targetStrip.innerHTML = noSelection;
    otherStrip.innerHTML = noSelection;
    return;
  }

  const keyCandidates = [];
  const rivalLabel = String(selectedRow.rivalLabel || "").trim();
  const rivalKey = String(selectedRow.rivalKey || "").trim();
  if (rivalLabel) keyCandidates.push(rivalLabel);
  if (rivalKey && !keyCandidates.includes(rivalKey)) keyCandidates.push(rivalKey);

  const useTargetUniqueRig = socialSynergyTargetRigMode !== "shared";
  const useOtherUniqueRig = socialSynergyOtherRigMode !== "shared";
  const targetToOtherSource = useTargetUniqueRig
    ? (cachedSocialSynergyRigTables.targetToOtherNoDuplicates || cachedSocialSynergyRigTables.targetToOther)
    : cachedSocialSynergyRigTables.targetToOther;
  const otherToTargetSource = useOtherUniqueRig
    ? (cachedSocialSynergyRigTables.otherToTargetNoDuplicates || cachedSocialSynergyRigTables.otherToTarget)
    : cachedSocialSynergyRigTables.otherToTarget;

  const targetToOtherOthers = targetToOtherSource && targetToOtherSource.others
    ? targetToOtherSource.others
    : {};
  const otherToTargetOthers = otherToTargetSource && otherToTargetSource.others
    ? otherToTargetSource.others
    : {};

  const pickSongIds = (bucket) => {
    for (const key of keyCandidates) {
      if (Object.prototype.hasOwnProperty.call(bucket, key) && Array.isArray(bucket[key])) {
        return bucket[key];
      }
    }
    return [];
  };

  await loadMalImageCache();
  const keyById = await loadSongKeyById();
  const targetToOtherRows = getSongRowsFromRigSongIds(pickSongIds(targetToOtherOthers), keyById);
  const otherToTargetRows = getSongRowsFromRigSongIds(pickSongIds(otherToTargetOthers), keyById);

  renderSocialSynergyRigStripById({
    cardId: "socialTargetToOtherRigCard",
    stripId: "socialTargetToOtherRigStrip",
    rows: targetToOtherRows,
    emptyMessage: "No songs found for this player pair."
  });
  renderSocialSynergyRigStripById({
    cardId: "socialOtherToTargetRigCard",
    stripId: "socialOtherToTargetRigStrip",
    rows: otherToTargetRows,
    emptyMessage: "No songs found for this player pair."
  });
}

function getSocialSynergyComparableKey(row) {
  const rivalKey = String(row && row.rivalKey || "").trim();
  if (rivalKey) return rivalKey.toLowerCase();
  return String(row && row.rivalLabel || "").trim().toLowerCase();
}

function mapSynergyComparisons(payload) {
  const map = new Map();
  const comparisons = payload && Array.isArray(payload.comparisons) ? payload.comparisons : [];
  comparisons.forEach((entry) => {
    const rivalKey = String(entry && entry.otherPlayerId || "").trim();
    const rivalLabel = String(entry && entry.otherDisplayName || rivalKey || "Unknown");
    const rivalAltNames = Array.isArray(entry && entry.otherAltNames)
      ? entry.otherAltNames.map(name => String(name || "").trim()).filter(Boolean)
      : [];
    if (!rivalKey && !rivalLabel) return;
    const hasTargetRigCount = Object.prototype.hasOwnProperty.call(entry || {}, "targetRigCount");
    const hasOtherRigCount = Object.prototype.hasOwnProperty.call(entry || {}, "otherRigCount");
    const hasRigMetrics = hasTargetRigCount && hasOtherRigCount;
    map.set((rivalKey || rivalLabel).toLowerCase(), {
      rivalKey,
      rivalLabel,
      rivalAltNames,
      targetOnlyCount: Math.max(0, Number(entry && entry.targetOnlyCount || 0)),
      otherOnlyCount: Math.max(0, Number(entry && entry.otherOnlyCount || 0)),
      overlapCount: Math.max(0, Number(entry && entry.overlapCount || 0)),
      targetRigCount: hasTargetRigCount ? Math.max(0, Number(entry && entry.targetRigCount || 0)) : 0,
      otherRigCount: hasOtherRigCount ? Math.max(0, Number(entry && entry.otherRigCount || 0)) : 0,
      hasRigMetrics
    });
  });
  return map;
}

function buildMergedSocialSynergyRows(synergyPayload, modeOverride = null) {
  const activeMode = modeOverride === "usual" ? "usual" : (modeOverride === "watched" ? "watched" : getActiveDataSourceMode());
  const includeRigMetrics = activeMode !== "usual";
  const classicMap = mapSynergyComparisons(synergyPayload && synergyPayload.classic);
  const sharedMap = mapSynergyComparisons(synergyPayload && synergyPayload.shared);
  const allKeys = new Set([...classicMap.keys(), ...sharedMap.keys()]);
  const rows = [];
  allKeys.forEach((key) => {
    const classic = classicMap.get(key) || null;
    const shared = sharedMap.get(key) || null;
    const base = classic || shared;
    if (!base) return;
    rows.push({
      rivalKey: base.rivalKey,
      rivalLabel: base.rivalLabel,
      rivalAltNames: Array.isArray(base.rivalAltNames) ? base.rivalAltNames.slice() : [],
      targetKnown: Math.max(0, (classic ? classic.targetOnlyCount + classic.overlapCount : 0)),
      rivalKnown: Math.max(0, (classic ? classic.otherOnlyCount + classic.overlapCount : 0)),
      overlapCount: Math.max(0, Number(classic ? classic.overlapCount : (shared ? shared.overlapCount : 0))),
      targetOnlyCount: Math.max(0, Number(classic ? classic.targetOnlyCount : (shared ? shared.targetOnlyCount : 0))),
      otherOnlyCount: Math.max(0, Number(classic ? classic.otherOnlyCount : (shared ? shared.otherOnlyCount : 0))),
      targetRigCount: includeRigMetrics
        ? Math.max(0, Number(classic ? classic.targetRigCount : (shared ? shared.targetRigCount : 0)))
        : 0,
      otherRigCount: includeRigMetrics
        ? Math.max(0, Number(classic ? classic.otherRigCount : (shared ? shared.otherRigCount : 0)))
        : 0,
      hasRigMetrics: includeRigMetrics && Boolean((classic && classic.hasRigMetrics) || (shared && shared.hasRigMetrics)),
      classic,
      shared
    });
  });
  return rows;
}

function createSocialSynergyRowElement(row, targetLabel, rankText = "") {
  const leftExclusive = Math.max(0, Number(row && row.targetOnlyCount || 0));
  const rightExclusive = Math.max(0, Number(row && row.otherOnlyCount || 0));
  const overlapCount = Math.max(0, Number(row && row.overlapCount || 0));
  const targetRigTotal = Math.max(0, Number(row && row.targetRigCount || 0));
  const rivalRigTotal = Math.max(0, Number(row && row.otherRigCount || 0));
  const hasRigMetrics = Boolean(row && row.hasRigMetrics);
  const union = Math.max(1, leftExclusive + overlapCount + rightExclusive);
  const leftPct = (leftExclusive / union) * 100;
  const overlapPct = (overlapCount / union) * 100;
  const rightPct = (rightExclusive / union) * 100;

  const container = document.createElement("div");
  container.className = "social-synergy-row";

  const head = document.createElement("div");
  head.className = "social-synergy-row-head";
  const rigLabelHtml = ` × <span class="social-synergy-rival-label">${escapeHtml(row && row.rivalLabel || "Unknown")}</span>`;
  head.innerHTML = `
    <div class="name">${rankText ? `${rankText} ` : ""}<span class="social-synergy-target-label">${escapeHtml(targetLabel)}</span>${rigLabelHtml}</div>
    <div class="stats">${leftExclusive} | <span class="social-synergy-overlap-pill">${overlapCount}</span> | ${rightExclusive}</div>
  `;

  const bar = document.createElement("div");
  bar.className = "social-synergy-bar";

  const left = document.createElement("div");
  left.className = "social-synergy-left-segment";
  left.style.width = `${leftPct}%`;
  const leftBase = document.createElement("div");
  leftBase.className = "social-synergy-left-base";
  left.appendChild(leftBase);

  const overlap = document.createElement("div");
  overlap.className = "social-synergy-overlap";
  overlap.style.width = `${overlapPct}%`;
  const overlapBase = document.createElement("div");
  overlapBase.className = "social-synergy-overlap-base";
  overlap.appendChild(overlapBase);

  const right = document.createElement("div");
  right.className = "social-synergy-right-segment";
  right.style.width = `${rightPct}%`;
  const rightBase = document.createElement("div");
  rightBase.className = "social-synergy-right-base";
  rightBase.style.width = "100%";
  right.appendChild(rightBase);

  bar.appendChild(left);
  bar.appendChild(overlap);
  bar.appendChild(right);

  // Rig marker overlays intentionally hidden in Synergy bars.

  container.appendChild(head);
  container.appendChild(bar);
  return container;
}

function renderSocialSynergyRows(rows, targetLabel) {
  const list = document.getElementById("socialSynergyList");
  const meta = document.getElementById("socialSynergyMeta");
  if (!list || !meta) return;

  if (!Array.isArray(rows) || !rows.length) {
    meta.innerText = "Found 0 players";
    list.innerHTML = '<div class="social-synergy-empty">No overlap data available.</div>';
    return;
  }

  list.innerHTML = "";
  rows.forEach((row, index) => {
    list.appendChild(createSocialSynergyRowElement(row, targetLabel, `#${index + 1}`));
  });
}

function renderOverviewSynergyRows(rows, targetLabel) {
  const list = document.getElementById("overviewSynergyList");
  const meta = document.getElementById("overviewSynergyMeta");
  if (!list || !meta) return;

  if (!Array.isArray(rows) || !rows.length) {
    meta.innerText = "Found 0 players";
    list.innerHTML = '<div class="social-synergy-empty">No overlap data available.</div>';
    return;
  }

  list.innerHTML = "";
  rows.forEach((row, index) => {
    list.appendChild(createSocialSynergyRowElement(row, targetLabel, `#${index + 1}`));
  });
}

function renderSocialSynergySinglePicker(rows, targetLabel) {
  const searchInput = document.getElementById("socialSynergyPlayerSearchInput");
  const list = document.getElementById("socialSynergyPlayerSearchList");
  const compareWrap = document.getElementById("socialSynergySingleCompare");
  const selectedPlayerText = document.getElementById("socialSynergySelectedPlayer");
  if (!list || !compareWrap) return;
  compareWrap.classList.toggle("usual-mode", getActiveDataSourceMode() === "usual");
  if (searchInput && String(searchInput.value || "").toLowerCase() !== socialSynergySingleSearchQuery) {
    searchInput.value = socialSynergySingleSearchQuery;
  }

  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length) {
    list.innerHTML = '<div class="social-synergy-empty">No players available.</div>';
    compareWrap.innerHTML = '<div class="social-synergy-empty">No comparison selected.</div>';
    if (selectedPlayerText) selectedPlayerText.innerText = "Selected player";
    updateSocialSynergySelectButtonState();
    renderSocialSynergyRigTables();
    return;
  }

  const query = String(socialSynergySingleSearchQuery || "").trim().toLowerCase();
  const filteredRows = sourceRows.filter(row => {
    if (!query) return true;
    const rivalLabel = String(row && row.rivalLabel || "").toLowerCase();
    const rivalKey = String(row && row.rivalKey || "").toLowerCase();
    const altNameMatch = Array.isArray(row && row.rivalAltNames)
      && row.rivalAltNames.some(name => String(name || "").toLowerCase().includes(query));
    return rivalLabel.includes(query) || rivalKey.includes(query) || altNameMatch;
  });

  let selectedRow = sourceRows.find(
    row => getSocialSynergyComparableKey(row) === socialSynergySingleSelectedRivalKey
  ) || null;

  if (!selectedRow && sourceRows.length) {
    const firstRowKey = getSocialSynergyComparableKey(sourceRows[0]);
    socialSynergySingleSelectedRivalKey = firstRowKey;
    socialSynergySinglePendingRivalKey = firstRowKey;
    selectedRow = sourceRows[0];
  }

  if (!socialSynergySinglePendingRivalKey && filteredRows.length) {
    socialSynergySinglePendingRivalKey = getSocialSynergyComparableKey(filteredRows[0]);
  }
  if (selectedPlayerText) {
    if (selectedRow) {
      const selectedRowLabel = selectedRow.rivalLabel || selectedRow.rivalKey || "Selected player";
      selectedPlayerText.innerText = `Selected player: ${selectedRowLabel}`;
    } else {
      selectedPlayerText.innerText = "Selected player";
    }
  }
  updateSocialSynergySelectButtonState();

  if (!filteredRows.length) {
    list.innerHTML = '<div class="social-synergy-empty">No players match your search.</div>';
  } else {
    list.innerHTML = "";
    filteredRows.forEach(row => {
      const rowKey = getSocialSynergyComparableKey(row);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "social-synergy-single-picker-item";
      if (rowKey === socialSynergySinglePendingRivalKey) {
        btn.classList.add("active");
      }
      btn.innerHTML = `
        <span>${escapeHtml(row.rivalLabel || row.rivalKey || "Unknown")}</span>
        <span class="meta">Overlap ${Number(row.overlapCount || 0)}</span>
      `;
      btn.addEventListener("click", () => {
        socialSynergySinglePendingRivalKey = rowKey;
        renderSocialSynergySinglePicker(sourceRows, targetLabel);
      });
      list.appendChild(btn);
    });
    const pickerItems = Array.from(list.querySelectorAll(".social-synergy-single-picker-item"));
    if (!pickerItems.length) {
      list.innerHTML = '<div class="social-synergy-empty">No players match your search.</div>';
    }
  }

  compareWrap.innerHTML = "";
  if (!selectedRow) {
    compareWrap.innerHTML = '<div class="social-synergy-empty">No comparison selected. Click a player then press Select.</div>';
    return;
  }

  const selectedRivalId = String(selectedRow && selectedRow.rivalKey || "").trim();
  const selectedRivalLabel = String(selectedRow && selectedRow.rivalLabel || "").trim().toLowerCase();
  const rigStatsComparisons = Array.isArray(cachedSocialSynergyRigStats && cachedSocialSynergyRigStats.comparisons)
    ? cachedSocialSynergyRigStats.comparisons
    : [];
  const selectedRigStats = rigStatsComparisons.find((entry) => {
    const otherId = String(entry && entry.otherPlayerId || "").trim();
    if (selectedRivalId && otherId && otherId === selectedRivalId) return true;
    const otherName = String(entry && entry.otherDisplayName || "").trim().toLowerCase();
    return Boolean(selectedRivalLabel && otherName && otherName === selectedRivalLabel);
  }) || null;
  const formatRigPct = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0%";
    return `${num.toFixed(3).replace(/\\.0+$/, "").replace(/(\\.\\d*?)0+$/, "$1")}%`;
  };
  const shouldShowWatchedRigStats = getActiveDataSourceMode() === "watched";
  if (shouldShowWatchedRigStats && (selectedRigStats || (cachedSocialSynergyRigStats && typeof cachedSocialSynergyRigStats === "object"))) {
    const rigStatsCard = document.createElement("div");
    rigStatsCard.className = "social-synergy-row social-synergy-stats-card";
    rigStatsCard.style.setProperty("padding", "10px 12px", "important");
    rigStatsCard.style.setProperty("margin-top", "26px", "important");
    rigStatsCard.style.setProperty("margin-bottom", "10px", "important");
    const targetSelfKnownPct = Number(cachedSocialSynergyRigStats && cachedSocialSynergyRigStats.targetSelfKnownPct || 0);
    const otherKnownPct = Number(selectedRigStats && selectedRigStats.otherKnownPct || 0);
    const otherSelfKnownPct = Number(selectedRigStats && selectedRigStats.otherSelfKnownPct || 0);
    const targetKnownPct = Number(selectedRigStats && selectedRigStats.targetKnownPct || 0);
    rigStatsCard.innerHTML = `
      <div class="social-synergy-row-meta" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;font-size:12px;line-height:1.35;">
        <div><strong>Your Onlist:</strong> ${formatRigPct(targetSelfKnownPct)}</div>
        <div><strong>Their Onlist:</strong> ${formatRigPct(otherSelfKnownPct)}</div>
        <div><strong>Them on your list:</strong> ${formatRigPct(otherKnownPct)}</div>
        <div><strong>You on their list:</strong> ${formatRigPct(targetKnownPct)}</div>
      </div>
    `;
    compareWrap.appendChild(rigStatsCard);
  }

  const allSeenTitle = document.createElement("div");
  allSeenTitle.className = "chart-meta";
  allSeenTitle.style.setProperty("margin", "12px 0 8px 0", "important");
  allSeenTitle.style.setProperty("font-weight", "400", "important");
  allSeenTitle.style.setProperty("font-size", "12px", "important");
  allSeenTitle.style.setProperty("text-align", "center", "important");
  allSeenTitle.style.setProperty("white-space", "nowrap", "important");
  allSeenTitle.innerHTML = `
    <span style="display:inline !important; white-space:nowrap !important;">
      All seen songs
      <span class="info-hover-wrap open-left social-synergy-hover-layer" style="display:inline-flex !important; vertical-align:middle !important; margin-left:6px !important;">
        <button class="info-hover-btn" type="button" aria-label="About all seen songs" style="display:inline-flex !important;">i</button>
        <span class="info-hover-tooltip">All seen songs: data pool uses all songs either you or the target player has seen. This means, if you or the target player has played more tours, it is likely that numbers may be inflated just because they have seen more songs.</span>
      </span>
    </span>
  `;
  compareWrap.appendChild(allSeenTitle);
  compareWrap.appendChild(createSocialSynergyRowElement(selectedRow.classic || selectedRow, targetLabel));

  const sharedSeenTitle = document.createElement("div");
  sharedSeenTitle.className = "chart-meta";
  sharedSeenTitle.style.setProperty("margin", "14px 0 8px 0", "important");
  sharedSeenTitle.style.setProperty("font-weight", "400", "important");
  sharedSeenTitle.style.setProperty("font-size", "12px", "important");
  sharedSeenTitle.style.setProperty("text-align", "center", "important");
  sharedSeenTitle.style.setProperty("white-space", "nowrap", "important");
  sharedSeenTitle.innerHTML = `
    <span style="display:inline !important; white-space:nowrap !important;">
      Shared seen songs
      <span class="info-hover-wrap open-left social-synergy-hover-layer" style="display:inline-flex !important; vertical-align:middle !important; margin-left:6px !important;">
        <button class="info-hover-btn" type="button" aria-label="About shared seen songs" style="display:inline-flex !important;">i</button>
        <span class="info-hover-tooltip">Shared seen songs: data pool uses only songs that both of you have seen. This more accurately measures skill on equal terms.</span>
      </span>
    </span>
  `;
  compareWrap.appendChild(sharedSeenTitle);
  if (selectedRow.shared) {
    compareWrap.appendChild(createSocialSynergyRowElement(selectedRow.shared, targetLabel));
  } else {
    const empty = document.createElement("div");
    empty.className = "social-synergy-empty";
    empty.textContent = "No shared-seen comparison data available.";
    compareWrap.appendChild(empty);
  }
}

function renderSocialSynergyTableRows(allRows) {
  const tbody = document.getElementById("socialSynergyTableBody");
  const pageMeta = document.getElementById("socialSynergyPageMeta");
  const prevBtn = document.getElementById("socialSynergyPrevPageBtn");
  const nextBtn = document.getElementById("socialSynergyNextPageBtn");
  if (!tbody || !pageMeta || !prevBtn || !nextBtn) return;

  const rows = Array.isArray(allRows) ? allRows : [];
  const totalPages = Math.max(1, Math.ceil(rows.length / SOCIAL_SYNERGY_PAGE_SIZE));
  socialSynergyPageIndex = Math.min(Math.max(0, socialSynergyPageIndex), totalPages - 1);
  const start = socialSynergyPageIndex * SOCIAL_SYNERGY_PAGE_SIZE;
  const pageRows = rows.slice(start, start + SOCIAL_SYNERGY_PAGE_SIZE);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="social-synergy-empty">No overlap data available.</td></tr>';
    pageMeta.innerText = "Page 1/1";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  tbody.innerHTML = pageRows.map((row, idx) => `
    <tr>
      <td>${start + idx + 1}</td>
      <td>${escapeHtml(row.rivalLabel || row.rivalKey || "Unknown")}</td>
      <td>${Number(row.targetOnlyCount || 0)}</td>
      <td class="search-song-frequency-percentile"><span class="social-synergy-overlap-count-text">${Number(row.overlapCount || 0)}</span></td>
      <td>${Number(row.otherOnlyCount || 0)}</td>
      <td>${row && row.hasRigMetrics ? Number(row.targetRigCount || 0) : "-"}</td>
      <td>${row && row.hasRigMetrics ? Number(row.otherRigCount || 0) : "-"}</td>
    </tr>
  `).join("");

  pageMeta.innerText = `Page ${socialSynergyPageIndex + 1}/${totalPages}`;
  prevBtn.disabled = socialSynergyPageIndex <= 0;
  nextBtn.disabled = socialSynergyPageIndex >= totalPages - 1;
}

async function renderSocialSynergyView() {
  const list = document.getElementById("socialSynergyList");
  const meta = document.getElementById("socialSynergyMeta");
  if (!list || !meta) return;
  socialSynergyTargetRigMode = "unique";
  socialSynergyOtherRigMode = "unique";
  syncSocialSynergyRigModeButtons();
  const requestId = ++socialSynergyRequestId;
  const modeSnapshot = getActiveDataSourceMode();

  if (!currentStatKey) {
    meta.innerText = "No player selected";
    list.innerHTML = '<div class="social-synergy-empty">No player selected.</div>';
    cachedSocialSynergyRows = [];
    socialSynergySingleSelectedRivalKey = "";
    socialSynergySinglePendingRivalKey = "";
    socialSynergyPageIndex = 0;
    renderSocialSynergySinglePicker(cachedSocialSynergyRows, currentDisplayName || currentStatKey || "You");
    renderSocialSynergyTableRows(cachedSocialSynergyRows);
    cachedSocialSynergyRigTables = null;
    cachedSocialSynergyRigStats = null;
    await renderSocialSynergyRigTables(modeSnapshot);
    return;
  }

  if (!currentPlayerId) {
    const playerEntry = await getPlayerEntryByName(currentDisplayName || currentStatKey);
    if (requestId !== socialSynergyRequestId || modeSnapshot !== getActiveDataSourceMode()) return;
    if (playerEntry && playerEntry.playerId) {
      currentPlayerId = String(playerEntry.playerId);
      if (!currentDisplayName) {
        currentDisplayName = String(playerEntry.displayName || currentStatKey);
      }
    }
  }

  if (!currentPlayerId) {
    meta.innerText = "No player selected";
    list.innerHTML = '<div class="social-synergy-empty">Could not resolve player ID for synergy data.</div>';
    cachedSocialSynergyRows = [];
    socialSynergySingleSelectedRivalKey = "";
    socialSynergySinglePendingRivalKey = "";
    socialSynergyPageIndex = 0;
    renderSocialSynergySinglePicker(cachedSocialSynergyRows, currentDisplayName || currentStatKey || "You");
    renderSocialSynergyTableRows(cachedSocialSynergyRows);
    cachedSocialSynergyRigTables = null;
    cachedSocialSynergyRigStats = null;
    await renderSocialSynergyRigTables(modeSnapshot);
    return;
  }

  meta.innerText = "Calculating top overlap...";
  list.innerHTML = '<div class="social-synergy-empty">Calculating top overlap...</div>';

  const synergyPayload = await loadSocialSynergyData(currentPlayerId, modeSnapshot);
  if (requestId !== socialSynergyRequestId || modeSnapshot !== getActiveDataSourceMode()) return;

  const targetLabel = currentDisplayName || currentStatKey;
  const mergedRows = getSocialSynergyMergedRowsFromCache(currentPlayerId, modeSnapshot, synergyPayload);
  cachedSocialSynergyRigTables = {
    targetToOther: synergyPayload && synergyPayload.targetToOtherRig ? synergyPayload.targetToOtherRig : null,
    otherToTarget: synergyPayload && synergyPayload.otherToTargetRig ? synergyPayload.otherToTargetRig : null,
    targetToOtherNoDuplicates: synergyPayload && synergyPayload.targetToOtherRigNoDuplicates ? synergyPayload.targetToOtherRigNoDuplicates : null,
    otherToTargetNoDuplicates: synergyPayload && synergyPayload.otherToTargetRigNoDuplicates ? synergyPayload.otherToTargetRigNoDuplicates : null
  };
  cachedSocialSynergyRigStats = modeSnapshot === "watched" && synergyPayload && synergyPayload.rigStats ? synergyPayload.rigStats : null;
  if (!mergedRows.length) {
    meta.innerText = "Found 0 players";
    list.innerHTML = '<div class="social-synergy-empty">No synergy count data found for this player.</div>';
    cachedSocialSynergyRows = [];
    socialSynergySingleSelectedRivalKey = "";
    socialSynergySinglePendingRivalKey = "";
    socialSynergyPageIndex = 0;
    renderSocialSynergySinglePicker(cachedSocialSynergyRows, targetLabel);
    renderSocialSynergyTableRows(cachedSocialSynergyRows);
    await renderSocialSynergyRigTables(modeSnapshot);
    return;
  }

  const sortedRows = mergedRows
    .filter(row => row && (row.rivalKey || row.rivalLabel))
    .filter(row => (row.targetOnlyCount + row.overlapCount + row.otherOnlyCount) > 0)
    .sort((a, b) => {
      if (a.overlapCount !== b.overlapCount) return b.overlapCount - a.overlapCount;
      if (a.targetOnlyCount !== b.targetOnlyCount) return b.targetOnlyCount - a.targetOnlyCount;
      if (a.rivalKnown !== b.rivalKnown) return b.rivalKnown - a.rivalKnown;
      return a.rivalKey.localeCompare(b.rivalKey);
    });

  const positiveOverlapRows = sortedRows.filter(row => row.overlapCount > 0);
  const topRows = (positiveOverlapRows.length ? positiveOverlapRows : sortedRows).slice(0, 5);
  meta.innerText = `Found ${sortedRows.length} players`;
  renderSocialSynergyRows(topRows, targetLabel);
  cachedSocialSynergyRows = sortedRows;
  if (!socialSynergySinglePendingRivalKey && sortedRows.length) {
    socialSynergySinglePendingRivalKey = getSocialSynergyComparableKey(sortedRows[0]);
  }
  renderSocialSynergySinglePicker(cachedSocialSynergyRows, targetLabel);
  socialSynergyPageIndex = 0;
  renderSocialSynergyTableRows(cachedSocialSynergyRows);
  await renderSocialSynergyRigTables(modeSnapshot);
}

async function renderOverviewSynergySummary() {
  const list = document.getElementById("overviewSynergyList");
  const meta = document.getElementById("overviewSynergyMeta");
  if (!list || !meta) return;
  const requestId = ++overviewSynergyRequestId;
  const modeSnapshot = getActiveDataSourceMode();

  if (!currentStatKey) {
    meta.innerText = "No player selected";
    list.innerHTML = '<div class="social-synergy-empty">No player selected.</div>';
    return;
  }

  if (!currentPlayerId) {
    const playerEntry = await getPlayerEntryByName(currentDisplayName || currentStatKey);
    if (requestId !== overviewSynergyRequestId || modeSnapshot !== getActiveDataSourceMode()) return;
    if (playerEntry && playerEntry.playerId) {
      currentPlayerId = String(playerEntry.playerId);
      if (!currentDisplayName) {
        currentDisplayName = String(playerEntry.displayName || currentStatKey);
      }
    }
  }

  if (!currentPlayerId) {
    meta.innerText = "No player selected";
    list.innerHTML = '<div class="social-synergy-empty">Could not resolve player ID for synergy data.</div>';
    return;
  }

  meta.innerText = "Calculating top overlap...";
  list.innerHTML = '<div class="social-synergy-empty">Calculating top overlap...</div>';

  const synergyPayload = await loadSocialSynergyData(currentPlayerId, modeSnapshot);
  if (requestId !== overviewSynergyRequestId || modeSnapshot !== getActiveDataSourceMode()) return;

  const targetLabel = currentDisplayName || currentStatKey;
  const mergedRows = getSocialSynergyMergedRowsFromCache(currentPlayerId, modeSnapshot, synergyPayload);
  if (!mergedRows.length) {
    meta.innerText = "Found 0 players";
    list.innerHTML = '<div class="social-synergy-empty">No synergy count data found for this player.</div>';
    return;
  }

  const sortedRows = mergedRows
    .filter(row => row && (row.rivalKey || row.rivalLabel))
    .filter(row => (row.targetOnlyCount + row.overlapCount + row.otherOnlyCount) > 0)
    .sort((a, b) => {
      if (a.overlapCount !== b.overlapCount) return b.overlapCount - a.overlapCount;
      if (a.targetOnlyCount !== b.targetOnlyCount) return b.targetOnlyCount - a.targetOnlyCount;
      if (a.rivalKnown !== b.rivalKnown) return b.rivalKnown - a.rivalKnown;
      return a.rivalKey.localeCompare(b.rivalKey);
    });

  const positiveOverlapRows = sortedRows.filter(row => row.overlapCount > 0);
  const topRows = (positiveOverlapRows.length ? positiveOverlapRows : sortedRows).slice(0, 5);
  meta.innerText = `Found ${sortedRows.length} players`;
  renderOverviewSynergyRows(topRows, targetLabel);
}

function getAvailableSocialRivalEntries() {
  const activeStatsData = getSocialStatsDataForActiveMode();
  if (!currentStatKey || !activeStatsData || typeof activeStatsData !== "object") return [];
  const activeMode = getActiveDataSourceMode();
  const currentPlayerEntry = getPlayerEntryFromCacheByName(currentStatKey || currentDisplayName || "");
  const currentPlayerIdResolved = String(
    currentPlayerId
    || (currentPlayerEntry && currentPlayerEntry.playerId)
    || ""
  ).trim();

  const rawEntries = Object.entries(activeStatsData)
    .filter(([key, rows]) => !isCurrentUserStatKey(key) && Array.isArray(rows) && rows.length)
    .map(([key, rows]) => {
      const playerEntry = getPlayerEntryFromCacheByName(key);
      const rankSnapshot = getLatestRankSnapshotForRows(rows, key, playerEntry, activeMode);
      const rowLatestRank = getLatestValidRankForPlayer(rows, null, activeMode);
      let rowLatestTimestamp = Number.NEGATIVE_INFINITY;
      rows.forEach(row => {
        const timestampValue = getSortableTimestampValue(row && row.Timestamp);
        if (Number.isFinite(timestampValue) && timestampValue > rowLatestTimestamp) {
          rowLatestTimestamp = timestampValue;
        }
      });
      const latestRank = Number.isFinite(rowLatestRank)
        ? rowLatestRank
        : rankSnapshot.latestRank;
      const playerId = String(playerEntry && playerEntry.playerId || "").trim();
      return {
        key,
        latestRank,
        latestTimestamp: Number.isFinite(rowLatestRank)
          ? rowLatestTimestamp
          : rankSnapshot.latestTimestamp,
        playerId,
        displayLabel: formatPlayerDisplayWithAliases(playerEntry, key)
      };
    })
    .filter(item => {
      if (!currentPlayerIdResolved || !item.playerId) return true;
      return item.playerId !== currentPlayerIdResolved;
    })
    .filter(item => Number.isFinite(item.latestRank));

  const dedupedByIdentity = new Map();
  rawEntries.forEach(entry => {
    const identityKey = entry.playerId ? `id:${entry.playerId}` : `key:${entry.key.toLowerCase()}`;
    const existing = dedupedByIdentity.get(identityKey);
    if (!existing) {
      dedupedByIdentity.set(identityKey, entry);
      return;
    }
    const shouldReplace =
      entry.latestTimestamp > existing.latestTimestamp
      || (
        entry.latestTimestamp === existing.latestTimestamp
        && entry.latestRank < existing.latestRank
      )
      || (
        entry.latestTimestamp === existing.latestTimestamp
        && entry.latestRank === existing.latestRank
        && entry.key.localeCompare(existing.key) < 0
      );
    if (shouldReplace) {
      dedupedByIdentity.set(identityKey, entry);
    }
  });

  return Array.from(dedupedByIdentity.values()).sort((a, b) => {
    const aLowRankBucket = a.latestRank < 30 ? 1 : 0;
    const bLowRankBucket = b.latestRank < 30 ? 1 : 0;
    if (aLowRankBucket !== bLowRankBucket) return aLowRankBucket - bLowRankBucket;
    if (a.latestRank !== b.latestRank) return a.latestRank - b.latestRank;
    return a.displayLabel.localeCompare(b.displayLabel);
  });
}

function renderSelectedSocialRivalButtons(entriesByKey) {
  const wrap = document.getElementById("socialRivalsSelectedInline");
  if (!wrap) return;

  if (!selectedSocialRivalKeys.length) {
    wrap.innerHTML = '<div class="social-rivals-empty">No selected rivals</div>';
    return;
  }

  wrap.innerHTML = "";
  selectedSocialRivalKeys.forEach(key => {
    const entry = entriesByKey.get(key);
    const entryLabel = entry ? (entry.displayLabel || entry.key) : key;
    const labelText = entry ? `${entryLabel} (${formatSocialRankLabel(entry.latestRank)})` : key;

    const chip = document.createElement("div");
    chip.className = "social-rivals-selected-chip";

    const text = document.createElement("span");
    text.innerText = labelText;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "social-rivals-selected-remove";
    removeBtn.innerText = "−";
    removeBtn.title = `Deselect ${key}`;
    removeBtn.addEventListener("click", () => {
      selectedSocialRivalKeys = selectedSocialRivalKeys.filter(value => value !== key);
      renderSocialRivalFilter();
      if (activeSection === "social" && activeSubSectionBySection.social === "Rivals") {
        renderSocialRivalsChart();
      }
    });

    chip.appendChild(text);
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

function renderSocialRivalFilter() {
  if (!(activeSection === "social" && activeSubSectionBySection.social === "Rivals")) {
    const rivalsTopLayout = document.getElementById("socialRivalsTopLayout");
    const rivalsFilterView = document.getElementById("socialRivalsFilterView");
    const rivalsBubbleView = document.getElementById("socialRivalsBubbleView");
    const rivalsView = document.getElementById("socialRivalsView");
    if (rivalsTopLayout) rivalsTopLayout.style.display = "none";
    if (rivalsFilterView) rivalsFilterView.style.display = "none";
    if (rivalsBubbleView) rivalsBubbleView.style.display = "none";
    if (rivalsView) rivalsView.style.display = "none";
    return;
  }

  const list = document.getElementById("socialRivalCheckboxList");
  const meta = document.getElementById("socialRivalsSelectionMeta");
  if (!list || !meta) return;

  const ownerKey = String(currentStatKey || "").toLowerCase();
  if (ownerKey && socialRivalsSelectionOwnerKey !== ownerKey) {
    selectedSocialRivalKeys = [];
    socialRivalsSelectionOwnerKey = ownerKey;
  }

  const entries = getAvailableSocialRivalEntries();
  const entriesByKey = new Map(entries.map(entry => [entry.key, entry]));
  selectedSocialRivalKeys = selectedSocialRivalKeys.filter(key => entriesByKey.has(key));
  if (!selectedSocialRivalKeys.length && entries.length) {
    selectedSocialRivalKeys = getClosestAvailableRivalKeys(
      currentStatKey,
      entries,
      MAX_SELECTED_SOCIAL_RIVALS
    );
  }

  meta.innerText = selectedSocialRivalKeys.length >= MAX_SELECTED_SOCIAL_RIVALS
    ? `Selected ${selectedSocialRivalKeys.length} rivals (maximum)`
    : `Selected ${selectedSocialRivalKeys.length} rivals`;

  renderSelectedSocialRivalButtons(entriesByKey);

  if (socialRivalSearchInput && socialRivalSearchInput.value.toLowerCase() !== socialRivalSearchQuery) {
    socialRivalSearchInput.value = socialRivalSearchQuery;
  }

  const normalizedSearch = String(socialRivalSearchQuery || "").trim().toLowerCase();
  const parsedRatingFilter = parseSocialRatingSearchQuery(normalizedSearch);
  const visibleEntries = normalizedSearch
    ? entries.filter(entry => {
        const nameMatch = entry.key.toLowerCase().includes(normalizedSearch)
          || String(entry.displayLabel || "").toLowerCase().includes(normalizedSearch);
        const ratingText = formatSocialRankLabel(entry.latestRank).toLowerCase();
        const ratingTextMatch = ratingText.includes(normalizedSearch);
        const ratingFilterMatch = matchesSocialRatingFilter(entry.latestRank, parsedRatingFilter);
        return nameMatch || ratingTextMatch || ratingFilterMatch;
      })
    : entries;

  list.innerHTML = "";
  visibleEntries.forEach(entry => {
    const label = document.createElement("label");
    label.className = "social-rivals-checkbox-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = entry.key;
    input.checked = selectedSocialRivalKeys.includes(entry.key);

    label.appendChild(input);
    const textWrap = document.createElement("span");
    textWrap.className = "social-rival-label-text";
    const fullLabelText = String(entry.displayLabel || entry.key || "");
    const ratingText = ` (${formatSocialRankLabel(entry.latestRank)})`;
    const aliasMatch = fullLabelText.match(/^(.*?)(\s*\[[^\]]+\])$/);
    if (aliasMatch) {
      const mainName = document.createElement("span");
      mainName.className = "social-rival-main-name";
      mainName.innerText = ` ${aliasMatch[1]}${ratingText}`;

      const altNames = document.createElement("span");
      altNames.className = "social-rival-alt-names";
      altNames.innerText = `${aliasMatch[2]}`;

      textWrap.appendChild(mainName);
      textWrap.appendChild(altNames);
    } else {
      const plain = document.createElement("span");
      plain.className = "social-rival-main-name";
      plain.innerText = ` ${fullLabelText}${ratingText}`;
      textWrap.appendChild(plain);
    }
    label.appendChild(textWrap);
    list.appendChild(label);
  });

  if (!visibleEntries.length) {
    list.innerHTML = '<div class="social-rivals-empty">No rivals match your search.</div>';
  }

  list.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener("change", event => {
      const changedKey = String(event.target.value || "");
      const isChecked = Boolean(event.target.checked);

      if (isChecked) {
        if (selectedSocialRivalKeys.includes(changedKey)) return;
        if (selectedSocialRivalKeys.length >= MAX_SELECTED_SOCIAL_RIVALS) {
          event.target.checked = false;
          return;
        }
        selectedSocialRivalKeys = [...selectedSocialRivalKeys, changedKey];
      } else {
        selectedSocialRivalKeys = selectedSocialRivalKeys.filter(key => key !== changedKey);
      }

      renderSocialRivalFilter();
      if (activeSection === "social" && activeSubSectionBySection.social === "Rivals") {
        renderSocialRivalsChart();
      }
    });
  });

  requestAnimationFrame(syncSocialRivalsBubbleHeight);
}

function getSelectedSocialRivalsMetricConfig() {
  const selectedKey = String(socialRivalsMetricKey || "guess_rate");
  if (isSocialRivalsMetricAvailableForActiveMode(selectedKey)) {
    return SOCIAL_RIVALS_METRICS[selectedKey];
  }
  socialRivalsMetricKey = "guess_rate";
  return SOCIAL_RIVALS_METRICS.guess_rate;
}

function isSocialRivalsMetricAvailableForActiveMode(metricKey) {
  const key = String(metricKey || "");
  if (!Object.prototype.hasOwnProperty.call(SOCIAL_RIVALS_METRICS, key)) return false;
  return !(getActiveDataSourceMode() === "usual" && SOCIAL_RIVALS_USUAL_HIDDEN_METRICS.has(key));
}

function syncSocialRivalsMetricOptionsForMode() {
  if (!socialRivalsMetricSelect) return;

  const availableMetricEntries = Object.entries(SOCIAL_RIVALS_METRICS)
    .filter(([key]) => isSocialRivalsMetricAvailableForActiveMode(key));
  const nextMetricKey = isSocialRivalsMetricAvailableForActiveMode(socialRivalsMetricKey)
    ? socialRivalsMetricKey
    : "guess_rate";

  if (socialRivalsMetricKey !== nextMetricKey) {
    socialRivalsMetricKey = nextMetricKey;
  }

  socialRivalsMetricSelect.innerHTML = "";
  availableMetricEntries.forEach(([key, config]) => {
    const option = document.createElement("option");
    option.value = key;
    option.innerText = config.label;
    socialRivalsMetricSelect.appendChild(option);
  });
  socialRivalsMetricSelect.value = socialRivalsMetricKey;
}

function getSocialRivalMainDisplayName(label, fallbackKey) {
  const fallback = String(fallbackKey || "").trim();
  const raw = String(label || fallback).trim();
  if (!raw) return fallback || "Unknown";
  const aliasMatch = raw.match(/^(.*?)(\s*\[[^\]]+\])$/);
  if (!aliasMatch) return raw;
  const main = String(aliasMatch[1] || "").trim();
  return main || raw;
}

function syncSocialRivalsBubbleHeight() {
  const layout = document.getElementById("socialRivalsTopLayout");
  const filterView = document.getElementById("socialRivalsFilterView");
  const bubbleView = document.getElementById("socialRivalsBubbleView");
  if (!layout || !filterView || !bubbleView) return;

  const layoutVisible = layout.style.display !== "none";
  const filterVisible = filterView.style.display !== "none";
  const bubbleVisible = bubbleView.style.display !== "none";
  if (!layoutVisible || !filterVisible || !bubbleVisible) {
    bubbleView.style.height = "";
    return;
  }

  const measuredHeight = Math.ceil(filterView.getBoundingClientRect().height);
  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
    bubbleView.style.height = "";
    return;
  }

  bubbleView.style.height = `${measuredHeight}px`;
}

let socialRivalsHeightObserver = null;
function startSocialRivalsHeightSync() {
  const filterView = document.getElementById("socialRivalsFilterView");
  if (!filterView) return;
  if (socialRivalsHeightObserver) {
    socialRivalsHeightObserver.disconnect();
    socialRivalsHeightObserver = null;
  }
  if (typeof ResizeObserver === "function") {
    socialRivalsHeightObserver = new ResizeObserver(() => {
      syncSocialRivalsBubbleHeight();
    });
    socialRivalsHeightObserver.observe(filterView);
  }
  syncSocialRivalsBubbleHeight();
}

function stopSocialRivalsHeightSync() {
  if (socialRivalsHeightObserver) {
    socialRivalsHeightObserver.disconnect();
    socialRivalsHeightObserver = null;
  }
  const bubbleView = document.getElementById("socialRivalsBubbleView");
  if (bubbleView) {
    bubbleView.style.height = "";
  }
}

function renderSocialRivalsChart() {
  if (!(activeSection === "social" && activeSubSectionBySection.social === "Rivals")) {
    const rivalsTopLayout = document.getElementById("socialRivalsTopLayout");
    const rivalsBubbleView = document.getElementById("socialRivalsBubbleView");
    const rivalsView = document.getElementById("socialRivalsView");
    if (rivalsTopLayout) rivalsTopLayout.style.display = "none";
    if (rivalsBubbleView) rivalsBubbleView.style.display = "none";
    if (rivalsView) rivalsView.style.display = "none";
    return;
  }

  requestAnimationFrame(syncSocialRivalsBubbleHeight);
  const shouldConvertLegacyUsefulness = getActiveDataSourceMode() === "watched";
  if (shouldConvertLegacyUsefulness && !convertUsefulnessEstimator) {
    ensureConvertEstimatorsLoaded().catch(() => {});
  }
  const meta = document.getElementById("socialRivalsMeta");
  const title = document.getElementById("socialRivalsChartTitle");
  const canvas = document.getElementById("socialRivalsChart");
  const bubbleMeta = document.getElementById("socialRivalsBubbleMeta");
  const bubbleCanvas = document.getElementById("socialRivalsBubbleChart");
  if (!meta || !canvas || !bubbleMeta || !bubbleCanvas) return;

  syncSocialRivalsMetricOptionsForMode();
  const metricConfig = getSelectedSocialRivalsMetricConfig();
  if (title) {
    title.innerText = `Rivals ${metricConfig.label} Comparison`;
  }

  if (socialRivalsChart) {
    if (typeof socialRivalsChart.$trendZoomBrushCleanup === "function") {
      socialRivalsChart.$trendZoomBrushCleanup();
    }
    socialRivalsChart.destroy();
    socialRivalsChart = null;
  }
  if (socialRivalsBubbleChart) {
    socialRivalsBubbleChart.destroy();
    socialRivalsBubbleChart = null;
  }

  const activeStatsData = getSocialStatsDataForActiveMode();
  const activeMode = getActiveDataSourceMode();
  const targetRows = getCurrentUserRecordsForActiveMode();
  if (!currentStatKey || !targetRows.length) {
    meta.innerText = "No player selected";
    bubbleMeta.innerText = "No player selected";
    return;
  }

  const targetRankSnapshot = getLatestRankSnapshotForRows(
    targetRows,
    currentStatKey,
    getPlayerEntryFromCacheByName(currentStatKey),
    activeMode
  );
  const targetRowLatestRank = getLatestValidRankForPlayer(targetRows, null, activeMode);
  const targetLatestRank = Number.isFinite(targetRowLatestRank)
    ? targetRowLatestRank
    : targetRankSnapshot.latestRank;
  const selectedKeys = selectedSocialRivalKeys
    .filter(key => !isCurrentUserStatKey(key) && Array.isArray(activeStatsData[key]) && activeStatsData[key].length)
    .slice(0, MAX_SELECTED_SOCIAL_RIVALS);
  const rivalKeys = selectedKeys.length ? selectedKeys : getClosestRivalKeys(currentStatKey, MAX_SELECTED_SOCIAL_RIVALS);
  if (!rivalKeys.length) {
    meta.innerText = "Select at least 1 rival with rank data";
    bubbleMeta.innerText = "Select at least 1 rival with rank data";
    return;
  }

  const targetLabel = getSocialRivalMainDisplayName(currentDisplayName || currentStatKey, currentStatKey);
  const rivalEntriesByKey = new Map(getAvailableSocialRivalEntries().map(entry => [entry.key, entry]));
  const livesMetricsCutoffTimestamp = Date.UTC(2026, 0, 1);
  const shouldApplyLivesCutoff = socialRivalsMetricKey === "lives_saved" || socialRivalsMetricKey === "lives_taken";
  const applyLivesMetricCutoff = (rows) => {
    if (!shouldApplyLivesCutoff) return Array.isArray(rows) ? rows : [];
    return (Array.isArray(rows) ? rows : []).filter(row => {
      const timestamp = String(row && row.Timestamp || "");
      if (!timestamp) return false;
      const sortableTimestamp = getSortableTimestampValue(timestamp);
      return Number.isFinite(sortableTimestamp) && sortableTimestamp >= livesMetricsCutoffTimestamp;
    });
  };
  const seriesPlayers = [
    { key: currentStatKey, label: targetLabel },
    ...rivalKeys.map(key => {
      const rivalEntry = rivalEntriesByKey.get(key);
      const displayLabel = rivalEntry ? (rivalEntry.displayLabel || key) : key;
      return { key, label: getSocialRivalMainDisplayName(displayLabel, key) };
    })
  ];

  const seriesData = seriesPlayers.map(player => {
    const allRowsRaw = player.key === currentStatKey
      ? sortRecordsByTimestamp(targetRows)
      : sortRecordsByTimestamp(activeStatsData[player.key] || []);
    const allRows = applyLivesMetricCutoff(allRowsRaw);
    const visibleRows = getVisibleUserData(allRows);
    return { ...player, rows: visibleRows, allRows };
  });

  const timestampSet = new Set();
  seriesData.forEach(player => {
    player.rows.forEach(row => {
      const metricValue = Number(row && row[metricConfig.field]);
      const timestamp = String(row && row.Timestamp || "");
      if (!timestamp || !Number.isFinite(metricValue)) return;
      timestampSet.add(timestamp);
    });
  });

  const labels = [...timestampSet].sort((a, b) => {
    const timeA = getSortableTimestampValue(a);
    const timeB = getSortableTimestampValue(b);
    if (timeA !== timeB) return timeA - timeB;
    return a.localeCompare(b);
  });

  if (!labels.length) {
    meta.innerText = `No ${metricConfig.label.toLowerCase()} data in selected range`;
    bubbleMeta.innerText = "No guess-rate data in selected range";
    return;
  }

  meta.innerText = "";
  bubbleMeta.innerText = "X: latest rank | Y: average guess rate | Bubble size: avg usefulness (selected range)";
  const rivalsSeriesOpacityScale = getTimeSeriesOpacityScale(labels.length);

  const toRgba = (hexColor, alpha) => {
    const cleaned = String(hexColor || "").replace("#", "");
    if (cleaned.length !== 6) return hexColor;
    const r = Number.parseInt(cleaned.slice(0, 2), 16);
    const g = Number.parseInt(cleaned.slice(2, 4), 16);
    const b = Number.parseInt(cleaned.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const palette = ["#2563eb", "#16a34a", "#f59e0b", "#9333ea", "#ef4444"];
  const hideStaticPoints = true;
  const overviewHoverPointRadius = 5;
  const datasets = seriesData.map((player, index) => {
    const valueMap = new Map();
    player.rows.forEach(row => {
      const timestamp = String(row && row.Timestamp || "");
      const metricValue = Number(row && row[metricConfig.field]);
      if (!timestamp || !Number.isFinite(metricValue)) return;
      valueMap.set(timestamp, metricValue);
    });

    const color = palette[index % palette.length];
    const isTarget = index === 0;
    const baseLineAlpha = 0.28;
    const basePointAlpha = 0.20;
    const targetLineAlpha = 0.92;
    const targetPointAlpha = 0.80;
    const lineAlpha = isTarget ? targetLineAlpha : baseLineAlpha;
    const pointAlpha = isTarget ? targetPointAlpha : basePointAlpha;
    return {
      label: player.label,
      data: labels.map(label => (valueMap.has(label) ? valueMap.get(label) : null)),
      borderColor: withSeriesOpacity(toRgba(color, lineAlpha), rivalsSeriesOpacityScale),
      backgroundColor: withSeriesOpacity(toRgba(color, pointAlpha), rivalsSeriesOpacityScale),
      pointBackgroundColor: withSeriesOpacity(toRgba(color, pointAlpha), rivalsSeriesOpacityScale),
      pointBorderColor: withSeriesOpacity(toRgba(color, pointAlpha), rivalsSeriesOpacityScale),
      _opacityBaseStyles: {
        borderColor: toRgba(color, lineAlpha),
        backgroundColor: toRgba(color, pointAlpha),
        pointBackgroundColor: toRgba(color, pointAlpha),
        pointBorderColor: toRgba(color, pointAlpha)
      },
      pointRadius: hideStaticPoints
        ? (context => (context && context.active ? overviewHoverPointRadius : 0))
        : 2,
      pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 4,
      pointHitRadius: 12,
      borderWidth: 2,
      tension: 0,
      fill: false,
      spanGaps: true
    };
  });

  const plottedValues = datasets
    .flatMap(dataset => dataset.data)
    .map(value => Number(value))
    .filter(value => Number.isFinite(value));
  const minMetricValue = plottedValues.length ? Math.min(...plottedValues) : 0;
  const maxMetricValue = plottedValues.length ? Math.max(...plottedValues) : 100;
  const metricRange = maxMetricValue - minMetricValue;
  const metricPadding = Math.max(1, metricRange * 0.15);
  let yMin = minMetricValue - metricPadding;
  let yMax = maxMetricValue + metricPadding;
  let yTickStep = null;
  const getNiceStep = (rawStep) => {
    if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
    const exponent = Math.floor(Math.log10(rawStep));
    const base = Math.pow(10, exponent);
    const normalized = rawStep / base;
    if (normalized <= 1) return 1 * base;
    if (normalized <= 2) return 2 * base;
    if (normalized <= 5) return 5 * base;
    return 10 * base;
  };
  if (metricConfig.isPercent) {
    // Keep % chart grid consistent: fixed step, and max snapped to a step multiple.
    yMin = 0;
    const boundedMax = Math.min(100, Math.max(1, maxMetricValue));
    // Aim for a tighter, zoomed-in scale (roughly up to ~10 tick steps).
    yTickStep = Math.max(1, getNiceStep(boundedMax / 10));
    yMax = Math.ceil(boundedMax / yTickStep) * yTickStep;
    yMax = Math.min(100, yMax);
    if (yMax <= yMin) {
      yMax = Math.min(100, yTickStep * 2);
    }
  } else {
    yMin = Math.max(0, yMin);
  }
  if (yMax - yMin < 4) {
    if (metricConfig.isPercent) {
      const boundedMax = Math.min(100, Math.max(1, maxMetricValue));
      yMax = Math.min(100, Math.max(yTickStep * 2, Math.ceil(boundedMax / yTickStep) * yTickStep));
      yMin = 0;
    } else {
      const center = (yMin + yMax) / 2;
      yMin = Math.max(0, center - 2);
      yMax = center + 2;
    }
  }

  socialRivalsChart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#333",
            font: { size: 12 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const raw = Number(context.raw);
              const formatted = Number.isFinite(raw)
                ? metricConfig.isPercent
                  ? `${raw.toFixed(2)}%`
                  : raw.toFixed(3)
                : "N/A";
              return Number.isFinite(raw)
                ? `${context.dataset.label}: ${formatted}`
                : `${context.dataset.label}: N/A`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#555",
            autoSkip: true,
            maxTicksLimit: 12,
            maxRotation: 45,
            minRotation: 45
          },
          grid: { color: "#e5e7eb" }
        },
        y: {
          beginAtZero: metricConfig.isPercent,
          min: yMin,
          max: yMax,
          title: {
            display: true,
            text: metricConfig.axisLabel,
            color: "#333",
            font: { size: 14, weight: "bold" }
          },
          ticks: {
            color: "#555",
            stepSize: yTickStep || undefined,
            callback: function(value) {
              return metricConfig.isPercent
                ? `${Number(value).toFixed(0)}%`
                : Number(value).toFixed(2);
            }
          },
          grid: { color: "#e5e7eb" }
        }
      }
    }
  });
  attachTrendZoomBrush(socialRivalsChart, "socialRivalsChart", labels.length);

  const bubblePlayers = seriesData
    .map((player, index) => {
      const primaryRows = Array.isArray(player.rows) ? player.rows : [];
      const fallbackRows = Array.isArray(player.allRows) ? player.allRows : [];
      const primaryGuessRates = primaryRows
        .map(row => Number(row && row["Guess rate"]))
        .filter(value => Number.isFinite(value));
      const modeRows = primaryGuessRates.length ? primaryRows : fallbackRows;
      const guessRateValues = modeRows
        .map(row => Number(row && row["Guess rate"]))
        .filter(value => Number.isFinite(value));
      const recentGuessRateValues = guessRateValues.slice(-5);
      const usefulnessValues = modeRows
        .map(row => {
          const raw = row && Object.prototype.hasOwnProperty.call(row, "Usefulness")
            ? row.Usefulness
            : (row ? row.usefulness : undefined);
          return convertLegacyUsefulnessValue(raw, shouldConvertLegacyUsefulness);
        })
        .filter(value => value != null);
      const recentUsefulnessValues = usefulnessValues.slice(-5);
      const gamesCount = recentGuessRateValues.length;
      const averageGuessRate = gamesCount
        ? recentGuessRateValues.reduce((sum, value) => sum + value, 0) / gamesCount
        : 0;
      const rivalRows = Array.isArray(activeStatsData[player.key]) ? activeStatsData[player.key] : [];
      const rivalRowLatestRank = getLatestValidRankForPlayer(rivalRows, null, activeMode);
      const rivalEntry = rivalEntriesByKey.get(player.key);
      const latestRank = player.key === currentStatKey
        ? targetLatestRank
        : (
          Number.isFinite(rivalRowLatestRank)
            ? rivalRowLatestRank
            : (
              Number.isFinite(Number(rivalEntry && rivalEntry.latestRank))
                ? Number(rivalEntry.latestRank)
                : getLatestValidRankForPlayer(player.key, rivalRows, activeMode)
            )
        );
      const usefulness = recentUsefulnessValues.length
        ? recentUsefulnessValues.reduce((sum, value) => sum + value, 0) / recentUsefulnessValues.length
        : 0;
      return {
        ...player,
        index,
        latestRank,
        averageGuessRate,
        gamesCount,
        usefulness
      };
    })
    .filter(player => Number.isFinite(player.latestRank));

  if (!bubblePlayers.length) {
    bubbleMeta.innerText = "No bubble data in selected range";
    return;
  }

  const usefulnessScores = bubblePlayers.map(player => Number(player.usefulness || 0));
  const minUsefulness = Math.min(...usefulnessScores);
  const maxUsefulness = Math.max(...usefulnessScores);
  const bubbleRadiusForUsefulness = usefulness => {
    if (maxUsefulness <= minUsefulness) return 10;
    const normalized = (usefulness - minUsefulness) / (maxUsefulness - minUsefulness);
    return 7 + normalized * 11;
  };

  const bubbleDatasets = bubblePlayers.map(player => {
    const color = palette[player.index % palette.length];
    const isTarget = player.index === 0;
    const alpha = isTarget ? 0.8 : 0.3;
    return {
      label: player.label,
      data: [
        {
          x: player.latestRank,
          y: player.averageGuessRate,
          r: bubbleRadiusForUsefulness(player.usefulness),
          gamesCount: player.gamesCount,
          usefulness: player.usefulness
        }
      ],
      borderColor: toRgba(color, isTarget ? 1 : 0.45),
      backgroundColor: toRgba(color, alpha),
      borderWidth: isTarget ? 2.4 : 1.8
    };
  });

  const bubbleGuessRates = bubblePlayers.map(player => player.averageGuessRate);
  const bubbleRanks = bubblePlayers.map(player => player.latestRank);
  const minBubbleGuessRate = Math.min(...bubbleGuessRates);
  const maxBubbleGuessRate = Math.max(...bubbleGuessRates);
  const bubbleGuessRateRange = maxBubbleGuessRate - minBubbleGuessRate;
  const bubbleGuessRatePadding = Math.max(1, bubbleGuessRateRange * 0.18);
  const rawBubbleYMin = Math.max(0, minBubbleGuessRate - bubbleGuessRatePadding);
  const rawBubbleYMax = Math.min(100, maxBubbleGuessRate + bubbleGuessRatePadding);
  let bubbleYTickStep = 5;
  let bubbleYMin = Math.floor(rawBubbleYMin / bubbleYTickStep) * bubbleYTickStep;
  let bubbleYMax = Math.ceil(rawBubbleYMax / bubbleYTickStep) * bubbleYTickStep;
  bubbleYMin = Math.max(0, bubbleYMin);
  bubbleYMax = Math.min(100, bubbleYMax);
  if (bubbleYMax - bubbleYMin < bubbleYTickStep * 2) {
    bubbleYMax = Math.min(100, bubbleYMin + bubbleYTickStep * 2);
  }
  if (bubbleYMax <= bubbleYMin) {
    bubbleYMin = 0;
    bubbleYMax = bubbleYTickStep * 2;
  }

  const minBubbleRank = Math.min(...bubbleRanks);
  const maxBubbleRank = Math.max(...bubbleRanks);
  const bubbleRankRange = maxBubbleRank - minBubbleRank;
  const bubbleRankPadding = Math.max(1, bubbleRankRange * 0.12);
  let bubbleXMin = Math.floor(minBubbleRank);
  let bubbleXMax = Math.ceil(maxBubbleRank + bubbleRankPadding);
  if (bubbleXMax <= bubbleXMin) {
    bubbleXMin -= 1;
    bubbleXMax += 1;
  }
  const bubbleXSpan = bubbleXMax - bubbleXMin;
  const bubbleXTickStep = Math.max(1, Math.ceil(bubbleXSpan / 8));

  socialRivalsBubbleChart = new Chart(bubbleCanvas, {
    type: "bubble",
    data: { datasets: bubbleDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#333",
            font: { size: 12 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const point = context.raw || {};
              const rank = Number(point.x);
              const avg = Number(point.y);
              const games = Number(point.gamesCount || 0);
              const usefulness = Number(point.usefulness || 0);
              return `${context.dataset.label}: Rank ${Math.round(rank)}, Avg ${Math.round(avg)}%, Usefulness ${usefulness.toFixed(3)}, Games ${games}`;
            }
          }
        }
      },
      scales: {
        x: {
          min: bubbleXMin,
          max: bubbleXMax,
          title: {
            display: true,
            text: "Latest Rank",
            color: "#333",
            font: { size: 14, weight: "bold" }
          },
          ticks: {
            color: "#555",
            stepSize: bubbleXTickStep,
            precision: 0,
            callback: function(value) {
              return `${Math.round(Number(value))}`;
            }
          },
          grid: { color: "#e5e7eb" }
        },
        y: {
          min: bubbleYMin,
          max: bubbleYMax,
          title: {
            display: true,
            text: "Average Guess Rate (%)",
            color: "#333",
            font: { size: 14, weight: "bold" }
          },
          ticks: {
            color: "#555",
            stepSize: bubbleYTickStep,
            callback: function(value) {
              return `${Math.round(Number(value))}%`;
            }
          },
          grid: { color: "#e5e7eb" }
        }
      }
    }
  });
  requestAnimationFrame(syncSocialRivalsBubbleHeight);
}

function toFiniteTrendValue(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildTrend(values) {
  const points = values
    .map((value, index) => ({ x: index, y: toFiniteTrendValue(value) }))
    .filter(point => point.y != null);
  const n = points.length;
  if (!n) {
    return {
      trend: values.map(() => null),
      slope: 0
    };
  }
  if (n === 1) {
    return {
      trend: values.map((_, index) => (index === points[0].x ? points[0].y : null)),
      slope: 0
    };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  points.forEach(point => {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
  });

  const denominator = n * sumXX - sumX * sumX;
  let slope = 0;
  let intercept = 0;

  if (denominator !== 0) {
    slope = (n * sumXY - sumX * sumY) / denominator;
    intercept = (sumY - slope * sumX) / n;
  } else {
    intercept = points[0].y;
  }

  return {
    trend: values.map((_, i) => slope * i + intercept),
    slope
  };
}

function solveThreeByThree(matrix, vector) {
  const a = matrix.map(row => row.slice());
  const b = vector.slice();

  for (let col = 0; col < 3; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivotRow][col])) {
        pivotRow = row;
      }
    }
    if (Math.abs(a[pivotRow][col]) < 1e-9) return null;
    if (pivotRow !== col) {
      [a[col], a[pivotRow]] = [a[pivotRow], a[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
    }

    for (let row = col + 1; row < 3; row += 1) {
      const factor = a[row][col] / a[col][col];
      for (let nextCol = col; nextCol < 3; nextCol += 1) {
        a[row][nextCol] -= factor * a[col][nextCol];
      }
      b[row] -= factor * b[col];
    }
  }

  const result = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let sum = b[row];
    for (let col = row + 1; col < 3; col += 1) {
      sum -= a[row][col] * result[col];
    }
    result[row] = sum / a[row][row];
  }
  return result;
}

function buildQuadraticTrend(values) {
  const points = values
    .map((value, index) => ({ x: index, y: toFiniteTrendValue(value) }))
    .filter(point => point.y != null);
  if (points.length < 3) {
    return { trend: buildTrend(values).trend };
  }

  const sums = points.reduce((acc, point) => {
    const x2 = point.x * point.x;
    const x3 = x2 * point.x;
    const x4 = x2 * x2;
    acc.count += 1;
    acc.x += point.x;
    acc.x2 += x2;
    acc.x3 += x3;
    acc.x4 += x4;
    acc.y += point.y;
    acc.xy += point.x * point.y;
    acc.x2y += x2 * point.y;
    return acc;
  }, { count: 0, x: 0, x2: 0, x3: 0, x4: 0, y: 0, xy: 0, x2y: 0 });

  const coefficients = solveThreeByThree(
    [
      [sums.count, sums.x, sums.x2],
      [sums.x, sums.x2, sums.x3],
      [sums.x2, sums.x3, sums.x4]
    ],
    [sums.y, sums.xy, sums.x2y]
  );

  if (!coefficients) {
    return { trend: buildTrend(values).trend };
  }

  const [intercept, linear, quadratic] = coefficients;
  return {
    trend: values.map((_, index) => intercept + linear * index + quadratic * index * index),
    quadratic,
    linear,
    intercept
  };
}

function buildSquareRootTrend(values) {
  const points = values
    .map((value, index) => ({ x: Math.sqrt(index), y: toFiniteTrendValue(value) }))
    .filter(point => point.y != null);
  if (points.length < 2) {
    return { trend: buildTrend(values).trend };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  points.forEach(point => {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
  });

  const n = points.length;
  const denominator = n * sumXX - sumX * sumX;
  let slope = 0;
  let intercept = points[0] ? points[0].y : 0;
  if (Math.abs(denominator) >= 1e-9) {
    slope = (n * sumXY - sumX * sumY) / denominator;
    intercept = (sumY - slope * sumX) / n;
  }

  return {
    trend: values.map((_, index) => intercept + slope * Math.sqrt(index)),
    slope,
    intercept
  };
}

function calculateTrendError(values, trend) {
  let squaredError = 0;
  let count = 0;
  values.forEach((value, index) => {
    const actual = toFiniteTrendValue(value);
    const predicted = toFiniteTrendValue(trend && trend[index]);
    if (actual == null || predicted == null) return;
    const delta = actual - predicted;
    squaredError += delta * delta;
    count += 1;
  });

  return {
    squaredError: count ? squaredError : Number.POSITIVE_INFINITY,
    count
  };
}

function buildBestCurveTrend(values) {
  const quadratic = buildQuadraticTrend(values);
  const squareRoot = buildSquareRootTrend(values);
  const quadraticError = calculateTrendError(values, quadratic.trend);
  const squareRootError = calculateTrendError(values, squareRoot.trend);

  if (squareRootError.squaredError < quadraticError.squaredError) {
    return {
      ...squareRoot,
      model: "Square Root",
      error: squareRootError
    };
  }

  return {
    ...quadratic,
    model: "Parabola",
    error: quadraticError
  };
}

function buildRadarScale(values, ringCount = 5) {
  const maxValue = Math.max(0, ...values);
  const safeRingCount = Math.max(1, ringCount);
  const stepSize = Math.max(1, Math.ceil(maxValue / safeRingCount));
  const max = Math.min(100, stepSize * safeRingCount);

  return {
    min: 0,
    max,
    stepSize
  };
}

function ensureTrendZoomResetButton(chart, canvasId) {
  const canvas = chart && chart.canvas;
  const card = canvas && canvas.closest ? canvas.closest(".chart-card") : null;
  if (!card) return null;
  const title = card.querySelector(".chart-header .chart-title");
  if (!title) return null;

  let titleBlock = title.closest(".trend-zoom-title-block");
  if (!titleBlock) {
    titleBlock = document.createElement("div");
    titleBlock.className = "trend-zoom-title-block";
    title.parentNode.insertBefore(titleBlock, title);
    titleBlock.appendChild(title);
  }

  let resetBtn = titleBlock.querySelector(`.trend-zoom-reset-btn[data-chart-id="${canvasId}"]`);
  if (!resetBtn) {
    resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "trend-zoom-reset-btn";
    resetBtn.dataset.chartId = canvasId;
    resetBtn.textContent = "Reset zoom";
    titleBlock.appendChild(resetBtn);
  }

  resetBtn.style.display = "none";
  return resetBtn;
}

function attachTrendZoomBrush(chart, canvasId, pointCount, options = {}) {
  const canvas = chart && chart.canvas;
  if (!canvas || !canvas.parentElement || pointCount < 3) return;
  const resetBtn = ensureTrendZoomResetButton(chart, canvasId);
  if (!resetBtn) return;
  applyTrendZoomSelectionState(chart, pointCount, pointCount, options);
  const resetTrendZoom = () => {
    if (!chart || !chart.options || !chart.options.scales || !chart.options.scales.x) return false;
    const xScaleOptions = chart.options.scales.x;
    const wasZoomed =
      xScaleOptions.min !== undefined ||
      xScaleOptions.max !== undefined ||
      resetBtn.style.display !== "none";
    if (!wasZoomed) {
      resetBtn.style.display = "none";
      return false;
    }
    xScaleOptions.min = undefined;
    xScaleOptions.max = undefined;
    applyTrendZoomSelectionState(chart, pointCount, pointCount, options);
    chart.update("none");
    resetBtn.style.display = "none";
    return wasZoomed;
  };
  chart.$resetTrendZoom = resetTrendZoom;
  trendZoomCharts.add(chart);
  resetBtn.onclick = resetTrendZoom;
  const wrap = canvas.parentElement;
  if (getComputedStyle(wrap).position === "static") {
    wrap.style.position = "relative";
  }

  let brush = wrap.querySelector(".overview-trend-brush");
  if (!brush) {
    brush = document.createElement("div");
    brush.className = "overview-trend-brush";
    brush.style.position = "absolute";
    brush.style.display = "none";
    brush.style.pointerEvents = "none";
    brush.style.background = "rgba(88, 111, 138, 0.20)";
    brush.style.border = "1px solid rgba(88, 111, 138, 0.72)";
    wrap.appendChild(brush);
  }

  let dragging = false;
  let startX = 0;

  const endDrag = event => {
    if (!dragging) return;
    dragging = false;
    const xScale = chart && chart.scales && chart.scales.x;
    const chartArea = chart && chart.chartArea;
    const rect = canvas.getBoundingClientRect();
    if (!chartArea) return;
    const endX = Math.max(chartArea.left, Math.min(chartArea.right, event.clientX - rect.left));
    const minX = Math.max(chartArea.left, Math.min(startX, endX));
    const maxX = Math.min(chartArea.right, Math.max(startX, endX));
    brush.style.display = "none";

    if (!xScale || maxX - minX < 10) return;
    const rawStart = Number(xScale.getValueForPixel(minX));
    const rawEnd = Number(xScale.getValueForPixel(maxX));
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return;

    const startIdx = Math.max(0, Math.min(pointCount - 1, Math.floor(Math.min(rawStart, rawEnd))));
    const endIdx = Math.max(0, Math.min(pointCount - 1, Math.ceil(Math.max(rawStart, rawEnd))));
    if (endIdx - startIdx < 1) return;
    const selectedCount = endIdx - startIdx + 1;

    if (chart.options && chart.options.scales && chart.options.scales.x) {
      chart.options.scales.x.min = startIdx;
      chart.options.scales.x.max = endIdx;
      applyTrendZoomSelectionState(chart, selectedCount, pointCount, options);
      chart.update("none");
      if (resetBtn) resetBtn.style.display = "inline-block";
    }
  };

  const onMouseDown = event => {
    if (event.button !== 0) return;
    const chartArea = chart && chart.chartArea;
    if (!chartArea) return;
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    if (pointerX < chartArea.left || pointerX > chartArea.right) return;
    if (pointerY < chartArea.top || pointerY > chartArea.bottom) return;
    startX = Math.max(chartArea.left, Math.min(chartArea.right, pointerX));
    dragging = true;
    brush.style.display = "block";
    brush.style.top = `${canvas.offsetTop + chartArea.top}px`;
    brush.style.height = `${Math.max(0, chartArea.bottom - chartArea.top)}px`;
    brush.style.left = `${canvas.offsetLeft + startX}px`;
    brush.style.width = "0px";
  };

  const onMouseMove = event => {
    if (!dragging) return;
    const chartArea = chart && chart.chartArea;
    if (!chartArea) return;
    const rect = canvas.getBoundingClientRect();
    const currentX = Math.max(chartArea.left, Math.min(chartArea.right, event.clientX - rect.left));
    const left = Math.min(startX, currentX);
    const width = Math.abs(currentX - startX);
    brush.style.left = `${canvas.offsetLeft + left}px`;
    brush.style.width = `${width}px`;
  };

  const onMouseUp = event => endDrag(event);

  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  chart.$trendZoomBrushCleanup = () => {
    canvas.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    trendZoomCharts.delete(chart);
    delete chart.$resetTrendZoom;
    brush.style.display = "none";
  };
}

function resetAllTrendZoomCharts() {
  let didReset = false;
  Array.from(trendZoomCharts).forEach(chart => {
    if (!chart || typeof chart.$resetTrendZoom !== "function") {
      trendZoomCharts.delete(chart);
      return;
    }
    didReset = chart.$resetTrendZoom() || didReset;
  });
  return didReset;
}

function renderTrendChart(
  existingChart,
  canvasId,
  labels,
  values,
  seriesLabel,
  yTitle,
  {
    suffix = "%",
    decimals = 3,
    integerTicks = false,
    palette = null,
    metaElementId = null,
    metaUnit = "tours",
    showCurvedTrend = false
  } = {}
) {
  const linearTrendResult = buildTrend(values);
  const { trend } = linearTrendResult;
  const curvedTrendResult = showCurvedTrend ? buildBestCurveTrend(values) : null;
  const displayedTrend = showCurvedTrend && curvedTrendResult ? curvedTrendResult.trend : trend;
  const resolvedPalette = {
    ...PERFORMANCE_LINE_PALETTES.default,
    ...(palette || {})
  };
  const hideStaticPoints = true;
  const overviewHoverPointRadius = 5;
  const allSeriesValues = [...values, ...displayedTrend]
    .map(toFiniteTrendValue)
    .filter(value => value != null);
  const valueMin = allSeriesValues.length ? Math.min(...allSeriesValues) : 0;
  const valueMax = allSeriesValues.length ? Math.max(...allSeriesValues) : 0;
  const rawRange = valueMax - valueMin;
  const isPercentSeries = suffix === "%";
  const isLivesSeries = canvasId === "takenLivesChart" || canvasId === "savedLivesChart";
  const isRigsMissedSeries = canvasId === "opRigsMissedChart" || canvasId === "edRigsMissedChart" || canvasId === "inRigsMissedChart";
  const isWeightedSeries = canvasId === "weightedGuessRateChart";
  const clampMinToZero = isLivesSeries || isRigsMissedSeries || (isPercentSeries && canvasId !== "weightedGuessRateChart");
  const getNiceStep = rawStep => {
    if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
    const exponent = Math.floor(Math.log10(rawStep));
    const base = Math.pow(10, exponent);
    const normalized = rawStep / base;
    if (normalized <= 1) return 1 * base;
    if (normalized <= 2) return 2 * base;
    if (normalized <= 5) return 5 * base;
    return 10 * base;
  };

  let yMin = valueMin;
  let yMax = valueMax;
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    yMin = 0;
    yMax = integerTicks ? 2 : 10;
  }
  if (rawRange <= 0) {
    const delta = integerTicks ? 1 : 0.5;
    yMin -= delta;
    yMax += delta;
  }
  const paddedRange = Math.max(rawRange, yMax - yMin);
  const padding = integerTicks
    ? Math.max(1, paddedRange * 0.15)
    : Math.max(0.5, paddedRange * 0.15);
  yMin -= padding;
  yMax += padding;
  if (clampMinToZero) {
    yMin = Math.max(0, yMin);
  }
  let yTickStep = getNiceStep((yMax - yMin) / 8);
  if (integerTicks) {
    yTickStep = Math.max(1, Math.round(yTickStep));
  }
  yMin = Math.floor(yMin / yTickStep) * yTickStep;
  yMax = Math.ceil(yMax / yTickStep) * yTickStep;
  if (clampMinToZero) {
    yMin = Math.max(0, yMin);
  }
  if (yMax <= yMin) {
    yMax = yMin + (yTickStep * 2);
  }
  if (isLivesSeries || isRigsMissedSeries) {
    const rawCountValues = values
      .map(toFiniteTrendValue)
      .filter(value => value != null);
    const countMaxValue = rawCountValues.length ? Math.max(...rawCountValues) : 0;
    yMin = 0;
    yMax = Math.max(1, Math.ceil(countMaxValue));
    yTickStep = 1;
  }
  if (isWeightedSeries) {
    const weightedRange = Math.max(1e-6, valueMax - valueMin);
    const weightedPadding = Math.max(0.35, weightedRange * 0.03);
    const rawWeightedMin = valueMin - weightedPadding;
    const rawWeightedMax = valueMax + weightedPadding;
    const weightedStep = getNiceStep((rawWeightedMax - rawWeightedMin) / 7);
    yTickStep = weightedStep;
    yMin = Math.floor(rawWeightedMin / weightedStep) * weightedStep;
    yMax = Math.ceil(rawWeightedMax / weightedStep) * weightedStep;
    if (yMax <= yMin) {
      yMax = yMin + 1;
    }
  }
  if (isPercentSeries && !isWeightedSeries) {
    yMin = Math.max(0, yMin);
    yMax = Math.min(100, yMax);
    if (yMax <= yMin) {
      if (yMin >= 100) {
        yMin = 99;
        yMax = 100;
      } else {
        yMax = Math.min(100, yMin + Math.max(1, yTickStep || 1));
      }
    }
  }

  if (existingChart) {
    if (typeof existingChart.$trendZoomBrushCleanup === "function") {
      existingChart.$trendZoomBrushCleanup();
    }
    existingChart.destroy();
  }

  const seriesOpacityScale = getTimeSeriesOpacityScale(labels.length);
  const chart = new Chart(document.getElementById(canvasId), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: seriesLabel,
          data: values,
          borderColor: withSeriesOpacity(resolvedPalette.line, seriesOpacityScale),
          backgroundColor: withSeriesOpacity(resolvedPalette.fill, seriesOpacityScale),
          pointBackgroundColor: withSeriesOpacity(resolvedPalette.line, seriesOpacityScale),
          pointBorderColor: withSeriesOpacity("#ffffff", seriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: resolvedPalette.line,
            backgroundColor: resolvedPalette.fill,
            pointBackgroundColor: resolvedPalette.line,
            pointBorderColor: "#ffffff"
          },
          pointBorderWidth: 1.5,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 2.2,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 5,
          order: 10,
          borderWidth: 1.8,
          tension: 0,
          fill: false
        },
        {
          label: showCurvedTrend ? "Trend" : "Linear Trend",
          data: displayedTrend,
          borderColor: resolvedPalette.trend,
          borderDash: [8, 6],
          order: 30,
          borderWidth: 3.2,
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 0,
          tension: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#314155",
            font: {
              size: 12,
              weight: "600"
            }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          multiKeyBackground: "transparent",
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          callbacks: {
            label: function(context) {
              const value = toFiniteTrendValue(context.raw);
              return context.dataset.label + ": " + (value == null ? "N/A" : value.toFixed(decimals) + suffix);
            },
            labelColor: function(context) {
              const color = context.dataset && context.dataset.borderColor
                ? context.dataset.borderColor
                : "#94a3b8";
              return {
                borderColor: "transparent",
                backgroundColor: color
              };
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#5d7087",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: true,
            maxTicksLimit: 12
          },
          grid: {
            color: "rgba(148, 163, 184, 0.28)"
          }
        },
        y: {
          min: yMin,
          max: yMax,
          title: {
            display: true,
            text: yTitle,
            color: "#314155",
            font: {
              size: 13,
              weight: "bold"
            }
          },
          ticks: {
            color: "#5d7087",
            stepSize: yTickStep || undefined,
            ...(integerTicks ? { stepSize: 1, precision: 0 } : {})
          },
          grid: {
            color: "rgba(148, 163, 184, 0.24)"
          }
        }
      }
    }
  });

  const metaElement = metaElementId ? document.getElementById(metaElementId) : null;
  attachTrendZoomBrush(chart, canvasId, labels.length, { metaElement, metaUnit });

  return chart;
}

function renderKnowledgeGenreRadar() {
  let activeGenreIndex = 0;

  function updateOverviewGenreInfo(index) {
    const infoEl = document.getElementById("overviewGenreInfo");
    if (!infoEl) return;
    const fallbackIndex = Number.isFinite(genreRadarChart && genreRadarChart.$activeGenreIndex)
      ? Number(genreRadarChart.$activeGenreIndex)
      : activeGenreIndex;
    const resolvedIndex = Number.isFinite(index) && index >= 0 && index < genres.length
      ? index
      : fallbackIndex;
    if (!Number.isFinite(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= genres.length) {
      infoEl.innerText = "Hover a genre to see details.";
      return;
    }
    const genreName = labels[resolvedIndex];
    const genreEntry = genres[resolvedIndex] && genres[resolvedIndex][1] ? genres[resolvedIndex][1] : {};
    const guessRate = Number(genreEntry.guessRate);
    const total = Number(genreEntry.total);
    const roundedGuessRate = Math.round(Number.isFinite(guessRate) ? guessRate : 0);
    const safeTotal = Number.isFinite(total) ? total : 0;
    infoEl.innerText = `${genreName}: ${roundedGuessRate}% guess rate across ${safeTotal} songs`;
  }

  if (!cachedGenreData || typeof cachedGenreData !== "object") {
    if (genreRadarChart) {
      genreRadarChart.destroy();
      genreRadarChart = null;
    }
    updateOverviewGenreInfo(-1);
    return;
  }

  const genres = Object.entries(cachedGenreData)
    .filter(([, value]) => value && typeof value.guessRate === "number")
    .sort((a, b) => (b[1].total || 0) - (a[1].total || 0));

  if (!genres.length) {
    if (genreRadarChart) {
      genreRadarChart.destroy();
      genreRadarChart = null;
    }
    updateOverviewGenreInfo(-1);
    return;
  }

  const labels = genres.map(([genre]) => genre);
  const values = genres.map(([, value]) => Number(value.guessRate));
  const radarScale = buildRadarScale(values);

  if (genreRadarChart) {
    genreRadarChart.destroy();
  }

  const axisHighlightColor = "#ff7a00";
  function isPointerInsideGenreRadar(chart, event) {
    const scale = chart && chart.scales ? chart.scales.r : null;
    if (!scale || !event || event.type === "mouseout") return false;
    const x = Number(event.x);
    const y = Number(event.y);
    const centerX = Number(scale.xCenter);
    const centerY = Number(scale.yCenter);
    const radius = Number(scale.drawingArea);
    if (![x, y, centerX, centerY, radius].every(Number.isFinite) || radius <= 0) return false;
    return Math.hypot(x - centerX, y - centerY) <= radius;
  }

  const genreRadarTickLabelPlugin = {
    id: "genreRadarTickLabelPlugin",
    afterDraw(chart) {
      const scale = chart && chart.scales ? chart.scales.r : null;
      if (!scale || !Array.isArray(scale.ticks) || !scale.ticks.length) return;

      const ctx = chart.ctx;
      const labelAngleDegrees = -48;
      const rightShiftSteps = 1;
      const sectorStep = (Math.PI * 2) / Math.max(1, (chart.data && Array.isArray(chart.data.labels) ? chart.data.labels.length : 1));
      const labelAngle = (labelAngleDegrees * Math.PI) / 180 + sectorStep * rightShiftSteps;
      const labelOffset = 6;

      ctx.save();
      ctx.font = "10px Arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#6b7280";

      scale.ticks.forEach(tick => {
        const value = Number(tick && tick.value);
        if (!Number.isFinite(value) || value <= 0) return;
        const radius = scale.getDistanceFromCenterForValue(value);
        if (!Number.isFinite(radius)) return;
        const textX = scale.xCenter + Math.cos(labelAngle) * radius + labelOffset;
        const textY = scale.yCenter + Math.sin(labelAngle) * radius;
        ctx.fillText(`${Math.round(value)}%`, textX, textY);
      });

      ctx.restore();
    }
  };
  const genrePersistentSelectionPlugin = {
    id: "genrePersistentSelectionPlugin",
    beforeInit(chart) {
      chart.$activeGenreIndex = Number.isFinite(activeGenreIndex) ? activeGenreIndex : 0;
    },
    afterEvent(chart, args) {
      const event = args && args.event ? args.event : null;
      if (!event) return;
      chart.$isPointerInsideRadar = isPointerInsideGenreRadar(chart, event);
      if (!chart.$isPointerInsideRadar) {
        args.changed = true;
        return;
      }
      const elements = chart.getElementsAtEventForMode(event, "nearest", { intersect: false }, false);
      if (Array.isArray(elements) && elements.length) {
        const idx = Number(elements[0].index);
        if (Number.isFinite(idx) && idx >= 0) {
          chart.$activeGenreIndex = idx;
          activeGenreIndex = idx;
          updateOverviewGenreInfo(idx);
        }
      } else if (Number.isFinite(chart.$activeGenreIndex) && chart.$activeGenreIndex >= 0) {
        updateOverviewGenreInfo(chart.$activeGenreIndex);
      }
    }
  };
  genreRadarChart = new Chart(document.getElementById("genreRadarChart"), {
    type: "radar",
    plugins: [genreRadarTickLabelPlugin, genrePersistentSelectionPlugin],
    data: {
      labels,
      datasets: [
        {
          label: "Genre Guess Rate (%)",
          data: values,
          borderColor: "#2a9d8f",
          backgroundColor: "rgba(42, 157, 143, 0.28)",
          pointBackgroundColor: "#2a9d8f",
          pointBorderColor: "#2a9d8f",
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 14,
          borderWidth: 2
        },
        {
          label: "__genre_axis_hit__",
          data: labels.map(() => radarScale.max),
          borderColor: "rgba(0, 0, 0, 0)",
          backgroundColor: "rgba(0, 0, 0, 0)",
          pointBackgroundColor: "rgba(0, 0, 0, 0)",
          pointBorderColor: "rgba(0, 0, 0, 0)",
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 20,
          borderWidth: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0
        }
      },
      onHover: (event, activeElements, chart) => {
        chart.$isPointerInsideRadar = isPointerInsideGenreRadar(chart, event);
        if (!chart.$isPointerInsideRadar) {
          chart.draw();
          return;
        }
        const hoveredIndex = Array.isArray(activeElements) && activeElements.length
          ? Number(activeElements[0].index)
          : -1;
        if (Number.isFinite(hoveredIndex) && hoveredIndex >= 0 && hoveredIndex !== activeGenreIndex) {
          activeGenreIndex = hoveredIndex;
          updateOverviewGenreInfo(activeGenreIndex);
        }
        chart.draw();
      },
      onClick: (event, activeElements, chart) => {
        if (!isPointerInsideGenreRadar(chart, event)) return;
        const clickedIndex = Array.isArray(activeElements) && activeElements.length
          ? Number(activeElements[0].index)
          : -1;
        if (Number.isFinite(clickedIndex) && clickedIndex >= 0 && clickedIndex !== activeGenreIndex) {
          activeGenreIndex = clickedIndex;
          updateOverviewGenreInfo(activeGenreIndex);
          chart.draw();
        }
      },
      interaction: {
        mode: "nearest",
        intersect: false
      },
      plugins: {
        legend: {
          onClick: () => {},
          labels: {
            filter: function(item) {
              return item && item.datasetIndex === 0;
            },
            color: "#333",
            font: { size: 14 }
          }
        },
        tooltip: {
          enabled: false,
          filter: function(context) {
            return context && context.datasetIndex === 0;
          },
          callbacks: {
            label: function(context) {
              const idx = Number(context && context.dataIndex);
              const safeIndex = Number.isFinite(idx) ? idx : 0;
              const value = Number(values[safeIndex]);
              return `Genre Guess Rate (%): ${Math.round(Number.isFinite(value) ? value : 0)}%`;
            }
          }
        }
      },
      scales: {
        r: {
          beginAtZero: true,
          min: radarScale.min,
          max: radarScale.max,
          ticks: {
            stepSize: radarScale.stepSize,
            precision: 0,
            color: "rgba(0, 0, 0, 0)",
            showLabelBackdrop: false,
            callback: function() {
              return "";
            }
          },
          grid: {
            circular: true,
            color: function(context) {
              const value = Number(context.tick && context.tick.value);
              const min = Number(radarScale.min);
              const max = Number(radarScale.max);
              if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
                return "rgba(148, 163, 184, 0.22)";
              }
              const isOuterRing = Math.abs(value - max) < Math.max(1e-8, Math.abs(max) * 1e-8);
              return isOuterRing
                ? "rgba(51, 65, 85, 0.72)"
                : "rgba(148, 163, 184, 0.22)";
            }
          },
          angleLines: {
            color: function(context) {
              const isPointerInsideRadar = Boolean(context && context.chart && context.chart.$isPointerInsideRadar);
              if (!isPointerInsideRadar) {
                return "rgba(148, 163, 184, 0.40)";
              }
              const activeAxisIndex = Number(context && context.chart && context.chart.$activeGenreIndex);
              const idx = Number(context && context.index);
              if (Number.isFinite(idx) && idx === activeAxisIndex) {
                return axisHighlightColor;
              }
              return "rgba(148, 163, 184, 0.40)";
            }
          },
          pointLabels: {
            color: function(context) {
              const isPointerInsideRadar = Boolean(context && context.chart && context.chart.$isPointerInsideRadar);
              const activeAxisIndex = Number(context && context.chart && context.chart.$activeGenreIndex);
              const idx = Number(context && context.index);
              return isPointerInsideRadar && Number.isFinite(idx) && idx === activeAxisIndex
                ? axisHighlightColor
                : "#374151";
            },
            font: { size: 12 }
          }
        }
      }
    }
  });
  if (genreRadarChart) {
    genreRadarChart.$activeGenreIndex = activeGenreIndex;
    genreRadarChart.$isPointerInsideRadar = false;
  }
  updateOverviewGenreInfo(activeGenreIndex);
}

function renderKnowledgeTagRadar() {
  if (!cachedTagData || typeof cachedTagData !== "object") {
    const meta = document.getElementById("tagSelectionMeta");
    meta.innerText = "Selected 0 tags";
    if (tagRadarChart) {
      tagRadarChart.destroy();
      tagRadarChart = null;
    }
    document.getElementById("tagCheckboxList").innerHTML = "";
    if (tagSearchInput) {
      tagSearchInput.value = "";
    }
    tagSearchQuery = "";
    return;
  }

  const tagEntries = Object.entries(cachedTagData)
    .filter(([, value]) => value && typeof value.guessRate === "number")
    .sort((a, b) => {
      const guessRateDiff = Number(b[1].guessRate || 0) - Number(a[1].guessRate || 0);
      if (guessRateDiff !== 0) return guessRateDiff;
      const totalDiff = Number(b[1].total || 0) - Number(a[1].total || 0);
      if (totalDiff !== 0) return totalDiff;
      return String(a[0]).localeCompare(String(b[0]));
    });
  const tagEntriesAlphabetical = [...tagEntries].sort((a, b) => a[0].localeCompare(b[0]));

  if (!tagEntries.length) {
    return;
  }

  if (!selectedTagNames.length) {
    selectedTagNames = tagEntries.slice(0, MAX_SELECTED_TAGS).map(([name]) => name);
  } else {
    selectedTagNames = selectedTagNames.filter(name => cachedTagData[name]);
    if (selectedTagNames.length > MAX_SELECTED_TAGS) {
      selectedTagNames = selectedTagNames.slice(0, MAX_SELECTED_TAGS);
    }
    if (!selectedTagNames.length) {
      selectedTagNames = tagEntries.slice(0, MAX_SELECTED_TAGS).map(([name]) => name);
    }
  }

  const minRequiredTags = Math.min(MIN_SELECTED_TAGS, tagEntries.length);
  if (selectedTagNames.length < minRequiredTags) {
    const selectedTagSet = new Set(selectedTagNames);
    for (const [tagName] of tagEntries) {
      if (selectedTagSet.has(tagName)) continue;
      selectedTagNames.push(tagName);
      selectedTagSet.add(tagName);
      if (selectedTagNames.length >= minRequiredTags) break;
    }
  }

  const checkboxWrap = document.getElementById("tagCheckboxList");
  if (tagSearchInput && tagSearchInput.value.toLowerCase() !== tagSearchQuery) {
    tagSearchInput.value = tagSearchQuery;
  }
  const normalizedSearch = String(tagSearchQuery || "").trim().toLowerCase();
  const visibleTagEntries = normalizedSearch
    ? tagEntriesAlphabetical.filter(([tag]) => tag.toLowerCase().includes(normalizedSearch))
    : tagEntriesAlphabetical;
  checkboxWrap.style.display = "grid";
  checkboxWrap.style.gridTemplateColumns = "repeat(3, minmax(120px, 1fr))";
  checkboxWrap.style.gap = "10px 18px";
  checkboxWrap.style.maxHeight = "520px";
  checkboxWrap.style.overflowY = "auto";
  checkboxWrap.style.alignContent = "start";
  checkboxWrap.innerHTML = "";
  visibleTagEntries.forEach(([tag]) => {
    const label = document.createElement("label");
    label.className = "tag-checkbox-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = tag;
    input.checked = selectedTagNames.includes(tag);

    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${tag}`));
    checkboxWrap.appendChild(label);
  });

  if (!visibleTagEntries.length) {
    checkboxWrap.innerHTML = '<div class="selected-tags-empty">No tags match your search.</div>';
  }

  checkboxWrap.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener("change", event => {
      const changedTag = String(event.target.value || "");
      const isChecked = Boolean(event.target.checked);

      if (isChecked) {
        if (selectedTagNames.includes(changedTag)) {
          return;
        }
        if (selectedTagNames.length >= MAX_SELECTED_TAGS) {
          event.target.checked = false;
          return;
        }
        selectedTagNames = [...selectedTagNames, changedTag];
      } else {
        const minRequiredSelection = Math.min(MIN_SELECTED_TAGS, tagEntries.length);
        if (selectedTagNames.length <= minRequiredSelection) {
          event.target.checked = true;
          return;
        }
        selectedTagNames = selectedTagNames.filter(name => name !== changedTag);
      }
      drawTagRadarFromSelection();
    });
  });

  drawTagRadarFromSelection();
}

function renderKnowledgeByEraDecadeChart() {
  const gamesIncludedEl = document.getElementById("byEraGamesIncluded");
  const seasonGamesIncludedEl = document.getElementById("byEraSeasonGamesIncluded");

  if (!cachedByEraData || typeof cachedByEraData !== "object") {
    gamesIncludedEl.innerText = "Found 0 games";
    if (seasonGamesIncludedEl) {
      seasonGamesIncludedEl.innerText = "Found 0 games";
    }
    if (byEraDecadeChart) {
      byEraDecadeChart.destroy();
      byEraDecadeChart = null;
    }
    if (byEraSeasonCompareChart) {
      byEraSeasonCompareChart.destroy();
      byEraSeasonCompareChart = null;
    }
    const seasonList = document.getElementById("byEraSeasonCheckboxList");
    if (seasonList) {
      seasonList.innerHTML = '<div class="by-era-season-empty">No seasonal by-era data available.</div>';
    }
    renderByEraSeasonSelectionMeta();
    renderByEraSelectedSeasonButtons();
    return;
  }

  const decadesRaw = Array.isArray(cachedByEraData.decades) ? cachedByEraData.decades : [];
  const decades = decadesRaw.filter(item => item && typeof item.label === "string" && Number.isFinite(Number(item.count)));
  const filteredDecades = decades.filter(item => Number(item.count) > 0);
  const decadesForChart = filteredDecades.length ? filteredDecades : decades;

  gamesIncludedEl.innerText = `Found ${Number(cachedByEraData.gamesIncluded || 0)} games`;
  if (seasonGamesIncludedEl) {
    seasonGamesIncludedEl.innerText = `Found ${Number(cachedByEraData.gamesIncluded || 0)} games`;
  }

  if (!decadesForChart.length) {
    if (byEraDecadeChart) {
      byEraDecadeChart.destroy();
      byEraDecadeChart = null;
    }
    renderByEraSeasonComparison();
    return;
  }

  if (byEraDecadeChart) {
    byEraDecadeChart.destroy();
  }

  const correctCounts = decadesForChart.map(item => Number(item.correct || 0));
  const wrongCounts = decadesForChart.map(item => Number(item.wrong || 0));
  const totalCounts = decadesForChart.map(item => Number(item.count || 0));
  const isPercentageMode = byEraDataMode === "percentage";
  const rightValues = isPercentageMode
    ? decadesForChart.map((item, idx) => {
        const total = Number(totalCounts[idx] || 0);
        if (Number.isFinite(Number(item.correctPct))) {
          return Number(item.correctPct);
        }
        return total > 0 ? (Number(item.correct || 0) / total) * 100 : 0;
      })
    : correctCounts;
  const wrongValues = isPercentageMode
    ? decadesForChart.map((item, idx) => {
        const total = Number(totalCounts[idx] || 0);
        if (Number.isFinite(Number(item.correctPct))) {
          return Math.max(0, 100 - Number(item.correctPct));
        }
        return total > 0 ? (Number(item.wrong || 0) / total) * 100 : 0;
      })
    : wrongCounts;

  const positiveStackTotals = totalCounts.filter(value => value > 0);
  const minPositiveStack = positiveStackTotals.length ? Math.min(...positiveStackTotals) : 1;
  const maxPositiveStack = positiveStackTotals.length ? Math.max(...positiveStackTotals) : 1;
  const logMin = Math.max(1, Math.pow(10, Math.floor(Math.log10(minPositiveStack))));
  let logMax = Math.pow(10, Math.ceil(Math.log10(maxPositiveStack)));
  if (maxPositiveStack >= logMax) {
    logMax *= 10;
  }
  if (logMax <= logMin) {
    logMax = logMin * 10;
  }
  const effectiveScaleType = isPercentageMode ? "linear" : byEraScaleType;

  byEraDecadeChart = new Chart(document.getElementById("byEraDecadeChart"), {
    type: "bar",
    data: {
      labels: decadesForChart.map(item => item.label),
      datasets: [
        {
          label: "Right",
          data: rightValues,
          backgroundColor: "rgba(34, 197, 94, 0.62)",
          borderColor: "#16a34a",
          borderWidth: 1.5,
          borderRadius: 6
        },
        {
          label: "Wrong",
          data: wrongValues,
          backgroundColor: "rgba(239, 68, 68, 0.62)",
          borderColor: "#dc2626",
          borderWidth: 1.5,
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#333",
            font: { size: 14 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const raw = Number(context.raw || 0);
              if (!isPercentageMode) {
                return `${context.dataset.label}: ${Math.round(raw)}`;
              }
              const idx = Number(context.dataIndex || 0);
              const total = Number(totalCounts[idx] || 0);
              const count = context.dataset.label === "Right"
                ? Number(correctCounts[idx] || 0)
                : Number(wrongCounts[idx] || 0);
              return `${context.dataset.label}: ${raw.toFixed(2)}% (${Math.round(count)}/${Math.round(total)})`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            color: "#555",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: false
          },
          grid: {
            color: "#e5e7eb"
          }
        },
        y: {
          type: effectiveScaleType,
          stacked: true,
          beginAtZero: true,
          ...(effectiveScaleType === "logarithmic"
            ? {
                min: logMin,
                max: logMax,
                bounds: "ticks",
                afterBuildTicks: axis => {
                  const ticks = [];
                  for (let value = logMin; value <= logMax; value *= 10) {
                    ticks.push({ value });
                  }
                  axis.ticks = ticks;
                }
              }
            : isPercentageMode
              ? {
                  min: 0,
                  max: 100
                }
            : {}),
          title: {
            display: true,
            text: isPercentageMode ? "Percentage (%)" : "Entries",
            color: "#333",
            font: {
              size: 14,
              weight: "bold"
            }
          },
          ticks: {
            color: "#555",
            ...(effectiveScaleType === "linear"
              ? (isPercentageMode
                  ? {
                      stepSize: 10,
                      callback: function(value) {
                        return `${Math.round(Number(value))}%`;
                      }
                    }
                  : { stepSize: 1, precision: 0 })
              : {
                  callback: function(value) {
                    const numericValue = Number(value);
                    if (numericValue <= 0) return "";
                    const log10 = Math.log10(numericValue);
                    return Math.abs(log10 - Math.round(log10)) < 1e-8
                      ? numericValue.toLocaleString()
                      : "";
                  }
                })
          },
          grid: {
            color: context => {
              if (effectiveScaleType !== "logarithmic") return "#e5e7eb";
              const numericValue = Number(context.tick && context.tick.value);
              if (numericValue <= 0) return "transparent";
              const log10 = Math.log10(numericValue);
              return Math.abs(log10 - Math.round(log10)) < 1e-8 ? "#e5e7eb" : "transparent";
            }
          }
        }
      }
    }
  });

  if (byEraSeasonSearchInput && byEraSeasonSearchInput.value.toLowerCase() !== byEraSeasonSearchQuery) {
    byEraSeasonSearchInput.value = byEraSeasonSearchQuery;
  }
  renderByEraSeasonComparison();
}

function drawTagRadarFromSelection() {
  const totalTagOptions = Object.values(cachedTagData || {}).filter(
    value => value && typeof value.guessRate === "number"
  ).length;
  const minRequiredSelection = Math.min(MIN_SELECTED_TAGS, totalTagOptions);
  const selectedEntries = selectedTagNames
    .map(tag => [tag, cachedTagData[tag]])
    .filter(([, value]) => value && typeof value.guessRate === "number");
  renderSelectedTagButtons(selectedEntries.map(([tag]) => tag));

  const meta = document.getElementById("tagSelectionMeta");
  const maxSuffix = selectedEntries.length >= MAX_SELECTED_TAGS ? " (maximum)" : "";
  const minSuffix = selectedEntries.length === minRequiredSelection ? " (minimum)" : "";
  meta.innerText = `Selected ${selectedEntries.length} tags${minSuffix}${maxSuffix}`;

  if (!selectedEntries.length) {
    if (tagRadarChart) {
      tagRadarChart.destroy();
      tagRadarChart = null;
    }
    return;
  }

  const radarEntriesAlphabetical = [...selectedEntries].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: "base" })
  );
  const labels = radarEntriesAlphabetical.map(([tag]) => tag);
  const values = radarEntriesAlphabetical.map(([, value]) => Number(value.guessRate));
  const radarScale = buildRadarScale(values);

  if (tagRadarChart) {
    tagRadarChart.destroy();
  }

  const axisHighlightColor = "#ff7a00";
  const tagRadarTickLabelPlugin = {
    id: "tagRadarTickLabelPlugin",
    afterDraw(chart) {
      const scale = chart && chart.scales ? chart.scales.r : null;
      if (!scale || !Array.isArray(scale.ticks) || !scale.ticks.length) return;

      const ctx = chart.ctx;
      const labelsCount = Math.max(1, (chart.data && Array.isArray(chart.data.labels) ? chart.data.labels.length : 1));
      const shouldUseVerticalQuadrantOneAxis = labelsCount === 3 || labelsCount === 4;
      const shouldUseFiveGenreAdjust = labelsCount === 5;
      const targetAngle = (-48 * Math.PI) / 180;
      let labelAngle = 0;
      let bestDiff = Number.POSITIVE_INFINITY;
      if (shouldUseVerticalQuadrantOneAxis) {
        labelAngle = (-90 * Math.PI) / 180;
      }
      for (let i = 0; i < labelsCount; i += 1) {
        const point = scale.getPointPositionForValue(i, scale.max);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const dx = point.x - scale.xCenter;
        const dy = point.y - scale.yCenter;
        if (!(dx > 0 && dy < 0)) continue; // first quadrant (top-right)
        const axisAngle = Math.atan2(dy, dx);
        const diff = shouldUseVerticalQuadrantOneAxis
          ? Math.abs(Math.atan2(Math.sin(axisAngle - ((-90 * Math.PI) / 180)), Math.cos(axisAngle - ((-90 * Math.PI) / 180))))
          : Math.abs(Math.atan2(Math.sin(axisAngle - targetAngle), Math.cos(axisAngle - targetAngle)));
        if (diff < bestDiff) {
          bestDiff = diff;
          labelAngle = axisAngle;
        }
      }
      const labelOffset = 6;
      const extraUpwardOffset = shouldUseVerticalQuadrantOneAxis ? 2 : shouldUseFiveGenreAdjust ? -4 : 0;
      const extraRightOffset = shouldUseVerticalQuadrantOneAxis ? 2 : shouldUseFiveGenreAdjust ? 4 : 0;

      ctx.save();
      ctx.font = "10px Arial";
      ctx.textAlign = "left";
      ctx.textBaseline = shouldUseVerticalQuadrantOneAxis ? "bottom" : "middle";
      ctx.fillStyle = "#6b7280";

      scale.ticks.forEach(tick => {
        const value = Number(tick && tick.value);
        if (!Number.isFinite(value) || value <= 0) return;
        const radius = scale.getDistanceFromCenterForValue(value);
        if (!Number.isFinite(radius)) return;
        const textX = scale.xCenter + Math.cos(labelAngle) * radius + labelOffset + extraRightOffset;
        const textY = scale.yCenter + Math.sin(labelAngle) * radius - extraUpwardOffset;
        ctx.fillText(`${Math.round(value)}%`, textX, textY);
      });

      ctx.restore();
    }
  };
  const fixedTagRadarRadiusPlugin = {
    id: "fixedTagRadarRadiusPlugin",
    afterLayout(chart) {
      const radialScale = chart && chart.scales ? chart.scales.r : null;
      if (!radialScale || !Number.isFinite(radialScale.drawingArea)) return;
      radialScale.drawingArea = Math.min(radialScale.drawingArea, 178);
      if (chart && chart.chartArea) {
        radialScale.xCenter = (chart.chartArea.left + chart.chartArea.right) / 2;
        radialScale.yCenter = (chart.chartArea.top + chart.chartArea.bottom) / 2;
      }
    }
  };
  function getTooltipAxisIndex(chart) {
    const tooltip = chart && chart.tooltip;
    if (!tooltip || tooltip.opacity === 0) {
      return -1;
    }
    const activeElements = typeof tooltip.getActiveElements === "function"
      ? tooltip.getActiveElements()
      : [];
    return Array.isArray(activeElements) && activeElements.length
      ? Number(activeElements[0].index)
      : -1;
  }

  tagRadarChart = new Chart(document.getElementById("tagRadarChart"), {
    type: "radar",
    plugins: [tagRadarTickLabelPlugin, fixedTagRadarRadiusPlugin],
    data: {
      labels,
      datasets: [
        {
          label: "Tag Guess Rate (%)",
          data: values,
          borderColor: "#2a9d8f",
          backgroundColor: "rgba(42, 157, 143, 0.28)",
          pointBackgroundColor: "#2a9d8f",
          pointBorderColor: "#2a9d8f",
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 18,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0
        }
      },
      onHover: (event, activeElements, chart) => {
        chart.draw();
      },
      interaction: {
        mode: "nearest",
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: "#333",
            font: { size: 14 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${Math.round(Number(context.raw))}%`;
            }
          }
        }
      },
      scales: {
        r: {
          beginAtZero: true,
          min: radarScale.min,
          max: radarScale.max,
          ticks: {
            stepSize: radarScale.stepSize,
            precision: 0,
            color: "rgba(0, 0, 0, 0)",
            showLabelBackdrop: false,
            callback: function() {
              return "";
            }
          },
          grid: {
            circular: true,
            color: function(context) {
              const value = Number(context.tick && context.tick.value);
              const min = Number(radarScale.min);
              const max = Number(radarScale.max);
              if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
                return "rgba(148, 163, 184, 0.22)";
              }
              const isOuterRing = Math.abs(value - max) < Math.max(1e-8, Math.abs(max) * 1e-8);
              return isOuterRing
                ? "rgba(51, 65, 85, 0.72)"
                : "rgba(148, 163, 184, 0.22)";
            }
          },
          angleLines: {
            color: function(context) {
              const activeAxisIndex = getTooltipAxisIndex(context && context.chart);
              const idx = Number(context && context.index);
              if (Number.isFinite(idx) && idx === activeAxisIndex) {
                return axisHighlightColor;
              }
              return "rgba(148, 163, 184, 0.40)";
            }
          },
          pointLabels: {
            color: function(context) {
              const activeAxisIndex = getTooltipAxisIndex(context && context.chart);
              const idx = Number(context && context.index);
              return Number.isFinite(idx) && idx === activeAxisIndex
                ? axisHighlightColor
                : "#374151";
            },
            font: { size: 12 }
          }
        }
      }
    }
  });
}

function renderSelectedTagButtons(tagNames) {
  const wrap = document.getElementById("selectedTagsInline");
  if (!wrap) return;

  if (!tagNames.length) {
    wrap.innerHTML = '<div class="selected-tags-empty">No selected tags</div>';
    return;
  }

  wrap.innerHTML = "";
  tagNames.forEach(tag => {
    const chip = document.createElement("div");
    chip.className = "selected-tag-chip";

    const text = document.createElement("span");
    text.innerText = tag;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "selected-tag-remove";
    removeBtn.innerText = "−";
    removeBtn.title = `Deselect ${tag}`;
    removeBtn.addEventListener("click", () => {
      const totalAvailableTags = Object.values(cachedTagData || {}).filter(
        value => value && typeof value.guessRate === "number"
      ).length;
      const minRequiredSelection = Math.min(MIN_SELECTED_TAGS, totalAvailableTags);
      if (selectedTagNames.length <= minRequiredSelection) {
        return;
      }
      selectedTagNames = selectedTagNames.filter(name => name !== tag);
      const checkboxWrap = document.getElementById("tagCheckboxList");
      checkboxWrap.querySelectorAll('input[type="checkbox"]').forEach(input => {
        if (input.value === tag) {
          input.checked = false;
        }
      });
      drawTagRadarFromSelection();
    });

    chip.appendChild(text);
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

function getCleanAltNames(playerEntry, canonicalName = "") {
  const rawAltNames = Array.isArray(playerEntry && playerEntry.altnames)
    ? playerEntry.altnames
    : [];
  const canonicalLower = String(canonicalName || "").trim().toLowerCase();
  const seen = new Set();
  return rawAltNames.filter(name => {
    const trimmed = String(name || "").trim();
    if (!trimmed) return false;
    const key = trimmed.toLowerCase();
    if (canonicalLower && key === canonicalLower) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatPlayerDisplayWithAliases(playerEntry, fallbackName = "") {
  const canonicalName = String(
    playerEntry && playerEntry.displayName
      ? playerEntry.displayName
      : fallbackName || "Unknown"
  ).trim();
  const cleanAlts = getCleanAltNames(playerEntry, canonicalName);
  return cleanAlts.length
    ? `${canonicalName} [${cleanAlts.join(", ")}]`
    : canonicalName;
}

function applyUsernameAkaUi(canonicalName, playerEntry) {
  const akaEl = document.getElementById("usernameAka");
  const akaPopoverEl = document.getElementById("usernameAkaPopover");
  const usernameBlockEl = document.getElementById("usernameBlock");
  if (!akaEl || !akaPopoverEl || !usernameBlockEl) return [];

  const cleanedAltNames = getCleanAltNames(playerEntry, canonicalName);
  const akaInlineText = cleanedAltNames.length ? `(aka) ${cleanedAltNames.join(", ")}` : "";
  akaEl.innerText = akaInlineText;
  akaPopoverEl.innerText = cleanedAltNames.length ? cleanedAltNames.join(", ") : "";
  usernameBlockEl.classList.toggle("has-aka", cleanedAltNames.length > 0);
  return cleanedAltNames;
}

async function loadPlayersDirectory() {
  if (playersDirectoryPromise) {
    return playersDirectoryPromise;
  }

  playersDirectoryPromise = (async () => {
    try {
      const playersRes = await fetch(dataUrl("players.json"));
      if (!playersRes.ok) {
        playersDirectoryByLookup = new Map();
        return [];
      }
      const players = await playersRes.json();
      if (!Array.isArray(players)) {
        playersDirectoryByLookup = new Map();
        return [];
      }

      const lookup = new Map();
      players.forEach(player => {
        const aliases = [
          player && player.displayName,
          ...(Array.isArray(player && player.altnames) ? player.altnames : [])
        ];
        aliases.forEach(alias => {
          const normalized = String(alias || "").trim().toLowerCase();
          if (!normalized || lookup.has(normalized)) return;
          lookup.set(normalized, player);
        });
      });
      playersDirectoryByLookup = lookup;
      return players;
    } catch (err) {
      console.error("Failed loading players.json", err);
      playersDirectoryByLookup = new Map();
      return [];
    }
  })();

  return playersDirectoryPromise;
}

function getPlayerEntryFromCacheByName(displayName) {
  const target = String(displayName || "").trim().toLowerCase();
  if (!target || !(playersDirectoryByLookup instanceof Map) || !playersDirectoryByLookup.size) {
    return null;
  }
  return playersDirectoryByLookup.get(target) || null;
}

async function getPlayerEntryByName(displayName) {
  await loadPlayersDirectory();
  return getPlayerEntryFromCacheByName(displayName);
}

function getWeightedGuessRateFromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const raw = Number(
    entry.weightedGuessRate
      ?? entry["weightedGuessRate"]
      ?? entry.weighted_guess_rate
      ?? entry["weighted_guess_rate"]
  );
  if (!Number.isFinite(raw)) return null;
  return Math.abs(raw) <= 1 ? raw * 100 : raw;
}

function getWeightedTimestampFromEntry(entry, keyHint = "") {
  const candidates = [
    entry && entry.timestamp,
    entry && entry.Timestamp,
    keyHint
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    if (Number.isFinite(getSortableTimestampValue(text))) return text;
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
      const millis = numeric < 1e11 ? numeric * 1000 : numeric;
      const epochDate = new Date(millis);
      if (!Number.isNaN(epochDate.getTime())) {
        return epochDate.toISOString().replace("T", " ").replace("Z", "");
      }
    }
  }
  return "";
}

function filterWeightedSeriesToVisibleRecords(series, records) {
  if (!Array.isArray(series) || !series.length) return [];
  if (!Array.isArray(records) || !records.length) return [];

  const visibleTimes = new Set(
    records
      .map(row => getSortableTimestampValue(row && row.Timestamp))
      .filter(value => Number.isFinite(value))
  );

  let filtered = series.filter(point => visibleTimes.has(getSortableTimestampValue(point && point.timestamp)));
  if (filtered.length) {
    return filtered;
  }

  const rangeValue = String(dataRangeSelect && dataRangeSelect.value ? dataRangeSelect.value : "all");
  if (rangeValue === "all") {
    return [...series];
  }
  if (/^\d+$/.test(rangeValue)) {
    const count = Number(rangeValue);
    if (!Number.isFinite(count) || count <= 0) return [...series];
    return series.slice(-count);
  }

  const latestMs = getSortableTimestampValue(series[series.length - 1] && series[series.length - 1].timestamp);
  if (!Number.isFinite(latestMs)) return [...series];
  const daysByRange = {
    week: 7,
    month: 30,
    "2months": 60,
    "3months": 90,
    "6months": 180
  };
  const days = daysByRange[rangeValue];
  if (!days) return [...series];
  const cutoffMs = latestMs - days * 24 * 60 * 60 * 1000;
  filtered = series.filter(point => {
    const ms = getSortableTimestampValue(point && point.timestamp);
    return Number.isFinite(ms) && ms >= cutoffMs;
  });
  return filtered.length ? filtered : [...series];
}

async function loadWeightedGuessRateSeriesForCurrentPlayer() {
  if (!currentPlayerId) {
    const playerEntry = await getPlayerEntryByName(currentDisplayName || currentStatKey || username || "");
    if (playerEntry && playerEntry.playerId) {
      currentPlayerId = String(playerEntry.playerId);
    }
  }
  if (!currentPlayerId) {
    return [];
  }

  const playerId = String(currentPlayerId);
  if (cachedWeightedGuessRateSeriesByPlayerId.has(playerId)) {
    return cachedWeightedGuessRateSeriesByPlayerId.get(playerId);
  }

  try {
    const response = await fetchPlayerScopedResponse(playerId, "weighted_guess_rate/weighted_guess_rate.json");
    if (!response) {
      cachedWeightedGuessRateSeriesByPlayerId.set(playerId, []);
      return [];
    }
    const payload = await response.json();
    const series = [];

    if (Array.isArray(payload)) {
      payload.forEach((entry, index) => {
        const weightedGuessRate = getWeightedGuessRateFromEntry(entry);
        if (!Number.isFinite(weightedGuessRate)) return;
        const timestamp = getWeightedTimestampFromEntry(entry, String(index));
        if (!timestamp) return;
        series.push({ timestamp, weightedGuessRate });
      });
    } else if (payload && typeof payload === "object") {
      Object.entries(payload).forEach(([key, value]) => {
        if (!value || typeof value !== "object") return;
        const weightedGuessRate = getWeightedGuessRateFromEntry(value);
        if (!Number.isFinite(weightedGuessRate)) return;
        const timestamp = getWeightedTimestampFromEntry(value, key);
        if (!timestamp) return;
        series.push({ timestamp, weightedGuessRate });
      });
    }

    series.sort((a, b) => {
      const timeA = getSortableTimestampValue(a && a.timestamp);
      const timeB = getSortableTimestampValue(b && b.timestamp);
      if (timeA !== timeB) return timeA - timeB;
      return String(a && a.timestamp || "").localeCompare(String(b && b.timestamp || ""));
    });

    cachedWeightedGuessRateSeriesByPlayerId.set(playerId, series);
    return series;
  } catch (error) {
    console.error("Failed loading weighted guess rate data", error);
    cachedWeightedGuessRateSeriesByPlayerId.set(playerId, []);
    return [];
  }
}

async function renderWeightedGuessRateChart(records) {
  const foundMeta = document.getElementById("weightedGuessRateFound");
  const slopeMeta = document.getElementById("weightedGuessRateSlope");
  const canvas = document.getElementById("weightedGuessRateChart");
  if (!foundMeta || !slopeMeta || !canvas) return;

  const requestId = ++weightedGuessRateRequestId;
  foundMeta.innerText = "Loading weighted data...";
  slopeMeta.innerText = "Slope: 0.00% per game";

  const fullSeries = await loadWeightedGuessRateSeriesForCurrentPlayer();
  if (requestId !== weightedGuessRateRequestId) return;

  const visibleSeries = filterWeightedSeriesToVisibleRecords(fullSeries, records);
  if (!visibleSeries.length) {
    foundMeta.innerText = "Found 0 games";
    if (weightedGuessRateChart) {
      weightedGuessRateChart.destroy();
      weightedGuessRateChart = null;
    }
    return;
  }

  const labels = visibleSeries.map(point => point.timestamp);
  const values = visibleSeries.map(point => Number(point.weightedGuessRate));
  const { slope } = buildTrend(values);

  foundMeta.innerText = `Found ${visibleSeries.length} games`;
  slopeMeta.innerText = `Slope: ${slope >= 0 ? "+" : ""}${slope.toFixed(2)}% per game`;
  weightedGuessRateChart = renderTrendChart(
    weightedGuessRateChart,
    "weightedGuessRateChart",
    labels,
    values,
    "Weighted Guess Rate (%)",
    "Weighted guess rate (%)",
    { metaElementId: "weightedGuessRateFound", metaUnit: "games" }
  );
}

function getKnowledgeWindowFileName() {
  const rangeValue = dataRangeSelect ? dataRangeSelect.value : "all";
  return knowledgeWindowFileByRange[rangeValue] || "all.json";
}

function getOverviewAnimeTypeFileName() {
  const windowFile = getKnowledgeWindowFileName();
  if (windowFile === "all.json") {
    return "anime_type_count_all.json";
  }
  return `anime_type_count_${windowFile.replace(/\.json$/i, "")}.json`;
}

async function loadGenreDataForUser(displayName) {
  try {
    if (!displayName) {
      cachedGenreData = null;
      renderKnowledgeGenreRadar();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedGenreData = null;
        renderKnowledgeGenreRadar();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    const windowFile = getKnowledgeWindowFileName();
    const genresRes = await fetchPlayerScopedResponse(currentPlayerId, `genres/${windowFile}`);
    if (!genresRes) {
      cachedGenreData = null;
      renderKnowledgeGenreRadar();
      return;
    }
    const genresPayload = await genresRes.json();
    cachedGenreData = genresPayload.data || null;
    renderKnowledgeGenreRadar();
  } catch (err) {
    console.error("Failed loading genre data", err);
    cachedGenreData = null;
    renderKnowledgeGenreRadar();
  }
}

async function loadOverviewZScoreDataForUser(displayName) {
  const requestId = ++overviewZScoreLoadRequestId;
  try {
    if (!displayName) {
      cachedOverviewZScoreData = null;
      renderOverviewZScoreChart();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedOverviewZScoreData = null;
        renderOverviewZScoreChart();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    const fileCandidates = ["z-score.json", "z_score.json"];
    let payload = null;
    for (const fileName of fileCandidates) {
      const res = await fetchPlayerScopedResponse(currentPlayerId, `overview/${fileName}`, "watched");
      if (!res) continue;
      payload = await res.json();
      break;
    }

    if (requestId !== overviewZScoreLoadRequestId) return;
    cachedOverviewZScoreData = payload && typeof payload === "object" ? payload : null;
    renderOverviewZScoreChart();
  } catch (err) {
    console.error("Failed loading overview z-score data", err);
    if (requestId !== overviewZScoreLoadRequestId) return;
    cachedOverviewZScoreData = null;
    renderOverviewZScoreChart();
  }
}

async function loadTagDataForUser(displayName) {
  try {
    if (!displayName) {
      cachedTagData = null;
      selectedTagNames = [];
      renderKnowledgeTagRadar();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedTagData = null;
        selectedTagNames = [];
        renderKnowledgeTagRadar();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    const windowFile = getKnowledgeWindowFileName();
    const tagsRes = await fetchPlayerScopedResponse(currentPlayerId, `tags/${windowFile}`);
    if (!tagsRes) {
      cachedTagData = null;
      selectedTagNames = [];
      renderKnowledgeTagRadar();
      return;
    }
    const tagsPayload = await tagsRes.json();
    cachedTagData = tagsPayload.data || null;
    selectedTagNames = [];
    renderKnowledgeTagRadar();
  } catch (err) {
    console.error("Failed loading tag data", err);
    cachedTagData = null;
    selectedTagNames = [];
    renderKnowledgeTagRadar();
  }
}

async function loadByEraDataForUser(displayName) {
  const requestSeq = ++byEraDataRequestSeq;
  try {
    if (!displayName) {
      cachedByEraData = null;
      selectedByEraSeasonLabels = [];
      renderKnowledgeByEraDecadeChart();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedByEraData = null;
        selectedByEraSeasonLabels = [];
        renderKnowledgeByEraDecadeChart();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    const windowFile = getKnowledgeWindowFileName();
    const byEraRes = await fetchPlayerScopedResponse(currentPlayerId, `by_era/${windowFile}`);
    if (!byEraRes) {
      if (requestSeq !== byEraDataRequestSeq) return;
      cachedByEraData = null;
      selectedByEraSeasonLabels = [];
      renderKnowledgeByEraDecadeChart();
      return;
    }
    const byEraPayloadRaw = await byEraRes.json();
    if (requestSeq !== byEraDataRequestSeq) return;
    cachedByEraData = byEraPayloadRaw && typeof byEraPayloadRaw === "object"
      && byEraPayloadRaw.data && typeof byEraPayloadRaw.data === "object"
      ? byEraPayloadRaw.data
      : byEraPayloadRaw;
    renderKnowledgeByEraDecadeChart();
  } catch (err) {
    if (requestSeq !== byEraDataRequestSeq) return;
    console.error("Failed loading by-era data", err);
    cachedByEraData = null;
    selectedByEraSeasonLabels = [];
    renderKnowledgeByEraDecadeChart();
  }
}

async function loadArtistDataForUser(displayName) {
  try {
    if (!displayName) {
      cachedArtistsData = null;
      artistFamiliarityEntries = [];
      selectedArtistName = "";
      renderArtistFamiliarityView();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedArtistsData = null;
        artistFamiliarityEntries = [];
        selectedArtistName = "";
        renderArtistFamiliarityView();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    const artistsRes = await fetchPlayerScopedResponse(currentPlayerId, "artists.json");
    if (!artistsRes) {
      cachedArtistsData = null;
      artistFamiliarityEntries = [];
      selectedArtistName = "";
      renderArtistFamiliarityView();
      return;
    }

    const artistsPayload = await artistsRes.json();
    await loadSongKeyById();
    cachedArtistsData = artistsPayload && typeof artistsPayload === "object" ? artistsPayload.data || null : null;

    const entries = cachedArtistsData && typeof cachedArtistsData === "object"
      ? Object.entries(cachedArtistsData)
          .map(([name, value]) => ({
            name: String(name || "").trim(),
            total: Number(value && value.total || 0),
            value: value && typeof value === "object" ? value : {}
          }))
          .filter(entry => entry.name)
      : [];

    artistFamiliarityEntries = entries.sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total;
      return a.name.localeCompare(b.name);
    });
    if (!artistFamiliarityEntries.some(entry => entry.name === selectedArtistName)) {
      selectedArtistName = artistFamiliarityEntries.length ? artistFamiliarityEntries[0].name : "";
    }
    renderArtistFamiliarityView();
  } catch (err) {
    console.error("Failed loading artist familiarity data", err);
    cachedArtistsData = null;
    artistFamiliarityEntries = [];
    selectedArtistName = "";
    renderArtistFamiliarityView();
  }
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractAnimeTypeOverviewRows(payload) {
  const root = (function() {
    if (!payload || typeof payload !== "object") return payload;
    if (payload.anime_type_stats && typeof payload.anime_type_stats === "object") {
      return payload.anime_type_stats;
    }
    if (payload.animeTypeStats && typeof payload.animeTypeStats === "object") {
      return payload.animeTypeStats;
    }
    if (payload.data && typeof payload.data === "object") {
      if (payload.data.anime_type_stats && typeof payload.data.anime_type_stats === "object") {
        return payload.data.anime_type_stats;
      }
      if (payload.data.animeTypeStats && typeof payload.data.animeTypeStats === "object") {
        return payload.data.animeTypeStats;
      }
      return payload.data;
    }
    return payload;
  })();
  const rows = [];

  const addRow = (labelValue, entry) => {
    if (!entry || typeof entry !== "object") return;
    const rawLabel = (entry.type ?? entry.animeType ?? entry.label ?? entry.name ?? labelValue);
    const label = String(rawLabel || "").trim();
    if (!label) return;

    const explicitTotal = numberOrNull(
      entry.totalSongs ?? entry["total songs"] ?? entry.totalPlayed ?? entry.total ?? entry.count ?? entry.songsPlayed
    );
    const correct = numberOrNull(entry.correct ?? entry.right);
    const wrong = numberOrNull(entry.wrong ?? entry.incorrect);
    const derivedTotal = (correct != null && wrong != null) ? correct + wrong : null;
    const totalSongs = explicitTotal != null ? explicitTotal : (derivedTotal != null ? derivedTotal : 0);

    const explicitGuessRate = numberOrNull(
      entry.guessRate ?? entry.guess_rate ?? entry.rate ?? entry.percentage ?? entry.percent
    );
    const guessRate = explicitGuessRate != null
      ? explicitGuessRate
      : ((totalSongs > 0 && correct != null) ? (correct / totalSongs) * 100 : 0);

    rows.push({
      label,
      totalSongs: Math.max(0, totalSongs),
      guessRate: Math.max(0, Math.min(100, guessRate))
    });
  };

  if (Array.isArray(root)) {
    root.forEach(entry => addRow("", entry));
  } else if (root && typeof root === "object") {
    Object.entries(root).forEach(([label, entry]) => addRow(label, entry));
  }

  return rows.filter(item => item.label && (item.totalSongs > 0 || item.guessRate > 0));
}

function buildOverviewTypeColors(size) {
  const palette = [
    "#2563eb", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#14b8a6",
    "#f97316", "#84cc16", "#06b6d4", "#e11d48", "#6366f1", "#22c55e"
  ];
  const colors = [];
  for (let i = 0; i < size; i++) {
    colors.push(palette[i % palette.length]);
  }
  return colors;
}

function calculateOverviewTypeMixBalanceScore(records) {
  if (!Array.isArray(records) || !records.length) return null;

  const opValues = records.map(row => Number(row && row["OP guess rate"]));
  const edValues = records.map(row => Number(row && row["ED guess rate"]));
  const inValues = records.map(row => Number(row && row["IN guess rate"]));
  const opAverage = opValues.reduce((sum, value) => sum + value, 0) / opValues.length;
  const edAverage = edValues.reduce((sum, value) => sum + value, 0) / edValues.length;
  const inAverage = inValues.reduce((sum, value) => sum + value, 0) / inValues.length;
  if (!Number.isFinite(opAverage) || !Number.isFinite(edAverage) || !Number.isFinite(inAverage)) return null;

  const totalAverage = opAverage + edAverage + inAverage;
  if (!Number.isFinite(totalAverage) || totalAverage <= 0) return null;

  const shares = [
    opAverage / totalAverage,
    edAverage / totalAverage,
    inAverage / totalAverage
  ];
  const k = 3;
  const targetShare = 1 / k;
  const l1Distance = shares.reduce((sum, value) => sum + Math.abs(value - targetShare), 0);
  const normalizedDistance = l1Distance / (2 * (1 - targetShare));
  const score = 100 * (1 - normalizedDistance);
  return Math.max(0, Math.min(100, score));
}

function renderOverviewTypeMixBalance(records = null) {
  const typeMixEl = document.getElementById("overviewTypeMixBalance");
  if (!typeMixEl) return;

  const sourceRecords = Array.isArray(records) && records.length
    ? records
    : (Array.isArray(fullUserData) && fullUserData.length ? getVisibleUserData(fullUserData) : []);
  const score = calculateOverviewTypeMixBalanceScore(sourceRecords);
  typeMixEl.innerText = Number.isFinite(score) ? score.toFixed(1) : "-";
}

function extractOverviewTopSolosRows(payload, { limit = 50 } = {}) {
  const rows = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.topSolos) ? payload.topSolos : []);

  const normalized = rows
    .filter(item => item && typeof item === "object")
    .map((item, index) => {
      const rankValue = Number(item.rank);
      const soloCount = Number(item.soloCount ?? item.count ?? 0);
      const difficultyRaw = Number(item.difficulty);
      const songidRaw = item.songid ?? item.songId;
      const songid = Number(songidRaw);
      return {
        rank: Number.isFinite(rankValue) ? rankValue : index + 1,
        songid: Number.isFinite(songid) ? Math.trunc(songid) : null,
        animeName: String(item.animeName ?? item.anime ?? ""),
        animeRomaji: String(item.animeRomaji ?? ""),
        songName: String(item.songName ?? item.song ?? ""),
        type: String(item.type ?? ""),
        soloCount: Number.isFinite(soloCount) ? Math.max(0, soloCount) : 0,
        difficulty: Number.isFinite(difficultyRaw) ? difficultyRaw : null
      };
    });

  normalized.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.soloCount !== b.soloCount) return b.soloCount - a.soloCount;
    return a.songName.localeCompare(b.songName);
  });

  if (Number.isFinite(limit) && limit >= 0) {
    return normalized.slice(0, limit);
  }
  return normalized;
}

function renderOverviewTopSolos() {
  const strip = document.getElementById("overviewTopSolosStrip");
  const meta = document.getElementById("overviewTopSolosMeta");
  if (!strip || !meta) return;

  const solos = Array.isArray(cachedOverviewTopSolos) ? cachedOverviewTopSolos : [];
  meta.innerText = `Found ${solos.length} songs`;
  strip.innerHTML = "";

  if (!solos.length) {
    const empty = document.createElement("div");
    empty.className = "overview-rig-top-songs-empty";
    empty.innerText = "No solo data found for this player.";
    strip.appendChild(empty);
    return;
  }

  solos.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "overview-rig-top-song-card";

    const rank = document.createElement("p");
    rank.className = "overview-rig-top-song-rank";
    rank.innerText = `#${Number(item.rank) || index + 1}`;
    card.appendChild(rank);

    const coverNode = buildInsightsCoverNode(item);
    coverNode.classList.add("overview-rig-top-song-cover");
    card.appendChild(coverNode);

    const anime = document.createElement("p");
    anime.className = "overview-rig-top-song-anime";
    anime.innerText = getLanguageAwareAnimeName(item);
    card.appendChild(anime);

    const songName = document.createElement("p");
    songName.className = "overview-rig-top-song-name";
    songName.innerText = String(item && (item.songName || item.title) ? (item.songName || item.title) : "—");
    card.appendChild(songName);

    const type = document.createElement("p");
    type.className = "overview-rig-top-song-type";
    const typeLabel = String(item && item.type ? item.type : "—");
    type.innerText = typeLabel;
    card.appendChild(type);

    const count = document.createElement("p");
    count.className = "overview-rig-top-song-submeta";
    count.innerText = `${Math.max(0, Number(item.soloCount || 0))} solos`;
    card.appendChild(count);

    strip.appendChild(card);
  });
}

function renderOverviewTopDoublesByIds(options = {}) {
  const {
    stripId = "",
    metaId = "",
    rows = [],
    countLabel = "doubles",
    emptyMessage = "No data found for this player."
  } = options;
  const strip = document.getElementById(stripId);
  const meta = document.getElementById(metaId);
  if (!strip || !meta) return;

  const songs = Array.isArray(rows) ? rows : [];
  meta.innerText = `Found ${songs.length} songs`;
  strip.innerHTML = "";

  if (!songs.length) {
    const empty = document.createElement("div");
    empty.className = "overview-rig-top-songs-empty";
    empty.innerText = emptyMessage;
    strip.appendChild(empty);
    return;
  }

  songs.forEach((song, index) => {
    const card = document.createElement("div");
    card.className = "overview-rig-top-song-card";

    const rank = document.createElement("p");
    rank.className = "overview-rig-top-song-rank";
    rank.innerText = `#${Number(song && song.rank) || (index + 1)}`;
    card.appendChild(rank);

    const coverNode = buildInsightsCoverNode(song);
    coverNode.classList.add("overview-rig-top-song-cover");
    card.appendChild(coverNode);

    const anime = document.createElement("p");
    anime.className = "overview-rig-top-song-anime";
    anime.innerText = getLanguageAwareAnimeName(song);
    card.appendChild(anime);

    const songName = document.createElement("p");
    songName.className = "overview-rig-top-song-name";
    songName.innerText = String(song && (song.songName || song.title) ? (song.songName || song.title) : "—");
    card.appendChild(songName);

    const type = document.createElement("p");
    type.className = "overview-rig-top-song-type";
    type.innerText = String(song && song.type ? song.type : "—");
    card.appendChild(type);

    if (Number.isFinite(song && song.count)) {
      const count = document.createElement("p");
      count.className = "overview-rig-top-song-submeta";
      count.innerText = `${Math.max(0, Number(song.count))} ${countLabel}`;
      card.appendChild(count);
    }

    strip.appendChild(card);
  });
}

function getOverviewTopDoublesRowsForMode(mode) {
  if (mode === "their_rig_you_blocked") {
    return Array.isArray(cachedOverviewTopDoublesTheirRigBlocked) ? cachedOverviewTopDoublesTheirRigBlocked : [];
  }
  if (mode === "your_rig_they_blocked") {
    return Array.isArray(cachedOverviewTopDoublesYourRigBlocked) ? cachedOverviewTopDoublesYourRigBlocked : [];
  }
  return Array.isArray(cachedOverviewTopDoublesGeneral) ? cachedOverviewTopDoublesGeneral : [];
}

function applyTopDoublesDisplayLimit(rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length) return [];
  const topThirtyPercentCount = Math.ceil(normalizedRows.length * 0.3);
  const cappedCount = Math.min(100, Math.max(0, topThirtyPercentCount));
  return normalizedRows.slice(0, cappedCount);
}

function renderOverviewTopDoubles() {
  const mode = String(overviewTopDoublesMode || "general");
  const rows = getOverviewTopDoublesRowsForMode(mode);
  updateOverviewTopDoublesTypeToggleUI();
  renderOverviewTopDoublesByIds({
    stripId: "overviewTopDoublesStrip",
    metaId: "overviewTopDoublesMeta",
    rows,
    countLabel: "doubles",
    emptyMessage: "No doubles data found for this player."
  });
}

function extractOverviewTopRigSongRows(payload) {
  const ids = Array.isArray(payload) ? payload : [];
  return ids
    .map(value => {
      if (value && typeof value === "object") {
        const songid = Number(value.songid ?? value.songId);
        const count = Number(value.count);
        return Number.isFinite(songid)
          ? { songid: Math.trunc(songid), count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null }
          : null;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? { songid: Math.trunc(numeric), count: null } : null;
    })
    .filter(item => item && Number.isFinite(item.songid) && item.songid > 0);
}

function renderOverviewTopRigSongs() {
  const strip = document.getElementById("overviewTopRigSongsStrip");
  const meta = document.getElementById("overviewTopRigSongsMeta");
  if (!strip || !meta) return;

  const songs = applyTopDoublesDisplayLimit(
    Array.isArray(cachedOverviewTopRigSongs) ? cachedOverviewTopRigSongs : []
  );
  meta.innerText = `Found ${songs.length} songs`;
  strip.innerHTML = "";

  if (!songs.length) {
    const empty = document.createElement("div");
    empty.className = "overview-rig-top-songs-empty";
    empty.innerText = "No rig top-song data found for this player.";
    strip.appendChild(empty);
    return;
  }

  songs.forEach((song, index) => {
    const card = document.createElement("div");
    card.className = "overview-rig-top-song-card";

    const rank = document.createElement("p");
    rank.className = "overview-rig-top-song-rank";
    rank.innerText = `#${index + 1}`;
    card.appendChild(rank);

    const coverNode = buildInsightsCoverNode(song);
    coverNode.classList.add("overview-rig-top-song-cover");
    card.appendChild(coverNode);

    const anime = document.createElement("p");
    anime.className = "overview-rig-top-song-anime";
    anime.innerText = getLanguageAwareAnimeName(song);
    card.appendChild(anime);

    const songName = document.createElement("p");
    songName.className = "overview-rig-top-song-name";
    songName.innerText = String(song && (song.songName || song.title) ? (song.songName || song.title) : "—");
    card.appendChild(songName);

    const type = document.createElement("p");
    type.className = "overview-rig-top-song-type";
    const typeLabel = String(song && song.type ? song.type : "—");
    type.innerText = typeLabel;
    card.appendChild(type);

    if (Number.isFinite(song && song.count)) {
      const count = document.createElement("p");
      count.className = "overview-rig-top-song-submeta";
      count.innerText = `Played ${song.count} times`;
      card.appendChild(count);
    }

    strip.appendChild(card);
  });
}

function extractOverviewZScoreRows(payload) {
  const chartMetrics = payload && Array.isArray(payload.chart_metrics)
    ? payload.chart_metrics
    : [];
  const metricDetails = payload && payload.metrics && typeof payload.metrics === "object"
    ? payload.metrics
    : {};
  return chartMetrics
    .map(item => {
      const value = Number(item && item.value);
      const averageValue = Number(item && item.average_value);
      const baselinePlayerCount = Number(item && item.baseline_player_count);
      const key = String(item && item.key || "");
      const detail = key && metricDetails[key] && typeof metricDetails[key] === "object"
        ? metricDetails[key]
        : {};
      const globalMean = Number(
        item && item.global_mean != null
          ? item.global_mean
          : detail.global_mean
      );
      return {
        key,
        label: String(item && item.label || item && item.key || "Metric"),
        value,
        averageValue: Number.isFinite(averageValue) ? averageValue : null,
        globalMean: Number.isFinite(globalMean) ? globalMean : null,
        direction: String(item && item.direction || "higher"),
        baselinePlayerCount: Number.isFinite(baselinePlayerCount) ? baselinePlayerCount : 0
      };
    })
    .filter(item => item.label && Number.isFinite(item.value));
}

function formatOverviewZScoreNumber(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return "-";
  return numericValue.toFixed(digits);
}

function ensureOverviewZScoreTooltipPositioner() {
  const tooltipApi = window.Chart && window.Chart.Tooltip;
  const positioners = tooltipApi && tooltipApi.positioners;
  if (!positioners) return false;
  if (positioners.overviewZScoreOppositeZero) return true;

  positioners.overviewZScoreOppositeZero = function(activeElements) {
    if (!activeElements || !activeElements.length) return false;

    const active = activeElements[0];
    const chart = this.chart;
    const xScale = chart && chart.scales && chart.scales.x;
    const chartArea = chart && chart.chartArea;
    if (!chart || !xScale || !chartArea || typeof xScale.getPixelForValue !== "function") {
      return false;
    }

    const dataset = chart.data && chart.data.datasets && chart.data.datasets[active.datasetIndex];
    const rawValue = Number(dataset && dataset.data ? dataset.data[active.index] : NaN);
    const zeroX = xScale.getPixelForValue(0);
    const gap = 8;
    const x = rawValue >= 0
      ? Math.max(chartArea.left + gap, zeroX - gap)
      : Math.min(chartArea.right - gap, zeroX + gap);
    const y = active.element && Number.isFinite(active.element.y)
      ? active.element.y
      : (chartArea.top + chartArea.bottom) / 2;

    return {
      x,
      y,
      xAlign: rawValue >= 0 ? "right" : "left",
      yAlign: "center"
    };
  };

  return true;
}

function renderOverviewZScoreChart() {
  const card = document.getElementById("overviewZScoreCard");
  const canvas = document.getElementById("overviewZScoreChart");
  const wrap = canvas ? canvas.closest(".overview-z-score-wrap") : null;
  if (!card || !canvas) return;

  if (overviewZScoreChart) {
    overviewZScoreChart.destroy();
    overviewZScoreChart = null;
  }

  const rows = extractOverviewZScoreRows(cachedOverviewZScoreData);
  if (!rows.length) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  if (wrap) {
    const chartHeight = `${Math.max(360, rows.length * 30 + 86)}px`;
    wrap.style.setProperty("height", chartHeight, "important");
    wrap.style.setProperty("min-height", chartHeight, "important");
  }

  const labels = rows.map(row => row.label);
  const values = rows.map(row => Number(row.value));
  const finiteValues = values.filter(value => Number.isFinite(value));
  const zTickStep = 0.5;
  const maxAbsValue = finiteValues.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const axisMax = Math.max(zTickStep, Math.ceil(maxAbsValue / zTickStep) * zTickStep);
  const barColors = values.map(value => value >= 0 ? "rgba(22, 163, 74, 0.74)" : "rgba(220, 38, 38, 0.70)");
  const borderColors = values.map(value => value >= 0 ? "#15803d" : "#b91c1c");
  const tooltipPosition = ensureOverviewZScoreTooltipPositioner()
    ? "overviewZScoreOppositeZero"
    : "nearest";

  overviewZScoreChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "score",
          data: values,
          backgroundColor: barColors,
          borderColor: borderColors,
          borderWidth: 1.1,
          borderRadius: 5,
          barPercentage: 0.74,
          categoryPercentage: 0.78
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          position: tooltipPosition,
          xAlign: function(context) {
            const tooltip = context && context.tooltip;
            const point = tooltip && tooltip.dataPoints && tooltip.dataPoints[0];
            const value = Number(point && point.raw);
            return value >= 0 ? "right" : "left";
          },
          yAlign: "center",
          caretPadding: 0,
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          callbacks: {
            label: function(context) {
              const value = Number(context.raw);
              return `Score: ${Number.isFinite(value) ? value.toFixed(2) : "-"}`;
            },
            afterLabel: function(context) {
              const row = rows[Number(context.dataIndex)] || {};
              const lines = [];
              if (Number.isFinite(row.averageValue)) {
                lines.push(`Your average: ${formatOverviewZScoreNumber(row.averageValue, 3)}`);
              }
              if (Number.isFinite(row.globalMean)) {
                lines.push(`Population average: ${formatOverviewZScoreNumber(row.globalMean, 3)}`);
              }
              if (Number.isFinite(row.baselinePlayerCount) && row.baselinePlayerCount > 0) {
                lines.push(`Baseline: ${row.baselinePlayerCount} players`);
              }
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          min: -axisMax,
          max: axisMax,
          border: {
            display: false
          },
          ticks: {
            color: "#475569",
            stepSize: zTickStep,
            callback: function(value) {
              return Number(value).toFixed(1);
            }
          },
          title: {
            display: true,
            text: "Standardized score",
            color: "#334155",
            font: {
              size: 12,
              weight: "bold"
            }
          },
          grid: {
            color: function(context) {
              return Number(context.tick && context.tick.value) === 0
                ? "rgba(15, 23, 42, 0.42)"
                : "rgba(148, 163, 184, 0.22)";
            },
            lineWidth: function(context) {
              return Number(context.tick && context.tick.value) === 0 ? 1.6 : 1;
            }
          }
        },
        y: {
          border: {
            display: false
          },
          ticks: {
            color: "#334155",
            autoSkip: false,
            font: {
              size: 12,
              weight: "600"
            }
          },
          grid: {
            display: false
          }
        }
      }
    }
  });
}

function renderOverviewAnimeTypeCharts() {
  const songsMeta = document.getElementById("overviewSongsPlayedMeta");
  const rateMeta = document.getElementById("overviewGuessRateMeta");
  const rows = Array.isArray(cachedOverviewAnimeTypeRows) ? cachedOverviewAnimeTypeRows : [];
  const gamesCounted = Number(cachedOverviewGamesCounted || 0);
  renderOverviewTypeMixBalance();

  if (songsMeta) {
    songsMeta.innerText = `Found ${gamesCounted} games`;
  }
  if (rateMeta) {
    rateMeta.innerText = `Found ${gamesCounted} games`;
  }

  if (overviewSongsPlayedChart) {
    overviewSongsPlayedChart.destroy();
    overviewSongsPlayedChart = null;
  }
  if (overviewGuessRateChart) {
    overviewGuessRateChart.destroy();
    overviewGuessRateChart = null;
  }

  if (!rows.length) return;

  const labels = rows.map(item => item.label);
  const songTotals = rows.map(item => Number(item.totalSongs || 0));
  const guessRates = rows.map(item => Number(item.guessRate || 0));
  const totalSongsAllTypes = songTotals.reduce((sum, value) => sum + value, 0);
  const songValues = overviewDataMode === "percentage"
    ? songTotals.map(value => totalSongsAllTypes > 0 ? (value / totalSongsAllTypes) * 100 : 0)
    : songTotals;
  const colors = buildOverviewTypeColors(rows.length);

  overviewSongsPlayedChart = new Chart(document.getElementById("overviewSongsPlayedChart"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          label: overviewDataMode === "percentage" ? "Songs Share (%)" : "Songs Played",
          data: songValues,
          backgroundColor: colors,
          borderColor: "#ffffff",
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: "#334155", font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: function(context) {
              const raw = Number(context.raw || 0);
              return overviewDataMode === "percentage"
                ? `${context.label}: ${raw.toFixed(2)}%`
                : `${context.label}: ${Math.round(raw)}`;
            }
          }
        }
      }
    }
  });

  overviewGuessRateChart = new Chart(document.getElementById("overviewGuessRateChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Guess Rate (%)",
          data: guessRates,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1.2,
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.label}: ${Number(context.raw || 0).toFixed(2)}%`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#475569",
            autoSkip: false,
            maxRotation: 45,
            minRotation: 45
          },
          grid: {
            color: "#e5e7eb"
          }
        },
        y: {
          beginAtZero: false,
          ticks: {
            color: "#475569",
            callback: function(value) {
              return `${Number(value).toFixed(1)}%`;
            }
          },
          title: {
            display: true,
            text: "Guess Rate (%)",
            color: "#334155",
            font: {
              size: 12,
              weight: "bold"
            }
          },
          grid: {
            color: "#e5e7eb"
          }
        }
      }
    }
  });
}

async function loadOverviewAnimeTypeDataForUser(displayName) {
  const requestId = ++overviewLoadRequestId;
  try {
    if (!displayName) {
      cachedOverviewAnimeTypeRows = [];
      cachedOverviewGamesCounted = 0;
      renderOverviewAnimeTypeCharts();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedOverviewAnimeTypeRows = [];
        cachedOverviewGamesCounted = 0;
        renderOverviewAnimeTypeCharts();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    const fileCandidates = [getOverviewAnimeTypeFileName(), "anime_type_count.json"];
    const tried = new Set();
    let overviewPayload = null;

    for (const fileName of fileCandidates) {
      if (tried.has(fileName)) continue;
      tried.add(fileName);
      const overviewRes = await fetchPlayerScopedResponse(currentPlayerId, `overview/${fileName}`);
      if (!overviewRes) continue;
      overviewPayload = await overviewRes.json();
      break;
    }

    if (!overviewPayload) {
      cachedOverviewAnimeTypeRows = [];
      cachedOverviewGamesCounted = 0;
      if (requestId !== overviewLoadRequestId) return;
      renderOverviewAnimeTypeCharts();
      return;
    }

    if (requestId !== overviewLoadRequestId) return;
    cachedOverviewAnimeTypeRows = extractAnimeTypeOverviewRows(overviewPayload);
    cachedOverviewGamesCounted = Number(
      (overviewPayload && overviewPayload.games_counted)
      || (overviewPayload && overviewPayload.data && overviewPayload.data.games_counted)
      || 0
    );
    renderOverviewAnimeTypeCharts();
  } catch (err) {
    console.error("Failed loading overview anime type data", err);
    if (requestId !== overviewLoadRequestId) return;
    cachedOverviewAnimeTypeRows = [];
    cachedOverviewGamesCounted = 0;
    renderOverviewAnimeTypeCharts();
  }
}

async function loadOverviewTopSolosForUser(displayName) {
  try {
    if (!displayName) {
      cachedOverviewTopSolos = [];
      renderOverviewTopSolos();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedOverviewTopSolos = [];
        renderOverviewTopSolos();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const solosRes = await fetchPlayerScopedResponse(currentPlayerId, "overview/top_solos.json");
    if (!solosRes) {
      cachedOverviewTopSolos = [];
      renderOverviewTopSolos();
      return;
    }

    const solosPayload = await solosRes.json();
    const normalizedRows = extractOverviewTopSolosRows(solosPayload);
    cachedOverviewTopSolos = await hydrateSongRowsWithSongKey(normalizedRows);
    renderOverviewTopSolos();
  } catch (err) {
    console.error("Failed loading overview top solos data", err);
    cachedOverviewTopSolos = [];
    renderOverviewTopSolos();
  }
}

async function loadOverviewTopRigSongsForUser(displayName) {
  try {
    if (!displayName) {
      cachedOverviewTopRigSongs = [];
      renderOverviewTopRigSongs();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedOverviewTopRigSongs = [];
        renderOverviewTopRigSongs();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const rigSongsRes = await fetchPlayerScopedResponse(currentPlayerId, "overview/top_songs_by_rig.json");
    if (!rigSongsRes) {
      cachedOverviewTopRigSongs = [];
      renderOverviewTopRigSongs();
      return;
    }

    const rigSongsPayload = await rigSongsRes.json();
    const rigSongRows = extractOverviewTopRigSongRows(rigSongsPayload);
    cachedOverviewTopRigSongs = await hydrateSongRowsWithSongKey(rigSongRows);
    renderOverviewTopRigSongs();
  } catch (err) {
    console.error("Failed loading overview top rig songs data", err);
    cachedOverviewTopRigSongs = [];
    renderOverviewTopRigSongs();
  }
}

async function loadOverviewTopDoublesForUser(displayName, { kind = "general" } = {}) {
  const normalizedKind = String(kind || "general");
  const isGeneral = normalizedKind === "general";
  const isTheirRigBlocked = normalizedKind === "their_rig_you_blocked";
  const setRows = rows => {
    if (isGeneral) {
      cachedOverviewTopDoublesGeneral = rows;
      renderOverviewTopDoubles();
      return;
    }
    if (isTheirRigBlocked) {
      cachedOverviewTopDoublesTheirRigBlocked = rows;
      renderOverviewTopDoubles();
      return;
    }
    cachedOverviewTopDoublesYourRigBlocked = rows;
    renderOverviewTopDoubles();
  };

  try {
    if (!displayName) {
      setRows([]);
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        setRows([]);
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const fileCandidates = isGeneral
      ? ["top_doubles_general.json"]
      : isTheirRigBlocked
      ? ["their_rig_you_blocked.json", "top_doubles_their_rig_you_blocked.json", "top_doubles_their_rig_blocked.json"]
      : ["your_rig_they_blocked.json", "top_doubles_your_rig_they_blocked.json", "top_doubles_your_rig_blocked.json"];

    let payload = null;
    for (const fileName of fileCandidates) {
      const res = await fetchPlayerScopedResponse(currentPlayerId, `overview/${fileName}`);
      if (!res) continue;
      payload = await res.json();
      break;
    }

    if (!payload) {
      setRows([]);
      return;
    }

    const rows = extractOverviewTopSolosRows(payload, { limit: null }).map((row, index) => ({
      ...row,
      rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : (index + 1),
      count: Number.isFinite(Number(row.soloCount)) ? Math.max(0, Number(row.soloCount)) : null
    }));
    setRows(await hydrateSongRowsWithSongKey(rows));
  } catch (err) {
    console.error("Failed loading overview top doubles data", err);
    setRows([]);
  }
}

async function loadMalImageCache() {
  if (cachedMalImageCache && typeof cachedMalImageCache === "object") {
    return cachedMalImageCache;
  }
  if (cachedMalImageCachePromise) {
    return cachedMalImageCachePromise;
  }

  cachedMalImageCachePromise = (async () => {
    try {
      const imageCacheRes = await fetch(dataUrl("mal_image_cache.json"));
      if (!imageCacheRes.ok) {
        cachedMalImageCache = {};
        return cachedMalImageCache;
      }
      const payload = await imageCacheRes.json();
      cachedMalImageCache = payload && typeof payload === "object" ? payload : {};
      return cachedMalImageCache;
    } catch (err) {
      console.error("Failed loading mal_image_cache.json", err);
      cachedMalImageCache = {};
      return cachedMalImageCache;
    } finally {
      cachedMalImageCachePromise = null;
    }
  })();

  return cachedMalImageCachePromise;
}

async function loadSongKeyById() {
  if (cachedSongKeyById && typeof cachedSongKeyById === "object") {
    return cachedSongKeyById;
  }
  if (cachedSongKeyByIdPromise) {
    return cachedSongKeyByIdPromise;
  }

  cachedSongKeyByIdPromise = (async () => {
    try {
      const songKeyRes = await fetch(dataUrl("song_key.json"));
      if (!songKeyRes.ok) {
        cachedSongKeyById = {};
        return cachedSongKeyById;
      }

      const payload = await songKeyRes.json();
      const rows = Array.isArray(payload) ? payload : [];
      const byId = {};

      rows.forEach(row => {
        if (!row || typeof row !== "object") return;
        const id = row.songid;
        if (id == null) return;
        byId[String(id)] = row;
      });

      cachedSongKeyById = byId;
      return cachedSongKeyById;
    } catch (err) {
      console.error("Failed loading song_key.json", err);
      cachedSongKeyById = {};
      return cachedSongKeyById;
    } finally {
      cachedSongKeyByIdPromise = null;
    }
  })();

  return cachedSongKeyByIdPromise;
}

function collectArtistAltNamesFromMembers(members) {
  const source = Array.isArray(members) ? members : [];
  if (!source.length) return [];

  const values = [];
  const seen = new Set();
  const pushIfText = raw => {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(text);
  };

  source.forEach(member => {
    if (typeof member === "string") {
      pushIfText(member);
      return;
    }
    if (!member || typeof member !== "object") return;

    pushIfText(member.primaryName);
    pushIfText(member.primaryNames);
    pushIfText(member.name);
    if (Array.isArray(member.primaryNames)) {
      member.primaryNames.forEach(pushIfText);
    }
    if (Array.isArray(member.allNames)) {
      member.allNames.forEach(pushIfText);
    }
  });

  return values;
}

function collectLooseStringValues(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(value => String(value == null ? "" : value).trim())
      .filter(Boolean);
  }

  const text = String(raw).trim();
  if (!text) return [];
  if (text[0] !== "[" || text[text.length - 1] !== "]") return [text];

  const quoted = [...text.matchAll(/['"]([^'"]+)['"]/g)]
    .map(match => String(match[1] || "").trim())
    .filter(Boolean);
  if (quoted.length) return quoted;

  return text
    .slice(1, -1)
    .split(",")
    .map(value => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function collectAnimeAltTitlesFromKey(keyRow) {
  const key = keyRow && typeof keyRow === "object" ? keyRow : null;
  if (!key) return [];

  const values = [];
  const seen = new Set();
  const pushIfText = raw => {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return;
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    values.push(text);
  };

  [
    key.animeEnglish,
    key.animeRomaji,
    key.animeName,
    key.animeTitle,
    key.animeNative,
    key.animeJapanese
  ].forEach(pushIfText);

  if (Array.isArray(key.animeAltTitles)) key.animeAltTitles.forEach(pushIfText);
  if (Array.isArray(key.animeAliases)) key.animeAliases.forEach(pushIfText);
  if (Array.isArray(key.animeSynonyms)) key.animeSynonyms.forEach(pushIfText);
  collectLooseStringValues(key.animeAltName).forEach(pushIfText);
  collectLooseStringValues(key.animeAltNames).forEach(pushIfText);

  return values;
}

function hydrateSongRowWithKey(rawRow, keyRow) {
  const row = rawRow && typeof rawRow === "object" ? { ...rawRow } : {};
  const key = keyRow && typeof keyRow === "object" ? keyRow : null;
  if (!key) {
    return row;
  }

  const animeEnglish = String(key.animeEnglish || "").trim();
  const animeRomaji = String(key.animeRomaji || "").trim();
  const anime = animeEnglish || animeRomaji;
  const songName = String(key.songName || "").trim();
  const artist = String(key.artist || "").trim();
  const type = String(key.type || "").trim();
  const audioLink = String(key.audioLink || "").trim();
  const malId = key.malId;
  const keyCorrectPct = Number(key.correctPct);
  const keyArtistMembers = Array.isArray(key.artistMembers) ? key.artistMembers : [];
  const keyArtistAltNames = collectArtistAltNamesFromMembers(keyArtistMembers);
  const keyAnimeAltTitles = collectAnimeAltTitlesFromKey(key);
  const normalizedSongId = row.songid != null ? row.songid : row.songId;
  if (normalizedSongId != null) {
    row.songid = normalizedSongId;
    row.songId = normalizedSongId;
  }

  if (!String(row.anime || "").trim()) row.anime = anime;
  if (!String(row.animeName || "").trim()) row.animeName = anime;
  if (!String(row.animeRomaji || "").trim()) row.animeRomaji = animeRomaji;
  const mergedAnimeAltTitles = [
    ...(Array.isArray(row.animeAltTitles) ? row.animeAltTitles : []),
    ...keyAnimeAltTitles
  ];
  const normalizedPrimaryAnime = new Set(
    [row.anime, row.animeName, row.animeRomaji]
      .map(value => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const seenAnimeAltTitles = new Set();
  const dedupedAnimeAltTitles = [];
  mergedAnimeAltTitles.forEach(title => {
    const text = String(title == null ? "" : title).trim();
    if (!text) return;
    const keyTitle = text.toLowerCase();
    if (normalizedPrimaryAnime.has(keyTitle)) return;
    if (seenAnimeAltTitles.has(keyTitle)) return;
    seenAnimeAltTitles.add(keyTitle);
    dedupedAnimeAltTitles.push(text);
  });
  if (dedupedAnimeAltTitles.length) {
    row.animeAltTitles = dedupedAnimeAltTitles;
  }

  const existingSongName = String(row.songName || "").trim();
  const existingTitle = String(row.title || "").trim();
  if (!existingSongName && songName) row.songName = songName;
  if (!existingTitle) row.title = row.songName || songName;

  if (!String(row.artist || "").trim() && artist) row.artist = artist;
  if (!String(row.type || "").trim() && type) row.type = type;
  if (!String(row.audioLink || "").trim() && audioLink) row.audioLink = audioLink;
  if ((row.malId == null || row.malId === "") && malId != null) row.malId = malId;
  if (Number.isFinite(keyCorrectPct)) row.correctPct = keyCorrectPct;
  if (!Array.isArray(row.artistMembers) || !row.artistMembers.length) {
    row.artistMembers = keyArtistMembers;
  }
  const mergedArtistAltNames = [
    ...(Array.isArray(row.artistAltNames) ? row.artistAltNames : []),
    ...keyArtistAltNames
  ];
  const normalizedPrimaryArtist = String(row.artist || "").trim().toLowerCase();
  const seenArtistAltNames = new Set();
  const dedupedArtistAltNames = [];
  mergedArtistAltNames.forEach(name => {
    const text = String(name == null ? "" : name).trim();
    if (!text) return;
    const keyName = text.toLowerCase();
    if (keyName === normalizedPrimaryArtist) return;
    if (seenArtistAltNames.has(keyName)) return;
    seenArtistAltNames.add(keyName);
    dedupedArtistAltNames.push(text);
  });
  if (dedupedArtistAltNames.length) {
    row.artistAltNames = dedupedArtistAltNames;
  }

  return row;
}

async function hydrateSongRowsWithSongKey(rows) {
  const inputRows = Array.isArray(rows) ? rows : [];
  if (!inputRows.length) return [];

  const keyById = await loadSongKeyById();
  let missingCount = 0;
  const hydrated = inputRows.map(rawRow => {
    const songid = rawRow && rawRow.songid != null
      ? String(rawRow.songid)
      : (rawRow && rawRow.songId != null ? String(rawRow.songId) : "");
    const keyRow = songid ? keyById[songid] : null;
    if (songid && !keyRow) missingCount += 1;
    return hydrateSongRowWithKey(rawRow, keyRow);
  });

  if (missingCount > 0) {
    console.warn(`song_key lookup miss for ${missingCount} row(s).`);
  }

  return hydrated;
}

function resolveRelearnRowsWithSearchSongs(relearnRows, searchRows) {
  const inputRows = Array.isArray(relearnRows) ? relearnRows : [];
  const sourceRows = Array.isArray(searchRows) ? searchRows : [];

  return inputRows.map((row, index) => {
    const refIndex = Number(row && row.searchSongIndex);
    const hasSearchSongRef = Number.isInteger(refIndex) && refIndex >= 0 && refIndex < sourceRows.length;
    const searchSongRow = hasSearchSongRef ? sourceRows[refIndex] : null;
    const mergedRow = searchSongRow && typeof searchSongRow === "object"
      ? { ...searchSongRow, ...(row && typeof row === "object" ? row : {}) }
      : (row && typeof row === "object" ? { ...row } : {});

    if (mergedRow.rank == null) mergedRow.rank = index + 1;
    return mergedRow;
  });
}

function resolveSearchSongDatePoolRows(rows, datePool) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const pool = Array.isArray(datePool) ? datePool : [];
  if (!inputRows.length || !pool.length) return inputRows;

  return inputRows.map(rawRow => {
    if (!rawRow || typeof rawRow !== "object") return rawRow;
    const dateIndexes = Array.isArray(rawRow.dates) ? rawRow.dates : [];
    if (!dateIndexes.length) return rawRow;

    const patternDates = dateIndexes.map(indexRaw => {
      const index = Number(indexRaw);
      if (!Number.isInteger(index) || index < 0 || index >= pool.length) return null;
      const dateValue = String(pool[index] == null ? "" : pool[index]).trim();
      return dateValue || null;
    });

    return { ...rawRow, patternDates };
  });
}

async function loadRelearnDataForUser(displayName, options = {}) {
  const shouldRender = () => {
    if (options && options.render === false) return false;
    return typeof options.shouldRender === "function" ? options.shouldRender() : true;
  };
  const renderLoadedRelearnTracker = () => {
    if (shouldRender()) renderInsightsRelearnTracker();
  };
  try {
    if (!displayName) {
      cachedRelearnSongs = [];
      relearnOnlistFilterMode = "all";
      relearnPageIndex = 0;
      renderLoadedRelearnTracker();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedRelearnSongs = [];
        relearnOnlistFilterMode = "all";
        relearnPageIndex = 0;
        renderLoadedRelearnTracker();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();
    const activeMode = getActiveDataSourceMode();
    let hydratedSearchRows = [];
    try {
      const searchSongsRes = await fetchPlayerScopedResponse(
        currentPlayerId,
        "search_songs/search_songs.json",
        activeMode
      );
      if (searchSongsRes) {
        const searchSongsPayload = await searchSongsRes.json();
        const searchRows = resolveSearchSongDatePoolRows(
          Array.isArray(searchSongsPayload.searchSongs) ? searchSongsPayload.searchSongs : [],
          searchSongsPayload.datePool
        );
        hydratedSearchRows = await hydrateSongRowsWithSongKey(searchRows);
      }
    } catch (searchErr) {
      console.warn("Failed loading search songs for relearn refs", searchErr);
      hydratedSearchRows = [];
    }

    const relearnRes = await fetchPlayerScopedResponse(currentPlayerId, "relearn_tracker/relearn_songs.json");
    if (!relearnRes) {
      cachedRelearnSongs = [];
      relearnOnlistFilterMode = "all";
      relearnPageIndex = 0;
      renderLoadedRelearnTracker();
      return;
    }

    const relearnPayload = await relearnRes.json();
    const relearnRows = Array.isArray(relearnPayload.relearnSongs) ? relearnPayload.relearnSongs : [];
    const resolvedRelearnRows = resolveRelearnRowsWithSearchSongs(relearnRows, hydratedSearchRows);
    cachedRelearnSongs = await hydrateSongRowsWithSongKey(resolvedRelearnRows);
    relearnOnlistFilterMode = "all";
    relearnPageIndex = 0;
    renderLoadedRelearnTracker();
  } catch (err) {
    console.error("Failed loading relearn tracker data", err);
    cachedRelearnSongs = [];
    relearnOnlistFilterMode = "all";
    relearnPageIndex = 0;
    renderLoadedRelearnTracker();
  }
}

async function loadWrongGuessDataForUser(displayName, options = {}) {
  const shouldRender = () => {
    if (options && options.render === false) return false;
    return typeof options.shouldRender === "function" ? options.shouldRender() : true;
  };
  const renderLoadedWrongGuess = () => {
    if (shouldRender()) renderInsightsWrongGuess();
  };
  try {
    if (!displayName) {
      cachedWrongGuessSongs = [];
      renderLoadedWrongGuess();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedWrongGuessSongs = [];
        renderLoadedWrongGuess();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const wrongGuessRes = await fetchPlayerScopedResponse(currentPlayerId, "recommendations_by_wrong_guess/top_200.json");
    if (!wrongGuessRes) {
      cachedWrongGuessSongs = [];
      renderLoadedWrongGuess();
      return;
    }

    const wrongGuessPayload = await wrongGuessRes.json();
    const wrongGuessRows = Array.isArray(wrongGuessPayload) ? wrongGuessPayload : [];
    cachedWrongGuessSongs = await hydrateSongRowsWithSongKey(wrongGuessRows);
    wrongGuessPageIndex = 0;
    renderLoadedWrongGuess();
  } catch (err) {
    console.error("Failed loading wrong guess recommendations", err);
    cachedWrongGuessSongs = [];
    renderLoadedWrongGuess();
  }
}

async function loadNeverCorrectDataForUser(displayName, options = {}) {
  const shouldRender = () => {
    if (options && options.render === false) return false;
    return typeof options.shouldRender === "function" ? options.shouldRender() : true;
  };
  const renderLoadedNeverCorrect = () => {
    if (shouldRender()) renderInsightsNeverCorrect();
  };
  try {
    if (!displayName) {
      cachedNeverCorrectSongs = [];
      renderLoadedNeverCorrect();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedNeverCorrectSongs = [];
        renderLoadedNeverCorrect();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const neverCorrectRes = await fetchPlayerScopedResponse(currentPlayerId, "recommendations_never_correct/top_30.json");
    if (!neverCorrectRes) {
      cachedNeverCorrectSongs = [];
      renderLoadedNeverCorrect();
      return;
    }

    const neverCorrectPayload = await neverCorrectRes.json();
    const neverCorrectRows = Array.isArray(neverCorrectPayload) ? neverCorrectPayload : [];
    cachedNeverCorrectSongs = await hydrateSongRowsWithSongKey(neverCorrectRows);
    neverCorrectPageIndex = 0;
    renderLoadedNeverCorrect();
  } catch (err) {
    console.error("Failed loading never-correct recommendations", err);
    cachedNeverCorrectSongs = [];
    renderLoadedNeverCorrect();
  }
}

async function loadPopularityDataForUser(displayName, options = {}) {
  const shouldRender = () => {
    if (options && options.render === false) return false;
    return typeof options.shouldRender === "function" ? options.shouldRender() : true;
  };
  const renderLoadedPopularity = () => {
    if (shouldRender()) renderInsightsPopularity();
  };
  try {
    if (!displayName) {
      cachedPopularitySongs = [];
      renderLoadedPopularity();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedPopularitySongs = [];
        renderLoadedPopularity();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const activeMode = getActiveDataSourceMode();
    const popularityPath = activeMode === "usual"
      ? "recommendations_by_popularity__usual.json"
      : "recommendations_by_popularity__watched.json";
    const popularityRes = await (async () => {
      const globalRes = await fetch(dataUrl(popularityPath));
      return globalRes.ok ? globalRes : null;
    })();
    if (!popularityRes) {
      cachedPopularitySongs = [];
      renderLoadedPopularity();
      return;
    }

    const popularityPayload = await popularityRes.json();
    const popularityRows = Array.isArray(popularityPayload) ? popularityPayload : [];
    cachedPopularitySongs = await hydrateSongRowsWithSongKey(popularityRows.slice(0, 300));
    popularityPageIndex = 0;
    renderLoadedPopularity();
  } catch (err) {
    console.error("Failed loading popularity recommendations", err);
    cachedPopularitySongs = [];
    renderLoadedPopularity();
  }
}

async function loadPCorrectDataForUser(displayName, options = {}) {
  const shouldRender = () => {
    if (options && options.render === false) return false;
    return typeof options.shouldRender === "function" ? options.shouldRender() : true;
  };
  const renderLoadedPCorrect = () => {
    if (shouldRender()) renderInsightsPCorrect();
  };
  try {
    if (!displayName) {
      cachedPCorrectSongs = [];
      renderLoadedPCorrect();
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedPCorrectSongs = [];
        renderLoadedPCorrect();
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();
    await loadSongKeyById();

    const activeMode = getActiveDataSourceMode();
    const pcorrectPath = activeMode === "usual"
      ? "pcorrect/pcorrect_usual.json"
      : "pcorrect/pcorrect_watched.json";
    const pcorrectRes = await (async () => {
      const globalRes = await fetch(dataUrl(pcorrectPath));
      return globalRes.ok ? globalRes : null;
    })();
    if (!pcorrectRes) {
      cachedPCorrectSongs = [];
      renderLoadedPCorrect();
      return;
    }

    const pcorrectPayload = await pcorrectRes.json();
    const pcorrectRows = Array.isArray(pcorrectPayload) ? pcorrectPayload : [];
    cachedPCorrectSongs = await hydrateSongRowsWithSongKey(pcorrectRows.slice(0, 300));
    pcorrectPageIndex = 0;
    renderLoadedPCorrect();
  } catch (err) {
    console.error("Failed loading pcorrect recommendations", err);
    cachedPCorrectSongs = [];
    renderLoadedPCorrect();
  }
}

async function loadSearchSongsDataForUser(displayName) {
  try {
    if (!displayName) {
      cachedSearchSongs = [];
      cachedOverviewCombinedSearchSongs = [];
      searchSongsPageIndex = 0;
      renderInsightsSearchSongs();
      if (fullUserData.length) {
        renderOverviewForActiveMode();
      }
      return;
    }

    if (!currentPlayerId || currentDisplayName !== displayName) {
      const playerEntry = await getPlayerEntryByName(displayName);
      if (!playerEntry || !playerEntry.playerId) {
        cachedSearchSongs = [];
        cachedOverviewCombinedSearchSongs = [];
        searchSongsPageIndex = 0;
        renderInsightsSearchSongs();
        if (fullUserData.length) {
          renderOverviewForActiveMode();
        }
        return;
      }
      currentPlayerId = String(playerEntry.playerId);
      currentDisplayName = displayName;
    }

    await loadMalImageCache();

    const activeMode = getActiveDataSourceMode();
    const modeScopedSearchSongsPath = `${activeMode}/search_songs/search_songs.json`;
    const searchSongsRes =
      await (async () => {
        const res = await fetch(dataUrl(modeScopedSearchSongsPath));
        return res.ok ? res : null;
      })()
      || await fetchPlayerScopedResponse(currentPlayerId, "search_songs/search_songs.json");
    if (!searchSongsRes) {
      cachedSearchSongs = [];
      cachedOverviewCombinedSearchSongs = [];
      searchSongsPageIndex = 0;
      renderInsightsSearchSongs();
      if (fullUserData.length) {
        renderOverviewForActiveMode();
      }
      return;
    }

    const searchSongsPayload = await searchSongsRes.json();
    const searchRows = resolveSearchSongDatePoolRows(
      Array.isArray(searchSongsPayload.searchSongs) ? searchSongsPayload.searchSongs : [],
      searchSongsPayload.datePool
    );
    cachedSearchSongs = await hydrateSongRowsWithSongKey(searchRows);

    const overviewCombinedRows = [];
    for (const mode of ["watched", "usual"]) {
      try {
        const modeResponse = await fetchPlayerScopedResponse(
          currentPlayerId,
          "search_songs/search_songs.json",
          mode
        );
        if (!modeResponse) continue;
        const modePayload = await modeResponse.json();
        const modeRows = resolveSearchSongDatePoolRows(
          Array.isArray(modePayload && modePayload.searchSongs) ? modePayload.searchSongs : [],
          modePayload && modePayload.datePool
        );
        if (modeRows.length) {
          overviewCombinedRows.push(...modeRows);
        }
      } catch (modeErr) {
        console.warn(`Failed loading ${mode} search songs for overview`, modeErr);
      }
    }
    cachedOverviewCombinedSearchSongs = overviewCombinedRows.length
      ? await hydrateSongRowsWithSongKey(overviewCombinedRows)
      : cachedSearchSongs;

    searchSongsPageIndex = 0;
    renderInsightsSearchSongs();
    renderInsightsWrongGuess();
    renderInsightsNeverCorrect();
    renderInsightsPopularity();
    renderInsightsPCorrect();
    if (fullUserData.length) {
      renderOverviewForActiveMode();
    }
  } catch (err) {
    console.error("Failed loading search songs data", err);
    cachedSearchSongs = [];
    cachedOverviewCombinedSearchSongs = [];
    searchSongsPageIndex = 0;
    renderInsightsSearchSongs();
    if (fullUserData.length) {
      renderOverviewForActiveMode();
    }
  }
}

async function ensureSearchSongFrequencyData() {
  const activeMode = getActiveDataSourceMode();
  if (searchSongFrequencyLoaded && searchSongFrequencyLoadedMode === activeMode) return;
  if (searchSongFrequencyLoadPromise) {
    await searchSongFrequencyLoadPromise;
    return;
  }

  searchSongFrequencyLoadPromise = (async () => {
    try {
      const frequencyPath = activeMode === "usual"
        ? "recommendations_by_popularity__usual.json"
        : "recommendations_by_popularity__watched.json";
      const response = await fetch(dataUrl(frequencyPath));
      if (!response.ok) {
        cachedSearchSongFrequencyRows = [];
        searchSongFrequencyPageIndex = 0;
        searchSongFrequencyLoadedMode = activeMode;
        return;
      }
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [];
      cachedSearchSongFrequencyRows = await hydrateSongRowsWithSongKey(rows);
      searchSongFrequencyPageIndex = 0;
      searchSongFrequencyLoadedMode = activeMode;
    } catch (err) {
      console.error("Failed loading song frequency data", err);
      cachedSearchSongFrequencyRows = [];
      searchSongFrequencyPageIndex = 0;
      searchSongFrequencyLoadedMode = activeMode;
    } finally {
      searchSongFrequencyLoaded = true;
      searchSongFrequencyLoadPromise = null;
      renderSearchSongFrequency();
    }
  })();

  await searchSongFrequencyLoadPromise;
}

function parseEstimatorInputValues(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];
  return text
    .split(/[,\s]+/)
    .map(token => Number(token))
    .filter(value => Number.isFinite(value));
}

function buildEstimatorFeatureRow(values, featureNames) {
  const names = Array.isArray(featureNames) ? featureNames : [];
  if (!names.length) return values.slice();
  const base = values.slice();
  while (base.length < 5) {
    if (!base.length) break;
    base.unshift(base[0]);
  }
  const selected = base.length > 5 ? base.slice(-5) : base.slice();
  if (selected.length < 5 && selected.length > 0) {
    while (selected.length < 5) selected.unshift(selected[0]);
  }

  const out = [];
  names.forEach((name, index) => {
    const key = String(name || "");
    if (key.startsWith("old_rank_") || key.startsWith("old_usefulness_")) {
      const m = key.match(/_(\d+)$/);
      if (m) {
        const oneBased = Number(m[1]);
        if (Number.isFinite(oneBased) && oneBased >= 1 && oneBased <= selected.length) {
          out.push(selected[oneBased - 1]);
          return;
        }
      }
      out.push(Number.isFinite(selected[index]) ? selected[index] : selected[selected.length - 1]);
      return;
    }

    const mean = selected.length ? (selected.reduce((acc, cur) => acc + cur, 0) / selected.length) : 0;
    const min = selected.length ? Math.min(...selected) : 0;
    const max = selected.length ? Math.max(...selected) : 0;
    const range = max - min;
    const slope = selected.length > 1 ? (selected[selected.length - 1] - selected[0]) / (selected.length - 1) : 0;
    const deltaRecent = selected.length > 1 ? selected[selected.length - 1] - selected[selected.length - 2] : 0;
    const variance = selected.length
      ? selected.reduce((acc, cur) => acc + ((cur - mean) ** 2), 0) / selected.length
      : 0;
    const std = Math.sqrt(Math.max(0, variance));

    if (key.includes("_mean")) out.push(mean);
    else if (key.includes("_std")) out.push(std);
    else if (key.includes("_slope")) out.push(slope);
    else if (key.includes("_min")) out.push(min);
    else if (key.includes("_max")) out.push(max);
    else if (key.includes("_range")) out.push(range);
    else if (key.includes("delta_recent")) out.push(deltaRecent);
    else out.push(Number.isFinite(selected[index]) ? selected[index] : selected[selected.length - 1]);
  });
  return out;
}

function predictFromEstimator(estimator, values) {
  if (!estimator || typeof estimator !== "object") return null;
  const variant = String(estimator.model_variant || "ols").toLowerCase();
  const featureNames = Array.isArray(estimator.feature_names) ? estimator.feature_names : [];
  const features = buildEstimatorFeatureRow(values, featureNames);
  if (!features.length) return null;

  if (variant === "knn" && Array.isArray(estimator.train_x) && Array.isArray(estimator.train_y)) {
    const means = Array.isArray(estimator.feature_means) ? estimator.feature_means : [];
    const stds = Array.isArray(estimator.feature_stds) ? estimator.feature_stds : [];
    const x = features.map((value, idx) => {
      const mean = Number.isFinite(Number(means[idx])) ? Number(means[idx]) : 0;
      const std = Number.isFinite(Number(stds[idx])) && Number(stds[idx]) !== 0 ? Number(stds[idx]) : 1;
      return (value - mean) / std;
    });
    const kRaw = Number(estimator.k);
    const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.floor(kRaw) : 3;
    const distances = [];
    for (let i = 0; i < estimator.train_x.length; i += 1) {
      const tx = Array.isArray(estimator.train_x[i]) ? estimator.train_x[i] : [];
      const ty = Number(estimator.train_y[i]);
      if (!Number.isFinite(ty) || tx.length !== x.length) continue;
      let distSq = 0;
      for (let j = 0; j < x.length; j += 1) {
        const d = x[j] - Number(tx[j] || 0);
        distSq += d * d;
      }
      distances.push({ distSq, y: ty });
    }
    if (!distances.length) return null;
    distances.sort((a, b) => a.distSq - b.distSq);
    const used = distances.slice(0, Math.max(1, Math.min(k, distances.length)));
    return used.reduce((acc, row) => acc + row.y, 0) / used.length;
  }

  const intercept = Number(estimator.intercept);
  const coefficients = Array.isArray(estimator.coefficients) ? estimator.coefficients.map(Number) : [];
  if (!Number.isFinite(intercept) || !coefficients.length) return null;
  const score = intercept + coefficients.reduce((acc, coeff, idx) => {
    const x = Number(features[idx]);
    if (!Number.isFinite(coeff) || !Number.isFinite(x)) return acc;
    return acc + (coeff * x);
  }, 0);
  return Number.isFinite(score) ? score : null;
}

function convertLegacyUsefulnessValue(value, shouldConvert = true) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  if (!shouldConvert) return numericValue;
  if (numericValue >= 30) return numericValue;
  if (!convertUsefulnessEstimator) return numericValue;
  const predicted = predictFromEstimator(convertUsefulnessEstimator, [numericValue]);
  return Number.isFinite(predicted) ? predicted : numericValue;
}

function renderEstimatorAccuracyLine(elementId, estimator) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const r2 = Number(estimator && estimator.r2);
  const accuracyText = Number.isFinite(r2)
    ? `${Math.max(0, Math.min(100, r2 * 100)).toFixed(1)}%`
    : "—";
  el.innerText = `Accuracy: ${accuracyText}`;
}

async function ensureConvertEstimatorsLoaded() {
  if (convertRankEstimator && convertUsefulnessEstimator) return;
  if (convertEstimatorsLoadPromise) {
    await convertEstimatorsLoadPromise;
    return;
  }
  convertEstimatorsLoadPromise = (async () => {
    const [rankRes, usefulnessRes] = await Promise.allSettled([
      loadJSON("rank_estimator/rank_estimator.json"),
      loadJSON("usefulness_estimator/usefulness_estimator.json")
    ]);
    convertRankEstimator = rankRes.status === "fulfilled" ? rankRes.value : null;
    convertUsefulnessEstimator = usefulnessRes.status === "fulfilled" ? usefulnessRes.value : null;
    const meta = document.getElementById("convertEstimatorMeta");
    if (meta) {
      if (convertRankEstimator && convertUsefulnessEstimator) {
        meta.innerText = "Estimators loaded";
      } else if (convertRankEstimator || convertUsefulnessEstimator) {
        meta.innerText = "Partially loaded (one estimator missing)";
      } else {
        meta.innerText = "Failed to load estimator files";
      }
    }
    renderEstimatorAccuracyLine("convertRankAccuracy", convertRankEstimator);
    renderEstimatorAccuracyLine("convertUsefulnessAccuracy", convertUsefulnessEstimator);
  })();
  try {
    await convertEstimatorsLoadPromise;
  } finally {
    convertEstimatorsLoadPromise = null;
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      const next = line[i + 1];
      if (inQuotes && next === "\"") {
        cur += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSimpleCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(h => String(h || "").trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = String(cols[idx] || "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function normalizeTransitionExamples(payload, oldKey, newKey) {
  if (!payload || typeof payload !== "object") return [];
  const out = [];
  Object.entries(payload).forEach(([name, value]) => {
    if (!value || typeof value !== "object") return;
    const oldValue = Number(value[oldKey]);
    const newValue = Number(value[newKey]);
    if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) return;
    out.push({ name, oldValue, newValue, source: "transition" });
  });
  return out;
}

function normalizeTrainingExamples(rows, prefix, targetKey, namePrefix) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, idx) => {
    const oldCandidates = [
      Number(row[`${prefix}_mean`]),
      Number(row[`${prefix}_5`]),
      Number(row[`${prefix}_4`]),
      Number(row[`${prefix}_3`]),
      Number(row[`${prefix}_2`]),
      Number(row[`${prefix}_1`])
    ].filter(value => Number.isFinite(value));
    const oldValue = oldCandidates.length ? oldCandidates[0] : NaN;
    const newValue = Number(row[targetKey]);
    if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) return null;
    return {
      name: `${namePrefix} #${idx + 1}`,
      oldValue,
      newValue,
      source: "training"
    };
  }).filter(Boolean);
}

async function ensureConvertExamplesLoaded() {
  if (convertRankClosestRows.length && convertUsefulnessClosestRows.length) return;
  if (convertExamplesLoadPromise) {
    await convertExamplesLoadPromise;
    return;
  }

  convertExamplesLoadPromise = (async () => {
    const rankTransition = await loadJSON("rank_estimator/rank_transition_output.json").catch(() => null);
    const usefulnessTransition = await loadJSON("usefulness_estimator/usefulness_transition_output.json").catch(() => null);

    convertRankClosestRows = normalizeTransitionExamples(rankTransition, "final_old_rank", "final_new_rank");
    convertUsefulnessClosestRows = normalizeTransitionExamples(usefulnessTransition, "final_old_usefulness", "final_new_usefulness");

    if (!convertRankClosestRows.length) {
      const rankCsvRes = await fetch(dataUrl("rank_estimator/rank_training_data.csv")).catch(() => null);
      if (rankCsvRes && rankCsvRes.ok) {
        const rankText = await rankCsvRes.text();
        const rankRows = parseSimpleCsv(rankText);
        convertRankClosestRows = normalizeTrainingExamples(rankRows, "old_rank", "target_new_rank", "rank row");
      }
    }
    if (!convertUsefulnessClosestRows.length) {
      const usefulCsvRes = await fetch(dataUrl("usefulness_estimator/usefulness_training_data.csv")).catch(() => null);
      if (usefulCsvRes && usefulCsvRes.ok) {
        const usefulText = await usefulCsvRes.text();
        const usefulRows = parseSimpleCsv(usefulText);
        convertUsefulnessClosestRows = normalizeTrainingExamples(usefulRows, "old_usefulness", "target_new_usefulness", "usefulness row");
      }
    }
  })();

  try {
    await convertExamplesLoadPromise;
  } finally {
    convertExamplesLoadPromise = null;
  }
}

function findClosestExamples(rows, targetOldValue, limit = 3) {
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(targetOldValue)) return [];
  return rows
    .map(row => ({ ...row, diff: Math.abs(row.oldValue - targetOldValue) }))
    .sort((a, b) => {
      if (a.diff !== b.diff) return a.diff - b.diff;
      return a.oldValue - b.oldValue;
    })
    .slice(0, limit);
}

function renderClosestExamples(containerEl, examples, labelText) {
  if (!containerEl) return;
  const renderPlaceholders = () => {
    containerEl.innerHTML = [
      "<div class=\"convert-estimator-closest-item\"><strong>Closest examples:</strong></div>",
      "<div class=\"convert-estimator-closest-item\">1. —</div>",
      "<div class=\"convert-estimator-closest-item\">2. —</div>",
      "<div class=\"convert-estimator-closest-item\">3. —</div>"
    ].join("");
  };
  if (!examples.length) {
    renderPlaceholders();
    return;
  }
  const lines = examples.map((ex, idx) => {
    return `<div class="convert-estimator-closest-item">${idx + 1}. ${ex.name}: ${ex.oldValue.toFixed(3)} -> ${ex.newValue.toFixed(3)} (${labelText} ${ex.diff.toFixed(3)})</div>`;
  });
  while (lines.length < 3) {
    lines.push(`<div class="convert-estimator-closest-item">${lines.length + 1}. —</div>`);
  }
  containerEl.innerHTML = `<div class="convert-estimator-closest-item"><strong>Closest examples:</strong></div>${lines.join("")}`;
}

function bindConvertEstimatorControlsOnce() {
  if (convertEstimatorUIBound) return;
  const rankInput = document.getElementById("convertOldRankInput");
  const rankBtn = document.getElementById("convertRankBtn");
  const rankResult = document.getElementById("convertRankResult");
  const rankClosest = document.getElementById("convertRankClosest");
  const usefulInput = document.getElementById("convertOldUsefulnessInput");
  const usefulBtn = document.getElementById("convertUsefulnessBtn");
  const usefulResult = document.getElementById("convertUsefulnessResult");
  const usefulClosest = document.getElementById("convertUsefulnessClosest");
  if (!rankInput || !rankBtn || !rankResult || !rankClosest || !usefulInput || !usefulBtn || !usefulResult || !usefulClosest) return;

  const handleRankConvert = async () => {
    await ensureConvertEstimatorsLoaded();
    await ensureConvertExamplesLoaded();
    const values = parseEstimatorInputValues(rankInput.value);
    if (!values.length) {
      rankResult.innerText = "New rank: invalid input";
      renderClosestExamples(rankClosest, [], "old diff");
      return;
    }
    if (!convertRankEstimator) {
      rankResult.innerText = "New rank: rank estimator unavailable";
      renderClosestExamples(rankClosest, [], "old diff");
      return;
    }
    const predicted = predictFromEstimator(convertRankEstimator, values);
    rankResult.innerText = Number.isFinite(predicted)
      ? `New rank: ${predicted.toFixed(3)}`
      : "New rank: prediction failed";
    const targetOld = values.reduce((acc, cur) => acc + cur, 0) / values.length;
    const examples = findClosestExamples(convertRankClosestRows, targetOld, 3);
    renderClosestExamples(rankClosest, examples, "old diff");
  };

  const handleUsefulnessConvert = async () => {
    await ensureConvertEstimatorsLoaded();
    await ensureConvertExamplesLoaded();
    const values = parseEstimatorInputValues(usefulInput.value);
    if (!values.length) {
      usefulResult.innerText = "New usefulness: invalid input";
      renderClosestExamples(usefulClosest, [], "old diff");
      return;
    }
    if (!convertUsefulnessEstimator) {
      usefulResult.innerText = "New usefulness: usefulness estimator unavailable";
      renderClosestExamples(usefulClosest, [], "old diff");
      return;
    }
    const predicted = predictFromEstimator(convertUsefulnessEstimator, values);
    usefulResult.innerText = Number.isFinite(predicted)
      ? `New usefulness: ${predicted.toFixed(3)}`
      : "New usefulness: prediction failed";
    const targetOld = values.reduce((acc, cur) => acc + cur, 0) / values.length;
    const examples = findClosestExamples(convertUsefulnessClosestRows, targetOld, 3);
    renderClosestExamples(usefulClosest, examples, "old diff");
  };

  rankBtn.addEventListener("click", handleRankConvert);
  usefulBtn.addEventListener("click", handleUsefulnessConvert);
  rankInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleRankConvert();
    }
  });
  usefulInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleUsefulnessConvert();
    }
  });
  convertEstimatorUIBound = true;
}

function getRigAnalysisModeValue() {
  const rawValue = String(dataRangeSelect && dataRangeSelect.value ? dataRangeSelect.value : "all");
  const allowedValues = new Set(rigAnalysisAllowedModes);
  return allowedValues.has(rawValue) ? rawValue : "all";
}

function getRigAnalysisPlayerEntry(payload) {
  if (!payload || typeof payload !== "object") return null;
  const players = payload.players;
  if (!players || typeof players !== "object") return null;

  if (currentPlayerId != null) {
    const directEntry = players[String(currentPlayerId)];
    if (directEntry && typeof directEntry === "object") return directEntry;
  }

  const normalizedDisplayName = normalizeText(currentDisplayName || username || "");
  if (!normalizedDisplayName) return null;
  const entries = Object.values(players);
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (normalizeText(entry.displayName || "") === normalizedDisplayName) {
      return entry;
    }
  }

  return null;
}

function getRigAnalysisNumericValues(payload, fieldName) {
  if (!payload || typeof payload !== "object") return [];
  const players = payload.players;
  if (!players || typeof players !== "object") return [];
  return Object.values(players)
    .map(entry => {
      const rawValue = entry && Object.prototype.hasOwnProperty.call(entry, fieldName)
        ? entry[fieldName]
        : undefined;
      if (rawValue == null) return NaN;
      return Number(rawValue);
    })
    .filter(value => Number.isFinite(value));
}

function computePercentileFromValues(targetValue, values) {
  if (!Number.isFinite(targetValue) || !Array.isArray(values) || !values.length) return null;
  let lessCount = 0;
  let equalCount = 0;
  values.forEach(value => {
    if (value < targetValue) lessCount += 1;
    else if (value === targetValue) equalCount += 1;
  });
  return ((lessCount + equalCount * 0.5) / values.length) * 100.0;
}

function computeRankFromValues(targetValue, values, order = "desc") {
  if (!Number.isFinite(targetValue) || !Array.isArray(values) || !values.length) return null;
  if (order === "asc") {
    const betterCount = values.filter(value => value < targetValue).length;
    return betterCount + 1;
  }
  const betterCount = values.filter(value => value > targetValue).length;
  return betterCount + 1;
}

async function ensureRigAnalysisDataForMode(modeValue, options = {}) {
  const shouldRerender = options && options.rerenderIfActive !== false;
  if (rigAnalysisCacheByMode.has(modeValue)) return;
  if (rigAnalysisLoadPromisesByMode.has(modeValue)) {
    await rigAnalysisLoadPromisesByMode.get(modeValue);
    return;
  }

  const loadPromise = (async () => {
    try {
      const [vintageRes, difficultyRes] = await Promise.all([
        fetch(dataUrl(`rig_analysis/list_vintage__${modeValue}.json`)),
        fetch(dataUrl(`rig_analysis/list_difficulty__${modeValue}.json`))
      ]);

      const vintagePayload = vintageRes.ok ? await vintageRes.json() : null;
      const difficultyPayload = difficultyRes.ok ? await difficultyRes.json() : null;

      rigAnalysisCacheByMode.set(modeValue, {
        vintagePayload: vintagePayload && typeof vintagePayload === "object" ? vintagePayload : null,
        difficultyPayload: difficultyPayload && typeof difficultyPayload === "object" ? difficultyPayload : null
      });
    } catch (err) {
      console.error("Failed loading rig analysis data", err);
      rigAnalysisCacheByMode.set(modeValue, {
        vintagePayload: null,
        difficultyPayload: null
      });
    } finally {
      rigAnalysisLoadPromisesByMode.delete(modeValue);
      if (
        shouldRerender
        && activeSection === "social"
        && activeSubSectionBySection.social === "Rig / List analysis"
        && getRigAnalysisModeValue() === modeValue
      ) {
        renderRigAnalysisView();
      }
    }
  })();

  rigAnalysisLoadPromisesByMode.set(modeValue, loadPromise);
  await loadPromise;
}

async function ensureRigAnalysisData() {
  const modeValue = getRigAnalysisModeValue();
  await ensureRigAnalysisDataForMode(modeValue, { rerenderIfActive: true });
}

function prefetchRigAnalysisDataInBackground() {
  if (rigAnalysisPrefetchStarted) return;
  rigAnalysisPrefetchStarted = true;

  const currentMode = getRigAnalysisModeValue();
  const modesToPrefetch = rigAnalysisAllowedModes.filter(mode => mode !== currentMode);
  if (!modesToPrefetch.length) return;

  modesToPrefetch.forEach(mode => {
    ensureRigAnalysisDataForMode(mode, { rerenderIfActive: false }).catch(err => {
      console.error(`Failed prefetching rig analysis data for mode: ${mode}`, err);
    });
  });
}

function renderRigAnalysisView() {
  const yearValueEl = document.getElementById("rigAnalysisYearValue");
  const yearRangeEl = document.getElementById("rigAnalysisYearRange");
  const yearPercentilesEl = document.getElementById("rigAnalysisYearPercentiles");
  const yearLegendEl = document.getElementById("rigAnalysisYearLegend");
  const yearSubEl = document.getElementById("rigAnalysisYearSub");
  const yearTrackEl = document.getElementById("rigAnalysisYearTrack");
  const yearMeanMarkerEl = document.getElementById("rigAnalysisYearMeanMarker");
  const yearMedianMarkerEl = document.getElementById("rigAnalysisYearMedianMarker");
  const yearMeanTagEl = document.getElementById("rigAnalysisYearMeanTag");
  const yearMedianTagEl = document.getElementById("rigAnalysisYearMedianTag");
  const difficultyValueEl = document.getElementById("rigAnalysisDifficultyValue");
  const difficultyRangeEl = document.getElementById("rigAnalysisDifficultyRange");
  const difficultyPercentilesEl = document.getElementById("rigAnalysisDifficultyPercentiles");
  const difficultyLegendEl = document.getElementById("rigAnalysisDifficultyLegend");
  const difficultyTrackEl = document.getElementById("rigAnalysisDifficultyTrack");
  const difficultyMarkerEl = document.getElementById("rigAnalysisDifficultyMarker");
  const difficultyTagEl = document.getElementById("rigAnalysisDifficultyTag");
  const difficultySubEl = document.getElementById("rigAnalysisDifficultySub");
  const avgRigValueEl = document.getElementById("rigAnalysisAvgRigValue");
  const avgRigSubEl = document.getElementById("rigAnalysisAvgRigSub");
  const avgRigPctValueEl = document.getElementById("rigAnalysisAvgRigPctValue");
  const avgRigPctSubEl = document.getElementById("rigAnalysisAvgRigPctSub");
  const emptyEl = document.getElementById("rigAnalysisEmpty");
  if (
    !yearValueEl || !yearRangeEl || !yearPercentilesEl || !yearLegendEl || !yearSubEl || !yearTrackEl
    || !yearMeanMarkerEl || !yearMedianMarkerEl
    || !yearMeanTagEl || !yearMedianTagEl
    || !difficultyValueEl || !difficultyRangeEl || !difficultyPercentilesEl || !difficultyLegendEl
    || !difficultyTrackEl || !difficultyMarkerEl || !difficultyTagEl || !difficultySubEl
    || !avgRigValueEl || !avgRigSubEl
    || !avgRigPctValueEl || !avgRigPctSubEl
    || !emptyEl
  ) return;

  const modeValue = getRigAnalysisModeValue();
  const modeData = rigAnalysisCacheByMode.get(modeValue);
  const selectedModeLabel = getSelectedDataModeLabel();
  if (!modeData) {
    yearValueEl.innerText = "—";
    yearRangeEl.innerText = "Loading...";
    yearPercentilesEl.innerHTML = "";
    yearLegendEl.innerHTML = "";
    yearSubEl.innerText = "Loading...";
    yearMeanTagEl.innerText = "Mean year: — (—)";
    yearMedianTagEl.innerText = "Median year: — (—)";
    yearMeanMarkerEl.style.display = "none";
    yearMedianMarkerEl.style.display = "none";
    difficultyValueEl.innerText = "—";
    difficultyRangeEl.innerText = "Loading...";
    difficultyPercentilesEl.innerHTML = "";
    difficultyLegendEl.innerHTML = "";
    difficultyTrackEl.style.setProperty("background", "#e2e8f0", "important");
    difficultyMarkerEl.style.display = "none";
    difficultyTagEl.innerText = "Mean Difficulty: —%";
    difficultySubEl.innerText = "Loading...";
    avgRigValueEl.innerText = "—";
    avgRigSubEl.innerText = "";
    avgRigPctValueEl.innerText = "—";
    avgRigPctSubEl.innerText = "";
    emptyEl.style.display = "block";
    emptyEl.innerText = "Loading rig analysis...";
    return;
  }

  const vintageEntry = getRigAnalysisPlayerEntry(modeData.vintagePayload);
  const difficultyEntry = getRigAnalysisPlayerEntry(modeData.difficultyPayload);
  const songCountVintage = Number(vintageEntry && vintageEntry.songCount);
  const songCountDifficulty = Number(difficultyEntry && difficultyEntry.songCount);
  const hasAnyData = (
    (vintageEntry && typeof vintageEntry === "object")
    || (difficultyEntry && typeof difficultyEntry === "object")
  );

  if (!hasAnyData) {
    yearValueEl.innerText = "—";
    yearRangeEl.innerText = "No data";
    yearPercentilesEl.innerHTML = "";
    yearLegendEl.innerHTML = "";
    yearSubEl.innerText = "No data";
    yearMeanTagEl.innerText = "Mean year: — (—)";
    yearMedianTagEl.innerText = "Median year: — (—)";
    yearMeanMarkerEl.style.display = "none";
    yearMedianMarkerEl.style.display = "none";
    difficultyValueEl.innerText = "—";
    difficultyRangeEl.innerText = "No range";
    difficultyPercentilesEl.innerHTML = "";
    difficultyLegendEl.innerHTML = "";
    difficultyTrackEl.style.setProperty("background", "#e2e8f0", "important");
    difficultyMarkerEl.style.display = "none";
    difficultyTagEl.innerText = "Mean Difficulty: —%";
    difficultySubEl.innerText = "No data";
    avgRigValueEl.innerText = "—";
    avgRigSubEl.innerText = "";
    avgRigPctValueEl.innerText = "—";
    avgRigPctSubEl.innerText = "";
    emptyEl.style.display = "block";
    emptyEl.innerText = "No rig analysis data for this player in the selected mode.";
    return;
  }

  emptyEl.style.display = "none";

  const isValidYearValue = value => Number.isFinite(value) && value >= 1900 && value <= 2100;
  const averageSeasonText = String(vintageEntry && vintageEntry.averageSeason ? vintageEntry.averageSeason : "—");
  const averageYearRaw = Number(vintageEntry && vintageEntry.averageYear);
  const averageYearValue = isValidYearValue(averageYearRaw) ? averageYearRaw : null;
  const averageYearText = Number.isFinite(averageYearValue) ? averageYearValue.toFixed(3) : "—";
  const medianSeasonText = String(vintageEntry && vintageEntry.medianSeason ? vintageEntry.medianSeason : "—");
  const medianYearRaw = Number(vintageEntry && vintageEntry.medianYear);
  const medianYearValue = isValidYearValue(medianYearRaw) ? medianYearRaw : null;
  const medianYearText = Number.isFinite(medianYearValue) ? medianYearValue.toFixed(3) : "—";
  const difficultyRawValue = difficultyEntry && Object.prototype.hasOwnProperty.call(difficultyEntry, "averageCorrectPercentage")
    ? difficultyEntry.averageCorrectPercentage
    : undefined;
  const difficultyValue = difficultyRawValue == null ? NaN : Number(difficultyRawValue);
  const difficultyText = Number.isFinite(difficultyValue) ? `${difficultyValue.toFixed(1)}%` : "—";

  const difficultyRawValues = getRigAnalysisNumericValues(modeData.difficultyPayload, "averageCorrectPercentage");
  const difficultyValues = [...difficultyRawValues];
  if (Number.isFinite(difficultyValue) && !difficultyValues.includes(difficultyValue)) {
    difficultyValues.push(difficultyValue);
  }
  const difficultyPercentile = computePercentileFromValues(difficultyValue, difficultyValues);
  const difficultyRank = computeRankFromValues(difficultyValue, difficultyValues, "asc");
  let difficultyLabel = "normal";
  if (Number.isFinite(difficultyPercentile)) {
    if (difficultyPercentile <= 20) difficultyLabel = "impossible";
    else if (difficultyPercentile <= 40) difficultyLabel = "relatively impossible";
    else if (difficultyPercentile < 60) difficultyLabel = "normal";
    else if (difficultyPercentile < 80) difficultyLabel = "relatively free";
    else difficultyLabel = "free";
  }

  const medianSeasonIndexValue = Number(vintageEntry && vintageEntry.medianSeasonIndex);
  const medianSeasonValues = getRigAnalysisNumericValues(modeData.vintagePayload, "medianSeasonIndex");
  const medianSeasonPercentile = computePercentileFromValues(medianSeasonIndexValue, medianSeasonValues);
  const seasonRank = computeRankFromValues(medianSeasonIndexValue, medianSeasonValues, "asc");
  const medianYearValues = getRigAnalysisNumericValues(modeData.vintagePayload, "medianYear").filter(isValidYearValue);
  const averageYearValues = getRigAnalysisNumericValues(modeData.vintagePayload, "averageYear").filter(isValidYearValue);
  const yearRangeSource = [...medianYearValues, ...averageYearValues];
  if (!yearRangeSource.length) {
    yearRangeSource.push(...[averageYearValue, medianYearValue].filter(value => Number.isFinite(value)));
  }
  let minYearValue = yearRangeSource.length ? Math.min(...yearRangeSource) : null;
  let maxYearValue = yearRangeSource.length ? Math.max(...yearRangeSource) : null;
  if (Number.isFinite(minYearValue) && Number.isFinite(maxYearValue) && minYearValue === maxYearValue) {
    minYearValue -= 1;
    maxYearValue += 1;
  }
  let eraLabel = "relatively boomer";
  if (Number.isFinite(medianSeasonPercentile)) {
    if (medianSeasonPercentile <= 25) eraLabel = "boomer";
    else if (medianSeasonPercentile <= 50) eraLabel = "relatively boomer";
    else if (medianSeasonPercentile < 75) eraLabel = "relatively zoomer";
    else eraLabel = "zoomer";
  }

  const preferredYearValue = Number.isFinite(medianYearValue) ? medianYearValue : averageYearValue;
  yearValueEl.innerText = Number.isFinite(preferredYearValue) ? preferredYearValue.toFixed(1) : "—";
  yearRangeEl.innerText = (
    Number.isFinite(minYearValue) && Number.isFinite(maxYearValue)
      ? `${minYearValue.toFixed(1)} - ${maxYearValue.toFixed(1)}`
      : "No year range"
  );
  const yearSpan = (Number.isFinite(minYearValue) && Number.isFinite(maxYearValue))
    ? Math.max(0.0001, maxYearValue - minYearValue)
    : null;
  const meanPct = (Number.isFinite(yearSpan) && Number.isFinite(averageYearValue))
    ? clamp01((averageYearValue - minYearValue) / yearSpan) * 100
    : null;
  const medianPct = (Number.isFinite(yearSpan) && Number.isFinite(medianYearValue))
    ? clamp01((medianYearValue - minYearValue) / yearSpan) * 100
    : null;
  const percentileBandColors = ["#e2e8f0", "#bae6fd", "#86efac", "#facc15", "#fb923c"];
  const computeQuantile = (sortedValues, q) => {
    if (!sortedValues.length) return null;
    if (sortedValues.length === 1) return sortedValues[0];
    const index = (sortedValues.length - 1) * q;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    const weight = index - lower;
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
  };
  const sortedYearValues = [...yearRangeSource].sort((a, b) => a - b);
  const quantileYears = [0, 0.2, 0.4, 0.6, 0.8, 1].map(q => computeQuantile(sortedYearValues, q));
  const quantilePcts = quantileYears.map(year => {
    if (!Number.isFinite(year) || !Number.isFinite(yearSpan)) return null;
    return clamp01((year - minYearValue) / yearSpan) * 100;
  });
  const hasQuantileBands = quantilePcts.every(value => Number.isFinite(value));
  const percentileLegendRanges = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];
  yearLegendEl.innerHTML = percentileBandColors.map((color, index) => (
    `<span class="rig-analysis-year-legend-item"><span class="rig-analysis-year-legend-swatch" style="background:${color};"></span>${percentileLegendRanges[index]}</span>`
  )).join("");
  if (hasQuantileBands) {
    const gradientStops = [];
    for (let index = 0; index < percentileBandColors.length; index += 1) {
      const startPct = quantilePcts[index];
      const endPct = quantilePcts[index + 1];
      gradientStops.push(`${percentileBandColors[index]} ${startPct.toFixed(2)}%`);
      gradientStops.push(`${percentileBandColors[index]} ${endPct.toFixed(2)}%`);
    }
    yearTrackEl.style.setProperty("background", `linear-gradient(90deg, ${gradientStops.join(", ")})`, "important");
    const startQuantiles = [0, 1, 2, 3, 4, 5].map(index => ({
      year: quantileYears[index],
      pct: quantilePcts[index]
    })).filter(entry => Number.isFinite(entry.year) && Number.isFinite(entry.pct));
    yearPercentilesEl.innerHTML = startQuantiles.map((entry, index) => {
      const label = String(Math.round(entry.year));
      if (index === 0) {
        return `<span class="rig-analysis-year-percentile-label start">${label}</span>`;
      }
      if (index === startQuantiles.length - 1) {
        return `<span class="rig-analysis-year-percentile-label end">${label}</span>`;
      }
      return `<span class="rig-analysis-year-percentile-label" style="left:${entry.pct.toFixed(2)}%;">${label}</span>`;
    }).join("");
  } else {
    yearTrackEl.style.setProperty("background", "#e2e8f0", "important");
    yearPercentilesEl.innerHTML = "";
  }
  const getPercentileBandColorByPct = rawPct => {
    if (!Number.isFinite(rawPct)) return percentileBandColors[0];
    if (hasQuantileBands) {
      for (let index = 0; index < percentileBandColors.length; index += 1) {
        const upperBound = quantilePcts[index + 1];
        if (!Number.isFinite(upperBound) || rawPct <= upperBound + 0.0001) {
          return percentileBandColors[index];
        }
      }
      return percentileBandColors[percentileBandColors.length - 1];
    }
    const normalized = clamp01(rawPct / 100);
    const bandIndex = Math.min(
      percentileBandColors.length - 1,
      Math.floor(normalized * percentileBandColors.length)
    );
    return percentileBandColors[bandIndex];
  };
  const formatMarkerLeftPct = rawPct => {
    if (!Number.isFinite(rawPct)) return null;
    const normalized = clamp01(rawPct / 100) * 100;
    if (normalized <= 0.01) return 0;
    if (normalized >= 99.99) return 100;
    return Math.min(97, Math.max(3, normalized));
  };
  const meanLeftPct = formatMarkerLeftPct(meanPct);
  const medianLeftPct = formatMarkerLeftPct(medianPct);
  const meanMarkerColor = getPercentileBandColorByPct(meanPct);
  const medianMarkerColor = getPercentileBandColorByPct(medianPct);
  yearMeanMarkerEl.style.setProperty("--rig-year-mean-color", meanMarkerColor, "important");
  yearMedianMarkerEl.style.setProperty("--rig-year-median-color", medianMarkerColor, "important");

  if (Number.isFinite(meanLeftPct) && Number.isFinite(averageYearValue)) {
    yearMeanMarkerEl.style.display = "flex";
    yearMeanMarkerEl.style.left = `${meanLeftPct.toFixed(2)}%`;
    yearMeanTagEl.innerText = `Mean year: ${averageYearValue.toFixed(2)} (${averageSeasonText})`;
  } else {
    yearMeanMarkerEl.style.display = "none";
    yearMeanTagEl.innerText = "Mean year: — (—)";
  }
  if (Number.isFinite(medianLeftPct) && Number.isFinite(medianYearValue)) {
    yearMedianMarkerEl.style.display = "flex";
    yearMedianMarkerEl.style.left = `${medianLeftPct.toFixed(2)}%`;
    yearMedianTagEl.innerText = `Median year: ${medianYearValue.toFixed(2)} (${medianSeasonText})`;
  } else {
    yearMedianMarkerEl.style.display = "none";
    yearMedianTagEl.innerText = "Median year: — (—)";
  }
  yearSubEl.innerHTML = [
    `Era rank (older→newer): ${seasonRank != null ? `${seasonRank}/${medianSeasonValues.length}` : "—"} | Percentile ${Number.isFinite(medianSeasonPercentile) ? `${medianSeasonPercentile.toFixed(1)}%` : "—"}`,
    `You have a ${escapeHtml(eraLabel)} list`
  ].join("<br>");

  const difficultyRangeSource = difficultyRawValues.length
    ? [...difficultyRawValues]
    : [...difficultyValues];
  if (Number.isFinite(difficultyValue) && !difficultyRangeSource.includes(difficultyValue)) {
    difficultyRangeSource.push(difficultyValue);
  }
  let minDifficultyValue = difficultyRangeSource.length ? Math.min(...difficultyRangeSource) : null;
  let maxDifficultyValue = difficultyRangeSource.length ? Math.max(...difficultyRangeSource) : null;
  if (Number.isFinite(minDifficultyValue) && Number.isFinite(maxDifficultyValue) && minDifficultyValue === maxDifficultyValue) {
    minDifficultyValue = Math.max(0, minDifficultyValue - 1);
    maxDifficultyValue = Math.min(100, maxDifficultyValue + 1);
  }
  difficultyRangeEl.innerText = (
    Number.isFinite(minDifficultyValue) && Number.isFinite(maxDifficultyValue)
      ? `${minDifficultyValue.toFixed(1)}% - ${maxDifficultyValue.toFixed(1)}%`
      : "No range"
  );
  const difficultySpan = (Number.isFinite(minDifficultyValue) && Number.isFinite(maxDifficultyValue))
    ? Math.max(0.0001, maxDifficultyValue - minDifficultyValue)
    : null;
  const sortedDifficultyValues = [...difficultyRangeSource].sort((a, b) => a - b);
  const difficultyQuantileValues = [0, 0.2, 0.4, 0.6, 0.8, 1].map(q => computeQuantile(sortedDifficultyValues, q));
  const difficultyQuantilePcts = difficultyQuantileValues.map(value => {
    if (!Number.isFinite(value) || !Number.isFinite(difficultySpan)) return null;
    return clamp01((value - minDifficultyValue) / difficultySpan) * 100;
  });
  const hasDifficultyQuantileBands = difficultyQuantilePcts.every(value => Number.isFinite(value));
  difficultyLegendEl.innerHTML = percentileBandColors.map((color, index) => (
    `<span class="rig-analysis-difficulty-legend-item"><span class="rig-analysis-difficulty-legend-swatch" style="background:${color};"></span>${percentileLegendRanges[index]}</span>`
  )).join("");
  if (hasDifficultyQuantileBands) {
    const difficultyGradientStops = [];
    for (let index = 0; index < percentileBandColors.length; index += 1) {
      const startPct = difficultyQuantilePcts[index];
      const endPct = difficultyQuantilePcts[index + 1];
      difficultyGradientStops.push(`${percentileBandColors[index]} ${startPct.toFixed(2)}%`);
      difficultyGradientStops.push(`${percentileBandColors[index]} ${endPct.toFixed(2)}%`);
    }
    difficultyTrackEl.style.setProperty("background", `linear-gradient(90deg, ${difficultyGradientStops.join(", ")})`, "important");
    const difficultyStarts = [0, 1, 2, 3, 4, 5].map(index => ({
      value: difficultyQuantileValues[index],
      pct: difficultyQuantilePcts[index]
    })).filter(entry => Number.isFinite(entry.value) && Number.isFinite(entry.pct));
    difficultyPercentilesEl.innerHTML = difficultyStarts.map((entry, index) => {
      const label = `${entry.value.toFixed(1)}%`;
      if (index === 0) {
        return `<span class="rig-analysis-difficulty-percentile-label start">${label}</span>`;
      }
      if (index === difficultyStarts.length - 1) {
        return `<span class="rig-analysis-difficulty-percentile-label end">${label}</span>`;
      }
      return `<span class="rig-analysis-difficulty-percentile-label" style="left:${entry.pct.toFixed(2)}%;">${label}</span>`;
    }).join("");
  } else {
    difficultyTrackEl.style.setProperty("background", "#e2e8f0", "important");
    difficultyPercentilesEl.innerHTML = "";
  }
  const difficultyValuePct = (Number.isFinite(difficultySpan) && Number.isFinite(difficultyValue))
    ? clamp01((difficultyValue - minDifficultyValue) / difficultySpan) * 100
    : null;
  const difficultyMarkerLeftPct = formatMarkerLeftPct(difficultyValuePct);
  const getDifficultyBandColorByPct = rawPct => {
    if (!Number.isFinite(rawPct)) return percentileBandColors[0];
    if (hasDifficultyQuantileBands) {
      for (let index = 0; index < percentileBandColors.length; index += 1) {
        const upperBound = difficultyQuantilePcts[index + 1];
        if (!Number.isFinite(upperBound) || rawPct <= upperBound + 0.0001) {
          return percentileBandColors[index];
        }
      }
      return percentileBandColors[percentileBandColors.length - 1];
    }
    const normalized = clamp01(rawPct / 100);
    const bandIndex = Math.min(
      percentileBandColors.length - 1,
      Math.floor(normalized * percentileBandColors.length)
    );
    return percentileBandColors[bandIndex];
  };
  const difficultyMarkerColor = getDifficultyBandColorByPct(difficultyValuePct);
  difficultyMarkerEl.style.setProperty("--rig-difficulty-marker-color", difficultyMarkerColor, "important");
  if (Number.isFinite(difficultyMarkerLeftPct) && Number.isFinite(difficultyValue)) {
    difficultyMarkerEl.style.display = "flex";
    difficultyMarkerEl.style.left = `${difficultyMarkerLeftPct.toFixed(2)}%`;
    difficultyTagEl.innerText = `Mean Difficulty: ${difficultyValue.toFixed(1)}%`;
  } else {
    difficultyMarkerEl.style.display = "none";
    difficultyTagEl.innerText = "Mean Difficulty: —%";
  }

  difficultyValueEl.innerText = difficultyText;
  difficultySubEl.innerHTML = [
    `Difficulty rank (hardest→easiest): ${difficultyRank != null ? `${difficultyRank}/${difficultyValues.length}` : "—"} | Percentile ${Number.isFinite(difficultyPercentile) ? `${difficultyPercentile.toFixed(1)}%` : "—"}`,
    `Your list is ${escapeHtml(difficultyLabel)}`
  ].join("<br>");

  const modeRows = getCurrentUserStatsRowsForSelectedMode();
  const averageRigValues = modeRows
    .map(row => getFirstFiniteNumber(row || {}, ["Rigs", "Rig count", "rig count", "rigs"]))
    .filter(value => Number.isFinite(value));
  const averageRig = averageRigValues.length
    ? averageRigValues.reduce((sum, value) => sum + value, 0) / averageRigValues.length
    : null;

  const averageRigPctValues = modeRows
    .map(row => {
      const safeRow = row || {};
      const rigCount = getFirstFiniteNumber(safeRow, ["Rigs", "Rig count", "rig count", "rigs"]);
      const totalSongs = getFirstFiniteNumber(safeRow, ["Total songs", "total songs", "Total song", "total song"]);
      if (!Number.isFinite(rigCount) || !Number.isFinite(totalSongs) || totalSongs <= 0) return null;
      return (rigCount / totalSongs) * 100;
    })
    .filter(value => Number.isFinite(value));
  const averageRigPct = averageRigPctValues.length
    ? averageRigPctValues.reduce((sum, value) => sum + value, 0) / averageRigPctValues.length
    : null;

  avgRigValueEl.innerText = Number.isFinite(averageRig) ? averageRig.toFixed(2) : "—";
  avgRigSubEl.innerText = "";

  avgRigPctValueEl.innerText = Number.isFinite(averageRigPct) ? `${averageRigPct.toFixed(1)}%` : "—";
  avgRigPctSubEl.innerText = "";
}

function computeOverviewSongsSeenAndGotten() {
  const songs = (Array.isArray(cachedOverviewCombinedSearchSongs) && cachedOverviewCombinedSearchSongs.length)
    ? cachedOverviewCombinedSearchSongs
    : (Array.isArray(cachedSearchSongs) ? cachedSearchSongs : []);
  return songs.reduce((acc, song) => {
    const pattern = String(song && song.pattern ? song.pattern : "");
    if (!pattern) return acc;
    const compactPattern = pattern.replace(/\s+/g, "");
    acc.seen += Array.from(compactPattern).length;
    acc.gotten += (compactPattern.match(/✅/g) || []).length;
    return acc;
  }, { seen: 0, gotten: 0 });
}

function buildInsightsCoverNode(song) {
  const imageMap = cachedMalImageCache && typeof cachedMalImageCache === "object"
    ? cachedMalImageCache
    : {};
  const animeToMalId = new Map();
  const allSongsForLookup = [
    ...(Array.isArray(cachedSearchSongs) ? cachedSearchSongs : []),
    ...(Array.isArray(cachedRelearnSongs) ? cachedRelearnSongs : [])
  ];
  allSongsForLookup.forEach(item => {
    const animeName = String(item && (item.anime || item.animeName) ? (item.anime || item.animeName) : "").trim();
    const malIdValue = item && item.malId != null ? String(item.malId).trim() : "";
    if (!animeName || !malIdValue) return;
    const normalizedAnimeName = animeName.toLowerCase();
    if (!animeToMalId.has(normalizedAnimeName)) {
      animeToMalId.set(normalizedAnimeName, malIdValue);
    }
  });

  const directMalId = song && song.malId != null ? String(song.malId).trim() : "";
  const fallbackAnimeName = String(song && (song.anime || song.animeName) ? (song.anime || song.animeName) : "").trim().toLowerCase();
  const malIdKey = directMalId || animeToMalId.get(fallbackAnimeName) || "";
  const imageUrl = imageMap[malIdKey] || "";

  if (imageUrl) {
    const image = document.createElement("img");
    image.className = "relearn-cover";
    image.alt = String(song && (song.anime || song.animeName) ? (song.anime || song.animeName) : "Anime");
    image.loading = "eager";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.dataset.loadState = "loading";

    const maxAttempts = 5;
    let attempt = 0;
    let settled = false;
    let timeoutId = null;

    const clearPendingTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const finalize = (state) => {
      if (settled) return;
      settled = true;
      clearPendingTimeout();
      image.dataset.loadState = state;
    };

    const buildRetryUrl = (baseUrl, attemptNumber) => {
      if (attemptNumber <= 1) return baseUrl;
      const separator = baseUrl.includes("?") ? "&" : "?";
      return `${baseUrl}${separator}retry=${attemptNumber}&ts=${Date.now()}`;
    };

    const scheduleAttempt = () => {
      if (settled) return;
      attempt += 1;
      image.dataset.loadState = `loading-${attempt}`;
      clearPendingTimeout();

      const attemptUrl = buildRetryUrl(imageUrl, attempt);
      image.src = attemptUrl;

      timeoutId = setTimeout(() => {
        if (settled) return;
        if (attempt < maxAttempts) {
          setTimeout(scheduleAttempt, 220);
          return;
        }
        finalize("timeout");
      }, 5000);
    };

    image.onload = () => {
      if (settled) return;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finalize("loaded");
        return;
      }
      if (attempt < maxAttempts) {
        scheduleAttempt();
        return;
      }
      finalize("error");
    };

    image.onerror = () => {
      if (settled) return;
      if (attempt < maxAttempts) {
        setTimeout(scheduleAttempt, 220);
        return;
      }
      finalize("error");
    };

    scheduleAttempt();

    return image;
  }

  const placeholder = document.createElement("div");
  placeholder.className = "relearn-cover-placeholder";
  return placeholder;
}

function logTableImageLoadStatus(tableBodyId, label) {
  const tableBody = document.getElementById(tableBodyId);
  if (!tableBody) return;
  const covers = Array.from(tableBody.querySelectorAll("img.relearn-cover"));
  if (!covers.length) return;

  const summary = covers.reduce((acc, img) => {
    const key = String(img.dataset.loadState || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.debug(`[image-status] ${label}`, summary);
}

function retryFailedInsightCoverImages() {
  const tableIds = [
    "relearnSongsTableBody",
    "wrongGuessSongsTableBody",
    "neverCorrectSongsTableBody",
    "popularitySongsTableBody",
    "pcorrectSongsTableBody"
  ];
  tableIds.forEach(tableId => {
    const tableBody = document.getElementById(tableId);
    if (!tableBody) return;
    const failedImages = Array.from(tableBody.querySelectorAll("img.relearn-cover"))
      .filter(img => {
        const state = String(img.dataset.loadState || "").toLowerCase();
        return state.includes("error") || state.includes("timeout");
      });
    failedImages.forEach((img, idx) => {
      const currentSrc = String(img.getAttribute("src") || "").trim();
      if (!currentSrc) return;
      const cleanSrc = currentSrc.replace(/([?&])retry=\d+/g, "$1").replace(/([?&])ts=\d+/g, "$1").replace(/[?&]$/, "");
      const separator = cleanSrc.includes("?") ? "&" : "?";
      img.dataset.loadState = "reloading";
      img.src = `${cleanSrc}${separator}retry_manual=1&ts=${Date.now()}_${idx}`;
    });
  });
}

function setRelearnInlineToggleState(toggleBtn, isPlaying) {
  if (!toggleBtn) return;
  const icon = toggleBtn.querySelector("img");
  if (icon) {
    icon.src = isPlaying ? "data/images/pause.png" : "data/images/play.png";
    icon.alt = isPlaying ? "Pause" : "Play";
  }
  const titleText = isPlaying
    ? String(toggleBtn.dataset.pauseTitle || "Pause")
    : String(toggleBtn.dataset.playTitle || "Play");
  toggleBtn.title = titleText;
  toggleBtn.ariaLabel = titleText;
}

function setRelearnDockToggleState(isPlaying) {
  if (!relearnAudioDockToggleBtn) return;
  const icon = relearnAudioDockToggleBtn.querySelector("img");
  if (icon) {
    icon.src = isPlaying ? "data/images/pause.png" : "data/images/play.png";
    icon.alt = isPlaying ? "Pause" : "Play";
  }
  const titleText = isPlaying ? "Pause" : "Play";
  relearnAudioDockToggleBtn.title = titleText;
  relearnAudioDockToggleBtn.ariaLabel = titleText;
}

function setRelearnAudioVolumePopoverOpen(isOpen) {
  isRelearnVolumePopoverOpen = !!isOpen;
  if (!relearnAudioDockVolumePopover) return;
  clearRelearnVolumePopoverFadeTimer();

  if (isRelearnVolumePopoverOpen) {
    relearnAudioDockVolumePopover.hidden = false;
    requestAnimationFrame(() => {
      if (!isRelearnVolumePopoverOpen || !relearnAudioDockVolumePopover) return;
      relearnAudioDockVolumePopover.classList.add("is-open");
    });
    return;
  }

  relearnAudioDockVolumePopover.classList.remove("is-open");
  relearnAudioDockVolumePopover.hidden = true;
}

function clearRelearnVolumePopoverFadeTimer() {
  if (!relearnVolumePopoverFadeTimer) return;
  clearTimeout(relearnVolumePopoverFadeTimer);
  relearnVolumePopoverFadeTimer = null;
}

function isPointerNearRelearnVolumeControl(clientX, clientY) {
  if (!relearnAudioDockVolumeBtn) return false;

  const expandedContains = (rect, padPx) =>
    clientX >= (rect.left - padPx) &&
    clientX <= (rect.right + padPx) &&
    clientY >= (rect.top - padPx) &&
    clientY <= (rect.bottom + padPx);

  const btnRect = relearnAudioDockVolumeBtn.getBoundingClientRect();
  if (expandedContains(btnRect, 0)) return true;

  if (!relearnAudioDockVolumePopover || relearnAudioDockVolumePopover.hidden) return false;
  const popoverRect = relearnAudioDockVolumePopover.getBoundingClientRect();
  return expandedContains(popoverRect, 10);
}

function getRelearnAudioVolumeIconPath(percentValue) {
  const numeric = Math.max(0, Math.min(100, Number(percentValue) || 0));
  if (numeric <= 0) return RELEARN_AUDIO_VOLUME_ICONS[3];
  if (numeric <= 33) return RELEARN_AUDIO_VOLUME_ICONS[2];
  if (numeric <= 66) return RELEARN_AUDIO_VOLUME_ICONS[1];
  return RELEARN_AUDIO_VOLUME_ICONS[0];
}

function applyRelearnAudioVolumeState(percentValue = relearnAudioVolumePercentValue) {
  const clampedPercent = Math.round(Math.max(0, Math.min(100, Number(percentValue) || 0)));
  relearnAudioVolumePercentValue = clampedPercent;
  if (clampedPercent > 0) {
    relearnAudioLastNonZeroPercentValue = clampedPercent;
  }

  if (relearnAudioElement) {
    relearnAudioElement.volume = clampedPercent / 100;
  }
  if (relearnAudioDockVolumeSlider && Number(relearnAudioDockVolumeSlider.value) !== clampedPercent) {
    relearnAudioDockVolumeSlider.value = String(clampedPercent);
  }
  if (relearnAudioDockVolumePercent) {
    relearnAudioDockVolumePercent.innerText = `${clampedPercent}%`;
  }
  if (!relearnAudioDockVolumeBtn) return;

  const iconPath = getRelearnAudioVolumeIconPath(clampedPercent);
  const icon = relearnAudioDockVolumeBtn.querySelector("img");
  if (icon) {
    icon.src = dataUrl(iconPath);
    icon.alt = `Volume: ${clampedPercent}%`;
  }
  const titleText = `Volume: ${clampedPercent}%`;
  relearnAudioDockVolumeBtn.title = titleText;
  relearnAudioDockVolumeBtn.ariaLabel = titleText;
}

function syncRelearnPlaybackControlState(isPlaying) {
  setRelearnInlineToggleState(relearnActiveToggleButton, isPlaying);
  setRelearnDockToggleState(isPlaying);
}

function clearRelearnAudioButtonState(forceHide = true) {
  syncRelearnPlaybackControlState(false);
  if (forceHide) {
    relearnActiveToggleButton = null;
    relearnActiveClipStartTime = null;
    relearnActiveClipEndTime = null;
  }
  updateRelearnAudioProgressUI(forceHide);
}

function stopAndResetRelearnAudio() {
  if (relearnAudioElement) {
    relearnAudioElement.dataset.sourceUrl = "";
    relearnAudioElement.pause();
    relearnAudioElement.currentTime = 0;
    relearnAudioElement.removeAttribute("src");
    relearnAudioElement.load();
  }
  clearRelearnAudioButtonState(true);
}

function formatAudioTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function updateRelearnAudioProgressUI(forceHide = false) {
  if (!relearnAudioProgressDock || !relearnAudioProgressRange || !relearnAudioProgressCurrent || !relearnAudioProgressDuration) {
    return;
  }

  const audio = relearnAudioElement;
  const hasAudio = !!audio;
  const hasDuration = hasAudio && Number.isFinite(audio.duration) && audio.duration > 0;
  const hasClipWindow =
    Number.isFinite(relearnActiveClipStartTime) &&
    Number.isFinite(relearnActiveClipEndTime) &&
    relearnActiveClipEndTime > relearnActiveClipStartTime;
  const windowStart = hasClipWindow ? relearnActiveClipStartTime : 0;
  const windowEnd = hasClipWindow
    ? relearnActiveClipEndTime
    : (hasDuration ? audio.duration : 0);
  const windowLength = Math.max(0, windowEnd - windowStart);
  const hasActiveSource = hasAudio && String(audio.dataset.sourceUrl || "").trim().length > 0;
  const shouldShow = !forceHide && hasAudio && hasDuration && hasActiveSource;
  relearnAudioProgressDock.style.display = shouldShow ? "block" : "none";
  if (relearnAudioDockToggleBtn) relearnAudioDockToggleBtn.disabled = !shouldShow;
  if (relearnAudioDockVolumeBtn) relearnAudioDockVolumeBtn.disabled = !shouldShow;
  if (!shouldShow) setRelearnAudioVolumePopoverOpen(false);
  if (!hasAudio) return;

  if (hasDuration && windowLength > 0) {
    relearnAudioProgressRange.min = String(windowStart);
    relearnAudioProgressRange.max = String(windowEnd);
    if (!isSeekingRelearnAudio) {
      const clamped = Math.min(Math.max(audio.currentTime || 0, windowStart), windowEnd);
      relearnAudioProgressRange.value = String(clamped);
    }
    const currentForLabel = Math.max(0, (audio.currentTime || 0) - windowStart);
    relearnAudioProgressDuration.innerText = formatAudioTime(windowLength);
    relearnAudioProgressCurrent.innerText = formatAudioTime(currentForLabel);
  } else {
    relearnAudioProgressRange.min = "0";
    relearnAudioProgressRange.max = "100";
    if (!isSeekingRelearnAudio) relearnAudioProgressRange.value = "0";
    relearnAudioProgressDuration.innerText = "0:00";
    relearnAudioProgressCurrent.innerText = "0:00";
  }
}

function ensureRelearnAudioElement() {
  if (relearnAudioElement) return relearnAudioElement;

  relearnAudioElement = new Audio();
  relearnAudioElement.preload = "none";
  applyRelearnAudioVolumeState();
  relearnAudioElement.addEventListener("pause", () => {
    syncRelearnPlaybackControlState(false);
    updateRelearnAudioProgressUI();
  });
  relearnAudioElement.addEventListener("play", () => {
    syncRelearnPlaybackControlState(true);
    updateRelearnAudioProgressUI();
  });
  relearnAudioElement.addEventListener("ended", () => {
    clearRelearnAudioButtonState(true);
  });
  relearnAudioElement.addEventListener("timeupdate", () => {
    if (
      Number.isFinite(relearnActiveClipEndTime) &&
      relearnActiveClipEndTime > 0 &&
      relearnAudioElement.currentTime >= relearnActiveClipEndTime
    ) {
      relearnAudioElement.currentTime = relearnActiveClipEndTime;
      relearnAudioElement.pause();
      return;
    }
    updateRelearnAudioProgressUI();
  });
  relearnAudioElement.addEventListener("loadedmetadata", () => {
    updateRelearnAudioProgressUI();
  });
  relearnAudioElement.addEventListener("durationchange", () => {
    updateRelearnAudioProgressUI();
  });
  return relearnAudioElement;
}

function toggleRelearnPlaybackFromControls() {
  const audio = relearnAudioElement;
  if (!audio) return;
  const hasSource = String(audio.dataset.sourceUrl || "").trim().length > 0;
  if (!hasSource) return;

  if (!audio.paused) {
    audio.pause();
    return;
  }

  const clipStart = Number.isFinite(relearnActiveClipStartTime) && relearnActiveClipStartTime >= 0
    ? relearnActiveClipStartTime
    : 0;
  const clipEnd = Number.isFinite(relearnActiveClipEndTime) && relearnActiveClipEndTime > clipStart
    ? relearnActiveClipEndTime
    : null;
  const reachedClipEnd = clipEnd != null && audio.currentTime >= (clipEnd - 0.05);

  if (!Number.isFinite(audio.currentTime) || audio.currentTime < clipStart || reachedClipEnd) {
    audio.currentTime = clipStart;
  }

  audio.play().catch(err => {
    console.error("Failed to resume relearn song audio", err);
  });
}

function toggleRelearnSongAudio(audioLink, toggleBtn, options = {}) {
  const url = String(audioLink || "").trim();
  if (!url || !toggleBtn) return;

  const audio = ensureRelearnAudioElement();
  const currentUrl = String(audio.dataset.sourceUrl || "");
  const clipStartRaw = Number(options.startTime);
  const clipEndRaw = Number(options.endTime);
  const clipStart = Number.isFinite(clipStartRaw) && clipStartRaw >= 0 ? clipStartRaw : 0;
  const clipEnd = Number.isFinite(clipEndRaw) && clipEndRaw > clipStart ? clipEndRaw : null;

  if (currentUrl === url && !audio.paused) {
    audio.pause();
    return;
  }

  relearnActiveClipStartTime = clipStart;
  relearnActiveClipEndTime = clipEnd;
  const reachedClipEnd = clipEnd != null && audio.currentTime >= (clipEnd - 0.05);
  const shouldResetToClipStart =
    currentUrl !== url ||
    !Number.isFinite(audio.currentTime) ||
    audio.currentTime < clipStart ||
    reachedClipEnd;
  if (currentUrl !== url) {
    audio.src = url;
    audio.dataset.sourceUrl = url;
  }
  if (shouldResetToClipStart) {
    audio.currentTime = clipStart;
  }

  audio.play()
    .then(() => {
      if (relearnActiveToggleButton && relearnActiveToggleButton !== toggleBtn) {
        setRelearnInlineToggleState(relearnActiveToggleButton, false);
      }
      relearnActiveToggleButton = toggleBtn;
      syncRelearnPlaybackControlState(true);
      updateRelearnAudioProgressUI();
    })
    .catch(err => {
      console.error("Failed to play relearn song audio", err);
    });
}

if (relearnAudioProgressRange) {
  relearnAudioProgressRange.addEventListener("pointerdown", () => {
    isSeekingRelearnAudio = true;
  });
  relearnAudioProgressRange.addEventListener("pointerup", () => {
    isSeekingRelearnAudio = false;
    updateRelearnAudioProgressUI();
  });
  relearnAudioProgressRange.addEventListener("input", () => {
    const audio = relearnAudioElement;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const minTime = Number(relearnAudioProgressRange.min);
    const maxTime = Number(relearnAudioProgressRange.max);
    const nextTime = Number(relearnAudioProgressRange.value);
    if (!Number.isFinite(nextTime) || !Number.isFinite(minTime) || !Number.isFinite(maxTime)) return;
    audio.currentTime = Math.min(Math.max(minTime, nextTime), maxTime);
    updateRelearnAudioProgressUI();
  });
}

if (relearnAudioDockToggleBtn) {
  relearnAudioDockToggleBtn.addEventListener("click", () => {
    toggleRelearnPlaybackFromControls();
  });
}

if (relearnAudioDockVolumeBtn) {
  relearnAudioDockVolumeBtn.addEventListener("click", () => {
    if (relearnAudioDockVolumeBtn.disabled) return;
    if (relearnAudioVolumePercentValue > 0) {
      applyRelearnAudioVolumeState(0);
      return;
    }
    const restoredPercent = Math.max(1, Math.min(100, Number(relearnAudioLastNonZeroPercentValue) || 100));
    applyRelearnAudioVolumeState(restoredPercent);
  });
}

if (relearnAudioDockVolumeSlider) {
  relearnAudioDockVolumeSlider.addEventListener("input", () => {
    applyRelearnAudioVolumeState(relearnAudioDockVolumeSlider.value);
  });
}

if (relearnAudioDockVolumeWrap) {
  relearnAudioDockVolumeWrap.addEventListener("pointerenter", () => {
    if (relearnAudioDockVolumeBtn && relearnAudioDockVolumeBtn.disabled) return;
    clearRelearnVolumePopoverFadeTimer();
    setRelearnAudioVolumePopoverOpen(true);
  });
  relearnAudioDockVolumeWrap.addEventListener("focusin", () => {
    if (relearnAudioDockVolumeBtn && relearnAudioDockVolumeBtn.disabled) return;
    clearRelearnVolumePopoverFadeTimer();
    setRelearnAudioVolumePopoverOpen(true);
  });
  relearnAudioDockVolumeWrap.addEventListener("focusout", event => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && relearnAudioDockVolumeWrap.contains(nextTarget)) return;
    setRelearnAudioVolumePopoverOpen(false);
  });
}

document.addEventListener("pointermove", event => {
  if (!isRelearnVolumePopoverOpen) return;
  if (isPointerNearRelearnVolumeControl(event.clientX, event.clientY)) {
    clearRelearnVolumePopoverFadeTimer();
    return;
  }
  setRelearnAudioVolumePopoverOpen(false);
});

document.addEventListener("pointerdown", event => {
  if (!isRelearnVolumePopoverOpen || !relearnAudioDockVolumeWrap) return;
  const target = event.target;
  if (target instanceof Node && relearnAudioDockVolumeWrap.contains(target)) return;
  clearRelearnVolumePopoverFadeTimer();
  setRelearnAudioVolumePopoverOpen(false);
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !isRelearnVolumePopoverOpen) return;
  clearRelearnVolumePopoverFadeTimer();
  setRelearnAudioVolumePopoverOpen(false);
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (resetAllTrendZoomCharts()) {
    event.preventDefault();
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== " " && event.code !== "Space") return;

  const target = event.target;
  if (target instanceof HTMLElement) {
    const tagName = target.tagName;
    const isTypingField =
      tagName === "INPUT" ||
      tagName === "TEXTAREA" ||
      tagName === "SELECT" ||
      target.isContentEditable;
    if (isTypingField) return;
  }

  if (!relearnAudioProgressDock || relearnAudioProgressDock.style.display === "none") return;

  event.preventDefault();
  toggleRelearnPlaybackFromControls();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  stopAndResetRelearnAudio();
});

function getFilteredRelearnSongs() {
  const songs = Array.isArray(cachedRelearnSongs) ? cachedRelearnSongs : [];
  if (relearnOnlistFilterMode === "onlist") {
    return songs.filter(song => song && song.isOnlist === true);
  }
  if (relearnOnlistFilterMode === "offlist") {
    return songs.filter(song => song && song.isOnlist === false);
  }
  return songs;
}

function updateRelearnOnlistFilterButtons() {
  const buttons = document.querySelectorAll("[data-relearn-onlist-filter]");
  buttons.forEach(button => {
    const isActive = button.dataset.relearnOnlistFilter === relearnOnlistFilterMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function renderInsightsRelearnTracker() {
  const tbody = document.getElementById("relearnSongsTableBody");
  const pageMeta = document.getElementById("relearnPageMeta");
  const prevPageBtn = document.getElementById("relearnPrevPageBtn");
  const nextPageBtn = document.getElementById("relearnNextPageBtn");
  if (!tbody || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  updateRelearnOnlistFilterButtons();
  const songs = getFilteredRelearnSongs();
  tbody.innerHTML = "";

  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  relearnPageIndex = Math.min(Math.max(0, relearnPageIndex), pageCount - 1);
  const start = relearnPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);
  const relearnTableEl = document.getElementById("relearnSongsTable");
  const getPatternMarkerCount = patternRaw => {
    const text = String(patternRaw == null ? "" : patternRaw).trim();
    if (!text) return 0;
    const marks = Array.from(text).filter(ch => /[✅✔☑🟩🟢❌✖✗🟥🔴⬜◻◽▫]/.test(ch));
    if (marks.length) return marks.length;
    return /^[01]+$/.test(text) ? text.length : 0;
  };
  if (relearnTableEl) {
    const maxPatternCount = pageSongs.reduce((maxValue, song) => {
      return Math.max(maxValue, getPatternMarkerCount(song && song.pattern));
    }, 0);
    const boundedCount = Math.max(1, Math.min(10, maxPatternCount || 1, 30));
    const patternWidth = Math.max(72, Math.min(160, 16 + (boundedCount * 14)));
    const extraSpace = 160 - patternWidth;
    const animeWidth = 185 + Math.round(extraSpace * 0.65);
    const artistWidth = 130 + Math.round(extraSpace * 0.35);
    relearnTableEl.style.setProperty("--relearn-pattern-col-width", `${patternWidth}px`);
    relearnTableEl.style.setProperty("--relearn-anime-col-width", `${animeWidth}px`);
    relearnTableEl.style.setProperty("--relearn-artist-col-width", `${artistWidth}px`);
  }
  pageMeta.innerText = `Page ${relearnPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = relearnPageIndex <= 0;
  nextPageBtn.disabled = relearnPageIndex >= pageCount - 1;

  if (!pageSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "relearn-empty";
    cell.innerText = "No relearn songs found for this user.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  const appendClampText = (cell, value) => {
    const textNode = document.createElement("div");
    textNode.className = "table-text-clamp-3";
    textNode.innerText = String(value == null ? "—" : value);
    cell.appendChild(textNode);
  };

  const getAnimeAltEntries = song => {
    if (!song || typeof song !== "object") return [];
    const values = [];
    const seen = new Set();
    const primaryNames = new Set(
      [
        song.anime,
        song.animeName,
        song.animeTitle,
        song.animeEnglish,
        song.animeRomaji
      ]
        .map(value => String(value == null ? "" : value).trim().toLowerCase())
        .filter(Boolean)
    );
    const pushIfText = raw => {
      const text = String(raw == null ? "" : raw).trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (primaryNames.has(key)) return;
      if (seen.has(key)) return;
      seen.add(key);
      values.push(text);
    };

    if (Array.isArray(song.animeAltTitles)) song.animeAltTitles.forEach(pushIfText);
    if (Array.isArray(song.animeAliases)) song.animeAliases.forEach(pushIfText);
    if (Array.isArray(song.animeSynonyms)) song.animeSynonyms.forEach(pushIfText);
    collectLooseStringValues(song.animeAltName).forEach(pushIfText);
    collectLooseStringValues(song.animeAltNames).forEach(pushIfText);
    return values;
  };

  const appendSearchSongsAnimeCell = (cell, song) => {
    const animeName = String(getLanguageAwareAnimeName(song) || "—");
    const animeAltEntries = getAnimeAltEntries(song);
    if (!animeAltEntries.length || animeName === "—") {
      appendClampText(cell, animeName);
      return;
    }

    const clampNode = document.createElement("div");
    clampNode.className = "artist-members-wrap";
    const hoverNode = document.createElement("span");
    hoverNode.className = "anime-alt-hover";
    hoverNode.tabIndex = 0;
    hoverNode.innerText = animeName;

    const ensureFloatingTooltip = () => {
      let tooltip = document.getElementById("searchSongsAnimeHoverTooltip");
      if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.id = "searchSongsAnimeHoverTooltip";
        document.body.appendChild(tooltip);
      }
      return tooltip;
    };

    const renderTooltipContent = tooltip => {
      tooltip.innerText = animeAltEntries.join("\n");
    };

    const positionFloatingTooltip = (tooltip, anchorRect) => {
      const margin = 12;
      const offset = 10;
      const rect = tooltip.getBoundingClientRect();
      let left = anchorRect.left;
      let top = anchorRect.bottom + offset;
      if (left + rect.width > window.innerWidth - margin) {
        left = anchorRect.right - rect.width;
      }
      if (left < margin) left = margin;
      if (top + rect.height > window.innerHeight - margin) {
        top = anchorRect.top - rect.height - offset;
      }
      if (top < margin) top = margin;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const showFloatingTooltip = () => {
      const tooltip = ensureFloatingTooltip();
      renderTooltipContent(tooltip);
      tooltip.style.visibility = "visible";
      tooltip.style.opacity = "1";
      positionFloatingTooltip(tooltip, hoverNode.getBoundingClientRect());
    };

    const hideFloatingTooltip = () => {
      const tooltip = document.getElementById("searchSongsAnimeHoverTooltip");
      if (!tooltip) return;
      tooltip.style.opacity = "0";
      tooltip.style.visibility = "hidden";
    };

    hoverNode.addEventListener("mouseenter", showFloatingTooltip);
    hoverNode.addEventListener("mouseleave", hideFloatingTooltip);
    hoverNode.addEventListener("focus", showFloatingTooltip);
    hoverNode.addEventListener("blur", hideFloatingTooltip);

    clampNode.appendChild(hoverNode);
    cell.appendChild(clampNode);
  };

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const imageCell = document.createElement("td");
    imageCell.appendChild(buildInsightsCoverNode(song));
    row.appendChild(imageCell);

    const animeCell = document.createElement("td");
    appendSearchSongsAnimeCell(animeCell, song);
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    appendClampText(songCell, String(song && (song.songName || song.title) ? (song.songName || song.title) : "—"));
    row.appendChild(songCell);

    const artistCell = document.createElement("td");
    appendInsightsArtistCell(artistCell, song);
    row.appendChild(artistCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const patternCell = document.createElement("td");
    patternCell.appendChild(buildPatternSquareNode(song && song.pattern, {
      maxPerRow: 10,
      maxCount: 30,
      dates: song && song.patternDates
    }));
    row.appendChild(patternCell);

    const audioLink = String(song && song.audioLink ? song.audioLink : "").trim();
    const startSampleValue = Number(song && song.startSample);
    const endSampleValue = Number(song && song.endSample);
    const hasValidSampleRange =
      Number.isFinite(startSampleValue) &&
      Number.isFinite(endSampleValue) &&
      endSampleValue > startSampleValue;

    const createAudioToggleCell = ({
      playTitle,
      pauseTitle,
      noLinkTitle,
      clipStart = null,
      clipEnd = null,
      requiresSampleRange = false
    }) => {
      const cell = document.createElement("td");
      const controlsWrap = document.createElement("div");
      controlsWrap.className = "relearn-audio-controls";
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "relearn-audio-btn";
      toggleBtn.dataset.playTitle = playTitle;
      toggleBtn.dataset.pauseTitle = pauseTitle;
      toggleBtn.ariaLabel = playTitle;
      toggleBtn.title = playTitle;
      const toggleIcon = document.createElement("img");
      toggleIcon.src = dataUrl("images/play.png");
      toggleIcon.alt = "Play";
      toggleIcon.loading = "lazy";
      toggleBtn.appendChild(toggleIcon);

      if (!audioLink) {
        toggleBtn.disabled = true;
        toggleBtn.title = noLinkTitle;
      } else if (requiresSampleRange && !hasValidSampleRange) {
        toggleBtn.disabled = true;
        toggleBtn.title = "No sample range available";
      } else {
        toggleBtn.addEventListener("click", () => {
          toggleRelearnSongAudio(audioLink, toggleBtn, {
            startTime: clipStart,
            endTime: clipEnd
          });
        });
      }

      controlsWrap.appendChild(toggleBtn);
      cell.appendChild(controlsWrap);
      return cell;
    };

    row.appendChild(
      createAudioToggleCell({
        playTitle: "Play song",
        pauseTitle: "Pause song",
        noLinkTitle: "No audio link available"
      })
    );
    row.appendChild(
      createAudioToggleCell({
        playTitle: "Play sample",
        pauseTitle: "Pause sample",
        noLinkTitle: "No audio link available",
        clipStart: hasValidSampleRange ? startSampleValue : null,
        clipEnd: hasValidSampleRange ? endSampleValue : null,
        requiresSampleRange: true
      })
    );

    tbody.appendChild(row);
  });
}

function renderInsightsWrongGuess() {
  const tbody = document.getElementById("wrongGuessSongsTableBody");
  const meta = document.getElementById("wrongGuessSongsMeta");
  const pageMeta = document.getElementById("wrongGuessPageMeta");
  const prevPageBtn = document.getElementById("wrongGuessPrevPageBtn");
  const nextPageBtn = document.getElementById("wrongGuessNextPageBtn");
  if (!tbody || !meta || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  const songs = Array.isArray(cachedWrongGuessSongs) ? cachedWrongGuessSongs : [];
  meta.innerText = `Found ${songs.length} songs`;
  tbody.innerHTML = "";

  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  wrongGuessPageIndex = Math.min(Math.max(0, wrongGuessPageIndex), pageCount - 1);
  const start = wrongGuessPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);
  pageMeta.innerText = `Page ${wrongGuessPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = wrongGuessPageIndex <= 0;
  nextPageBtn.disabled = wrongGuessPageIndex >= pageCount - 1;

  if (!pageSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "relearn-empty";
    cell.innerText = "No wrong-guess recommendations found for this user.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const imageCell = document.createElement("td");
    imageCell.appendChild(buildInsightsCoverNode(song));
    row.appendChild(imageCell);

    const rankCell = document.createElement("td");
    rankCell.innerText = String(song && song.rank != null ? song.rank : "—");
    row.appendChild(rankCell);

    const animeCell = document.createElement("td");
    appendInsightsAnimeCell(animeCell, song);
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    songCell.innerText = String(song && song.songName ? song.songName : "—");
    row.appendChild(songCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const wrongCell = document.createElement("td");
    wrongCell.className = "search-song-frequency-percentile";
    const wrongValue = Number(song && song.wrong);
    if (Number.isFinite(wrongValue)) {
      const wrongText = document.createElement("span");
      wrongText.className = "search-song-frequency-percentile-text";
      wrongText.innerText = String(wrongValue);
      wrongCell.appendChild(wrongText);
    } else {
      wrongCell.innerText = "—";
    }
    row.appendChild(wrongCell);

    const correctCell = document.createElement("td");
    correctCell.innerText = String(song && song.correct != null ? song.correct : "—");
    row.appendChild(correctCell);

    const correctPctCell = document.createElement("td");
    correctPctCell.className = "search-song-frequency-correct";
    const correctPctValue = Number(song && song.correctPct);
    if (Number.isFinite(correctPctValue)) {
      const correctPctText = document.createElement("span");
      correctPctText.className = "search-song-frequency-correct-text";
      correctPctText.innerText = `${correctPctValue.toFixed(1)}%`;
      correctPctCell.appendChild(correctPctText);
    } else {
      correctPctCell.innerText = "—";
    }
    row.appendChild(correctPctCell);

    const difficultyCell = document.createElement("td");
    difficultyCell.innerText = formatInsightsDifficulty(song && song.difficulty);
    row.appendChild(difficultyCell);

    tbody.appendChild(row);
  });
}

function formatInsightsDifficulty(value) {
  if (value == null || value === "") return "—";
  const difficultyValue = Number(value);
  return Number.isFinite(difficultyValue) ? difficultyValue.toFixed(3) : "—";
}

function appendInsightsClampText(cell, value) {
  const textNode = document.createElement("div");
  textNode.className = "table-text-clamp-3";
  textNode.innerText = String(value == null ? "—" : value);
  cell.appendChild(textNode);
}

function getInsightsAnimeAltEntries(song) {
  if (!song || typeof song !== "object") return [];
  const values = [];
  const seen = new Set();
  const primaryNames = new Set(
    [
      song.anime,
      song.animeName,
      song.animeTitle,
      song.animeEnglish,
      song.animeRomaji
    ]
      .map(value => String(value == null ? "" : value).trim().toLowerCase())
      .filter(Boolean)
  );

  const pushIfText = raw => {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (primaryNames.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    values.push(text);
  };

  if (Array.isArray(song.animeAltTitles)) song.animeAltTitles.forEach(pushIfText);
  if (Array.isArray(song.animeAliases)) song.animeAliases.forEach(pushIfText);
  if (Array.isArray(song.animeSynonyms)) song.animeSynonyms.forEach(pushIfText);
  collectLooseStringValues(song.animeAltName).forEach(pushIfText);
  collectLooseStringValues(song.animeAltNames).forEach(pushIfText);
  return values;
}

function appendInsightsAnimeCell(cell, song) {
  const animeName = String(getLanguageAwareAnimeName(song) || "—");
  const animeAltEntries = getInsightsAnimeAltEntries(song);
  if (!animeAltEntries.length || animeName === "—") {
    appendInsightsClampText(cell, animeName);
    return;
  }

  const clampNode = document.createElement("div");
  clampNode.className = "artist-members-wrap";
  const hoverNode = document.createElement("span");
  hoverNode.className = "anime-alt-hover";
  hoverNode.tabIndex = 0;
  hoverNode.innerText = animeName;

  const ensureFloatingTooltip = () => {
    let tooltip = document.getElementById("searchSongsAnimeHoverTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "searchSongsAnimeHoverTooltip";
      document.body.appendChild(tooltip);
    }
    return tooltip;
  };

  const positionFloatingTooltip = (tooltip, anchorRect) => {
    const margin = 12;
    const offset = 10;
    const rect = tooltip.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + offset;
    if (left + rect.width > window.innerWidth - margin) left = anchorRect.right - rect.width;
    if (left < margin) left = margin;
    if (top + rect.height > window.innerHeight - margin) top = anchorRect.top - rect.height - offset;
    if (top < margin) top = margin;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const showFloatingTooltip = () => {
    const tooltip = ensureFloatingTooltip();
    tooltip.innerText = animeAltEntries.join("\n");
    tooltip.style.visibility = "visible";
    tooltip.style.opacity = "1";
    positionFloatingTooltip(tooltip, hoverNode.getBoundingClientRect());
  };

  const hideFloatingTooltip = () => {
    const tooltip = document.getElementById("searchSongsAnimeHoverTooltip");
    if (!tooltip) return;
    tooltip.style.opacity = "0";
    tooltip.style.visibility = "hidden";
  };

  hoverNode.addEventListener("mouseenter", showFloatingTooltip);
  hoverNode.addEventListener("mouseleave", hideFloatingTooltip);
  hoverNode.addEventListener("focus", showFloatingTooltip);
  hoverNode.addEventListener("blur", hideFloatingTooltip);

  clampNode.appendChild(hoverNode);
  cell.appendChild(clampNode);
}

function getInsightsArtistMemberEntries(song) {
  const members = song && Array.isArray(song.artistMembers) ? song.artistMembers : [];
  const baseArtist = String(song && song.artist ? song.artist : "").trim();
  if (!members.length) {
    if (!baseArtist) return [];
    const aliasSeen = new Set([baseArtist.toLowerCase()]);
    const aliases = [];
    const pushAlias = raw => {
      const text = String(raw == null ? "" : raw).trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (aliasSeen.has(key)) return;
      aliasSeen.add(key);
      aliases.push(text);
    };
    if (Array.isArray(song && song.artistAltNames)) song.artistAltNames.forEach(pushAlias);
    if (Array.isArray(song && song.artistAliases)) song.artistAliases.forEach(pushAlias);
    collectLooseStringValues(song && song.artistAltName).forEach(pushAlias);
    collectLooseStringValues(song && song.artistAlias).forEach(pushAlias);
    return aliases.length ? [{ primary: baseArtist, aliases }] : [];
  }
  const entries = [];
  const seenPrimary = new Set();

  members.forEach(member => {
    if (typeof member === "string") {
      const normalized = member.trim();
      if (!normalized) return;
      const primaryKey = normalized.toLowerCase();
      if (seenPrimary.has(primaryKey)) return;
      seenPrimary.add(primaryKey);
      entries.push({ primary: normalized, aliases: [] });
      return;
    }
    if (!member || typeof member !== "object") return;

    const primaryCandidates = [];
    const allCandidates = [];
    if (typeof member.primaryName === "string") primaryCandidates.push(member.primaryName);
    if (typeof member.primaryNames === "string") primaryCandidates.push(member.primaryNames);
    if (typeof member.name === "string") primaryCandidates.push(member.name);
    if (Array.isArray(member.primaryNames)) member.primaryNames.forEach(value => primaryCandidates.push(value));
    primaryCandidates.forEach(value => allCandidates.push(value));
    if (Array.isArray(member.allNames)) member.allNames.forEach(value => allCandidates.push(value));

    let primary = "";
    for (const value of primaryCandidates) {
      const normalized = String(value || "").trim();
      if (normalized) {
        primary = normalized;
        break;
      }
    }
    if (!primary) return;
    const primaryKey = primary.toLowerCase();
    if (seenPrimary.has(primaryKey)) return;
    seenPrimary.add(primaryKey);

    const aliasSeen = new Set([primaryKey]);
    const aliases = [];
    allCandidates.forEach(value => {
      const normalized = String(value || "").trim();
      if (!normalized) return;
      const aliasKey = normalized.toLowerCase();
      if (aliasSeen.has(aliasKey)) return;
      aliasSeen.add(aliasKey);
      aliases.push(normalized);
    });

    entries.push({ primary, aliases });
  });

  return entries;
}

function appendInsightsArtistCell(cell, song) {
  const artistName = String(song && song.artist ? song.artist : "—");
  const memberEntries = getInsightsArtistMemberEntries(song);
  if (!memberEntries.length || artistName === "—") {
    appendInsightsClampText(cell, artistName);
    return;
  }

  const clampNode = document.createElement("div");
  clampNode.className = "artist-members-wrap";
  const hoverNode = document.createElement("span");
  hoverNode.className = "artist-members-hover";
  hoverNode.tabIndex = 0;
  hoverNode.innerText = artistName;

  const ensureFloatingTooltip = () => {
    let tooltip = document.getElementById("searchSongsArtistHoverTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "searchSongsArtistHoverTooltip";
      document.body.appendChild(tooltip);
    }
    return tooltip;
  };

  const renderTooltipContent = tooltip => {
    tooltip.replaceChildren();
    memberEntries.forEach(entry => {
      const row = document.createElement("div");
      row.className = "artist-member-row";
      const text = document.createElement("span");
      const primary = document.createElement("span");
      primary.className = "artist-member-primary";
      primary.innerText = entry.primary;
      text.appendChild(primary);

      if (Array.isArray(entry.aliases) && entry.aliases.length) {
        const aliases = document.createElement("span");
        aliases.className = "artist-member-aliases";
        aliases.innerText = ` (${entry.aliases.join(", ")})`;
        text.appendChild(aliases);
      }

      row.appendChild(text);
      tooltip.appendChild(row);
    });
  };

  const positionFloatingTooltip = (tooltip, anchorRect) => {
    const margin = 12;
    const offset = 10;
    const rect = tooltip.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + offset;
    if (left + rect.width > window.innerWidth - margin) left = anchorRect.right - rect.width;
    if (left < margin) left = margin;
    if (top + rect.height > window.innerHeight - margin) top = anchorRect.top - rect.height - offset;
    if (top < margin) top = margin;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const showFloatingTooltip = () => {
    const tooltip = ensureFloatingTooltip();
    renderTooltipContent(tooltip);
    tooltip.style.visibility = "visible";
    tooltip.style.opacity = "1";
    positionFloatingTooltip(tooltip, hoverNode.getBoundingClientRect());
  };

  const hideFloatingTooltip = () => {
    const tooltip = document.getElementById("searchSongsArtistHoverTooltip");
    if (!tooltip) return;
    tooltip.style.opacity = "0";
    tooltip.style.visibility = "hidden";
  };

  hoverNode.addEventListener("mouseenter", showFloatingTooltip);
  hoverNode.addEventListener("mouseleave", hideFloatingTooltip);
  hoverNode.addEventListener("focus", showFloatingTooltip);
  hoverNode.addEventListener("blur", hideFloatingTooltip);

  clampNode.appendChild(hoverNode);
  cell.appendChild(clampNode);
}

function renderInsightsNeverCorrect() {
  const tbody = document.getElementById("neverCorrectSongsTableBody");
  const meta = document.getElementById("neverCorrectSongsMeta");
  const pageMeta = document.getElementById("neverCorrectPageMeta");
  const prevPageBtn = document.getElementById("neverCorrectPrevPageBtn");
  const nextPageBtn = document.getElementById("neverCorrectNextPageBtn");
  if (!tbody || !meta || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  const songs = Array.isArray(cachedNeverCorrectSongs) ? cachedNeverCorrectSongs : [];
  meta.innerText = `Found ${songs.length} songs`;
  tbody.innerHTML = "";

  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  neverCorrectPageIndex = Math.min(Math.max(0, neverCorrectPageIndex), pageCount - 1);
  const start = neverCorrectPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);
  pageMeta.innerText = `Page ${neverCorrectPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = neverCorrectPageIndex <= 0;
  nextPageBtn.disabled = neverCorrectPageIndex >= pageCount - 1;

  if (!pageSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "relearn-empty";
    cell.innerText = "No never-correct recommendations found for this user.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const imageCell = document.createElement("td");
    imageCell.appendChild(buildInsightsCoverNode(song));
    row.appendChild(imageCell);

    const rankCell = document.createElement("td");
    rankCell.innerText = String(song && song.rank != null ? song.rank : "—");
    row.appendChild(rankCell);

    const animeCell = document.createElement("td");
    appendInsightsAnimeCell(animeCell, song);
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    songCell.innerText = String(song && song.songName ? song.songName : "—");
    row.appendChild(songCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const countCell = document.createElement("td");
    countCell.className = "search-song-frequency-percentile";
    const countValue = Number(song && song.count);
    if (Number.isFinite(countValue)) {
      const countText = document.createElement("span");
      countText.className = "search-song-frequency-percentile-text";
      countText.innerText = String(countValue);
      countCell.appendChild(countText);
    } else {
      countCell.innerText = "—";
    }
    row.appendChild(countCell);

    const wrongCell = document.createElement("td");
    wrongCell.innerText = String(song && song.wrong != null ? song.wrong : "—");
    row.appendChild(wrongCell);

    const difficultyCell = document.createElement("td");
    difficultyCell.innerText = formatInsightsDifficulty(song && song.difficulty);
    row.appendChild(difficultyCell);

    tbody.appendChild(row);
  });
}

function renderInsightsPopularity() {
  const tbody = document.getElementById("popularitySongsTableBody");
  const meta = document.getElementById("popularitySongsMeta");
  const pageMeta = document.getElementById("popularityPageMeta");
  const prevPageBtn = document.getElementById("popularityPrevPageBtn");
  const nextPageBtn = document.getElementById("popularityNextPageBtn");
  if (!tbody || !meta || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  const songs = Array.isArray(cachedPopularitySongs) ? cachedPopularitySongs : [];
  meta.innerText = `Found ${songs.length} songs`;
  tbody.innerHTML = "";

  const pageCount = Math.max(1, Math.ceil(songs.length / RELEARN_PAGE_SIZE));
  popularityPageIndex = Math.min(Math.max(0, popularityPageIndex), pageCount - 1);
  const start = popularityPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = songs.slice(start, end);
  pageMeta.innerText = `Page ${popularityPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = popularityPageIndex <= 0;
  nextPageBtn.disabled = popularityPageIndex >= pageCount - 1;

  if (!pageSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.className = "relearn-empty";
    cell.innerText = "No popularity recommendations found for this user.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const imageCell = document.createElement("td");
    imageCell.appendChild(buildInsightsCoverNode(song));
    row.appendChild(imageCell);

    const rankCell = document.createElement("td");
    rankCell.innerText = String(song && song.rank != null ? song.rank : "—");
    row.appendChild(rankCell);

    const animeCell = document.createElement("td");
    appendInsightsAnimeCell(animeCell, song);
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    songCell.innerText = String(song && song.songName ? song.songName : "—");
    row.appendChild(songCell);

    const artistCell = document.createElement("td");
    appendInsightsArtistCell(artistCell, song);
    row.appendChild(artistCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const countCell = document.createElement("td");
    countCell.className = "search-song-frequency-percentile";
    const countValue = Number(song && song.count);
    if (Number.isFinite(countValue)) {
      const countText = document.createElement("span");
      countText.className = "search-song-frequency-percentile-text";
      countText.innerText = String(countValue);
      countCell.appendChild(countText);
    } else {
      countCell.innerText = "—";
    }
    row.appendChild(countCell);

    const correctPctCell = document.createElement("td");
    correctPctCell.className = "search-song-frequency-correct";
    const correctPctValue = Number(song && song.correctPct);
    if (Number.isFinite(correctPctValue)) {
      const correctPctText = document.createElement("span");
      correctPctText.className = "search-song-frequency-correct-text";
      correctPctText.innerText = `${correctPctValue.toFixed(1)}%`;
      correctPctCell.appendChild(correctPctText);
    } else {
      correctPctCell.innerText = "—";
    }
    row.appendChild(correctPctCell);

    const difficultyCell = document.createElement("td");
    difficultyCell.innerText = formatInsightsDifficulty(song && song.difficulty);
    row.appendChild(difficultyCell);

    tbody.appendChild(row);
  });

  setTimeout(() => {
    logTableImageLoadStatus("popularitySongsTableBody", "By Popularity");
  }, 400);
}

function renderInsightsPCorrect() {
  const tbody = document.getElementById("pcorrectSongsTableBody");
  const meta = document.getElementById("pcorrectSongsMeta");
  const pageMeta = document.getElementById("pcorrectPageMeta");
  const prevPageBtn = document.getElementById("pcorrectPrevPageBtn");
  const nextPageBtn = document.getElementById("pcorrectNextPageBtn");
  if (!tbody || !meta || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  const songs = Array.isArray(cachedPCorrectSongs) ? cachedPCorrectSongs : [];
  const eligibleSongs = songs.filter(song => {
    const attempts = Number(song && song.attempts);
    return Number.isFinite(attempts) && attempts >= 8;
  });
  meta.innerText = `Found ${eligibleSongs.length} songs`;
  tbody.innerHTML = "";

  const pageCount = Math.max(1, Math.ceil(eligibleSongs.length / RELEARN_PAGE_SIZE));
  pcorrectPageIndex = Math.min(Math.max(0, pcorrectPageIndex), pageCount - 1);
  const start = pcorrectPageIndex * RELEARN_PAGE_SIZE;
  const end = start + RELEARN_PAGE_SIZE;
  const pageSongs = eligibleSongs.slice(start, end);
  pageMeta.innerText = `Page ${pcorrectPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = pcorrectPageIndex <= 0;
  nextPageBtn.disabled = pcorrectPageIndex >= pageCount - 1;

  if (!pageSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 10;
    cell.className = "relearn-empty";
    cell.innerText = "No percent-correct recommendations found.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const imageCell = document.createElement("td");
    imageCell.appendChild(buildInsightsCoverNode(song));
    row.appendChild(imageCell);

    const rankCell = document.createElement("td");
    rankCell.innerText = String(song && song.rank != null ? song.rank : "—");
    row.appendChild(rankCell);

    const animeCell = document.createElement("td");
    appendInsightsAnimeCell(animeCell, song);
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    const displaySongName = String(song && (song.songName || song.title) ? (song.songName || song.title) : "").trim();
    songCell.innerText = displaySongName || "—";
    row.appendChild(songCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const artistCell = document.createElement("td");
    appendInsightsArtistCell(artistCell, song);
    row.appendChild(artistCell);

    const correctPctCell = document.createElement("td");
    correctPctCell.className = "search-song-frequency-correct";
    const correctPctValue = Number(song && song.pcorrect);
    if (Number.isFinite(correctPctValue)) {
      const correctPctText = document.createElement("span");
      correctPctText.className = "search-song-frequency-correct-text";
      correctPctText.innerText = `${correctPctValue.toFixed(1)}%`;
      correctPctCell.appendChild(correctPctText);
    } else {
      correctPctCell.innerText = "—";
    }
    row.appendChild(correctPctCell);

    const correctCell = document.createElement("td");
    correctCell.innerText = String(song && song.correct != null ? song.correct : "—");
    row.appendChild(correctCell);

    const attemptsCell = document.createElement("td");
    attemptsCell.innerText = String(song && song.attempts != null ? song.attempts : "—");
    row.appendChild(attemptsCell);

    const difficultyCell = document.createElement("td");
    difficultyCell.innerText = formatInsightsDifficulty(song && song.difficulty);
    row.appendChild(difficultyCell);

    tbody.appendChild(row);
  });

  setTimeout(() => {
    logTableImageLoadStatus("pcorrectSongsTableBody", "By % correct");
  }, 400);
}

function renderInsightsSearchSongs() {
  const tbody = document.getElementById("searchSongsTableBody");
  const meta = document.getElementById("searchSongsMeta");
  const pageMeta = document.getElementById("searchSongsPageMeta");
  const prevPageBtn = document.getElementById("searchSongsPrevPageBtn");
  const nextPageBtn = document.getElementById("searchSongsNextPageBtn");
  if (!tbody || !meta || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  const songs = Array.isArray(cachedSearchSongs) ? cachedSearchSongs : [];
  const normalizedQuery = String(searchSongsQuery || "").trim().toLowerCase();
  const normalizedQueryCompact = normalizeSearchSongText(normalizedQuery);
  const rawMode = String(searchSongsMode || "all").toLowerCase();
  const activeMode = rawMode === "off" ? "all" : rawMode;

  const filteredSongs = normalizedQuery
    ? songs.filter(song => {
        const candidates = getSearchSongCandidatesByMode(song, activeMode);
        const compactCandidates = candidates.map(value => normalizeSearchSongText(value));
        if (searchSongsExactMatch) {
          return candidates.some(value => value === normalizedQuery)
            || compactCandidates.some(value => value === normalizedQueryCompact);
        }
        return candidates.some(value => value.includes(normalizedQuery))
          || compactCandidates.some(value => value.includes(normalizedQueryCompact));
      })
    : songs;

  meta.innerText = normalizedQuery
    ? `Found ${filteredSongs.length} songs`
    : `Found ${songs.length} songs`;

  tbody.innerHTML = "";
  const pageCount = Math.max(1, Math.ceil(filteredSongs.length / SEARCH_SONGS_PAGE_SIZE));
  searchSongsPageIndex = Math.min(Math.max(0, searchSongsPageIndex), pageCount - 1);
  const start = searchSongsPageIndex * SEARCH_SONGS_PAGE_SIZE;
  const end = start + SEARCH_SONGS_PAGE_SIZE;
  const pageSongs = filteredSongs.slice(start, end);
  const searchSongsTableEl = tbody.closest("table");
  const getPatternMarkerCount = patternRaw => {
    const text = String(patternRaw == null ? "" : patternRaw).trim();
    if (!text) return 0;
    const marks = Array.from(text).filter(ch => /[✅✔☑🟩🟢❌✖✗🟥🔴⬜◻◽▫]/.test(ch));
    if (marks.length) return marks.length;
    return /^[01]+$/.test(text) ? text.length : 0;
  };
  if (searchSongsTableEl) {
    const maxPatternCount = pageSongs.reduce((maxValue, song) => {
      return Math.max(maxValue, getPatternMarkerCount(song && song.pattern));
    }, 0);
    const boundedCount = Math.max(1, Math.min(10, maxPatternCount || 1, 30));
    const patternWidth = Math.max(72, Math.min(130, 16 + (boundedCount * 11)));
    const extraSpace = 130 - patternWidth;
    const textWidth = 150 + Math.round(extraSpace / 3);
    searchSongsTableEl.style.setProperty("--search-pattern-col-width", `${patternWidth}px`);
    searchSongsTableEl.style.setProperty("--search-text-col-width", `${textWidth}px`);
  }
  pageMeta.innerText = `Page ${searchSongsPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = searchSongsPageIndex <= 0;
  nextPageBtn.disabled = searchSongsPageIndex >= pageCount - 1;

  if (!filteredSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "relearn-empty";
    cell.innerText = normalizedQuery
      ? "No songs match your search."
      : "No search songs found for this user.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  const appendClampText = (cell, value) => {
    const textNode = document.createElement("div");
    textNode.className = "table-text-clamp-3";
    textNode.innerText = String(value == null ? "—" : value);
    cell.appendChild(textNode);
  };

  const getAnimeAltEntries = song => {
    if (!song || typeof song !== "object") return [];
    const values = [];
    const seen = new Set();
    const primaryNames = new Set(
      [
        song.anime,
        song.animeName,
        song.animeTitle,
        song.animeEnglish,
        song.animeRomaji
      ]
        .map(value => String(value == null ? "" : value).trim().toLowerCase())
        .filter(Boolean)
    );
    const pushIfText = raw => {
      const text = String(raw == null ? "" : raw).trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (primaryNames.has(key)) return;
      if (seen.has(key)) return;
      seen.add(key);
      values.push(text);
    };

    if (Array.isArray(song.animeAltTitles)) song.animeAltTitles.forEach(pushIfText);
    if (Array.isArray(song.animeAliases)) song.animeAliases.forEach(pushIfText);
    if (Array.isArray(song.animeSynonyms)) song.animeSynonyms.forEach(pushIfText);
    collectLooseStringValues(song.animeAltName).forEach(pushIfText);
    collectLooseStringValues(song.animeAltNames).forEach(pushIfText);
    return values;
  };

  const appendSearchSongsAnimeCell = (cell, song) => {
    const animeName = String(getLanguageAwareAnimeName(song) || "—");
    const animeAltEntries = getAnimeAltEntries(song);
    if (!animeAltEntries.length || animeName === "—") {
      appendClampText(cell, animeName);
      return;
    }

    const clampNode = document.createElement("div");
    clampNode.className = "artist-members-wrap";
    const hoverNode = document.createElement("span");
    hoverNode.className = "anime-alt-hover";
    hoverNode.tabIndex = 0;
    hoverNode.innerText = animeName;

    const ensureFloatingTooltip = () => {
      let tooltip = document.getElementById("searchSongsAnimeHoverTooltip");
      if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.id = "searchSongsAnimeHoverTooltip";
        document.body.appendChild(tooltip);
      }
      return tooltip;
    };

    const renderTooltipContent = tooltip => {
      tooltip.innerText = animeAltEntries.join("\n");
    };

    const positionFloatingTooltip = (tooltip, anchorRect) => {
      const margin = 12;
      const offset = 10;
      const rect = tooltip.getBoundingClientRect();
      let left = anchorRect.left;
      let top = anchorRect.bottom + offset;
      if (left + rect.width > window.innerWidth - margin) {
        left = anchorRect.right - rect.width;
      }
      if (left < margin) left = margin;
      if (top + rect.height > window.innerHeight - margin) {
        top = anchorRect.top - rect.height - offset;
      }
      if (top < margin) top = margin;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const showFloatingTooltip = () => {
      const tooltip = ensureFloatingTooltip();
      renderTooltipContent(tooltip);
      tooltip.style.visibility = "visible";
      tooltip.style.opacity = "1";
      positionFloatingTooltip(tooltip, hoverNode.getBoundingClientRect());
    };

    const hideFloatingTooltip = () => {
      const tooltip = document.getElementById("searchSongsAnimeHoverTooltip");
      if (!tooltip) return;
      tooltip.style.opacity = "0";
      tooltip.style.visibility = "hidden";
    };

    hoverNode.addEventListener("mouseenter", showFloatingTooltip);
    hoverNode.addEventListener("mouseleave", hideFloatingTooltip);
    hoverNode.addEventListener("focus", showFloatingTooltip);
    hoverNode.addEventListener("blur", hideFloatingTooltip);

    clampNode.appendChild(hoverNode);
    cell.appendChild(clampNode);
  };

  const getArtistMemberEntries = song => {
    const members = song && Array.isArray(song.artistMembers) ? song.artistMembers : [];
    if (!members.length) return [];
    const entries = [];
    const seenPrimary = new Set();
    members.forEach(member => {
      if (typeof member === "string") {
        const normalized = member.trim();
        if (!normalized) return;
        const primaryKey = normalized.toLowerCase();
        if (seenPrimary.has(primaryKey)) return;
        seenPrimary.add(primaryKey);
        entries.push({ primary: normalized, aliases: [] });
        return;
      }
      if (!member || typeof member !== "object") return;

      const primaryCandidates = [];
      const allCandidates = [];
      if (typeof member.primaryName === "string") primaryCandidates.push(member.primaryName);
      if (typeof member.primaryNames === "string") primaryCandidates.push(member.primaryNames);
      if (typeof member.name === "string") primaryCandidates.push(member.name);
      if (Array.isArray(member.primaryNames)) {
        member.primaryNames.forEach(value => primaryCandidates.push(value));
      }
      primaryCandidates.forEach(value => allCandidates.push(value));
      if (Array.isArray(member.allNames)) {
        member.allNames.forEach(value => allCandidates.push(value));
      }

      let primary = "";
      for (const value of primaryCandidates) {
        const normalized = String(value || "").trim();
        if (normalized) {
          primary = normalized;
          break;
        }
      }
      if (!primary) return;
      const primaryKey = primary.toLowerCase();
      if (seenPrimary.has(primaryKey)) return;
      seenPrimary.add(primaryKey);

      const aliasSeen = new Set([primaryKey]);
      const aliases = [];
      allCandidates.forEach(value => {
        const normalized = String(value || "").trim();
        if (!normalized) return;
        const aliasKey = normalized.toLowerCase();
        if (aliasSeen.has(aliasKey)) return;
        aliasSeen.add(aliasKey);
        aliases.push(normalized);
      });

      entries.push({ primary, aliases });
    });
    return entries;
  };

  const appendSearchSongsArtistCell = (cell, song) => {
    const artistName = String(song && song.artist ? song.artist : "—");
    const memberEntries = getArtistMemberEntries(song);
    if (!memberEntries.length || artistName === "—") {
      appendClampText(cell, artistName);
      return;
    }

    const clampNode = document.createElement("div");
    clampNode.className = "artist-members-wrap";
    const hoverNode = document.createElement("span");
    hoverNode.className = "artist-members-hover";
    hoverNode.tabIndex = 0;
    hoverNode.innerText = artistName;
    const ensureFloatingTooltip = () => {
      let tooltip = document.getElementById("searchSongsArtistHoverTooltip");
      if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.id = "searchSongsArtistHoverTooltip";
        document.body.appendChild(tooltip);
      }
      return tooltip;
    };

    const renderTooltipContent = tooltip => {
      tooltip.replaceChildren();
      memberEntries.forEach(entry => {
        const row = document.createElement("div");
        row.className = "artist-member-row";

        const text = document.createElement("span");
        const primary = document.createElement("span");
        primary.className = "artist-member-primary";
        primary.innerText = entry.primary;
        text.appendChild(primary);

        if (Array.isArray(entry.aliases) && entry.aliases.length) {
          const aliases = document.createElement("span");
          aliases.className = "artist-member-aliases";
          aliases.innerText = ` (${entry.aliases.join(", ")})`;
          text.appendChild(aliases);
        }

        row.appendChild(text);
        tooltip.appendChild(row);
      });
    };

    const positionFloatingTooltip = (tooltip, anchorRect) => {
      const margin = 12;
      const offset = 10;
      const rect = tooltip.getBoundingClientRect();
      let left = anchorRect.left;
      let top = anchorRect.bottom + offset;
      if (left + rect.width > window.innerWidth - margin) {
        left = anchorRect.right - rect.width;
      }
      if (left < margin) left = margin;
      if (top + rect.height > window.innerHeight - margin) {
        top = anchorRect.top - rect.height - offset;
      }
      if (top < margin) top = margin;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const showFloatingTooltip = () => {
      const tooltip = ensureFloatingTooltip();
      renderTooltipContent(tooltip);
      tooltip.style.visibility = "visible";
      tooltip.style.opacity = "1";
      positionFloatingTooltip(tooltip, hoverNode.getBoundingClientRect());
    };

    const hideFloatingTooltip = () => {
      const tooltip = document.getElementById("searchSongsArtistHoverTooltip");
      if (!tooltip) return;
      tooltip.style.opacity = "0";
      tooltip.style.visibility = "hidden";
    };

    hoverNode.addEventListener("mouseenter", showFloatingTooltip);
    hoverNode.addEventListener("mouseleave", hideFloatingTooltip);
    hoverNode.addEventListener("focus", showFloatingTooltip);
    hoverNode.addEventListener("blur", hideFloatingTooltip);

    clampNode.appendChild(hoverNode);
    cell.appendChild(clampNode);
  };

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const imageCell = document.createElement("td");
    imageCell.appendChild(buildInsightsCoverNode(song));
    row.appendChild(imageCell);

    const animeCell = document.createElement("td");
    appendSearchSongsAnimeCell(animeCell, song);
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    appendClampText(songCell, formatSearchSongTitle(song));
    row.appendChild(songCell);

    const artistCell = document.createElement("td");
    appendSearchSongsArtistCell(artistCell, song);
    row.appendChild(artistCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const patternCell = document.createElement("td");
    patternCell.appendChild(buildPatternSquareNode(song && song.pattern, {
      maxPerRow: 10,
      maxCount: 30,
      dates: song && song.patternDates
    }));
    row.appendChild(patternCell);

    const audioLink = String(song && song.audioLink ? song.audioLink : "").trim();
    const startSampleValue = Number(
      song && (song.startSample != null ? song.startSample : song.sampleStart)
    );
    const endSampleValue = Number(
      song && (song.endSample != null ? song.endSample : song.sampleEnd)
    );
    const hasValidSampleRange =
      Number.isFinite(startSampleValue) &&
      Number.isFinite(endSampleValue) &&
      endSampleValue > startSampleValue;

    const createAudioToggleCell = ({
      playTitle,
      pauseTitle,
      noLinkTitle,
      clipStart = null,
      clipEnd = null,
      requiresSampleRange = false
    }) => {
      const cell = document.createElement("td");
      const controlsWrap = document.createElement("div");
      controlsWrap.className = "relearn-audio-controls";
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "relearn-audio-btn";
      toggleBtn.dataset.playTitle = playTitle;
      toggleBtn.dataset.pauseTitle = pauseTitle;
      toggleBtn.ariaLabel = playTitle;
      toggleBtn.title = playTitle;
      const toggleIcon = document.createElement("img");
      toggleIcon.src = dataUrl("images/play.png");
      toggleIcon.alt = "Play";
      toggleIcon.loading = "lazy";
      toggleBtn.appendChild(toggleIcon);

      if (!audioLink) {
        toggleBtn.disabled = true;
        toggleBtn.title = noLinkTitle;
      } else if (requiresSampleRange && !hasValidSampleRange) {
        toggleBtn.disabled = true;
        toggleBtn.title = "No sample range available";
      } else {
        toggleBtn.addEventListener("click", () => {
          toggleRelearnSongAudio(audioLink, toggleBtn, {
            startTime: clipStart,
            endTime: clipEnd
          });
        });
      }

      controlsWrap.appendChild(toggleBtn);
      cell.appendChild(controlsWrap);
      return cell;
    };

    row.appendChild(
      createAudioToggleCell({
        playTitle: "Play song",
        pauseTitle: "Pause song",
        noLinkTitle: "No audio link available"
      })
    );
    row.appendChild(
      createAudioToggleCell({
        playTitle: "Play sample",
        pauseTitle: "Pause sample",
        noLinkTitle: "No audio link available",
        clipStart: hasValidSampleRange ? startSampleValue : null,
        clipEnd: hasValidSampleRange ? endSampleValue : null,
        requiresSampleRange: true
      })
    );

    tbody.appendChild(row);
  });
}

function renderSearchSongFrequency() {
  const tbody = document.getElementById("searchSongFrequencyTableBody");
  const meta = document.getElementById("searchSongFrequencyMeta");
  const pageMeta = document.getElementById("searchSongFrequencyPageMeta");
  const prevPageBtn = document.getElementById("searchSongFrequencyPrevPageBtn");
  const nextPageBtn = document.getElementById("searchSongFrequencyNextPageBtn");
  if (!tbody || !meta || !pageMeta || !prevPageBtn || !nextPageBtn) return;

  const songs = Array.isArray(cachedSearchSongFrequencyRows) ? cachedSearchSongFrequencyRows : [];
  const normalizedQuery = String(searchSongFrequencyQuery || "").trim().toLowerCase();
  const normalizedQueryCompact = normalizeSearchSongText(normalizedQuery);
  const activeMode = "all";

  const filteredSongs = normalizedQuery
    ? songs.filter(song => {
        const candidates = getSearchSongCandidatesByMode(song, activeMode);
        const compactCandidates = candidates.map(value => normalizeSearchSongText(value));
        if (searchSongFrequencyExactMatch) {
          return candidates.some(value => value === normalizedQuery)
            || compactCandidates.some(value => value === normalizedQueryCompact);
        }
        return candidates.some(value => value.includes(normalizedQuery))
          || compactCandidates.some(value => value.includes(normalizedQueryCompact));
      })
    : songs;

  meta.innerText = normalizedQuery
    ? `Found ${filteredSongs.length} songs`
    : `Found ${songs.length} songs`;

  tbody.innerHTML = "";
  const pageCount = Math.max(1, Math.ceil(filteredSongs.length / SEARCH_SONGS_PAGE_SIZE));
  searchSongFrequencyPageIndex = Math.min(Math.max(0, searchSongFrequencyPageIndex), pageCount - 1);
  const start = searchSongFrequencyPageIndex * SEARCH_SONGS_PAGE_SIZE;
  const end = start + SEARCH_SONGS_PAGE_SIZE;
  const pageSongs = filteredSongs.slice(start, end);
  pageMeta.innerText = `Page ${searchSongFrequencyPageIndex + 1}/${pageCount}`;
  prevPageBtn.disabled = searchSongFrequencyPageIndex <= 0;
  nextPageBtn.disabled = searchSongFrequencyPageIndex >= pageCount - 1;

  const hideFrequencyTitleTooltip = () => {
    const tooltip = document.getElementById("searchSongFrequencyTitleHoverTooltip");
    if (!tooltip) return;
    tooltip.style.opacity = "0";
    tooltip.style.visibility = "hidden";
  };

  const getFrequencyTitleTooltip = () => {
    let tooltip = document.getElementById("searchSongFrequencyTitleHoverTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "searchSongFrequencyTitleHoverTooltip";
      document.body.appendChild(tooltip);
    }
    return tooltip;
  };

  const placeFrequencyTitleTooltip = (tooltip, cell) => {
    const margin = 10;
    const gap = -5;
    const cellRect = cell.getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const anchorX = cellRect.left + cellRect.width / 2;
    const left = Math.min(Math.max(margin, anchorX - rect.width / 2), maxLeft);
    let top = cellRect.top - rect.height - gap;
    if (top < margin) {
      top = Math.min(window.innerHeight - rect.height - margin, cellRect.bottom + gap);
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  };

  const bindFrequencyTitleTooltip = (cell, text) => {
    cell.removeAttribute("title");
    cell.removeAttribute("aria-label");
    cell.addEventListener("mouseenter", () => {
      cell.removeAttribute("title");
      cell.removeAttribute("aria-label");
      if (cell.scrollWidth <= cell.clientWidth + 1) return;
      const tooltip = getFrequencyTitleTooltip();
      tooltip.textContent = text;
      tooltip.style.opacity = "1";
      tooltip.style.visibility = "visible";
      placeFrequencyTitleTooltip(tooltip, cell);
    });
    cell.addEventListener("mouseleave", hideFrequencyTitleTooltip);
  };

  hideFrequencyTitleTooltip();

  if (!filteredSongs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "relearn-empty";
    cell.innerText = normalizedQuery
      ? "No songs match your search."
      : "No song frequency rows found.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  pageSongs.forEach(song => {
    const row = document.createElement("tr");

    const rankCell = document.createElement("td");
    rankCell.innerText = String(song && song.rank != null ? song.rank : "—");
    row.appendChild(rankCell);

    const appendHoverTitleText = (cell, value) => {
      const text = String(value == null || value === "" ? "—" : value);
      cell.innerText = text;
      if (text !== "—") {
        bindFrequencyTitleTooltip(cell, text);
      }
    };

    const animeCell = document.createElement("td");
    appendHoverTitleText(animeCell, getLanguageAwareAnimeName(song));
    row.appendChild(animeCell);

    const songCell = document.createElement("td");
    appendHoverTitleText(songCell, song && song.songName ? song.songName : "—");
    row.appendChild(songCell);

    const typeCell = document.createElement("td");
    typeCell.innerText = String(song && song.type ? song.type : "—");
    row.appendChild(typeCell);

    const artistCell = document.createElement("td");
    appendHoverTitleText(
      artistCell,
      song && (song.artist || song.songArtist || song.artistName)
        ? (song.artist || song.songArtist || song.artistName)
        : "—"
    );
    row.appendChild(artistCell);

    const percentileCell = document.createElement("td");
    const percentileValue = Number(song && song.percentile);
    percentileCell.className = "search-song-frequency-percentile";
    if (Number.isFinite(percentileValue)) {
      const percentileText = document.createElement("span");
      percentileText.className = "search-song-frequency-percentile-text";
      percentileText.innerText = `${percentileValue.toFixed(2)}%`;
      percentileCell.appendChild(percentileText);
    } else {
      percentileCell.innerText = "—";
    }
    row.appendChild(percentileCell);

    const countCell = document.createElement("td");
    countCell.innerText = String(song && song.count != null ? song.count : "—");
    row.appendChild(countCell);

    const correctPctCell = document.createElement("td");
    correctPctCell.className = "search-song-frequency-correct";
    const correctPctValue = Number(song && song.correctPct);
    if (Number.isFinite(correctPctValue)) {
      const correctPctText = document.createElement("span");
      correctPctText.className = "search-song-frequency-correct-text";
      correctPctText.innerText = `${correctPctValue.toFixed(1)}%`;
      correctPctCell.appendChild(correctPctText);
    } else {
      correctPctCell.innerText = "—";
    }
    row.appendChild(correctPctCell);

    tbody.appendChild(row);
  });
}

function detectPatternState(patternRaw) {
  const text = String(patternRaw == null ? "" : patternRaw).trim();
  if (!text) return "unknown";

  const lower = text.toLowerCase();
  const hasCorrectWord = /\b(correct|right|true|yes|hit|pass)\b/.test(lower);
  const hasWrongWord = /\b(wrong|incorrect|false|no|miss|fail)\b/.test(lower);
  const hasCorrectMark = /[✅✔☑🟩🟢]/.test(text);
  const hasWrongMark = /[❌✖✗🟥🔴]/.test(text);

  if (hasCorrectMark && !hasWrongMark) return "correct";
  if (hasWrongMark && !hasCorrectMark) return "wrong";
  if (hasCorrectWord && !hasWrongWord) return "correct";
  if (hasWrongWord && !hasCorrectWord) return "wrong";

  const lastCorrectIndex = Math.max(
    text.lastIndexOf("✅"),
    text.lastIndexOf("✔"),
    text.lastIndexOf("☑"),
    text.lastIndexOf("🟩"),
    text.lastIndexOf("🟢")
  );
  const lastWrongIndex = Math.max(
    text.lastIndexOf("❌"),
    text.lastIndexOf("✖"),
    text.lastIndexOf("✗"),
    text.lastIndexOf("🟥"),
    text.lastIndexOf("🔴")
  );
  if (lastCorrectIndex >= 0 || lastWrongIndex >= 0) {
    return lastCorrectIndex >= lastWrongIndex ? "correct" : "wrong";
  }

  if (lower === "1") return "correct";
  if (lower === "0") return "wrong";

  return "unknown";
}

function ensurePatternDateHoverTooltip() {
  let tooltip = document.getElementById("patternDateHoverTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "patternDateHoverTooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function positionPatternDateHoverTooltip(tooltip, anchorRect) {
  const margin = 8;
  const offset = 7;
  const rect = tooltip.getBoundingClientRect();
  let left = anchorRect.left + (anchorRect.width / 2) - (rect.width / 2);
  let top = anchorRect.top - rect.height - offset;

  if (left < margin) left = margin;
  if (left + rect.width > window.innerWidth - margin) {
    left = window.innerWidth - rect.width - margin;
  }
  if (top < margin) {
    top = anchorRect.bottom + offset;
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = window.innerHeight - rect.height - margin;
  }

  tooltip.style.setProperty("left", `${Math.max(margin, left)}px`, "important");
  tooltip.style.setProperty("top", `${Math.max(margin, top)}px`, "important");
}

function showPatternDateHoverTooltip(anchor, dateValue) {
  const text = String(dateValue == null ? "" : dateValue).trim();
  if (!text) return;
  const tooltip = ensurePatternDateHoverTooltip();
  tooltip.innerText = text;
  tooltip.classList.add("visible");
  positionPatternDateHoverTooltip(tooltip, anchor.getBoundingClientRect());
}

function hidePatternDateHoverTooltip() {
  const tooltip = document.getElementById("patternDateHoverTooltip");
  if (!tooltip) return;
  tooltip.classList.remove("visible");
}

function buildPatternSquareNode(patternRaw, options = {}) {
  const originalText = String(patternRaw == null ? "" : patternRaw).trim();
  const container = document.createElement("span");
  container.className = "pattern-square-list";
  let patternDates = Array.isArray(options && options.dates) ? options.dates : [];
  const maxPerRowRaw = Number(options && options.maxPerRow);
  const maxPerRow = Number.isFinite(maxPerRowRaw) && maxPerRowRaw > 0
    ? Math.floor(maxPerRowRaw)
    : null;
  const maxCountRaw = Number(options && options.maxCount);
  const maxCount = Number.isFinite(maxCountRaw) && maxCountRaw > 0
    ? Math.floor(maxCountRaw)
    : null;

  let states = [];
  const chars = Array.from(originalText);
  chars.forEach(ch => {
    if (/[✅✔☑🟩🟢]/.test(ch)) {
      states.push("correct");
    } else if (/[❌✖✗🟥🔴]/.test(ch)) {
      states.push("wrong");
    } else if (/[⬜◻◽▫]/.test(ch)) {
      states.push("unknown");
    }
  });

  if (!states.length && /^[01]+$/.test(originalText)) {
    Array.from(originalText).forEach(ch => {
      states.push(ch === "1" ? "correct" : "wrong");
    });
  }

  if (!states.length && /^[crwx]+$/i.test(originalText)) {
    Array.from(originalText.toLowerCase()).forEach(ch => {
      if (ch === "c" || ch === "r") states.push("correct");
      if (ch === "w" || ch === "x") states.push("wrong");
    });
  }

  if (!states.length && originalText) {
    states.push(detectPatternState(originalText));
  }

  if (!states.length) {
    states.push("unknown");
  }

  if (maxCount && states.length > maxCount) {
    states = states.slice(-maxCount);
    patternDates = patternDates.slice(-states.length);
  }

  const appendSquare = (parent, state, index) => {
    const square = document.createElement("span");
    square.className = `pattern-square pattern-${state}`;
    const dateValue = String(patternDates[index] == null ? "" : patternDates[index]).trim();
    if (dateValue) {
      const stateLabel = state === "correct" ? "Correct" : (state === "wrong" ? "Wrong" : "Unknown");
      square.classList.add("has-pattern-date");
      square.setAttribute("aria-label", `${stateLabel} on ${dateValue}`);
      square.addEventListener("mouseenter", () => showPatternDateHoverTooltip(square, dateValue));
      square.addEventListener("mousemove", () => {
        const tooltip = document.getElementById("patternDateHoverTooltip");
        if (tooltip && tooltip.classList.contains("visible")) {
          positionPatternDateHoverTooltip(tooltip, square.getBoundingClientRect());
        }
      });
      square.addEventListener("mouseleave", hidePatternDateHoverTooltip);
    }
    parent.appendChild(square);
  };

  if (maxPerRow && states.length > maxPerRow) {
    container.classList.add("multiline");
    for (let i = 0; i < states.length; i += maxPerRow) {
      const row = document.createElement("span");
      row.className = "pattern-square-row";
      states.slice(i, i + maxPerRow).forEach((state, offset) => appendSquare(row, state, i + offset));
      container.appendChild(row);
    }
  } else {
    states.forEach((state, index) => appendSquare(container, state, index));
  }

  container.removeAttribute("title");
  container.setAttribute("aria-label", "Pattern");
  return container;
}

function formatSearchSongTitle(song) {
  const songName = String(song && (song.songName || song.title) ? (song.songName || song.title) : "—");
  const songNameRomaji = String(
    song && (
      song.songNameRomaji
      || song.songRomaji
      || song.songRomanji
    ) || ""
  ).trim();
  if (!songNameRomaji) return songName;
  if (songNameRomaji.toLowerCase() === songName.toLowerCase()) return songName;
  return `${songName} (${songNameRomaji})`;
}

function normalizeSearchSongText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function getSearchSongCandidates(song) {
  if (!song || typeof song !== "object") return [];

  const values = [];
  const pushIfText = raw => {
    const text = String(raw == null ? "" : raw).trim().toLowerCase();
    if (text) values.push(text);
  };

  pushIfText(song.anime);
  pushIfText(song.animeName);
  pushIfText(song.animeTitle);
  pushIfText(song.songName || song.title);
  pushIfText(song.artist);
  if (Array.isArray(song.artistAltNames)) {
    song.artistAltNames.forEach(pushIfText);
  }

  // Optional alternate fields (if present in generated search_songs.json).
  [
    "animeRomaji", "animeRomanji", "animeEnglish",
    "animeNative", "animeJapanese",
    "songNameRomaji", "titleRomaji", "titleEnglish",
    "songRomaji", "songRomanji"
  ].forEach(key => pushIfText(song[key]));

  if (Array.isArray(song.animeAltTitles)) {
    song.animeAltTitles.forEach(pushIfText);
  }
  if (Array.isArray(song.animeAliases)) {
    song.animeAliases.forEach(pushIfText);
  }
  if (Array.isArray(song.animeSynonyms)) {
    song.animeSynonyms.forEach(pushIfText);
  }
  collectLooseStringValues(song.animeAltName).forEach(pushIfText);
  collectLooseStringValues(song.animeAltNames).forEach(pushIfText);
  if (Array.isArray(song.altTitles)) {
    song.altTitles.forEach(pushIfText);
  }
  if (Array.isArray(song.aliases)) {
    song.aliases.forEach(pushIfText);
  }

  return [...new Set(values)];
}

function getSearchSongCandidatesByMode(song, mode) {
  const normalizedMode = String(mode || "all").toLowerCase();
  if (!song || typeof song !== "object") return [];
  if (normalizedMode === "all") return getSearchSongCandidates(song);

  const values = [];
  const pushIfText = raw => {
    const text = String(raw == null ? "" : raw).trim().toLowerCase();
    if (text) values.push(text);
  };

  if (normalizedMode === "anime") {
    pushIfText(song.anime);
    pushIfText(song.animeName);
    pushIfText(song.animeTitle);
    [
      "animeRomaji", "animeRomanji", "animeEnglish",
      "animeNative", "animeJapanese"
    ].forEach(key => pushIfText(song[key]));
    if (Array.isArray(song.animeAltTitles)) {
      song.animeAltTitles.forEach(pushIfText);
    }
    if (Array.isArray(song.animeAliases)) {
      song.animeAliases.forEach(pushIfText);
    }
    if (Array.isArray(song.animeSynonyms)) {
      song.animeSynonyms.forEach(pushIfText);
    }
    collectLooseStringValues(song.animeAltName).forEach(pushIfText);
    collectLooseStringValues(song.animeAltNames).forEach(pushIfText);
    return [...new Set(values)];
  }

  if (normalizedMode === "song") {
    pushIfText(song.songName || song.title);
    [
      "songNameRomaji", "titleRomaji", "titleEnglish",
      "songRomaji", "songRomanji"
    ].forEach(key => pushIfText(song[key]));
    if (Array.isArray(song.altTitles)) {
      song.altTitles.forEach(pushIfText);
    }
    if (Array.isArray(song.aliases)) {
      song.aliases.forEach(pushIfText);
    }
    return [...new Set(values)];
  }

  if (normalizedMode === "artist") {
    pushIfText(song.artist);
    if (Array.isArray(song.artistAltNames)) {
      song.artistAltNames.forEach(pushIfText);
    }
    return [...new Set(values)];
  }

  return getSearchSongCandidates(song);
}

function normalizeSearchSongsQueryValue(value) {
  return String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function hideSearchSongsSuggestions() {
  if (!searchSongsSuggestions) return;
  searchSongsSuggestions.style.display = "none";
  searchSongsSuggestions.innerHTML = "";
}

function getSearchSongsSuggestionPool() {
  if (String(searchSongsMode || "all").toLowerCase() === "off") {
    return [];
  }
  const songs = Array.isArray(cachedSearchSongs) ? cachedSearchSongs : [];
  const mode = String(searchSongsMode || "all").toLowerCase();
  const map = new Map();

  songs.forEach(song => {
    const values = getSearchSongCandidatesByMode(song, mode);
    values.forEach(value => {
      const rawText = String(value || "").trim();
      const key = rawText.toLowerCase();
      if (!key || !rawText) return;
      if (!map.has(key)) {
        map.set(key, { value: rawText, normalized: key, count: 0 });
      }
      map.get(key).count += 1;
    });
  });

  return [...map.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return String(a.normalized || a.value).localeCompare(String(b.normalized || b.value));
  });
}

function getSearchSongsSuggestions() {
  if (String(searchSongsMode || "all").toLowerCase() === "off") {
    return [];
  }
  const pool = getSearchSongsSuggestionPool();
  const normalizedQuery = normalizeSearchSongsQueryValue(searchSongsQuery);
  const compactQuery = normalizeSearchSongText(normalizedQuery);

  const matches = normalizedQuery
    ? pool.filter(entry => {
        const value = String(entry.value || "");
        const compact = normalizeSearchSongText(value);
        return value.includes(normalizedQuery) || compact.includes(compactQuery);
      })
    : pool;

  return matches.slice(0, 12);
}

function getSearchSongsPrefixSuggestion(rawTypedText) {
  if (String(searchSongsMode || "all").toLowerCase() === "off") {
    return null;
  }
  const typed = normalizeSearchSongsQueryValue(rawTypedText);
  if (!typed) return null;
  const pool = getSearchSongsSuggestionPool();
  const prefixMatch = pool.find(entry => String(entry.value || "").toLowerCase().startsWith(typed));
  if (prefixMatch) return prefixMatch;
  if (String(searchSongsMode || "all").toLowerCase() === "anime") {
    return pool.find(entry => String(entry.value || "").toLowerCase().includes(typed)) || null;
  }
  return null;
}

function renderSearchSongsInlineSuggestion() {
  if (!searchSongsInlineSuggestion || !searchSongsInput) return;
  if (String(searchSongsMode || "all").toLowerCase() === "off") {
    searchSongsInlineSuggestion.innerHTML = "";
    return;
  }
  const typed = String(searchSongsInput.value || "");
  const active = document.activeElement === searchSongsInput;
  if (!active || !typed.trim()) {
    searchSongsInlineSuggestion.innerHTML = "";
    return;
  }

  const suggestionEntry = getSearchSongsPrefixSuggestion(typed);
  if (!suggestionEntry) {
    searchSongsInlineSuggestion.innerHTML = "";
    return;
  }

  const suggestionValue = String(suggestionEntry.value || "");
  if (!suggestionValue || suggestionValue.toLowerCase() === typed.toLowerCase()) {
    searchSongsInlineSuggestion.innerHTML = "";
    return;
  }
  if (!suggestionValue.toLowerCase().startsWith(typed.toLowerCase())) {
    searchSongsInlineSuggestion.innerHTML = "";
    return;
  }

  const tail = suggestionValue.slice(typed.length);
  if (!tail) {
    searchSongsInlineSuggestion.innerHTML = "";
    return;
  }

  searchSongsInlineSuggestion.innerHTML = `<span class="search-inline-typed">${escapeHtml(typed)}</span><span class="search-inline-rest">${escapeHtml(tail)}</span>`;
}

function renderSearchSongsSuggestions() {
  if (!searchSongsSuggestions || !searchSongsInput) return;
  if (String(searchSongsMode || "all").toLowerCase() === "off") {
    renderSearchSongsInlineSuggestion();
    hideSearchSongsSuggestions();
    return;
  }
  const suggestions = getSearchSongsSuggestions();
  renderSearchSongsInlineSuggestion();
  if (!suggestions.length || document.activeElement !== searchSongsInput) {
    hideSearchSongsSuggestions();
    return;
  }

  searchSongsSuggestions.innerHTML = "";
  suggestions.forEach(entry => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-songs-suggestion-item";
    button.innerText = `${entry.value} (${entry.count})`;
    button.addEventListener("mousedown", event => {
      event.preventDefault();
      if (searchSongsInput) {
        searchSongsInput.value = entry.value;
      }
      searchSongsQuery = entry.value;
      applySearchSongsFilters();
    });
    searchSongsSuggestions.appendChild(button);
  });
  searchSongsSuggestions.style.display = "block";
}

function renderPerformanceGuessRate(records) {
  const buildRollingAverageSeries = (values, windowSize) => {
    return values.map((_, index) => {
      const start = Math.max(0, index - windowSize + 1);
      const windowValues = values.slice(start, index + 1).filter(value => Number.isFinite(value));
      if (!windowValues.length) {
        return null;
      }
      const total = windowValues.reduce((sum, value) => sum + value, 0);
      return total / windowValues.length;
    });
  };

  renderWeightedGuessRateChart(getVisibleUserData(fullUserData));

  if (!records.length) {
    if (combinedGuessAreaChart) {
      combinedGuessAreaChart.destroy();
      combinedGuessAreaChart = null;
    }
    if (guessRateRollingChart) {
      guessRateRollingChart.destroy();
      guessRateRollingChart = null;
    }
    const combinedMeta = document.getElementById("combinedFoundGames");
    if (combinedMeta) {
      combinedMeta.innerText = "Found 0 tours";
    }
    const rollingMeta = document.getElementById("rollingFoundGames");
    if (rollingMeta) {
      rollingMeta.innerText = "Found 0 tours";
    }
    return;
  }

  const labels = records.map(x => x.Timestamp);
  const opValues = records.map(x => Number(x["OP guess rate"]));
  const edValues = records.map(x => Number(x["ED guess rate"]));
  const inValues = records.map(x => Number(x["IN guess rate"]));
  const { slope: opSlope } = buildTrend(opValues);
  const { slope: edSlope } = buildTrend(edValues);
  const { slope: inSlope } = buildTrend(inValues);
  const { trend: opTrend } = buildTrend(opValues);
  const { trend: edTrend } = buildTrend(edValues);
  const { trend: inTrend } = buildTrend(inValues);

  document.getElementById("opFoundGames").innerText = `Found ${records.length} tours`;
  document.getElementById("edFoundGames").innerText = `Found ${records.length} tours`;
  document.getElementById("inFoundGames").innerText = `Found ${records.length} tours`;
  document.getElementById("combinedFoundGames").innerText = `Found ${records.length} tours`;
  document.getElementById("rollingFoundGames").innerText = `Found ${records.length} tours`;
  document.getElementById("mixFoundGames").innerText = `Found ${records.length} tours`;
  document.getElementById("opSlopeInfo").innerText = `Slope: ${opSlope >= 0 ? "+" : ""}${opSlope.toFixed(2)}% per game`;
  document.getElementById("edSlopeInfo").innerText = `Slope: ${edSlope >= 0 ? "+" : ""}${edSlope.toFixed(2)}% per game`;
  document.getElementById("inSlopeInfo").innerText = `Slope: ${inSlope >= 0 ? "+" : ""}${inSlope.toFixed(2)}% per game`;

  opGuessChart = renderTrendChart(
    opGuessChart,
    "opGuessChart",
    labels,
    opValues,
    "OP Guess Rate (%)",
    "OP guess rate (%)",
    { palette: PERFORMANCE_LINE_PALETTES.op, metaElementId: "opFoundGames", metaUnit: "tours" }
  );

  edGuessChart = renderTrendChart(
    edGuessChart,
    "edGuessChart",
    labels,
    edValues,
    "ED Guess Rate (%)",
    "ED guess rate (%)",
    { palette: PERFORMANCE_LINE_PALETTES.ed, metaElementId: "edFoundGames", metaUnit: "tours" }
  );

  inGuessChart = renderTrendChart(
    inGuessChart,
    "inGuessChart",
    labels,
    inValues,
    "Insert Guess Rate (%)",
    "Insert guess rate (%)",
    { palette: PERFORMANCE_LINE_PALETTES.insert, metaElementId: "inFoundGames", metaUnit: "tours" }
  );

  const combinedValues = [...opValues, ...edValues, ...inValues].filter(value => Number.isFinite(value));
  const combinedMin = combinedValues.length ? Math.min(...combinedValues) : 0;
  const combinedMax = combinedValues.length ? Math.max(...combinedValues) : 100;
  const combinedStep = combinedMax <= 25 ? 2.5 : (combinedMax <= 60 ? 5 : 10);
  const combinedYMax = Math.min(
    100,
    Math.ceil(Math.max(0, combinedMax) / combinedStep) * combinedStep
  );
  const combinedYMin = Math.max(0, Math.floor(Math.max(0, combinedMin) / combinedStep) * combinedStep);

  if (combinedGuessAreaChart) {
    if (typeof combinedGuessAreaChart.$trendZoomBrushCleanup === "function") {
      combinedGuessAreaChart.$trendZoomBrushCleanup();
    }
    combinedGuessAreaChart.destroy();
  }
  const combinedSeriesOpacityScale = getTimeSeriesOpacityScale(labels.length);

  combinedGuessAreaChart = new Chart(document.getElementById("combinedGuessAreaChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "OP Guess Rate (%)",
          data: opValues,
          borderColor: withSeriesOpacity("rgba(47, 109, 246, 0.40)", combinedSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(47, 109, 246, 0.06)", combinedSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "rgba(47, 109, 246, 0.40)",
            backgroundColor: "rgba(47, 109, 246, 0.06)",
            pointBorderColor: "rgba(255, 255, 255, 0.52)"
          },
          borderWidth: 1.3,
          pointRadius: 1.2,
          pointHoverRadius: 2.8,
          pointBorderWidth: 0.8,
          pointBorderColor: withSeriesOpacity("rgba(255, 255, 255, 0.52)", combinedSeriesOpacityScale),
          order: 8,
          fill: false,
          tension: 0,
          spanGaps: true
        },
        {
          label: "OP Trend",
          data: opTrend,
          borderColor: "#2f6df6",
          borderDash: [8, 6],
          borderWidth: 3.2,
          pointRadius: 0,
          pointHoverRadius: 0,
          order: 30,
          fill: false,
          tension: 0,
          spanGaps: true
        },
        {
          label: "ED Guess Rate (%)",
          data: edValues,
          borderColor: withSeriesOpacity("rgba(16, 185, 129, 0.40)", combinedSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(16, 185, 129, 0.06)", combinedSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "rgba(16, 185, 129, 0.40)",
            backgroundColor: "rgba(16, 185, 129, 0.06)",
            pointBorderColor: "rgba(255, 255, 255, 0.52)"
          },
          borderWidth: 1.3,
          pointRadius: 1.2,
          pointHoverRadius: 2.8,
          pointBorderWidth: 0.8,
          pointBorderColor: withSeriesOpacity("rgba(255, 255, 255, 0.52)", combinedSeriesOpacityScale),
          order: 8,
          fill: false,
          tension: 0,
          spanGaps: true
        },
        {
          label: "ED Trend",
          data: edTrend,
          borderColor: "#10b981",
          borderDash: [8, 6],
          borderWidth: 3.2,
          pointRadius: 0,
          pointHoverRadius: 0,
          order: 30,
          fill: false,
          tension: 0,
          spanGaps: true
        },
        {
          label: "Insert Guess Rate (%)",
          data: inValues,
          borderColor: withSeriesOpacity("rgba(245, 158, 11, 0.40)", combinedSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(245, 158, 11, 0.06)", combinedSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "rgba(245, 158, 11, 0.40)",
            backgroundColor: "rgba(245, 158, 11, 0.06)",
            pointBorderColor: "rgba(255, 255, 255, 0.52)"
          },
          borderWidth: 1.3,
          pointRadius: 1.2,
          pointHoverRadius: 2.8,
          pointBorderWidth: 0.8,
          pointBorderColor: withSeriesOpacity("rgba(255, 255, 255, 0.52)", combinedSeriesOpacityScale),
          order: 8,
          fill: false,
          tension: 0,
          spanGaps: true
        },
        {
          label: "Insert Trend",
          data: inTrend,
          borderColor: "#f59e0b",
          borderDash: [8, 6],
          borderWidth: 3.2,
          pointRadius: 0,
          pointHoverRadius: 0,
          order: 30,
          fill: false,
          tension: 0,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#314155",
            font: { size: 12, weight: "600" }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          multiKeyBackground: "transparent",
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          callbacks: {
            label: function(context) {
              const raw = Number(context.raw);
              return Number.isFinite(raw)
                ? `${context.dataset.label}: ${raw.toFixed(2)}%`
                : `${context.dataset.label}: N/A`;
            },
            labelColor: function(context) {
              const color = context.dataset && context.dataset.borderColor
                ? context.dataset.borderColor
                : "#94a3b8";
              return {
                borderColor: "transparent",
                backgroundColor: color
              };
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#5d7087",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: true,
            maxTicksLimit: 12
          },
          grid: { color: "rgba(148, 163, 184, 0.28)" }
        },
        y: {
          min: combinedYMin,
          max: combinedYMax,
          title: {
            display: true,
            text: "Guess rate (%)",
            color: "#314155",
            font: { size: 13, weight: "bold" }
          },
          ticks: {
            color: "#5d7087",
            stepSize: combinedStep,
            callback: function(value) {
              return `${Number(value).toFixed(combinedStep % 1 ? 1 : 0)}%`;
            }
          },
          grid: { color: "rgba(148, 163, 184, 0.24)" }
        }
      }
    }
  });
  attachTrendZoomBrush(combinedGuessAreaChart, "combinedGuessAreaChart", labels.length, {
    metaElement: document.getElementById("combinedFoundGames"),
    metaUnit: "tours"
  });

  const perGameGuessRateValues = records.map(row => {
    const values = [
      Number(row["OP guess rate"]),
      Number(row["ED guess rate"]),
      Number(row["IN guess rate"])
    ].filter(value => Number.isFinite(value));
    if (!values.length) {
      return null;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  });
  const rolling3Values = buildRollingAverageSeries(perGameGuessRateValues, 3);
  const rolling5Values = buildRollingAverageSeries(perGameGuessRateValues, 5);
  const hideStaticPoints = true;
  const overviewHoverPointRadius = 5;
  const rollingAllValues = [...rolling3Values, ...rolling5Values].filter(value => Number.isFinite(value));
  const rollingMin = rollingAllValues.length ? Math.min(...rollingAllValues) : 0;
  const rollingMax = rollingAllValues.length ? Math.max(...rollingAllValues) : 100;
  const rollingRange = rollingMax - rollingMin;
  const rollingPadding = Math.max(1, rollingRange * 0.15);
  let rollingYMin = Math.max(0, rollingMin - rollingPadding);
  let rollingYMax = Math.min(100, rollingMax + rollingPadding);
  if (rollingYMax - rollingYMin < 4) {
    const center = (rollingYMin + rollingYMax) / 2;
    rollingYMin = Math.max(0, center - 2);
    rollingYMax = Math.min(100, center + 2);
  }
  const getNiceStep = rawStep => {
    if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
    const exponent = Math.floor(Math.log10(rawStep));
    const base = Math.pow(10, exponent);
    const normalized = rawStep / base;
    if (normalized <= 1) return 1 * base;
    if (normalized <= 2) return 2 * base;
    if (normalized <= 5) return 5 * base;
    return 10 * base;
  };
  const rollingStep = Math.max(1, getNiceStep((rollingYMax - rollingYMin) / 6));
  rollingYMin = Math.max(0, Math.floor(rollingYMin / rollingStep) * rollingStep);
  rollingYMax = Math.min(100, Math.ceil(rollingYMax / rollingStep) * rollingStep);
  if (rollingYMax <= rollingYMin) {
    rollingYMax = Math.min(100, rollingYMin + rollingStep * 2);
  }

  if (guessRateRollingChart) {
    if (typeof guessRateRollingChart.$trendZoomBrushCleanup === "function") {
      guessRateRollingChart.$trendZoomBrushCleanup();
    }
    guessRateRollingChart.destroy();
  }
  const rollingSeriesOpacityScale = getTimeSeriesOpacityScale(labels.length);

  guessRateRollingChart = new Chart(document.getElementById("guessRateRollingChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "3-game rolling avg (%)",
          data: rolling3Values,
          borderColor: withSeriesOpacity("#2563eb", rollingSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(37, 99, 235, 0.10)", rollingSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.10)",
            pointBorderColor: "rgba(255, 255, 255, 0.62)"
          },
          borderWidth: 2.5,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 1.8,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 3.8,
          pointHitRadius: 12,
          pointBorderWidth: 0.8,
          pointBorderColor: withSeriesOpacity("rgba(255, 255, 255, 0.62)", rollingSeriesOpacityScale),
          fill: false,
          tension: 0.15,
          spanGaps: true
        },
        {
          label: "5-game rolling avg (%)",
          data: rolling5Values,
          borderColor: withSeriesOpacity("#0f766e", rollingSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(15, 118, 110, 0.10)", rollingSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "#0f766e",
            backgroundColor: "rgba(15, 118, 110, 0.10)",
            pointBorderColor: "rgba(255, 255, 255, 0.62)"
          },
          borderWidth: 2.5,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 1.8,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 3.8,
          pointHitRadius: 12,
          pointBorderWidth: 0.8,
          pointBorderColor: withSeriesOpacity("rgba(255, 255, 255, 0.62)", rollingSeriesOpacityScale),
          fill: false,
          tension: 0.15,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#314155",
            font: { size: 12, weight: "600" }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          callbacks: {
            label: function(context) {
              const raw = Number(context.raw);
              return Number.isFinite(raw)
                ? `${context.dataset.label}: ${raw.toFixed(2)}%`
                : `${context.dataset.label}: N/A`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#5d7087",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: true,
            maxTicksLimit: 12
          },
          grid: { color: "rgba(148, 163, 184, 0.28)" }
        },
        y: {
          min: rollingYMin,
          max: rollingYMax,
          title: {
            display: true,
            text: "Guess rate (%)",
            color: "#314155",
            font: { size: 13, weight: "bold" }
          },
          ticks: {
            color: "#5d7087",
            stepSize: rollingStep,
            callback: function(value) {
              return `${Number(value).toFixed(rollingStep % 1 ? 1 : 0)}%`;
            }
          },
          grid: { color: "rgba(148, 163, 184, 0.24)" }
        }
      }
    }
  });
  attachTrendZoomBrush(guessRateRollingChart, "guessRateRollingChart", labels.length, {
    metaElement: document.getElementById("rollingFoundGames"),
    metaUnit: "tours"
  });

  const opAverage = opValues.reduce((sum, value) => sum + value, 0) / opValues.length;
  const edAverage = edValues.reduce((sum, value) => sum + value, 0) / edValues.length;
  const inAverage = inValues.reduce((sum, value) => sum + value, 0) / inValues.length;
  const opEdValues = records.map(row => (Number(row["OP guess rate"]) + Number(row["ED guess rate"])) / 2);
  const edInValues = records.map(row => (Number(row["ED guess rate"]) + Number(row["IN guess rate"])) / 2);
  const opInValues = records.map(row => (Number(row["OP guess rate"]) + Number(row["IN guess rate"])) / 2);
  const opEdAverage = opEdValues.reduce((sum, value) => sum + value, 0) / opEdValues.length;
  const edInAverage = edInValues.reduce((sum, value) => sum + value, 0) / edInValues.length;
  const opInAverage = opInValues.reduce((sum, value) => sum + value, 0) / opInValues.length;
  const mixValues = [
    opAverage,
    opEdAverage,
    edAverage,
    edInAverage,
    inAverage,
    opInAverage
  ];
  const mixScale = buildRadarScale(mixValues);

  if (guessRateMixRadarChart) {
    guessRateMixRadarChart.destroy();
  }

  guessRateMixRadarChart = new Chart(document.getElementById("guessRateMixRadarChart"), {
    type: "radar",
    data: {
      labels: ["OP", "OP + ED", "ED", "ED + IN", "IN", "OP + IN"],
      datasets: [
        {
          label: "Average Guess Rate (%)",
          data: mixValues,
          borderColor: "#d946ef",
          backgroundColor: "rgba(217, 70, 239, 0.20)",
          pointBackgroundColor: "#d946ef",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 0,
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#314155",
            font: { size: 12, weight: "600" }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${Number(context.raw).toFixed(2)}%`;
            }
          }
        }
      },
      scales: {
        r: {
          beginAtZero: true,
          min: mixScale.min,
          max: mixScale.max,
          ticks: {
            stepSize: mixScale.stepSize,
            precision: 0,
            color: "#5d7087",
            backdropColor: "transparent",
            callback: function(value) {
              return String(Math.round(Number(value)));
            }
          },
          grid: { color: "rgba(148, 163, 184, 0.25)", circular: false },
          angleLines: { color: "rgba(148, 163, 184, 0.28)" },
          pointLabels: {
            color: "#334a62",
            font: { size: 12, weight: "600" }
          }
        }
      }
    }
  });

}

function renderGuessRateVsAvg8Chart(records) {
  const guessVsAvg8Meta = document.getElementById("guessVsAvg8FoundGames");
  if (guessVsAvg8Meta) {
    guessVsAvg8Meta.innerText = `Found ${records.length} tours`;
  }

  const labels = records.map(x => x.Timestamp);
  const hideStaticPoints = true;
  const overviewHoverPointRadius = 5;
  const isGuessVsAvg8PercentageMode = overviewDataMode === "percentage";
  const guessRateValues = records.map(row => {
    const value = resolveNumericMetricValue(row, "Guess rate");
    return Number.isFinite(value) ? value : null;
  });
  const avg8Values = records.map(row => {
    const keys = ["avg/8 of your rigs", "avg/8", "Avg/8 of your rigs", "Avg/8"];
    for (const key of keys) {
      const value = Number(row && row[key]);
      if (Number.isFinite(value)) {
        return isGuessVsAvg8PercentageMode ? value * 12.5 : value;
      }
    }
    return null;
  });
  const { trend: guessRateTrendValues } = buildTrend(
    guessRateValues.map(value => Number.isFinite(value) ? value : 0)
  );
  const { trend: avg8TrendValues } = buildTrend(
    avg8Values.map(value => Number.isFinite(value) ? value : 0)
  );
  const finiteGuessRateValues = guessRateValues.filter(value => Number.isFinite(value));
  const guessRateMinValue = finiteGuessRateValues.length ? Math.min(...finiteGuessRateValues) : 0;
  const guessRateMaxValue = finiteGuessRateValues.length ? Math.max(...finiteGuessRateValues) : 0;
  const guessRateRange = guessRateMaxValue - guessRateMinValue;
  const guessRatePadding = Math.max(1, guessRateRange * 0.2);
  const rawGuessRateMax = Math.min(100, guessRateMaxValue + guessRatePadding);
  const guessRateTickStep = rawGuessRateMax <= 30 ? 5 : 10;
  const guessRateAxisMax = Math.max(
    guessRateTickStep,
    Math.ceil(rawGuessRateMax / guessRateTickStep) * guessRateTickStep
  );

  const finiteAvg8Values = avg8Values.filter(value => Number.isFinite(value));
  const avg8MaxValue = finiteAvg8Values.length ? Math.max(...finiteAvg8Values) : 0;
  let avg8AxisMax;
  let avg8TickStep;
  if (isGuessVsAvg8PercentageMode) {
    const rawAvg8PercentMax = Math.min(100, avg8MaxValue + 5);
    avg8TickStep = rawAvg8PercentMax <= 30 ? 5 : 10;
    avg8AxisMax = Math.max(
      avg8TickStep,
      Math.ceil(rawAvg8PercentMax / avg8TickStep) * avg8TickStep
    );
  } else {
    avg8AxisMax = Math.max(1, Math.min(8, Math.ceil((avg8MaxValue + 0.25) / 0.5) * 0.5));
    avg8TickStep = avg8AxisMax <= 3 ? 0.25 : 0.5;
  }

  if (guessRateVsAvg8Chart) {
    if (typeof guessRateVsAvg8Chart.$trendZoomBrushCleanup === "function") {
      guessRateVsAvg8Chart.$trendZoomBrushCleanup();
    }
    guessRateVsAvg8Chart.destroy();
  }
  const guessVsAvgSeriesOpacityScale = getTimeSeriesOpacityScale(labels.length);

  guessRateVsAvg8Chart = new Chart(document.getElementById("guessRateVsAvg8Chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Guess Rate (%)",
          data: guessRateValues,
          yAxisID: "yGuessRate",
          borderColor: withSeriesOpacity("#2563eb", guessVsAvgSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(37, 99, 235, 0.15)", guessVsAvgSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.15)"
          },
          borderWidth: 1.8,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 2.2,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 4.6,
          pointHitRadius: 12,
          order: 10,
          spanGaps: true,
          tension: 0
        },
        {
          label: "Guess Rate Trend",
          data: guessRateTrendValues,
          yAxisID: "yGuessRate",
          borderColor: "#1d4ed8",
          borderDash: [8, 6],
          order: 30,
          borderWidth: 3.2,
          pointRadius: 0,
          pointHoverRadius: 0,
          spanGaps: true,
          tension: 0
        },
        {
          label: isGuessVsAvg8PercentageMode ? "Avg/8 (%)" : "Avg/8",
          data: avg8Values,
          yAxisID: "yAvg8",
          borderColor: withSeriesOpacity("#f97316", guessVsAvgSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(249, 115, 22, 0.15)", guessVsAvgSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "#f97316",
            backgroundColor: "rgba(249, 115, 22, 0.15)"
          },
          borderWidth: 1.8,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 2.2,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 4.6,
          pointHitRadius: 12,
          order: 11,
          spanGaps: true,
          tension: 0
        },
        {
          label: isGuessVsAvg8PercentageMode ? "Avg/8 Trend (%)" : "Avg/8 Trend",
          data: avg8TrendValues,
          yAxisID: "yAvg8",
          borderColor: "#c2410c",
          borderDash: [8, 6],
          order: 31,
          borderWidth: 3.2,
          pointRadius: 0,
          pointHoverRadius: 0,
          spanGaps: true,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#314155",
            font: { size: 12, weight: "600" }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          multiKeyBackground: "transparent",
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          callbacks: {
            label: function(context) {
              const label = String((context.dataset && context.dataset.label) || "");
              const value = Number(context.raw);
              if (!Number.isFinite(value)) return `${label}: N/A`;
              if (label.includes("Guess Rate")) return `${label}: ${value.toFixed(2)}%`;
              if (isGuessVsAvg8PercentageMode) return `${label}: ${value.toFixed(2)}%`;
              return `${label}: ${value.toFixed(3)}`;
            },
            labelColor: function(context) {
              const color = context.dataset && context.dataset.borderColor
                ? context.dataset.borderColor
                : "#94a3b8";
              return {
                borderColor: "transparent",
                backgroundColor: color
              };
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#5d7087",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: true,
            maxTicksLimit: 12
          },
          grid: { color: "rgba(148, 163, 184, 0.28)" }
        },
        yGuessRate: {
          type: "linear",
          position: "left",
          beginAtZero: true,
          min: 0,
          max: guessRateAxisMax,
          title: {
            display: true,
            text: "Guess rate (%)",
            color: "#314155",
            font: { size: 13, weight: "bold" }
          },
          ticks: {
            color: "#5d7087",
            stepSize: guessRateTickStep,
            callback: function(value) {
              return `${Number(value).toFixed(1)}%`;
            }
          },
          grid: { color: "rgba(148, 163, 184, 0.24)" }
        },
        yAvg8: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          min: 0,
          max: avg8AxisMax,
          title: {
            display: true,
            text: isGuessVsAvg8PercentageMode ? "Avg/8 (%)" : "Avg/8",
            color: "#314155",
            font: { size: 13, weight: "bold" }
          },
          ticks: {
            color: "#5d7087",
            stepSize: avg8TickStep,
            callback: function(value) {
              return isGuessVsAvg8PercentageMode
                ? `${Number(value).toFixed(1)}%`
                : Number(value).toFixed(2);
            }
          },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
  attachTrendZoomBrush(guessRateVsAvg8Chart, "guessRateVsAvg8Chart", labels.length, {
    metaElement: document.getElementById("guessVsAvg8FoundGames"),
    metaUnit: "tours"
  });
}

function renderPerformanceLivesTakenSaved(records) {
  if (!records.length) return;

  const livesCutoffTs = new Date("2026-01-01T00:00:00").getTime();
  const filteredRecords = records.filter(row => (
    getSortableTimestampValue(row && row.Timestamp) >= livesCutoffTs
  ));

  if (!filteredRecords.length) {
    document.getElementById("takenFoundGames").innerText = "Found 0 tours";
    document.getElementById("savedFoundGames").innerText = "Found 0 tours";
    document.getElementById("takenSlopeInfo").innerText = "Slope: 0.00% per game";
    document.getElementById("savedSlopeInfo").innerText = "Slope: 0.00% per game";
    if (takenLivesChart) {
      takenLivesChart.destroy();
      takenLivesChart = null;
    }
    if (savedLivesChart) {
      savedLivesChart.destroy();
      savedLivesChart = null;
    }
    return;
  }

  const labels = filteredRecords.map(x => x.Timestamp);
  const takenValues = filteredRecords.map(x => Number(x["Lives taken"]));
  const savedValues = filteredRecords.map(x => Number(x["Lives saved"]));
  const { slope: takenSlope } = buildTrend(takenValues);
  const { slope: savedSlope } = buildTrend(savedValues);

  document.getElementById("takenFoundGames").innerText = `Found ${filteredRecords.length} tours`;
  document.getElementById("savedFoundGames").innerText = `Found ${filteredRecords.length} tours`;
  document.getElementById("takenSlopeInfo").innerText = `Slope: ${takenSlope >= 0 ? "+" : ""}${takenSlope.toFixed(2)}% per game`;
  document.getElementById("savedSlopeInfo").innerText = `Slope: ${savedSlope >= 0 ? "+" : ""}${savedSlope.toFixed(2)}% per game`;

  takenLivesChart = renderTrendChart(
    takenLivesChart,
    "takenLivesChart",
    labels,
    takenValues,
    "Lives Taken",
    "Lives taken",
    {
      suffix: "",
      decimals: 0,
      integerTicks: true,
      palette: PERFORMANCE_LINE_PALETTES.taken,
      metaElementId: "takenFoundGames",
      metaUnit: "tours"
    }
  );

  savedLivesChart = renderTrendChart(
    savedLivesChart,
    "savedLivesChart",
    labels,
    savedValues,
    "Lives Saved",
    "Lives saved",
    {
      suffix: "",
      decimals: 0,
      integerTicks: true,
      palette: PERFORMANCE_LINE_PALETTES.saved,
      metaElementId: "savedFoundGames",
      metaUnit: "tours"
    }
  );
}

function getFirstFiniteNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function renderPerformanceRigAnalysis(records) {
  if (!records.length) return;

  const labels = records.map(x => x.Timestamp);
  const onlistValues = records.map(row => {
    const resolved = resolveNumericMetricValue(row, "Onlist");
    return Number.isFinite(resolved) ? resolved : 0;
  });
  const offlistValues = records.map(row => {
    const resolved = resolveNumericMetricValue(row, "Offlist");
    return Number.isFinite(resolved) ? resolved : 0;
  });
  const { slope: onlistSlope } = buildTrend(onlistValues);
  const { slope: offlistSlope } = buildTrend(offlistValues);

  const onlistFoundGames = document.getElementById("onlistFoundGames");
  const onlistSlopeInfo = document.getElementById("onlistSlopeInfo");
  const offlistFoundGames = document.getElementById("offlistFoundGames");
  const offlistSlopeInfo = document.getElementById("offlistSlopeInfo");
  if (onlistFoundGames) onlistFoundGames.innerText = `Found ${records.length} tours`;
  if (onlistSlopeInfo) onlistSlopeInfo.innerText = `Slope: ${onlistSlope >= 0 ? "+" : ""}${onlistSlope.toFixed(2)}% per game`;
  if (offlistFoundGames) offlistFoundGames.innerText = `Found ${records.length} tours`;
  if (offlistSlopeInfo) offlistSlopeInfo.innerText = `Slope: ${offlistSlope >= 0 ? "+" : ""}${offlistSlope.toFixed(2)}% per game`;

  onlistAnalysisChart = renderTrendChart(
    onlistAnalysisChart,
    "onlistAnalysisChart",
    labels,
    onlistValues,
    "Onlist guess rate",
    "Onlist guess rate (%)",
    {
      suffix: "%",
      decimals: 2,
      palette: PERFORMANCE_LINE_PALETTES.op,
      metaElementId: "onlistFoundGames",
      metaUnit: "tours"
    }
  );

  offlistAnalysisChart = renderTrendChart(
    offlistAnalysisChart,
    "offlistAnalysisChart",
    labels,
    offlistValues,
    "Offlist guess rate",
    "Offlist guess rate (%)",
    {
      suffix: "%",
      decimals: 2,
      palette: PERFORMANCE_LINE_PALETTES.insert,
      metaElementId: "offlistFoundGames",
      metaUnit: "tours"
    }
  );
}

function renderPerformanceRigsMissed(records) {
  const metricConfigs = [
    {
      field: "OP Rigs Missed",
      canvasId: "opRigsMissedChart",
      metaId: "opRigsMissedFoundGames",
      slopeId: "opRigsMissedSlopeInfo",
      label: "OP Rigs Missed",
      palette: PERFORMANCE_LINE_PALETTES.op,
      getChart: () => opRigsMissedChart,
      setChart: chart => { opRigsMissedChart = chart; }
    },
    {
      field: "ED Rigs Missed",
      canvasId: "edRigsMissedChart",
      metaId: "edRigsMissedFoundGames",
      slopeId: "edRigsMissedSlopeInfo",
      label: "ED Rigs Missed",
      palette: PERFORMANCE_LINE_PALETTES.ed,
      getChart: () => edRigsMissedChart,
      setChart: chart => { edRigsMissedChart = chart; }
    },
    {
      field: "IN Rigs Missed",
      canvasId: "inRigsMissedChart",
      metaId: "inRigsMissedFoundGames",
      slopeId: "inRigsMissedSlopeInfo",
      label: "IN Rigs Missed",
      palette: PERFORMANCE_LINE_PALETTES.insert,
      getChart: () => inRigsMissedChart,
      setChart: chart => { inRigsMissedChart = chart; }
    }
  ];

  const destroyChartForConfig = config => {
    const chart = config.getChart();
    if (chart) {
      if (typeof chart.$trendZoomBrushCleanup === "function") {
        chart.$trendZoomBrushCleanup();
      }
      chart.destroy();
      config.setChart(null);
    }
  };

  if (!records.length) {
    metricConfigs.forEach(config => {
      const metaEl = document.getElementById(config.metaId);
      const slopeEl = document.getElementById(config.slopeId);
      if (metaEl) metaEl.innerText = "Found 0 tours";
      if (slopeEl) slopeEl.innerText = "Slope: 0.00 per game";
      destroyChartForConfig(config);
    });
    return;
  }

  metricConfigs.forEach(config => {
    const availablePoints = records.map(row => {
      const resolved = resolveNumericMetricValue(row, config.field);
      return Number.isFinite(resolved)
        ? { label: row.Timestamp, value: resolved }
        : null;
    }).filter(point => point != null);
    const metaEl = document.getElementById(config.metaId);
    const slopeEl = document.getElementById(config.slopeId);
    if (!availablePoints.length) {
      if (metaEl) metaEl.innerText = "Found 0 tours";
      if (slopeEl) slopeEl.innerText = "Slope: 0.00 per game";
      destroyChartForConfig(config);
      return;
    }

    const labels = availablePoints.map(point => point.label);
    const values = availablePoints.map(point => point.value);
    const { slope } = buildTrend(values);
    if (metaEl) metaEl.innerText = `Found ${availablePoints.length} tours`;
    if (slopeEl) slopeEl.innerText = `Slope: ${slope >= 0 ? "+" : ""}${slope.toFixed(2)} per game`;

    config.setChart(renderTrendChart(
      config.getChart(),
      config.canvasId,
      labels,
      values,
      config.label,
      config.label,
      {
        suffix: "",
        decimals: 0,
        integerTicks: true,
        palette: config.palette,
        metaElementId: config.metaId,
        metaUnit: "tours"
      }
    ));
  });
}

function renderPerformanceCompositeCharts(records) {
  if (!records.length) {
    const rigFoundGames = document.getElementById("rigFoundGames");
    const rigSlopeInfo = document.getElementById("rigSlopeInfo");
    const rigHitSlopeInfo = document.getElementById("rigHitSlopeInfo");
    const guessVsAvg8Meta = document.getElementById("guessVsAvg8FoundGames");
    if (rigFoundGames) rigFoundGames.innerText = "Found 0 tours";
    if (rigSlopeInfo) rigSlopeInfo.innerText = "Rigs slope: 0.00% per game";
    if (rigHitSlopeInfo) rigHitSlopeInfo.innerText = "Total hit slope: 0.00% per game";
    if (guessVsAvg8Meta) guessVsAvg8Meta.innerText = "Found 0 tours";
    if (rigAnalysisChart) {
      if (typeof rigAnalysisChart.$trendZoomBrushCleanup === "function") {
        rigAnalysisChart.$trendZoomBrushCleanup();
      }
      rigAnalysisChart.destroy();
      rigAnalysisChart = null;
    }
    if (guessRateVsAvg8Chart) {
      guessRateVsAvg8Chart.destroy();
      guessRateVsAvg8Chart = null;
    }
    return;
  }

  const labels = records.map(x => x.Timestamp);
  const hideStaticPoints = true;
  const overviewHoverPointRadius = 5;
  const rigCountValues = records.map(row => getFirstFiniteNumber(row, ["Rigs", "Rig count", "rig count", "rigs"]));
  const totalSongsHitValues = records.map(row => getFirstFiniteNumber(row, ["Total hit", "total songs hit", "Total songs hit", "total hit"]));
  const { trend: rigTrend, slope: rigSlope } = buildTrend(rigCountValues);
  const { trend: totalHitTrend, slope: totalHitSlope } = buildTrend(totalSongsHitValues);

  const rigFoundGames = document.getElementById("rigFoundGames");
  const rigSlopeInfo = document.getElementById("rigSlopeInfo");
  const rigHitSlopeInfo = document.getElementById("rigHitSlopeInfo");
  if (rigFoundGames) rigFoundGames.innerText = `Found ${records.length} tours`;
  if (rigSlopeInfo) rigSlopeInfo.innerText = `Rigs slope: ${rigSlope >= 0 ? "+" : ""}${rigSlope.toFixed(2)}% per game`;
  if (rigHitSlopeInfo) rigHitSlopeInfo.innerText = `Total hit slope: ${totalHitSlope >= 0 ? "+" : ""}${totalHitSlope.toFixed(2)}% per game`;

  if (rigAnalysisChart) {
    if (typeof rigAnalysisChart.$trendZoomBrushCleanup === "function") {
      rigAnalysisChart.$trendZoomBrushCleanup();
    }
    rigAnalysisChart.destroy();
  }
  const rigSeriesOpacityScale = getTimeSeriesOpacityScale(labels.length);

  rigAnalysisChart = new Chart(document.getElementById("rigAnalysisChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Rig count",
          data: rigCountValues,
          borderColor: withSeriesOpacity("#8b5cf6", rigSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(139, 92, 246, 0.16)", rigSeriesOpacityScale),
          pointBackgroundColor: withSeriesOpacity("#8b5cf6", rigSeriesOpacityScale),
          pointBorderColor: withSeriesOpacity("#ffffff", rigSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "#8b5cf6",
            backgroundColor: "rgba(139, 92, 246, 0.16)",
            pointBackgroundColor: "#8b5cf6",
            pointBorderColor: "#ffffff"
          },
          pointBorderWidth: 1.3,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 2.4,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 5,
          pointHitRadius: 12,
          order: 10,
          borderWidth: 1.8,
          tension: 0,
          fill: false
        },
        {
          label: "Rig count trend",
          data: rigTrend,
          borderColor: "#6b7f99",
          borderDash: [8, 6],
          order: 30,
          borderWidth: 3.0,
          pointRadius: 0,
          tension: 0,
          fill: false
        },
        {
          label: "Total songs hit",
          data: totalSongsHitValues,
          borderColor: withSeriesOpacity("#0ea5e9", rigSeriesOpacityScale),
          backgroundColor: withSeriesOpacity("rgba(14, 165, 233, 0.15)", rigSeriesOpacityScale),
          pointBackgroundColor: withSeriesOpacity("#0ea5e9", rigSeriesOpacityScale),
          pointBorderColor: withSeriesOpacity("#ffffff", rigSeriesOpacityScale),
          _opacityBaseStyles: {
            borderColor: "#0ea5e9",
            backgroundColor: "rgba(14, 165, 233, 0.15)",
            pointBackgroundColor: "#0ea5e9",
            pointBorderColor: "#ffffff"
          },
          pointBorderWidth: 1.3,
          pointRadius: hideStaticPoints
            ? (context => (context && context.active ? overviewHoverPointRadius : 0))
            : 2.4,
          pointHoverRadius: hideStaticPoints ? overviewHoverPointRadius : 5,
          pointHitRadius: 12,
          order: 11,
          borderWidth: 1.8,
          tension: 0,
          fill: false
        },
        {
          label: "Total songs hit trend",
          data: totalHitTrend,
          borderColor: "#6b7f99",
          borderDash: [8, 6],
          order: 31,
          borderWidth: 3.0,
          pointRadius: 0,
          tension: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "#314155",
            font: { size: 12, weight: "600" }
          }
        },
        tooltip: {
          backgroundColor: "rgba(17, 26, 40, 0.94)",
          borderColor: "rgba(148, 163, 184, 0.28)",
          borderWidth: 1,
          padding: 10,
          titleColor: "#e5edf7",
          bodyColor: "#d8e4f3",
          multiKeyBackground: "transparent",
          callbacks: {
            labelColor: function(context) {
              const color = context.dataset.borderColor || "#93c5fd";
              return {
                borderColor: "transparent",
                backgroundColor: color,
                borderWidth: 0,
                borderRadius: 0
              };
            },
            label: function(context) {
              const value = Number(context.raw);
              const label = String((context.dataset && context.dataset.label) || "");
              const isCountSeries = label === "Rig count" || label === "Total songs hit";
              const formattedValue = Number.isFinite(value)
                ? (isCountSeries ? String(Math.round(value)) : value.toFixed(2))
                : "0";
              return `${label}: ${formattedValue}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#5d7087",
            maxRotation: 45,
            minRotation: 45,
            autoSkip: true,
            maxTicksLimit: 12
          },
          grid: {
            color: "rgba(148, 163, 184, 0.28)"
          }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "Count",
            color: "#314155",
            font: { size: 13, weight: "bold" }
          },
          ticks: {
            color: "#5d7087"
          },
          grid: {
            color: "rgba(148, 163, 184, 0.24)"
          }
        }
      }
    }
  });
  attachTrendZoomBrush(rigAnalysisChart, "rigAnalysisChart", labels.length, {
    metaElement: document.getElementById("rigFoundGames"),
    metaUnit: "tours"
  });

  renderGuessRateVsAvg8Chart(records);
}

function renderOverview(records, latestRankOverride = null, latestRankPercentileOverride = null, latestRankIsTopThreeOverride = false, allRecordsOverride = null) {
  const songCounters = computeOverviewSongsSeenAndGotten();
  const songsSeenEl = document.getElementById("overviewSongsSeen");
  const songsGottenEl = document.getElementById("overviewSongsGotten");
  if (songsSeenEl) songsSeenEl.innerText = String(songCounters.seen);
  if (songsGottenEl) songsGottenEl.innerText = String(songCounters.gotten);

  const momentumEl = document.getElementById("overviewMomentum");
  const momentumSourceRows = Array.isArray(allRecordsOverride) && allRecordsOverride.length
    ? allRecordsOverride
    : (Array.isArray(fullUserData) && fullUserData.length ? fullUserData : records);
  const momentumGuessValues = momentumSourceRows
    .map(row => Number(row && row["Guess rate"]))
    .filter(value => Number.isFinite(value));
  const shortWindowValues = momentumGuessValues.slice(-MOMENTUM_SHORT_WINDOW);
  const longWindowValues = momentumGuessValues.slice(-MOMENTUM_LONG_WINDOW);
  let momentumValue = null;
  if (shortWindowValues.length && longWindowValues.length) {
    const shortAverage = shortWindowValues.reduce((sum, value) => sum + value, 0) / shortWindowValues.length;
    const longAverage = longWindowValues.reduce((sum, value) => sum + value, 0) / longWindowValues.length;
    momentumValue = shortAverage - longAverage;
  }
  if (momentumEl) {
    const momentumPrefix = Number.isFinite(momentumValue) && momentumValue >= 0 ? "+" : "";
    momentumEl.innerText = Number.isFinite(momentumValue)
      ? `${momentumPrefix}${momentumValue.toFixed(3)}%`
      : "-";
  }

  const consistencyEl = document.getElementById("overviewConsistency");
  const consistencyWindowValues = momentumGuessValues.slice(-CONSISTENCY_WINDOW);
  let consistencyValue = null;
  if (consistencyWindowValues.length > 1) {
    const mean = consistencyWindowValues.reduce((sum, value) => sum + value, 0) / consistencyWindowValues.length;
    const variance = consistencyWindowValues.reduce((sum, value) => {
      const delta = value - mean;
      return sum + (delta * delta);
    }, 0) / consistencyWindowValues.length;
    consistencyValue = Math.sqrt(variance);
  }
  if (consistencyEl) {
    consistencyEl.innerText = Number.isFinite(consistencyValue)
      ? `±${consistencyValue.toFixed(3)}%`
      : "-";
  }
  renderOverviewTypeMixBalance(records);
  renderOverviewSynergySummary();

  const statsSourceRows = Array.isArray(allRecordsOverride) && allRecordsOverride.length
    ? allRecordsOverride
    : (Array.isArray(fullUserData) && fullUserData.length ? fullUserData : records);
  const lastTenRows = Array.isArray(statsSourceRows) ? statsSourceRows.slice(-10) : [];
  const netLivesContributionEl = document.getElementById("overviewNetLivesContribution");
  const averageRigLast10El = document.getElementById("overviewAverageRigLast10");
  const averageRigPctLast10El = document.getElementById("overviewAverageRigPctLast10");
  const guessQuartilesTextEl = document.getElementById("overviewGuessQuartilesText");

  const netLivesValues = lastTenRows
    .map(row => Number(row && row["Lives saved"]) + Number(row && row["Lives taken"]))
    .filter(value => Number.isFinite(value));
  const netLivesAverage = netLivesValues.length
    ? netLivesValues.reduce((sum, value) => sum + value, 0) / netLivesValues.length
    : null;
  if (netLivesContributionEl) {
    netLivesContributionEl.innerText = Number.isFinite(netLivesAverage)
      ? netLivesAverage.toFixed(1)
      : "-";
  }

  const averageRigValues = lastTenRows
    .map(row => getFirstFiniteNumber(row || {}, ["Rigs", "Rig count", "rig count", "rigs"]))
    .filter(value => Number.isFinite(value));
  const averageRigLast10 = averageRigValues.length
    ? averageRigValues.reduce((sum, value) => sum + value, 0) / averageRigValues.length
    : null;
  if (averageRigLast10El) {
    if (overviewDataSourceMode === "usual") {
      averageRigLast10El.innerText = "N/A";
    } else {
      averageRigLast10El.innerText = Number.isFinite(averageRigLast10)
        ? String(Math.round(averageRigLast10))
        : "-";
    }
  }

  const averageRigPctValues = lastTenRows
    .map(row => {
      const safeRow = row || {};
      const rigCount = getFirstFiniteNumber(safeRow, ["Rigs", "Rig count", "rig count", "rigs"]);
      const totalSongs = getFirstFiniteNumber(safeRow, ["Total songs", "total songs", "Total song", "total song"]);
      if (!Number.isFinite(rigCount) || !Number.isFinite(totalSongs) || totalSongs <= 0) return null;
      return (rigCount / totalSongs) * 100;
    })
    .filter(value => Number.isFinite(value));
  const averageRigPctLast10 = averageRigPctValues.length
    ? averageRigPctValues.reduce((sum, value) => sum + value, 0) / averageRigPctValues.length
    : null;
  if (averageRigPctLast10El) {
    if (overviewDataSourceMode === "usual") {
      averageRigPctLast10El.innerText = "N/A";
    } else {
      averageRigPctLast10El.innerText = Number.isFinite(averageRigPctLast10)
        ? `${averageRigPctLast10.toFixed(1)}%`
        : "-";
    }
  }

  const percentileGuessRateValues = lastTenRows
    .map(row => Number(row && row["Guess rate"]))
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);
  const computePercentile = (sortedValues, percentileRatio) => {
    if (!Array.isArray(sortedValues) || !sortedValues.length) return null;
    if (sortedValues.length === 1) return sortedValues[0];
    const position = (sortedValues.length - 1) * percentileRatio;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const lowerValue = sortedValues[lowerIndex];
    const upperValue = sortedValues[upperIndex];
    if (lowerIndex === upperIndex) return lowerValue;
    const weight = position - lowerIndex;
    return lowerValue + (upperValue - lowerValue) * weight;
  };

  const guessRateP25 = computePercentile(percentileGuessRateValues, 0.25);
  const guessRateP75 = computePercentile(percentileGuessRateValues, 0.75);
  if (guessQuartilesTextEl) {
    const p25Text = Number.isFinite(guessRateP25) ? `${guessRateP25.toFixed(3)}%` : "-";
    const p75Text = Number.isFinite(guessRateP75) ? `${guessRateP75.toFixed(3)}%` : "-";
    guessQuartilesTextEl.innerText = `Target Range: ${p25Text} — ${p75Text}`;
  }

  if (!records.length) return;

  const latest = records[records.length - 1];
  const values = records.map(x => Number(x["Guess rate"]));
  const averageSourceRows = Array.isArray(allRecordsOverride) && allRecordsOverride.length
    ? allRecordsOverride
    : (Array.isArray(fullUserData) && fullUserData.length ? fullUserData : records);
  const averageGuessValues = averageSourceRows
    .slice(-10)
    .map(row => Number(row && row["Guess rate"]))
    .filter(value => Number.isFinite(value));
  const averageGuessRate = averageGuessValues.length
    ? averageGuessValues.reduce((sum, value) => sum + value, 0) / averageGuessValues.length
    : null;

  const resolvedRank = overviewDataSourceMode === "usual"
    ? (Number.isFinite(Number(latestRankOverride)) ? Number(latestRankOverride) : null)
    : (Number.isFinite(Number(latestRankOverride)) ? Number(latestRankOverride) : Number(latest["Rank"]));
  updateCurrentRankInfoTooltip(getRankPoolSizeForMode(overviewDataSourceMode));
  const isWatchedUnassignedRank = overviewDataSourceMode !== "usual"
    && Number.isFinite(resolvedRank)
    && resolvedRank < MIN_VALID_RANK;
  document.getElementById("rank").innerText = Number.isFinite(resolvedRank)
    ? resolvedRank.toFixed(3)
    : "-";
  let resolvedPercentile = Number(latestRankPercentileOverride);
  if (!isWatchedUnassignedRank && !Number.isFinite(resolvedPercentile) && Number.isFinite(resolvedRank)) {
    let rankRows = [];
    if (overviewDataSourceMode === "usual") {
      const usualRankMap = getLatestRankCacheForMode("usual").map;
      if (usualRankMap instanceof Map && usualRankMap.size) {
        rankRows = Array.from(usualRankMap.values())
          .map(value => Number(value))
          .filter(value => Number.isFinite(value))
          .sort((a, b) => b - a);
      }
    }
    if (!rankRows.length && overviewDataSourceMode !== "usual") {
      rankRows = (Array.isArray(allRecordsOverride) && allRecordsOverride.length
        ? allRecordsOverride
        : (Array.isArray(fullUserData) && fullUserData.length ? fullUserData : records))
        .map(row => Number(row && row["Rank"]))
        .filter(value => Number.isFinite(value) && value >= MIN_VALID_RANK)
        .sort((a, b) => b - a);
    }
    if (rankRows.length) {
      let position = rankRows.findIndex(value => resolvedRank >= value);
      if (position < 0) position = rankRows.length - 1;
      resolvedPercentile = rankRows.length <= 1
        ? 100
        : ((rankRows.length - 1 - position) / (rankRows.length - 1)) * 100;
    }
  }
  applyCurrentRankCardStyle(
    resolvedPercentile,
    latestRankIsTopThreeOverride,
    isWatchedUnassignedRank ? "rank-tier-silver" : ""
  );
  document.getElementById("guess").innerText = Number.isFinite(averageGuessRate)
    ? `${averageGuessRate.toFixed(3)}%`
    : "-";
  const labels = records.map(x => x.Timestamp);
  document.getElementById("foundGames").innerText = `Found ${labels.length} tours`;
  const { slope } = buildTrend(values);
  const slopePrefix = slope >= 0 ? "+" : "";
  document.getElementById("slopeInfo").innerText = `Slope: ${slopePrefix}${slope.toFixed(2)}% per game`;

  guessChart = renderTrendChart(
    guessChart,
    "chart",
    labels,
    values,
    "Guess Rate (%)",
    "Guess rate (%)",
    { metaElementId: "foundGames", metaUnit: "tours", showCurvedTrend: true }
  );
}

if (dataRangeSelect) {
  dataRangeSelect.addEventListener("change", () => {
    if (!fullUserData.length) return;
    const performanceVisibleRecords = getVisibleUserData(getPerformanceRowsForActiveMode());
    renderOverviewForActiveMode();

    if (activeSection === "performance" && activeSubSectionBySection.performance === "Guess Rate") {
      renderPerformanceGuessRate(performanceVisibleRecords);
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Lives Taken / Saved") {
      renderPerformanceLivesTakenSaved(performanceVisibleRecords);
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Rigs Missed") {
      renderPerformanceRigsMissed(getVisibleUserData(fullUserData));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Onlist/Offlist") {
      renderPerformanceRigAnalysis(getVisibleUserData(fullUserData));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Composite charts") {
      renderPerformanceCompositeCharts(getVisibleUserData(fullUserData));
    }
    if (activeSection === "social") {
      scheduleSocialSubSectionRender(activeSubSectionBySection.social || "");
    }
    if (currentDisplayName) {
      loadOverviewAnimeTypeDataForUser(currentDisplayName);
      loadOverviewTopSolosForUser(currentDisplayName);
      loadOverviewTopDoublesForUser(currentDisplayName, { kind: "general" });
      loadOverviewTopDoublesForUser(currentDisplayName, { kind: "their_rig_you_blocked" });
      loadOverviewTopDoublesForUser(currentDisplayName, { kind: "your_rig_they_blocked" });
      loadOverviewTopRigSongsForUser(currentDisplayName);
      loadOverviewZScoreDataForUser(currentDisplayName);
      loadGenreDataForUser(currentDisplayName);
      loadTagDataForUser(currentDisplayName);
      loadByEraDataForUser(currentDisplayName);
      loadArtistDataForUser(currentDisplayName);
      if (activeSection === "insights") {
        scheduleInsightsSubSectionLoad(activeSubSectionBySection.insights || "", currentDisplayName);
      } else {
        loadRelearnDataForUser(currentDisplayName, { render: false });
        loadWrongGuessDataForUser(currentDisplayName, { render: false });
        loadNeverCorrectDataForUser(currentDisplayName, { render: false });
        loadPopularityDataForUser(currentDisplayName, { render: false });
        loadPCorrectDataForUser(currentDisplayName, { render: false });
      }
      loadSearchSongsDataForUser(currentDisplayName);
    }
  });
}

if (artistFamiliaritySearchInput) {
  artistFamiliaritySearchInput.addEventListener("input", event => {
    artistFamiliaritySearchQuery = String(event.target.value || "");
    renderArtistSuggestions();
  });
  artistFamiliaritySearchInput.addEventListener("focus", () => {
    renderArtistSuggestions();
  });
  artistFamiliaritySearchInput.addEventListener("blur", () => {
    setTimeout(() => {
      renderArtistInlineSuggestion();
    }, 0);
  });
  artistFamiliaritySearchInput.addEventListener("keydown", event => {
    if (event.key === "Tab" && !event.shiftKey) {
      const typed = String(artistFamiliaritySearchInput.value || "");
      const suggestion = getArtistPrefixSuggestion(typed);
      if (suggestion && suggestion.name && suggestion.name.toLowerCase() !== typed.toLowerCase()) {
        event.preventDefault();
        artistFamiliaritySearchInput.value = suggestion.name;
        artistFamiliaritySearchQuery = suggestion.name;
        renderArtistSuggestions();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitArtistSearch(artistFamiliaritySearchInput.value);
      return;
    }
    if (event.key === "Escape") {
      if (artistFamiliarityInlineSuggestion) {
        artistFamiliarityInlineSuggestion.innerHTML = "";
      }
      hideArtistSuggestions();
    }
  });
}

if (artistFamiliaritySearchBtn) {
  artistFamiliaritySearchBtn.addEventListener("click", () => {
    const typed = artistFamiliaritySearchInput ? artistFamiliaritySearchInput.value : "";
    submitArtistSearch(typed);
  });
}

if (artistFamiliarityRightModeAttemptsBtn) {
  artistFamiliarityRightModeAttemptsBtn.addEventListener("click", () => {
    artistFamiliarityRightMode = "attempts";
    renderArtistFamiliarityView();
  });
}

if (artistFamiliarityRightModeCompareBtn) {
  artistFamiliarityRightModeCompareBtn.addEventListener("click", () => {
    artistFamiliarityRightMode = "compare_radar";
    renderArtistFamiliarityView();
  });
}

document.addEventListener("click", event => {
  const target = event.target;
  const compareSuggestions = document.getElementById("artistFamiliarityCompareSuggestions");
  const compareInput = document.getElementById("artistFamiliarityCompareSearchInput");
  const keepLeftOpen = Boolean(
    artistFamiliaritySuggestions
    && artistFamiliaritySearchInput
    && (artistFamiliaritySuggestions.contains(target) || artistFamiliaritySearchInput.contains(target))
  );
  const keepCompareOpen = Boolean(
    compareSuggestions
    && compareInput
    && (compareSuggestions.contains(target) || compareInput.contains(target))
  );
  if (!keepLeftOpen) hideArtistSuggestions();
  if (!keepCompareOpen) hideArtistCompareSuggestions();
});

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  fields.push(current);
  return fields;
}

function csvToPlayerStats(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) return {};

  const headers = parseCsvLine(lines[0]);
  const output = {};

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (!values.length) continue;

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? "";
    });

    const playerName = row["Player name"];
    if (!playerName) continue;

    if (!output[playerName]) {
      output[playerName] = [];
    }
    output[playerName].push(row);
  }

  return output;
}

function getLatestRankCacheForMode(mode = "watched") {
  const resolvedMode = mode === "usual" ? "usual" : "watched";
  return {
    mode: resolvedMode,
    map: latestRankByPlayerKeyByMode[resolvedMode],
    percentileMap: latestRankPercentileByPlayerKeyByMode[resolvedMode],
    timestampMap: latestRankTimestampByPlayerKeyByMode[resolvedMode],
    loadPromise: latestRankLoadPromiseByMode[resolvedMode]
  };
}

async function loadLatestRankMap(mode = "watched") {
  const cache = getLatestRankCacheForMode(mode);
  if (cache.map instanceof Map) {
    return cache.map;
  }
  if (cache.loadPromise) {
    return cache.loadPromise;
  }

  latestRankLoadPromiseByMode[cache.mode] = (async () => {
    const map = new Map();
    const percentileMap = new Map();
    const timestampMap = new Map();
    const latestRankFile = cache.mode === "usual" ? "latest_rank_usual.json" : "latest_rank.json";
    try {
      const latestRankRes = await fetch(dataUrl(latestRankFile));
      if (!latestRankRes.ok) {
        latestRankByPlayerKeyByMode[cache.mode] = map;
        latestRankPercentileByPlayerKeyByMode[cache.mode] = percentileMap;
        latestRankTimestampByPlayerKeyByMode[cache.mode] = timestampMap;
        return map;
      }

      const payload = await latestRankRes.json();
      if (!Array.isArray(payload)) {
        latestRankByPlayerKeyByMode[cache.mode] = map;
        latestRankPercentileByPlayerKeyByMode[cache.mode] = percentileMap;
        latestRankTimestampByPlayerKeyByMode[cache.mode] = timestampMap;
        return map;
      }

      const normalizedRows = payload.map(entry => {
        const playerKey = String(entry && entry.player ? entry.player : "").trim().toLowerCase();
        const rankValue = Number(entry && entry.rank);
        const timestampValue = getSortableTimestampValue(entry && entry.timestamp);
        return { playerKey, rankValue, timestampValue };
      }).filter(entry => entry.playerKey && Number.isFinite(entry.rankValue));

      normalizedRows.forEach(entry => {
        const playerKey = entry.playerKey;
        const rankValue = entry.rankValue;
        const timestampValue = entry.timestampValue;
        const existingTimestamp = Number(timestampMap.get(playerKey));
        const shouldReplace = !Number.isFinite(existingTimestamp)
          || (Number.isFinite(timestampValue) && timestampValue >= existingTimestamp);
        if (!shouldReplace) return;
        map.set(playerKey, rankValue);
        if (Number.isFinite(timestampValue)) {
          timestampMap.set(playerKey, timestampValue);
        }
      });

      const rankCutoff = cache.mode === "watched" ? MIN_VALID_RANK : Number.NEGATIVE_INFINITY;
      const percentileEligibleRows = normalizedRows.filter(entry => entry.rankValue >= rankCutoff);
      const sortedRows = percentileEligibleRows.slice().sort((a, b) => {
        if (a.rankValue !== b.rankValue) return b.rankValue - a.rankValue;
        return a.playerKey.localeCompare(b.playerKey);
      });
      const total = sortedRows.length;
      sortedRows.forEach((entry, index) => {
        const percentile = total <= 1
          ? 100
          : ((total - 1 - index) / (total - 1)) * 100;
        percentileMap.set(entry.playerKey, Math.max(0, Math.min(100, percentile)));
      });
    } catch (error) {
      console.warn(`Failed to load data/${latestRankFile}:`, error);
    }

    latestRankByPlayerKeyByMode[cache.mode] = map;
    latestRankPercentileByPlayerKeyByMode[cache.mode] = percentileMap;
    latestRankTimestampByPlayerKeyByMode[cache.mode] = timestampMap;
    return map;
  })();

  return latestRankLoadPromiseByMode[cache.mode];
}

function resolveLatestRankFromMap(latestRankMap, canonicalName, matchedKey, altNames = [], mode = "watched") {
  if (!(latestRankMap instanceof Map) || !latestRankMap.size) return null;

  const candidates = [canonicalName, matchedKey, ...(Array.isArray(altNames) ? altNames : [])];
  const uniqueCandidates = [];
  const seen = new Set();
  candidates.forEach(name => {
    const key = String(name || "").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    uniqueCandidates.push(key);
  });

  const cache = getLatestRankCacheForMode(mode);
  const timestampMap = cache.timestampMap instanceof Map
    ? cache.timestampMap
    : null;
  let bestRank = null;
  let bestTimestamp = Number.NEGATIVE_INFINITY;
  let foundWithTimestamp = false;

  if (timestampMap && timestampMap.size) {
    uniqueCandidates.forEach(key => {
      if (!latestRankMap.has(key)) return;
      const rankValue = Number(latestRankMap.get(key));
      if (!Number.isFinite(rankValue)) return;
      const timestampValue = Number(timestampMap.get(key));
      if (!Number.isFinite(timestampValue)) return;
      if (!foundWithTimestamp || timestampValue > bestTimestamp) {
        foundWithTimestamp = true;
        bestTimestamp = timestampValue;
        bestRank = rankValue;
      }
    });
    if (foundWithTimestamp && Number.isFinite(bestRank)) {
      return bestRank;
    }
  }

  for (const key of uniqueCandidates) {
    if (!latestRankMap.has(key)) continue;
    const rankValue = Number(latestRankMap.get(key));
    if (Number.isFinite(rankValue)) return rankValue;
  }
  return null;
}

function resolveLatestRankPercentileFromMap(canonicalName, matchedKey, altNames = [], mode = "watched") {
  const cache = getLatestRankCacheForMode(mode);
  const percentileMap = cache.percentileMap;
  if (!(percentileMap instanceof Map) || !percentileMap.size) return null;

  const candidates = [canonicalName, matchedKey, ...(Array.isArray(altNames) ? altNames : [])];
  for (const name of candidates) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) continue;
    if (!percentileMap.has(key)) continue;
    const percentile = Number(percentileMap.get(key));
    if (Number.isFinite(percentile)) return percentile;
  }
  return null;
}

function applyCurrentRankCardStyle(percentile, isTopThree = false, forceTierClass = "") {
  const card = document.getElementById("currentRankCard");
  const tierLabel = document.getElementById("currentRankTierLabel");
  const overviewCardsRow = document.querySelector("#overviewSection .overview-cards-row");
  if (!card) return;

  const tierClasses = [
    "rank-tier-bronze",
    "rank-tier-silver",
    "rank-tier-gold",
    "rank-tier-diamond",
    "rank-tier-platinum",
    "rank-top-3-badge"
  ];
  tierClasses.forEach(className => card.classList.remove(className));
  if (overviewCardsRow) {
    tierClasses.forEach(className => overviewCardsRow.classList.remove(className));
  }

  if (forceTierClass && tierClasses.includes(forceTierClass)) {
    card.classList.add(forceTierClass);
    if (overviewCardsRow) {
      overviewCardsRow.classList.add(forceTierClass);
    }
    if (tierLabel) {
      tierLabel.innerText = "";
    }
    return;
  }

  if (!Number.isFinite(percentile)) {
    if (tierLabel) tierLabel.innerText = "";
    return;
  }

  const value = Math.max(0, Math.min(100, Number(percentile)));
  const displayValue = Math.max(0, Math.min(100, 100 - value));
  let tierClass = "rank-tier-bronze";
  if (value >= 80) {
    tierClass = "rank-tier-platinum";
  } else if (value >= 60) {
    tierClass = "rank-tier-diamond";
  } else if (value >= 40) {
    tierClass = "rank-tier-gold";
  } else if (value >= 20) {
    tierClass = "rank-tier-silver";
  }

  card.classList.add(tierClass);
  if (overviewCardsRow) {
    overviewCardsRow.classList.add(tierClass);
  }
  if (isTopThree) {
    card.classList.add("rank-top-3-badge");
    if (tierLabel) {
      tierLabel.innerText = `Top ${displayValue.toFixed(1)}% • Top 3`;
    }
    return;
  }
  if (tierLabel) {
    tierLabel.innerText = `Top ${displayValue.toFixed(1)}%`;
  }
}

async function loadGlobalStatsData(mode = "watched") {
  const resolvedMode = mode === "usual" ? "usual" : "watched";
  const jsonFile = resolvedMode === "usual" ? "stats_usual.json" : "stats.json";
  const csvFile = resolvedMode === "usual" ? "stats_usual.csv" : "stats.csv";

  const jsonRes = await fetch(dataUrl(jsonFile));
  if (jsonRes.ok) {
    return jsonRes.json();
  }

  const legacyJsonRes = await fetch(jsonFile);
  if (legacyJsonRes.ok) {
    return legacyJsonRes.json();
  }

  const csvRes = await fetch(dataUrl(csvFile));
  if (!csvRes.ok) {
    throw new Error(`Could not load stats data from data/${jsonFile}, ${jsonFile}, or data/${csvFile}`);
  }

  const csvText = await csvRes.text();
  return csvToPlayerStats(csvText);
}

async function loadWeeklyStatsData(mode = "watched") {
  const resolvedMode = mode === "usual" ? "usual" : "watched";
  const jsonFile = resolvedMode === "usual" ? "stats_usual_weekly.json" : "stats_weekly.json";

  const jsonRes = await fetch(dataUrl(jsonFile));
  if (!jsonRes.ok) {
    throw new Error(`Could not load weekly stats data from data/${jsonFile}`);
  }
  return jsonRes.json();
}

async function loadLastWeekStatsData(mode = "watched") {
  const resolvedMode = mode === "usual" ? "usual" : "watched";
  const jsonFile = resolvedMode === "usual" ? "stats_usual_last_week.json" : "stats_last_week.json";

  const jsonRes = await fetch(dataUrl(jsonFile));
  if (!jsonRes.ok) {
    throw new Error(`Could not load last-week stats data from data/${jsonFile}`);
  }
  return jsonRes.json();
}

function normalizeStatsMapFromPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (payload.stats && typeof payload.stats === "object") {
    return payload.stats;
  }
  if (payload.players && typeof payload.players === "object") {
    return payload.players;
  }
  return payload;
}

async function loadScopedStatsDataForCurrentUser(mode = "watched") {
  const playerEntry = await getPlayerEntryByName(username || "");
  const playerId = String(playerEntry && playerEntry.playerId || "").trim();
  if (!playerId) return null;

  const resolvedMode = mode === "usual" ? "usual" : "watched";
  const scopedPaths = resolvedMode === "usual"
    ? [
      `players/${playerId}/usual/stat.json`,
      `players/${playerId}/stat_usual.json`
    ]
    : [
      `players/${playerId}/watched/stat.json`,
      `players/${playerId}/stat.json`
    ];

  for (const scopedPath of scopedPaths) {
    const scopedRes = await fetchLocalDataIfAvailable(scopedPath);
    if (!scopedRes || !scopedRes.ok) continue;
    const scopedPayload = await scopedRes.json();
    const scopedStats = normalizeStatsMapFromPayload(scopedPayload);
    return {
      data: scopedStats,
      playerEntry
    };
  }

  return null;
}

async function loadStatsData(mode = "watched") {
  try {
    const scoped = await loadScopedStatsDataForCurrentUser(mode);
    if (scoped && scoped.data && Object.keys(scoped.data).length) {
      return {
        data: scoped.data,
        playerEntry: scoped.playerEntry,
        source: "scoped"
      };
    }
  } catch (err) {
    console.warn("Scoped stats load failed, falling back to global stats", err);
  }

  const globalData = await loadGlobalStatsData(mode);
  return {
    data: globalData,
    playerEntry: null,
    source: "global"
  };
}

/* -------------------------
   FETCH DATA
------------------------- */
Promise.all([
  loadStatsData("watched"),
  loadStatsData("usual").catch(err => {
    console.warn("Usual stats load failed; keeping watched-only mode", err);
    return { data: {}, playerEntry: null, source: "global" };
  }),
  loadWeeklyStatsData("watched").catch(err => {
    console.warn("Weekly watched stats load failed", err);
    return {};
  }),
  loadWeeklyStatsData("usual").catch(err => {
    console.warn("Weekly usual stats load failed", err);
    return {};
  }),
  loadLastWeekStatsData("watched").catch(err => {
    console.warn("Last-week watched stats load failed", err);
    return {};
  }),
  loadLastWeekStatsData("usual").catch(err => {
    console.warn("Last-week usual stats load failed", err);
    return {};
  })
])
  .then(async ([watchedStatsResult, usualStatsResult, weeklyWatchedPayload, weeklyUsualPayload, lastWeekWatchedPayload, lastWeekUsualPayload]) => {
    const data = watchedStatsResult && typeof watchedStatsResult === "object" ? (watchedStatsResult.data || {}) : {};
    const usualData = usualStatsResult && typeof usualStatsResult === "object" ? (usualStatsResult.data || {}) : {};
    const usualStatKeys = Object.keys(usualData);
    const latestRankMapPromise = loadLatestRankMap("watched");
    const latestRankUsualMapPromise = loadLatestRankMap("usual");
    let globalSocialData = null;
    let globalSocialUsualData = null;
    try {
      const loadedGlobalData = await loadGlobalStatsData("watched");
      const normalizedGlobalData = normalizeStatsMapFromPayload(loadedGlobalData);
      if (normalizedGlobalData && typeof normalizedGlobalData === "object") {
        globalSocialData = normalizedGlobalData;
      }
    } catch (globalLoadErr) {
      console.warn("Global stats load failed for social views; using current scoped dataset as fallback", globalLoadErr);
    }
    try {
      const loadedGlobalUsualData = await loadGlobalStatsData("usual");
      const normalizedGlobalUsualData = normalizeStatsMapFromPayload(loadedGlobalUsualData);
      if (normalizedGlobalUsualData && typeof normalizedGlobalUsualData === "object") {
        globalSocialUsualData = normalizedGlobalUsualData;
      }
    } catch (globalUsualLoadErr) {
      console.warn("Global usual stats load failed for social views; using current scoped usual dataset as fallback", globalUsualLoadErr);
    }
    allPlayerStatsData = (globalSocialData && typeof globalSocialData === "object")
      ? globalSocialData
      : ((data && typeof data === "object") ? data : {});
    allPlayerUsualStatsData = (globalSocialUsualData && typeof globalSocialUsualData === "object")
      ? globalSocialUsualData
      : ((usualData && typeof usualData === "object") ? usualData : {});
    allPlayerWeeklyStatsData = normalizeStatsMapFromPayload(weeklyWatchedPayload);
    allPlayerUsualWeeklyStatsData = normalizeStatsMapFromPayload(weeklyUsualPayload);
    allPlayerLastWeekStatsData = normalizeStatsMapFromPayload(lastWeekWatchedPayload);
    allPlayerUsualLastWeekStatsData = normalizeStatsMapFromPayload(lastWeekUsualPayload);
    weeklyPlayerTransitionCountsByMode.watched = normalizeTransitionCountsMap(weeklyWatchedPayload);
    weeklyPlayerTransitionCountsByMode.usual = normalizeTransitionCountsMap(weeklyUsualPayload);
    lastWeekPlayerTransitionCountsByMode.watched = normalizeTransitionCountsMap(lastWeekWatchedPayload);
    lastWeekPlayerTransitionCountsByMode.usual = normalizeTransitionCountsMap(lastWeekUsualPayload);
    weeklyDateRangeByMode.watched = (weeklyWatchedPayload && typeof weeklyWatchedPayload === "object" && weeklyWatchedPayload.dateRange && typeof weeklyWatchedPayload.dateRange === "object")
      ? weeklyWatchedPayload.dateRange
      : null;
    weeklyDateRangeByMode.usual = (weeklyUsualPayload && typeof weeklyUsualPayload === "object" && weeklyUsualPayload.dateRange && typeof weeklyUsualPayload.dateRange === "object")
      ? weeklyUsualPayload.dateRange
      : null;
    cachedWeightedGuessRateSeriesByPlayerId = new Map();
    weightedGuessRateRequestId = 0;
    const normalizedUser = String(username || "").trim().toLowerCase();
    const statKeys = Object.keys(data);
    let matchedKey = statKeys.find(key => key.toLowerCase() === normalizedUser);
    let playerEntry = watchedStatsResult && watchedStatsResult.playerEntry ? watchedStatsResult.playerEntry : await getPlayerEntryByName(username || "");

    // If the direct username lookup misses, try using the matched stats key as a lookup
    // so aliases from players.json still resolve to a canonical player identity.
    if (!playerEntry && matchedKey) {
      playerEntry = await getPlayerEntryByName(matchedKey);
    }

    const altNames = Array.isArray(playerEntry && playerEntry.altnames)
      ? playerEntry.altnames.map(name => String(name || "").trim().toLowerCase()).filter(Boolean)
      : [];

    if (!matchedKey) {
      const aliasCandidates = new Set([
        ...altNames,
        String(playerEntry && playerEntry.displayName || "").trim().toLowerCase()
      ].filter(Boolean));
      if (aliasCandidates.size) {
        matchedKey = statKeys.find(key => aliasCandidates.has(String(key || "").trim().toLowerCase()));
        if (!matchedKey) {
          matchedKey = usualStatKeys.find(key => aliasCandidates.has(String(key || "").trim().toLowerCase()));
        }
      }
    }

    if (!matchedKey) {
      matchedKey = usualStatKeys.find(key => String(key || "").trim().toLowerCase() === normalizedUser);
    }

    if (!matchedKey) {
      alert("User not found");
      return;
    }

    const canonicalName = (playerEntry && playerEntry.displayName) ? playerEntry.displayName : matchedKey;
    document.getElementById("usernameDisplay").innerText = canonicalName;
    document.title = canonicalName;
    let cleanedAltNames = applyUsernameAkaUi(canonicalName, playerEntry);

    if (!playerEntry) {
      getPlayerEntryByName(username || "").then(entry => {
        if (!entry) return;
        const nextCanonical = String(entry.displayName || canonicalName).trim() || canonicalName;
        const displayEl = document.getElementById("usernameDisplay");
        if (displayEl) {
          displayEl.innerText = nextCanonical;
        }
        document.title = nextCanonical;
        cleanedAltNames = applyUsernameAkaUi(nextCanonical, entry);
      }).catch(err => {
        console.warn("Deferred player alias load failed", err);
      });
    }

    const identityNames = new Set([
      normalizedUser,
      String(canonicalName || "").trim().toLowerCase(),
      String(matchedKey || "").trim().toLowerCase(),
      ...altNames,
      ...cleanedAltNames.map(name => String(name || "").trim().toLowerCase())
    ].filter(Boolean));
    let sourceKeys = Array.from(new Set([
      ...statKeys.filter(key => identityNames.has(String(key || "").trim().toLowerCase())),
      ...usualStatKeys.filter(key => identityNames.has(String(key || "").trim().toLowerCase()))
    ]));
    if (!sourceKeys.length) {
      sourceKeys = [matchedKey];
    }
    const mergedUserDataRaw = sourceKeys
      .flatMap(key => Array.isArray(data[key]) ? data[key] : [])
      .filter(row => row && typeof row === "object");
    const dedupeSeenKeys = new Set();
    const mergedUserData = mergedUserDataRaw.filter(row => {
      const dedupeKey = [
        String(row.Timestamp || ""),
        String(row["Guess rate"] || ""),
        String(row["OP guess rate"] || ""),
        String(row["ED guess rate"] || ""),
        String(row["IN guess rate"] || ""),
        String(row["Rank"] || ""),
        String(row["Lives saved"] || ""),
        String(row["Lives taken"] || "")
      ].join("|");
      if (dedupeSeenKeys.has(dedupeKey)) return false;
      dedupeSeenKeys.add(dedupeKey);
      return true;
    });

    currentDisplayName = canonicalName;
    currentStatKey = matchedKey;
    currentStatSourceKeys = sourceKeys;
    currentLatestRankValue = null;
    currentLatestRankPercentile = null;
    currentLatestRankIsTopThree = false;
    currentUsualLatestRankValue = null;
    currentUsualLatestRankPercentile = null;
    currentUsualLatestRankIsTopThree = false;
    selectedSocialRivalKeys = [];
    socialRivalSearchQuery = "";
    currentPlayerId = null;
    preloadOverviewGeneralForUser(canonicalName, { immediate: true });
    preloadOverviewStatsSummaryForUser(canonicalName, { immediate: true });

    const usualMergedUserDataRaw = sourceKeys
      .flatMap(key => Array.isArray(usualData[key]) ? usualData[key] : [])
      .filter(row => row && typeof row === "object");
    const usualDedupeSeenKeys = new Set();
    usualUserData = usualMergedUserDataRaw.filter(row => {
      const dedupeKey = [
        String(row.Timestamp || ""),
        String(row["Guess rate"] || ""),
        String(row["OP guess rate"] || ""),
        String(row["ED guess rate"] || ""),
        String(row["IN guess rate"] || ""),
        String(row["Rank"] || ""),
        String(row["Lives saved"] || ""),
        String(row["Lives taken"] || "")
      ].join("|");
      if (usualDedupeSeenKeys.has(dedupeKey)) return false;
      usualDedupeSeenKeys.add(dedupeKey);
      return true;
    });
    usualUserData = sortRecordsByTimestamp(usualUserData);

    if (!mergedUserData.length && !usualUserData.length) {
      alert("No records found for this user");
      return;
    }

    // Sort by timestamp using shared parser (supports legacy DD-MM-YYYY rows too).
    const sortedMergedUserData = sortRecordsByTimestamp(mergedUserData);

    fullUserData = sortedMergedUserData;
    if (!fullUserData.length && usualUserData.length) {
      // Usual-only user: default to usual data source on first load.
      overviewDataSourceMode = "usual";
    }
    updateDataRangeControlState(activeSection, activeSubSectionBySection[activeSection] || "");
    refreshOverviewModeScopedCards(canonicalName);
    const performanceVisibleRecords = getVisibleUserData(getPerformanceRowsForActiveMode());
    renderOverviewForActiveMode();
    preloadFirstSubtabsForAllSections(canonicalName);
    preloadOtherSubtabsForSection("overview", canonicalName);

    if (activeSection === "performance" && activeSubSectionBySection.performance === "Guess Rate") {
      renderPerformanceGuessRate(performanceVisibleRecords);
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Lives Taken / Saved") {
      renderPerformanceLivesTakenSaved(performanceVisibleRecords);
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Rigs Missed") {
      renderPerformanceRigsMissed(getVisibleUserData(fullUserData));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Onlist/Offlist") {
      renderPerformanceRigAnalysis(getVisibleUserData(fullUserData));
    }
    if (activeSection === "performance" && activeSubSectionBySection.performance === "Composite charts") {
      renderPerformanceCompositeCharts(getVisibleUserData(fullUserData));
    }
    if (activeSection === "social") {
      scheduleSocialSubSectionRender(activeSubSectionBySection.social || "");
    }

    latestRankMapPromise.then(latestRankMap => {
      currentLatestRankValue = resolveLatestRankFromMap(
        latestRankMap,
        canonicalName,
        matchedKey,
        cleanedAltNames,
        "watched"
      );
      currentLatestRankPercentile = resolveLatestRankPercentileFromMap(
        canonicalName,
        matchedKey,
        cleanedAltNames,
        "watched"
      );
      const latestTopThreeSet = new Set(Array.from(latestRankMap.keys()).slice(0, 3));
      currentLatestRankIsTopThree = Array.from(identityNames).some(name => latestTopThreeSet.has(name));
      renderOverviewForActiveMode();
    }).catch(err => {
      console.warn("Deferred latest rank load failed", err);
    });

    latestRankUsualMapPromise.then(latestRankMap => {
      currentUsualLatestRankValue = resolveLatestRankFromMap(
        latestRankMap,
        canonicalName,
        matchedKey,
        cleanedAltNames,
        "usual"
      );
      currentUsualLatestRankPercentile = resolveLatestRankPercentileFromMap(
        canonicalName,
        matchedKey,
        cleanedAltNames,
        "usual"
      );
      const latestTopThreeSet = new Set(Array.from(latestRankMap.keys()).slice(0, 3));
      currentUsualLatestRankIsTopThree = Array.from(identityNames).some(name => latestTopThreeSet.has(name));
      renderOverviewForActiveMode();
    }).catch(err => {
      console.warn("Deferred latest usual rank load failed", err);
    });
  })
  .catch(err => {
    console.error(err);
    alert("Failed to load stats data");
  });
