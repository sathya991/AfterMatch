export function validateMatch(data) {
  if (!data || !Array.isArray(data.players) || !data.players.length) {
    throw new Error('This file does not contain an OpenDota match with players.');
  }
  if (!Number.isFinite(data.duration) || data.duration <= 0) {
    throw new Error('The match duration is missing or invalid.');
  }
  if (data.players.some(player => !Number.isInteger(player.player_slot) || !Number.isInteger(player.hero_id))) {
    throw new Error('The match has invalid player slots or hero identifiers.');
  }
  if (new Set(data.players.map(player => player.player_slot)).size !== data.players.length) {
    throw new Error('The match contains duplicate player slots.');
  }
  if (data.objectives != null && !Array.isArray(data.objectives)) {
    throw new Error('The match objectives must be a list.');
  }
  for (const player of data.players) {
    for (const field of ['purchase_log', 'kills_log', 'times', 'gold_t', 'xp_t', 'lh_t']) {
      if (player[field] != null && !Array.isArray(player[field])) {
        throw new Error('Invalid player ' + field + ': expected a list.');
      }
    }
    for (const field of ['purchase_log', 'kills_log']) {
      if (player[field]?.some(event => !event || typeof event !== 'object')) {
        throw new Error('Invalid event in player ' + field + '.');
      }
    }
  }
  if (data.objectives?.some(event => !event || typeof event !== 'object')) {
    throw new Error('The match contains invalid objective events.');
  }
  return data;
}

export function isRadiant(player) {
  return player.player_slot < 128;
}

export function outcome(match, player) {
  if (typeof match.radiant_win !== 'boolean') return 'Result unavailable';
  return isRadiant(player) === match.radiant_win ? 'Victory' : 'Defeat';
}

export function clock(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '−' : '';
  const total = Math.floor(Math.abs(seconds));
  return sign + Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

export function itemName(key, items = {}) {
  if (items[key]?.dname) return items[key].dname;
  return String(key || 'Unknown item').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function heroName(id, heroes) {
  return heroes[String(id)]?.localized_name || 'Hero ' + id;
}

export function seriesFor(player, field, duration) {
  if (!Array.isArray(player.times) || !Array.isArray(player[field])) return [];
  return player.times.flatMap((time, index) => {
    const value = player[field][index];
    return Number.isFinite(time) && time >= 0 && time <= duration && Number.isFinite(value)
      ? [{ time, value }]
      : [];
  }).sort((a, b) => a.time - b.time);
}

export function eventLog(match, player, heroes, items = {}) {
  const events = [];
  const canonicalName = heroes[String(player.hero_id)]?.name;
  const namedHero = value => {
    const hero = Object.values(heroes).find(entry => entry.name === value);
    return hero?.localized_name || String(value || 'unknown hero').replace('npc_dota_hero_', '').replaceAll('_', ' ');
  };
  const add = event => {
    if (Number.isFinite(event.time) && event.time >= 0 && event.time <= match.duration) events.push(event);
  };
  for (const event of player.purchase_log || []) {
    add({ time: event.time, type: 'item', title: itemName(event.key, items), itemKey: event.key, detail: 'Purchase recorded in the match log.' });
  }
  for (const event of player.kills_log || []) {
    add({ time: event.time, type: 'kill', title: 'Killed ' + namedHero(event.key), detail: 'Kill recorded for the selected player.' });
  }
  if (canonicalName) {
    for (const killer of match.players) {
      if (isRadiant(killer) === isRadiant(player)) continue;
      for (const event of killer.kills_log || []) {
        if (event.key !== canonicalName) continue;
        add({
          time: event.time,
          type: 'death',
          title: 'Killed by ' + heroName(killer.hero_id, heroes),
          detail: 'Reconstructed from an opposing player’s kill log. Event timing is not a full replay.'
        });
      }
    }
  }
  for (const event of match.objectives || []) {
    if (event.type === 'CHAT_MESSAGE_TOWER_KILL' || (event.type === 'building_kill' && String(event.key).includes('tower'))) {
      const tower = String(event.key || '').replace('npc_dota_', '').replaceAll('_', ' ');
      add({ time: event.time, type: 'objective', title: 'Tower destroyed', detail: tower || 'Tower event recorded in the match log.' });
    }
    if (event.type === 'CHAT_MESSAGE_ROSHAN_KILL') {
      const team = event.team === 2 ? 'Radiant' : event.team === 3 ? 'Dire' : 'A team';
      add({ time: event.time, type: 'objective', title: 'Roshan killed', detail: team + ' killed Roshan.' });
    }
  }
  return events.sort((a, b) => a.time - b.time).map((event, index) => ({ ...event, id: index }));
}

export function comparison(rows, match, player) {
  const recent = rows.filter(row =>
    row && typeof row === 'object' && String(row.match_id) !== String(match.match_id) &&
    (!Number.isInteger(row.hero_id) || row.hero_id === player.hero_id)
  ).slice(0, 10);
  const average = field => {
    const values = recent.map(row => row[field]).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return { count: recent.length, gpm: average('gold_per_min'), xpm: average('xp_per_min'), deaths: average('deaths') };
}

export function momentContext(event, player, match) {
  const gold = seriesFor(player, 'gold_t', match.duration).filter(point => point.time <= event.time).at(-1);
  const nearbyItems = (player.purchase_log || []).filter(item =>
    Number.isFinite(item.time) && item.time >= 0 && item.time <= event.time && event.time - item.time <= 180
  );
  return { gold, nearbyItems };
}

export function hasReplayData(match) {
  return match.players.some(player =>
    seriesFor(player, 'gold_t', match.duration).length > 0 ||
    seriesFor(player, 'xp_t', match.duration).length > 0 ||
    seriesFor(player, 'lh_t', match.duration).length > 0 ||
    player.kills_log?.length > 0 ||
    player.purchase_log?.length > 0
  );
}

export function summaryFacts(match, player) {
  const teamKills = isRadiant(player) ? match.radiant_score : match.dire_score;
  const participation = Number.isFinite(player.kills) && Number.isFinite(player.assists)
    ? player.kills + player.assists
    : null;
  return {
    killParticipation: Number.isFinite(teamKills) && teamKills > 0 && participation !== null && participation <= teamKills
      ? participation / teamKills * 100
      : null,
    heroDamage: Number.isFinite(player.hero_damage) ? player.hero_damage : null,
    towerDamage: Number.isFinite(player.tower_damage) ? player.tower_damage : null
  };
}
