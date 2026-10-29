const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../analytics.js'), 'utf8');
function setup(url = 'https://example.com/tracker/player.html?user=PrivatePlayer#secret', existing) {
  let time = 0;
  const timers = new Map(), scripts = [], listeners = {}, captures = [], elements = new Map();
  const document = {
    visibilityState: 'visible',
    referrer: 'https://example.com/?user=PrivateReferrer',
    title: 'PrivatePlayer dashboard',
    createElement: () => ({}),
    getElementById: id => elements.get(id) || null,
    getElementsByTagName: () => [{ parentNode: { insertBefore: script => scripts.push(script) } }],
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  const window = {
    posthog: existing,
    setTimeout: fn => { const key = {}; timers.set(key, fn); return key; },
    clearTimeout: key => timers.delete(key),
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  vm.runInNewContext(source, { window, document, location: new URL(url), URL, performance: { now: () => time } });
  const config = window.posthog?._i?.[0]?.[1];
  function flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }
  function loadSdk() {
    const queue = window.posthog;
    window.posthog = { capture(name, properties) { captures.push(config.before_send({ event: name, properties })); } };
    queue.forEach(([method, ...args]) => window.posthog[method](...args));
  }
  return { window, document, scripts, listeners, captures, config, flush, loadSdk, elements, advance: ms => { time += ms; } };
}

for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'file:///tmp/player.html', 'http://192.168.1.10/', 'http://test.localhost/']) {
  const local = setup(url);
  local.window.AMQAnalytics.track('song_played', { source: 'relearn' });
  local.window.AMQAnalytics.view('overview', 'overview');
  assert.equal(local.scripts.length, 0, url);
}
const test = setup();
assert.equal(test.scripts.length, 1);
assert.equal(test.scripts[0].src, 'https://us-assets.i.posthog.com/static/array.js');
assert.equal(test.scripts[0].async, true);
assert.equal(test.scripts[0].referrerPolicy, 'no-referrer');
assert.equal(test.window.posthog._i[0][0], 'phc_zuVBFGWRDTZp8V32sSu9Xk8LhyUCLcgHtZmAkQEnFeid');
assert.equal(test.window.posthog._i[0][2], 'posthog');
for (const key of ['autocapture', 'capture_pageview', 'capture_pageleave', 'capture_heatmaps', 'capture_performance', 'capture_exceptions', 'capture_dead_clicks', 'rageclick']) assert.equal(test.config[key], false);
assert.equal(test.config.disable_session_recording, false);
assert.equal(test.config.advanced_disable_flags, false);
assert.equal(test.config.advanced_disable_feature_flags, true);
assert.equal(test.config.enable_recording_console_log, false);
assert.equal(test.config.session_recording.maskAllInputs, true);
assert.match(test.config.session_recording.blockSelector, /input\[type="password"\]/);
for (const key of ['recordHeaders', 'recordBody', 'streamNetworkBody']) assert.equal(test.config.session_recording[key], false);
assert.equal(test.config.session_recording.captureCanvas.recordCanvas, true);
assert.equal(test.config.session_recording.captureCanvas.canvasFps, 2);
assert.equal(test.config.session_recording.captureCanvas.canvasQuality, 0.6);
for (const selector of ['#playlistSearchBannerEditorCanvas', '#playlistCoverEditorCanvas']) assert(test.config.session_recording.blockSelector.includes(selector));
assert.equal(test.config.disable_surveys, true);
assert.equal(test.config.person_profiles, 'never');
assert.equal(test.config.persistence, 'sessionStorage');

