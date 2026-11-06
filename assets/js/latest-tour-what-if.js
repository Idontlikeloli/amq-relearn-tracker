/* Same-tour counterfactuals. Formula source: data/usefulness_formula/formula.json. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMQLatestTourWhatIf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const weights = Object.freeze([0, 1, 9 / 14, 17 / 42, 1 / 4, 3 / 20, 1 / 12, 1 / 28, 0]);
  const cutoff = '2026-02-16 06:17:45';
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  const numeric = value => value == null || String(value).trim() === '' ? null : Number(String(value).replace(/[% ,]/g, ''));
  const array = value => {
    if (Array.isArray(value)) return value;
    try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
  };
  const names = value => array(value).map(p => typeof p === 'object' ? p?.name : p).filter(Boolean);
  const type = song => String(song['songInfo.type'] || ({ OP: 1, ED: 2, IN: 3 }[String(song.type || '').replace(/\d/g, '').toUpperCase()]) || '');
  const day = value => String(value || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';

  // Identity ownership can change over time (for example Lika before/after
  // 2024-03-01). Keep the same inclusive-after/exclusive-before bounds as the pipeline.
  function createPlayerNameResolver(players, timestamp = '') {
    const plain = new Map(), dated = new Map();
    const add = (map, name, value) => {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(value);
    };
    for (const player of players || []) {
      if (player?.playerId == null) continue;
      const key = `player:${player.playerId}`;
      for (const raw of [player.displayName, ...(Array.isArray(player.altnames) ? player.altnames : [])]) {
        const spec = String(raw || '').trim();
        if (!spec) continue;
        const match = spec.match(/^(.*?)\s*\[([^\]]+)\]$/);
        const bounds = match && match[2].split(',').map(part => part.trim().match(/^([<>])\s*(\d{4}-\d{2}-\d{2})$/));
        if (bounds?.length && bounds.every(Boolean)) {
          const rule = { key, before: null, after: null };
          bounds.forEach(([, sign, date]) => { rule[sign === '<' ? 'before' : 'after'] = date; });
          add(dated, normalize(match[1]), rule);
        } else add(plain, normalize(spec), key);
      }
    }
    return (name, at = timestamp) => {
      const token = normalize(name), date = day(at);
      const matching = date ? (dated.get(token) || []).filter(rule =>
        (!rule.before || date < rule.before) && (!rule.after || date >= rule.after)) : [];
      const keys = new Set(matching.length ? matching.map(rule => rule.key) : plain.get(token) || []);
      if (keys.size > 1) throw new Error(`Player alias "${name}" is ambiguous for this tour; results cannot be matched reliably.`);
      return keys.size ? [...keys][0] : token;
    };
  }

  function songKeys(song) {
    const title = normalize(song['Song Name'] || song.songName || song.title || song.song);
    const artist = normalize(song.Artist || song.artist);
    const anime = [song['English Title'], song['Romaji Title'], song.animeName, song.anime,
      song.animeEnglish, song.animeRomaji, ...array(song['Alt. Names']), ...array(song['Alt. Answers'])];
    if (!title || !artist) return [];
    return [...new Set(anime.map(normalize).filter(Boolean))].map(a => JSON.stringify([a, title, artist, type(song)]));
  }

  function encounterKey(song) {
    return JSON.stringify([String(song['JSON name'] || ''), String(song.songNumber || song['Song No.'] || song._sheetIndex || '')]);
  }

  function orderedSongs(rawSongs) {
    const seen = new Map();
    for (const song of rawSongs || []) {
      const key = encounterKey(song);
      if (seen.has(key)) {
        const first = seen.get(key);
        if (String(first.correctGuessPlayers) !== String(song.correctGuessPlayers)
          || String(first.incorrectGuessPlayers) !== String(song.incorrectGuessPlayers)) {
          throw new Error('Conflicting duplicate song records; this tour cannot be simulated reliably.');
        }
      } else seen.set(key, song);
    }
    return [...seen.values()].sort((a, b) => String(a['JSON name'] || '').localeCompare(String(b['JSON name'] || ''))
      || (numeric(a.songNumber) ?? 0) - (numeric(b.songNumber) ?? 0)
      || (numeric(a._sheetIndex) ?? 0) - (numeric(b._sheetIndex) ?? 0));
  }

  function findEligibleMisses({ rawSongs, historySongs = [], searchRows = [], relearnRows = [], identityNames, timestamp, canonicalName = normalize }) {
    const identities = new Set([...identityNames].map(name => normalize(canonicalName(name))));
    const isMe = (name, at = timestamp) => identities.has(normalize(canonicalName(name, at)));
    const known = new Set();
    const forced = new Set();
    const mark = (set, song) => songKeys(song).forEach(key => set.add(key));
    const tourDay = day(timestamp);
    for (const song of searchRows) {
      const pattern = [...String(song.pattern || '')].filter(char => char === '✅' || char === '❌');
      const dates = song.patternDates || [];
      if (pattern.some((result, i) => result === '✅' && day(dates[i]) && day(dates[i]) < tourDay)) mark(known, song);
    }
    // Precise tour timestamps resolve earlier tours on the same date. Never use future tours.
    for (const song of historySongs) {
      const date = String(song['Export Date'] || '').replace('T', ' ').replace(/Z$/, '');
      if (date && date < String(timestamp).replace('T', ' ').replace(/Z$/, '') && names(song.correctGuessPlayers).some(name => isMe(name, date))) mark(known, song);
    }
    for (const song of relearnRows) if (song.shouldKnow === true) mark(forced, song);
    const eligible = [];
    for (const song of orderedSongs(rawSongs)) {
      const correct = names(song.correctGuessPlayers).some(name => isMe(name));
      const wrong = names(song.incorrectGuessPlayers).some(name => isMe(name));
      if (!correct && !wrong) continue; // Never include matches the player did not see.
      if (wrong && !correct && songKeys(song).some(key => known.has(key) || forced.has(key))) eligible.push(song);
      if (correct) mark(known, song);
    }
    return eligible;
  }

  function simulate({ tourRows, rawSongs, eligibleMisses, identityNames, percentage = 100, canonicalName = normalize, timestamp, mode = 'watched', selectedEncounterKeys = null }) {
    const percent = Number(percentage);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Enter a percentage from 0 to 100.');
    if (String(timestamp || '').replace('T', ' ').slice(0, 19) < cutoff) throw new Error('What if supports the usefulness calculation used from February 16, 2026 onwards.');
    const canonical = name => normalize(canonicalName(name));
    const identities = new Set([...identityNames].map(canonical));
    const isMe = name => identities.has(canonical(name));
    const stats = new Map();
    for (const row of tourRows || []) {
      const key = canonical(row['Player name']);
      if (stats.has(key)) throw new Error('Duplicate player stats are present for this tour.');
      stats.set(key, row);
    }
    const target = [...stats.keys()].filter(key => identities.has(key));
    if (target.length !== 1) throw new Error('Could not identify your stats row for this tour.');
    const targetKey = target[0];
    const eloValues = [...stats.values()].map(row => numeric(row.Rank)).filter(Number.isFinite);
    if (eloValues.length !== stats.size) throw new Error('Tour Elo values are missing; usefulness cannot be recalculated reliably.');
    const rosterAverages = [...stats.values()].map(row => numeric(row.tour_average_elo)).filter(Number.isFinite);
    const hasSubstitutes = [...stats.values()].some(row => numeric(row.is_substitute) === 1);
    if (rosterAverages.some(value => Math.abs(value - rosterAverages[0]) > 1e-8)) {
      throw new Error('The original tour Elo average is inconsistent; please refresh the tour data.');
    }
    if (hasSubstitutes && !rosterAverages.length) {
      throw new Error('The original roster Elo average is missing for this substitute tour; please refresh the tour data.');
    }
    const averageElo = rosterAverages.length ? rosterAverages[0]
      : eloValues.reduce((sum, value) => sum + value, 0) / eloValues.length;
    const songs = orderedSongs(rawSongs);
    const eligibleKeys = new Set(eligibleMisses.map(encounterKey));
    const candidates = songs.filter(song => eligibleKeys.has(encounterKey(song))
      && names(song.incorrectGuessPlayers).some(name => isMe(name)) && !names(song.correctGuessPlayers).some(name => isMe(name)));
    const candidateKeys = new Set(candidates.map(encounterKey));
    const selectedKeys = selectedEncounterKeys == null
      ? new Set(candidates.slice(0, Math.round(candidates.length * percent / 100)).map(encounterKey))
      : new Set(selectedEncounterKeys);
    if ([...selectedKeys].some(key => !candidateKeys.has(key))) {
      throw new Error('Only eligible missed answers can be changed.');
    }
    const selectedSongs = candidates.filter(song => selectedKeys.has(encounterKey(song)));
    const added = selectedSongs.length;
    const createAccumulator = () => ({ songs: 0, hit: 0, weight: 0, sumK: 0, solos: 0, zeros: 0, sevens: 0, hard: 0,
      taken: 0, saved: 0, rigs: 0, rigHit: 0, rigSumK: 0, soloRigs: 0, missedSolos: 0, lostRig: 0, offSolos: 0,
      types: { '1': [0, 0, 0], '2': [0, 0, 0], '3': [0, 0, 0] } });
    const before = new Map([...stats.keys()].map(key => [key, createAccumulator()]));
    const after = new Map([...stats.keys()].map(key => [key, createAccumulator()]));
    const affected = new Set();
    for (const song of songs) {
      const correct = new Set(names(song.correctGuessPlayers).map(canonical));
      const wrong = new Set(names(song.incorrectGuessPlayers).map(canonical));
      const members = new Set([...correct, ...wrong]);
      if (members.size !== 8 || correct.size + wrong.size !== 8
        || correct.size !== numeric(song.correctCount) || wrong.size !== numeric(song.wrongCount)) {
        throw new Error('Some song results are incomplete or are not 4v4 matches; this tour cannot be simulated reliably.');
      }
      if ([...members].some(key => !stats.has(key))) throw new Error('Some song participants could not be matched to the stats sheet.');
      const riggers = new Set(names(song.listStates).map(canonical));
      const k = correct.size;
      const changed = selectedKeys.has(encounterKey(song));
      const nextCorrect = new Set(correct);
      if (changed) {
        nextCorrect.add(targetKey);
        for (const key of members) affected.add(key);
      }
      for (const [map, hits] of [[before, correct], [after, nextCorrect]]) {
        const count = hits.size;
        const teams = new Set([...members].map(key => String(stats.get(key).team ?? '')));
        const validTeams = teams.size === 2 && !teams.has('') && [...teams].every(team => [...members].filter(key => String(stats.get(key).team) === team).length === 4);
        for (const key of members) {
          const acc = map.get(key), hit = hits.has(key), onlist = riggers.has(key);
          acc.songs++;
          if (count === 0) acc.zeros++;
          if (count === 7 && !hit) acc.sevens++;
          if (hit) {
            acc.hit++; acc.weight += weights[count]; acc.sumK += count;
            if (count === 1) acc.solos++;
            if (count <= 3) acc.hard++;
            if (count === 1 && !onlist) acc.offSolos++;
          }
          if (onlist) {
            acc.rigs++; acc.rigSumK += count;
            if (hit) acc.rigHit++;
            if (riggers.size === 1) acc.soloRigs++;
            if (count === 0) acc.missedSolos++;
          }
          if (acc.types[type(song)]) {
            acc.types[type(song)][0]++;
            if (hit) acc.types[type(song)][1]++;
            if (onlist && !hit) acc.types[type(song)][2]++;
          }
          if (validTeams) {
            const team = String(stats.get(key).team);
            const ownHits = [...hits].filter(p => String(stats.get(p).team) === team).length;
            const otherHits = count - ownHits;
            if (hit && !otherHits) acc.taken++;
            if (hit && ownHits === 1 && otherHits > 0) acc.saved++;
            if (onlist && ownHits === 0 && otherHits > 0) acc.lostRig++;
          } else if (changed) throw new Error('Team assignments are incomplete for an affected match; lives saved/taken cannot be recalculated.');
        }
      }
    }
    // Partial exports must not silently replace missing rounds with invented results.
    for (const key of stats.keys()) {
      const acc = before.get(key), row = stats.get(key);
      if (acc.songs !== numeric(row['Total songs']) || acc.hit !== numeric(row['Total hit'])) {
        throw new Error('Linked song data does not cover the full stats sheet. What if is unavailable until the data is refreshed.');
      }
    }
    const fields = (acc, original) => {
      const rate = (hit, total) => total ? 100 * hit / total : null;
      const result = {
        'Total hit': acc.hit, 'Guess rate': rate(acc.hit, acc.songs),
        Usefulness: acc.songs ? acc.weight * averageElo * 8 / acc.songs : 0,
        erigs: acc.solos, '0/8s': acc.zeros, '7/8s': acc.sevens,
        'avg/8': acc.hit ? acc.sumK / acc.hit : null, '# 3/8s or below': acc.hard,
        'Lives taken': acc.taken, 'Lives saved': acc.saved,
      };
      for (const [id, label] of [['1', 'OP'], ['2', 'ED'], ['3', 'IN']]) {
        result[`${label} guess rate`] = rate(acc.types[id][1], acc.types[id][0]);
        if (mode === 'watched') result[`${label} Rigs Missed`] = acc.types[id][2];
      }
      if (mode === 'watched') Object.assign(result, {
        Onlist: rate(acc.rigHit, acc.rigs), Offlist: rate(acc.hit - acc.rigHit, acc.songs - acc.rigs),
        'Rigs hit': acc.rigHit, 'Rigs missed': acc.rigs - acc.rigHit,
        'Missed solos': acc.missedSolos, 'Lives lost on rigs': acc.lostRig,
        'Offlist erigs': acc.offSolos, 'avg/8 of your rigs': acc.rigs ? acc.rigSumK / acc.rigs : null,
      });
      return result;
    };
    const changedFields = new Map();
    const rows = [...stats].map(([key, original]) => {
      const row = { ...original };
      if (!affected.has(key)) return row;
      const oldValues = fields(before.get(key), original), newValues = fields(after.get(key), original);
      const changes = [];
      for (const field of Object.keys(newValues)) {
        if (!(field in row) || oldValues[field] === newValues[field] || Math.abs(oldValues[field] - newValues[field]) < 1e-10) continue;
        // Preserve the actual exported baseline (including harmless rounding).
        if (field === 'Usefulness') {
          const oldUF = numeric(original[field]);
          row[field] = oldUF == null ? newValues[field] : oldUF + newValues[field] - oldValues[field];
        } else row[field] = newValues[field];
        changes.push(field);
      }
      changedFields.set(original['Player name'], changes);
      return row;
    });
    return { rows, added, eligibleCount: candidates.length, percentage: percent, averageElo, changedFields,
      targetName: stats.get(targetKey)['Player name'], selectedKeys,
      selectedSongs, eligibleSongs: candidates };
  }
  return Object.freeze({ weights, cutoff, normalize, createPlayerNameResolver, songKeys, encounterKey, orderedSongs, findEligibleMisses, simulate });
});