const { before_send: sanitize } = test.config;
const safe = sanitize({ event: 'songs_exported', properties: {
  source: 'relearn', format: 'csl', song_count: 2, mode: 'watched', list: 'all',
  section: 'insights', view: 'Relearn Tracker', username: 'PrivatePlayer', search: 'PrivateSearch',
  $current_url: 'https://example.com/?user=PrivatePlayer', $referrer: 'PrivateReferrer',
  $set: { name: 'PrivateName' }, $set_once: { $initial_current_url: 'PrivateURL' },
  $initial_person_info: { r: 'PrivateURL' }, $session_id: 'random-session',
  distinct_id: 'anonymous-id', token: 'project-token'
} });
assert.equal(safe.properties.$current_url, 'https://example.com/tracker/player.html');
assert.equal(safe.properties.$process_person_profile, false);
assert.equal(safe.properties.song_count, 2);
assert.equal(safe.properties.$session_id, 'random-session');
assert.doesNotMatch(JSON.stringify(safe), /Private/);
assert.equal(sanitize({ event: '$autocapture' }), null);
const snapshot = { event: '$snapshot', properties: { $snapshot_data: [{ type: 3, data: { text: 'Naruto', masked: '********' } }], $session_id: 'session', $snapshot_bytes: 123 } };
assert.strictEqual(sanitize(snapshot), snapshot, 'Replay transport must retain snapshot payload and metadata');
assert.equal(sanitize({ event: 'constructor' }), null);
assert.equal(sanitize({ event: 'song_played', properties: { source: 'PrivatePlayer', clip: 'PrivateSearch' } }).properties.source, undefined);

const searchElement = { id: 'searchSongsInput', type: 'text', value: '  All in good time  ', closest: () => null };
const passwordElement = { id: 'playlistsPasswordInput', type: 'password', value: 'never-send-this', closest: () => ({}) };
test.elements.set(searchElement.id, searchElement);
test.elements.set(passwordElement.id, passwordElement);
const mask = test.config.session_recording.maskInputFn;
assert.equal(mask('All in good time', searchElement), 'All in good time');
assert.equal(mask('never-send-this', passwordElement), '***************');
assert.equal(mask('private playlist name', { id: 'playlistRenameInput', type: 'text' }), '*'.repeat(21));
assert.equal(mask('never-send-this', { ...searchElement, type: 'password' }), '***************');
assert.equal(mask('never-send-this', { ...searchElement, closest: () => ({}) }), '***************');
assert.equal(mask('private', null), '*******');
const sanitizedSearch = sanitize({ event: 'search_submitted', properties: { input_id: 'searchSongsInput', feature: 'song', query: '  All\n in   good time  ', password: 'never-send-this' } });
assert.equal(sanitizedSearch.properties.query, 'All in good time');
assert.doesNotMatch(JSON.stringify(sanitizedSearch), /never-send-this/);
assert.equal(sanitize({ event: 'search_submitted', properties: { input_id: 'playlistsPasswordInput', feature: 'song', query: 'never-send-this' } }).properties.query, undefined);
assert.equal(sanitize({ event: 'search_submitted', properties: { input_id: 'searchSongsInput', feature: 'synergy', query: 'never-send-this' } }).properties.query, undefined);
assert.equal(sanitize({ event: 'search_submitted', properties: { input_id: 'searchSongsInput', feature: 'song', query: 'a'.repeat(1000) } }).properties.query.length, 220);

// Events queue until the asynchronous SDK is available; nav renders are deduped.
test.window.AMQAnalytics.view('overview', 'overview');
test.window.AMQAnalytics.view('insights', 'Relearn Tracker');
test.window.AMQAnalytics.view('insights', 'Relearn Tracker');
test.flush();
test.loadSdk();
assert.equal(test.captures.filter(e => e.event === '$pageview').length, 1);
assert.equal(test.captures.filter(e => e.event === 'section_viewed').length, 1);
test.window.AMQAnalytics.view('insights', 'Relearn Tracker'); test.flush();
assert.equal(test.captures.filter(e => e.event === 'section_viewed').length, 1);
test.advance(5000);
test.document.visibilityState = 'hidden'; test.listeners.visibilitychange();
test.advance(600000);
test.window.AMQAnalytics.view('social', 'Synergy'); test.flush();
test.document.visibilityState = 'visible'; test.listeners.visibilitychange();
assert.equal(test.captures.filter(e => e.event === 'section_viewed').length, 2);
assert.deepEqual(test.captures.filter(e => e.event === 'section_time').map(e => e.properties.visible_seconds), [5]);
test.advance(2000); test.listeners.pagehide(); test.listeners.pagehide();
assert.deepEqual(test.captures.filter(e => e.event === 'section_time').map(e => e.properties.visible_seconds), [5, 2]);

// Search text is emitted only by the explicit search API and known live filters.
test.window.AMQAnalytics.search('searchSongsInput', searchElement.value);
assert.equal(test.captures.at(-1).properties.query, 'All in good time');
assert.equal(test.captures.at(-1).properties.feature, 'song');
const beforeSecrets = test.captures.length;
test.window.AMQAnalytics.search('playlistsPasswordInput', passwordElement.value);
test.window.AMQAnalytics.search('unknownInput', 'private');
test.window.AMQAnalytics.search('searchSongsInput', '   ');
searchElement.type = 'password'; test.window.AMQAnalytics.search('searchSongsInput', 'never-send-this'); searchElement.type = 'text';
assert.equal(test.captures.length, beforeSecrets);
const tagInput = { id: 'tagSearchInput', type: 'text', value: 'romance', closest: () => null };
test.elements.set(tagInput.id, tagInput);
test.listeners.input({ target: tagInput, isTrusted: true });
tagInput.value = 'romance anime';
test.listeners.input({ target: tagInput, isTrusted: true });
assert.equal(test.captures.length, beforeSecrets, 'No event on each keystroke');
test.flush();
assert.equal(test.captures.at(-1).event, 'search_filtered');
assert.equal(test.captures.at(-1).properties.query, 'romance anime');
const afterLive = test.captures.length;
test.listeners.focusout({ target: tagInput, isTrusted: true });
test.listeners.keydown({ target: tagInput, isTrusted: true, key: 'Enter' });
assert.equal(test.captures.length, afterLive, 'Idle, blur and Enter do not triple-count one live filter');
tagInput.value = ''; test.listeners.focusout({ target: tagInput, isTrusted: true });
tagInput.value = 'romance anime'; test.listeners.keydown({ target: tagInput, isTrusted: true, key: 'Enter' });
assert.equal(test.captures.length, afterLive + 1);
test.listeners.input({ target: passwordElement, isTrusted: true }); test.flush();
assert.equal(test.captures.length, afterLive + 1);
assert.doesNotMatch(JSON.stringify(test.captures), /never-send-this/);
test.window.posthog.capture = () => { throw new Error('blocked'); };
assert.doesNotThrow(() => test.window.AMQAnalytics.track('song_played', { source: 'relearn', clip: 'sample' }));
const blocked = setup(); blocked.scripts[0].onerror();
for (let i = 0; i < 150; i++) blocked.window.AMQAnalytics.track('song_played');
assert.equal(blocked.window.posthog.length, 0);

for (const page of ['index.html', 'player.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
  assert.equal((html.match(/src="analytics\.js\?v=20261029-canvas1"/g) || []).length, 1);
  assert(html.indexOf('src="analytics.js') < html.indexOf('<script>'));
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(code);
}
const player = fs.readFileSync(path.join(__dirname, '../player.html'), 'utf8');
const preload = player.slice(player.indexOf('function scheduleBackgroundTask'), player.indexOf('function setActiveSubSection'));
assert.doesNotMatch(preload, /AMQAnalytics/);
assert.match(player, /if \(event\.isTrusted\) globalThis\.AMQAnalytics\?\.track/);
assert.match(player, /id="playlistsPasswordInput" class="[^"]*ph-no-capture[^"]*ph-mask/);
assert.match(player, /AMQAnalytics\?\.search\?\.\("searchSongsInput", searchSongsQuery\)/);
assert.match(player, /AMQAnalytics\?\.search\?\.\("playlistSongSearchInput", playlistSongSearchQuery\)/);
console.log('Analytics, replay transport, input/password masking, submitted/live searches, navigation, duration and failure checks passed.');
