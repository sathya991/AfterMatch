import {
  validateMatch, isRadiant, outcome, clock, itemName, heroName,
  seriesFor, eventLog, comparison, momentContext, hasReplayData, summaryFacts
} from './model.js';
import { requestReplay } from './replay.js';
import { coachingReport, practicePlan, appendPracticePlan } from './coach.js';

const API = 'https://api.opendota.com/api';
const NOTE_KEY = 'aftermatch.notes.v1';
const state = {
  match: null,
  slot: 0,
  heroes: {},
  items: {},
  events: [],
  metric: 'gold_t',
  filter: 'all',
  coachRole: 'unsure',
  eventId: null,
  baseline: null,
  baselineStatus: '',
  replay: { status: 'idle', message: '' },
  loading: false,
  notes: [],
  drafts: new Map()
};
let matchRequest = null;
let baselineRequest = null;
let replayRequest = null;
let toastTimer;

const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const number = value => Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';
const selectedPlayer = () => state.match.players.find(player => player.player_slot === state.slot);
const noteId = () => String(state.match.match_id) + ':' + state.slot;
const hero = player => heroName(player.hero_id, state.heroes);
const eventColors = { death: '#ee827d', kill: '#65dfc0', item: '#e6b96b', objective: '#a4b6ee' };
const eventSymbols = { death: '×', kill: '⚔', item: '◇', objective: '♜' };

function showStatus(message = '', kind = '') {
  const element = $('#status');
  element.innerHTML = message ? '<div class="status-message ' + kind + '">' + escapeHTML(message) + '</div>' : '';
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}

function initialNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(note =>
      note && typeof note.id === 'string' && typeof note.text === 'string' &&
      typeof note.hero === 'string' && Number.isFinite(note.savedAt)
    ).slice(0, 100);
  } catch {
    return [];
  }
}

function saveNotes(notes) {
  try {
    localStorage.setItem(NOTE_KEY, JSON.stringify(notes));
    state.notes = notes;
    return true;
  } catch {
    toast('Your browser could not save this note. Allow site storage or export your notes.');
    return false;
  }
}

async function fetchJSON(url, signal, options = {}) {
  const response = await fetch(url, { cache: url.startsWith(API) ? 'no-store' : 'default', ...options, signal });
  if (!response.ok) {
    if (response.status === 429) throw new Error('OpenDota is rate limiting requests. Wait a minute, then try again.');
    if (response.status === 404) throw new Error('That match was not found. Check the ID or import a saved match JSON.');
    throw new Error('The data service returned HTTP ' + response.status + '. Please try again.');
  }
  const result = await response.json();
  if (result?.error) throw new Error(String(result.error));
  return result;
}

function cancelBaseline() {
  baselineRequest?.abort();
  baselineRequest = null;
}

function cancelReplay() {
  replayRequest?.abort();
  replayRequest = null;
  if (state.replay.status === 'loading') {
    state.replay = { status: 'pending', message: 'Stopped checking for this replay. Any queued OpenDota analysis can continue. Refresh this match to check for new data.' };
  }
}

async function requestCurrentReplay() {
  if (replayRequest || state.loading) return;
  const id = String(state.match.match_id);
  const request = new AbortController();
  replayRequest = request;
  state.replay = { status: 'loading', message: 'Requesting replay analysis from OpenDota…' };
  const timeout = setTimeout(() => request.abort(), 120000);
  render();
  try {
    const result = await requestReplay(id, {
      signal: request.signal,
      request: (path, signal, options) => fetchJSON(API + path, signal, options),
      onProgress: message => {
        if (request !== replayRequest || String(state.match.match_id) !== id) return;
        state.replay.message = message;
        const status = $('#replay-message');
        if (status) status.textContent = message;
      }
    });
    if (request !== replayRequest || String(state.match.match_id) !== id) return;
    if (result.status === 'complete') {
      state.replay = { status: 'complete', message: 'Replay data is ready. Available timelines and events have been loaded.' };
      beginMatch(result.match);
    } else {
      state.replay = { status: 'pending', message: 'Replay data is still unavailable after 18 checks. The queue may still be running, or OpenDota may be unable to retrieve the replay. Use Refresh match data later or check the match on OpenDota.' };
    }
  } catch (error) {
    if (request !== replayRequest || String(state.match.match_id) !== id) return;
    state.replay = {
      status: 'error',
      message: request.signal.aborted
        ? 'Timed out waiting for OpenDota. Any queued analysis may continue. Refresh the match later.'
        : error.message || 'Could not request replay analysis. Try the match page on OpenDota.'
    };
  } finally {
    clearTimeout(timeout);
    if (request === replayRequest) {
      replayRequest = null;
      render();
    }
  }
}

function beginMatch(match) {
  cancelBaseline();
  validateMatch(match);
  const sameMatch = state.match && String(state.match.match_id) === String(match.match_id);
  const previousSlot = sameMatch ? state.slot : match.players[0].player_slot;
  state.match = match;
  state.slot = match.players.some(player => player.player_slot === previousSlot) ? previousSlot : match.players[0].player_slot;
  if (!sameMatch) {
    state.replay = { status: 'idle', message: '' };
    state.metric = 'gold_t';
    state.filter = 'all';
    state.coachRole = 'unsure';
  } else if (hasReplayData(match)) {
    state.replay = { status: 'complete', message: 'Replay data is ready. Available timelines and events have been loaded.' };
  } else if (state.replay.status === 'complete') {
    state.replay = { status: 'idle', message: '' };
  }
  state.eventId = null;
  state.baseline = null;
  state.baselineStatus = '';
  refreshEvents();
  if (match.demo) {
    state.baseline = comparison(match.demo_baseline || [], match, selectedPlayer());
  }
  render();
}

function refreshEvents() {
  state.events = eventLog(state.match, selectedPlayer(), state.heroes, state.items);
  state.eventId = (state.events.find(event => event.type === 'death') || state.events[0])?.id ?? null;
}

function setLoading(loading) {
  state.loading = loading;
  $('#load-button').disabled = loading;
  $('#load-button').innerHTML = loading ? 'Loading…' : 'Investigate <span>↗</span>';
  $('#match-content').setAttribute('aria-busy', String(loading));
  for (const selector of ['#request-replay', '#refresh-match']) {
    const button = $(selector);
    if (button) button.disabled = loading || state.replay.status === 'loading';
  }
}

async function loadMatch(id) {
  matchRequest?.abort();
  cancelReplay();
  cancelBaseline();
  const request = new AbortController();
  matchRequest = request;
  const timeout = setTimeout(() => request.abort('timeout'), 18000);
  setLoading(true);
  showStatus('Asking OpenDota for match #' + id + '…', 'loading');
  try {
    const match = await fetchJSON(API + '/matches/' + encodeURIComponent(id), request.signal);
    if (request !== matchRequest) return;
    validateMatch(match);
    if (String(match.match_id) !== id) throw new Error('The match service returned an unexpected match ID.');
    beginMatch(match);
    showStatus();
    const url = new URL(location.href);
    url.searchParams.set('match', id);
    history.replaceState(null, '', url);
  } catch (error) {
    if (request !== matchRequest) return;
    const message = request.signal.aborted
      ? 'The match request timed out. Try again or use Import JSON.'
      : error.message || 'Could not reach OpenDota. Try again or use Import JSON.';
    showStatus(message, 'error');
  } finally {
    clearTimeout(timeout);
    if (request === matchRequest) setLoading(false);
  }
}

async function loadDemo() {
  matchRequest?.abort();
  cancelReplay();
  cancelBaseline();
  const request = new AbortController();
  matchRequest = request;
  setLoading(true);
  try {
    const match = await fetchJSON('./data/demo-match.json', request.signal);
    if (request !== matchRequest) return;
    beginMatch(match);
    showStatus();
    $('#match-id').value = '';
    const url = new URL(location.href);
    url.searchParams.delete('match');
    history.replaceState(null, '', url);
  } catch (error) {
    if (request === matchRequest) showStatus('Could not open the sample match. Reload the page to try again.', 'error');
  } finally {
    if (request === matchRequest) setLoading(false);
  }
}

function choosePlayer(slot) {
  cancelBaseline();
  state.slot = slot;
  state.filter = 'all';
  state.coachRole = 'unsure';
  state.baseline = null;
  state.baselineStatus = '';
  refreshEvents();
  if (state.match.demo && slot === 0) {
    state.baseline = comparison(state.match.demo_baseline, state.match, selectedPlayer());
  }
  render();
}

async function loadBaseline() {
  const player = selectedPlayer();
  if (!Number.isInteger(player.account_id) || player.account_id === 4294967295) return;
  cancelBaseline();
  const request = new AbortController();
  baselineRequest = request;
  const key = noteId();
  const timeout = setTimeout(() => request.abort(), 18000);
  state.baselineStatus = 'Loading your recent games…';
  render();
  try {
    const rows = await fetchJSON(
      API + '/players/' + player.account_id + '/matches?hero_id=' + player.hero_id + '&limit=11&project=gold_per_min&project=xp_per_min&project=deaths',
      request.signal
    );
    if (request !== baselineRequest || key !== noteId()) return;
    if (!Array.isArray(rows)) throw new Error('The recent-game response was not valid.');
    const normalized = rows.map(row => ({
      ...row,
      win: typeof row.radiant_win === 'boolean' ? isRadiant(row) === row.radiant_win : null
    }));
    state.baseline = comparison(normalized, state.match, player);
    state.baselineStatus = state.baseline.count ? '' : 'No other public games for this hero were returned.';
  } catch (error) {
    if (request !== baselineRequest || key !== noteId()) return;
    state.baselineStatus = request.signal.aborted
      ? 'Recent games took too long to load. Try again.'
      : error.message || 'Unable to load recent games.';
  } finally {
    clearTimeout(timeout);
    if (request === baselineRequest && key === noteId()) {
      baselineRequest = null;
      render();
    }
  }
}

function portrait(player, mini = false) {
  const info = state.heroes[String(player.hero_id)];
  const initials = hero(player).split(' ').map(word => word[0]).slice(0, 2).join('');
  const image = info?.img
    ? '<img src="https://cdn.cloudflare.steamstatic.com' + escapeHTML(info.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
    : '';
  return '<div class="' + (mini ? 'mini-portrait' : 'hero-portrait') + '"><span>' + escapeHTML(initials) + '</span>' + image + '</div>';
}

function matchSummary(player) {
  const match = state.match;
  const result = outcome(match, player);
  const source = match.demo ? 'SAMPLE DATA · FICTIONAL MATCH' : 'OPENDOTA · ' + (match.match_id || 'IMPORTED MATCH') + (hasReplayData(match) ? ' · REPLAY DATA' : ' · SUMMARY ONLY');
  const date = Number.isFinite(match.start_time)
    ? new Date(match.start_time * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Illustrative match';
  return `
    <div class="review-heading">
      <h2 class="section-title">The match file <small>REVIEW / ${match.demo ? 'SAMPLE' : escapeHTML(match.match_id)}</small></h2>
      <span class="source-badge ${match.demo ? '' : 'live'}">${escapeHTML(source)}</span>
    </div>
    <section class="match-hero" aria-label="Selected hero and match result">
      ${portrait(player)}
      <div class="hero-copy">
        <p class="eyebrow">${isRadiant(player) ? 'RADIANT' : 'DIRE'} · SELECTED PLAYER</p>
        <h2>${escapeHTML(hero(player))}</h2>
        <div class="hero-meta"><span>${escapeHTML(player.personaname || 'Anonymous player')}</span><span>${date}</span><span>${clock(match.duration)} duration</span></div>
      </div>
      <div class="hero-outcome">
        <span class="result ${result === 'Defeat' ? 'defeat' : ''}">${result}</span>
        <span class="score">${number(match.radiant_score)}<em>:</em>${number(match.dire_score)}</span>
        <small>RADIANT / DIRE</small>
      </div>
    </section>
    <div class="stats-grid">
      <div class="stat-card"><p>K / D / A</p><strong>${number(player.kills)} / ${number(player.deaths)} / ${number(player.assists)}</strong></div>
      <div class="stat-card"><p>GOLD PER MINUTE</p><strong>${number(player.gold_per_min)}</strong><span>GPM</span></div>
      <div class="stat-card"><p>LAST HITS / DENIES</p><strong>${number(player.last_hits)} / ${number(player.denies)}</strong></div>
      <div class="stat-card"><p>FINAL NET WORTH</p><strong>${number(player.net_worth)}</strong><span>GOLD</span></div>
    </div>`;
}

function replayNotice() {
  const match = state.match;
  if (match.demo || !/^\d+$/.test(String(match.match_id))) return '';
  if (hasReplayData(match) && state.replay.status === 'idle') return '';
  const available = hasReplayData(match);
  const busy = state.replay.status === 'loading';
  const message = state.replay.message || 'OpenDota has the final score and stats for this match, but has not returned replay analysis. Charts, purchase timings, and death events need that extra data.';
  return '<section class="replay-notice ' + (available ? 'ready' : '') + '" id="replay-notice" aria-label="Replay data status">' +
    '<div><p class="eyebrow">MATCH DATA / ' + (available ? 'REPLAY AVAILABLE' : 'SUMMARY ONLY') + '</p><h3>' + (available ? 'Your replay data is ready.' : 'The match loaded. Replay analysis is missing.') + '</h3>' +
    '<p id="replay-message" role="status" aria-live="polite">' + escapeHTML(message) + '</p></div>' +
    '<div class="replay-actions">' +
    (available ? '' : '<button type="button" id="request-replay" class="primary-action" ' + (busy || state.loading ? 'disabled' : '') + '>' + (busy ? 'Waiting for OpenDota…' : 'Request replay analysis') + '</button>') +
    '<button type="button" id="refresh-match" class="secondary" ' + (busy || state.loading ? 'disabled' : '') + '>Refresh match data ↻</button>' +
    '<a href="https://www.opendota.com/matches/' + encodeURIComponent(match.match_id) + '" target="_blank" rel="noreferrer">View on OpenDota ↗</a></div></section>';
}

function summaryReport(player) {
  const facts = summaryFacts(state.match, player);
  return '<div class="summary-report"><p class="eyebrow">AVAILABLE FROM FINAL MATCH STATS</p><div class="summary-facts">' +
    '<div><strong>' + (facts.killParticipation === null ? '—' : facts.killParticipation.toFixed(1) + '%') + '</strong><span>Team kill participation</span></div>' +
    '<div><strong>' + number(facts.heroDamage) + '</strong><span>Hero damage</span></div>' +
    '<div><strong>' + number(facts.towerDamage) + '</strong><span>Tower damage</span></div>' +
    '</div><p>Kill participation = (kills + assists) ÷ team kills. These totals describe the match without assigning event times.</p></div>';
}

function chart(player) {
  const points = seriesFor(player, state.metric, state.match.duration);
  if (!points.length) {
    return '<div class="empty-state"><strong>' + (hasReplayData(state.match) ? 'No sampled timeline for this player' : 'Replay analysis is needed for the timeline') + '</strong>' + (hasReplayData(state.match) ? 'OpenDota did not include this metric for the selected player.' : 'The match loaded successfully. OpenDota currently has final stats only. Use Request replay analysis above to try to unlock event timings and charts.') + '</div>' + summaryReport(player);
  }
  const width = 660;
  const height = 205;
  const left = 44;
  const right = 14;
  const top = 12;
  const bottom = 30;
  const maximum = Math.max(...points.map(point => point.value), 1);
  const x = time => left + time / state.match.duration * (width - left - right);
  const y = value => height - bottom - value / maximum * (height - bottom - top);
  const polyline = points.map(point => x(point.time) + ',' + y(point.value)).join(' ');
  const area = x(points[0].time) + ',' + (height - bottom) + ' ' + polyline + ' ' + x(points.at(-1).time) + ',' + (height - bottom);
  const valueAt = time => points.filter(point => point.time <= time).at(-1)?.value ?? points[0].value;
  const metricLabel = { gold_t: 'Total gold earned', xp_t: 'Experience', lh_t: 'Last hits' }[state.metric];
  let grid = '';
  for (let i = 0; i <= 3; i++) {
    const value = maximum * i / 3;
    const label = value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(Math.round(value));
    grid += '<line class="grid-line" x1="' + left + '" y1="' + y(value) + '" x2="' + (width - right) + '" y2="' + y(value) + '"/>';
    grid += '<text text-anchor="end" x="' + (left - 9) + '" y="' + (y(value) + 4) + '">' + label + '</text>';
  }
  for (let i = 0; i <= 4; i++) {
    const time = state.match.duration * i / 4;
    grid += '<text text-anchor="middle" x="' + x(time) + '" y="' + (height - 7) + '">' + clock(time) + '</text>';
  }
  const markers = state.events.filter(event => event.type === 'death' || event.id === state.eventId).map(event => {
    const selected = event.id === state.eventId;
    return `<g class="event-hit" role="button" tabindex="0" data-event="${event.id}" aria-label="${escapeHTML(event.title + ' at ' + clock(event.time))}">
      <title>${escapeHTML(event.title)} · ${clock(event.time)}</title>
      ${selected ? '<line x1="' + x(event.time) + '" y1="10" x2="' + x(event.time) + '" y2="' + (height - bottom) + '" stroke="#698d8b" stroke-dasharray="3 4"/>' : ''}
      <circle cx="${x(event.time)}" cy="${y(valueAt(event.time))}" r="${selected ? 6 : 4}" fill="${eventColors[event.type]}" stroke="#101923" stroke-width="2"/>
    </g>`;
  }).join('');
  return `
    <div class="chart-wrap">
      <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${metricLabel} over match time. Deaths are marked in red; select a point to inspect it.">
        <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#65dfc0" stop-opacity=".15"/><stop offset="1" stop-color="#65dfc0" stop-opacity="0"/></linearGradient></defs>
        ${grid}<polygon points="${area}" fill="url(#chart-fill)"/><polyline class="line" points="${polyline}"/>${markers}
      </svg>
      <p class="chart-note"><span><i class="legend-dot"></i>${metricLabel}</span><span><i class="legend-dot death"></i>Recorded death</span><span>Click a moment to investigate</span></p>
    </div>`;
}

function eventSymbol(event) {
  const item = event.itemKey && state.items[event.itemKey];
  const picture = item?.img
    ? '<img src="https://cdn.cloudflare.steamstatic.com' + escapeHTML(item.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
    : '';
  return eventSymbols[event.type] + picture;
}

function timeline(player) {
  const filtered = state.events.filter(event => state.filter === 'all' || event.type === state.filter);
  const filters = [['all', 'All moments'], ['death', 'Deaths'], ['item', 'Purchases'], ['kill', 'Kills'], ['objective', 'Objectives']];
  const rows = filtered.map(event => `
    <button type="button" class="event-row ${event.id === state.eventId ? 'selected' : ''}" data-event="${event.id}" aria-pressed="${event.id === state.eventId}">
      <span class="event-time">${clock(event.time)}</span><span class="event-icon ${event.type}">${eventSymbol(event)}</span>
      <span><span class="event-label">${escapeHTML(event.title)}</span><span class="event-sublabel">${{ death: 'Player death', kill: 'Player kill', item: 'Item purchase', objective: 'Match objective' }[event.type]}</span></span>
      <span class="event-arrow">↗</span>
    </button>`).join('');
  const hasKillLogs = state.match.players.some(entry => Array.isArray(entry.kills_log));
  const event = state.events.find(entry => entry.id === state.eventId);
  let detail = '';
  if (event) {
    const context = momentContext(event, player, state.match);
    detail = `<div class="moment-detail">
      <p class="eyebrow">MOMENT UNDER THE LENS / ${clock(event.time)}</p>
      <h4>${escapeHTML(event.title)}</h4>
      <p>${escapeHTML(event.detail)}</p>
      ${context.gold ? '<p>Last sampled gold earned: <strong>' + number(context.gold.value) + '</strong> at ' + clock(context.gold.time) + '.</p>' : ''}
      ${context.nearbyItems.length ? '<p>Purchased in the previous 3 minutes: ' + escapeHTML(context.nearbyItems.map(item => itemName(item.key, state.items)).join(', ')) + '.</p>' : ''}
    </div>`;
  }
  return `<section class="panel" id="timeline">
    <div class="panel-head"><div><h3>The turning points</h3><p>Explore the record. Decide what to try next.</p></div>
      <div class="segmented" aria-label="Chart metric">
        ${[['gold_t', 'Gold'], ['xp_t', 'XP'], ['lh_t', 'Last hits']].map(([key, label]) => '<button type="button" data-metric="' + key + '" class="' + (key === state.metric ? 'selected' : '') + '" aria-pressed="' + (key === state.metric) + '">' + label + '</button>').join('')}
      </div>
    </div>
    ${chart(player)}
    <div class="timeline-filters" aria-label="Filter events">${filters.map(([key, label]) => '<button type="button" class="chip ' + (state.filter === key ? 'selected' : '') + '" data-filter="' + key + '" aria-pressed="' + (state.filter === key) + '">' + label + '</button>').join('')}</div>
    <div class="events">${rows || '<div class="empty-state compact">No recorded events for this filter.</div>'}</div>
    ${detail}
    <p class="panel-caption" style="padding-top:12px">${hasKillLogs ? 'Death markers are reconstructed from available opponent kill logs. Missing events do not mean the player survived.' : 'Kill logs are unavailable. Death timings cannot be reconstructed from the final death count.'}</p>
  </section>`;
}

function baselinePanel(player) {
  let content;
  const baseline = state.baseline;
  if (baseline?.count) {
    const entries = [
      ['GOLD / MIN', player.gold_per_min, baseline.gpm, true],
      ['XP / MIN', player.xp_per_min, baseline.xpm, true],
      ['DEATHS / GAME', player.deaths, baseline.deaths, false]
    ];
    content = '<div class="comparison-grid">' + entries.map(([label, current, average, higherIsBetter]) => {
      const delta = Number.isFinite(current) && Number.isFinite(average) ? current - average : null;
      const good = delta === null || (higherIsBetter ? delta >= 0 : delta <= 0);
      const change = delta === null ? 'Comparison unavailable' : (delta > 0 ? '+' : '') + delta.toFixed(1) + ' vs your average';
      return '<div class="compare-stat"><p>' + label + '</p><strong>' + number(current) + '</strong><small>avg ' + (average === null ? '—' : average.toFixed(0)) + '</small><span class="delta ' + (good ? '' : 'negative') + '">' + change + '</span></div>';
    }).join('') + '</div><p class="panel-caption">' + (state.match.demo ? 'Illustrative baseline from 5 fictional Slark matches.' : 'Average of ' + baseline.count + ' other public ' + escapeHTML(hero(player)) + ' games. Game lengths, roles, and patches may differ.') + ' These comparisons describe performance; they do not establish why a match was won.</p>';
  } else if (state.match.demo) {
    content = '<div class="empty-state compact">The sample baseline is available for Slark. Select Slark to explore it.</div>';
  } else if (!Number.isInteger(player.account_id) || player.account_id === 4294967295) {
    content = '<div class="empty-state compact"><strong>OpenDota did not return this player’s account ID</strong>The current match can still be reviewed. Comparing past games also requires a public account ID and public history. Replay analysis may add data, but does not guarantee a player identity.</div>';
  } else {
    content = '<div class="empty-state compact">' + escapeHTML(state.baselineStatus || 'Compare this match with up to 10 recent public games on ' + hero(player) + '.') + '<br><button type="button" class="secondary" id="baseline-button" ' + (baselineRequest ? 'disabled' : '') + '>Load recent games ⇄</button></div>';
  }
  return '<section class="panel" id="comparison"><div class="panel-head"><div><h3>You vs. your usual</h3><p>Same hero. Your own recent games.</p></div><span class="source-badge ' + (state.match.demo ? '' : 'live') + '">' + (state.match.demo ? 'SAMPLE BASELINE' : 'PERSONAL BASELINE') + '</span></div>' + content + '</section>';
}

function playerPanel() {
  const list = team => state.match.players.filter(player => isRadiant(player) === team).map(player => `
    <button type="button" class="player-button ${player.player_slot === state.slot ? 'selected' : ''}" data-player="${player.player_slot}" aria-pressed="${player.player_slot === state.slot}">
      ${portrait(player, true)}
      <span><span class="player-name">${escapeHTML(hero(player))}</span><span class="player-sub">${escapeHTML(player.personaname || 'Anonymous player')}</span></span>
      <span class="player-kills">${number(player.kills)}</span>
    </button>`).join('');
  return '<section class="panel players-panel"><div class="panel-head"><h3>The lineup</h3><p>SELECT PLAYER</p></div><div class="team-header"><span>● RADIANT</span><span>KILLS</span></div><div class="player-list">' + list(true) + '</div><div class="team-header dire"><span>● DIRE</span><span>KILLS</span></div><div class="player-list">' + list(false) + '</div><p class="side-info">Switch players to explore their match record. Names and stats come from the loaded data.</p></section>';
}

function notebook(player) {
  const saved = state.notes.find(note => note.id === noteId());
  const draft = state.drafts.get(noteId()) ?? saved?.text ?? '';
  const notes = state.notes.slice().sort((a, b) => b.savedAt - a.savedAt).slice(0, 5);
  return `<section class="panel note-card" id="notebook">
    <p class="eyebrow">✦ TAKE ONE THING FORWARD</p>
    <h3>A note for next game.</h3>
    <p>What would you like to try differently on ${escapeHTML(hero(player))}?</p>
    <label class="muted" for="takeaway" style="font-size:9px">YOUR TAKEAWAY</label>
    <textarea id="takeaway" maxlength="1000" placeholder="e.g. Check the minimap before walking up to the next wave.">${escapeHTML(draft)}</textarea>
    <div class="note-actions"><small>Saved in this browser</small><button class="save-button" id="save-note" type="button">Save note ↗</button></div>
    ${notes.length ? '<div class="notebook-list"><p class="eyebrow">RECENT FIELD NOTES</p>' + notes.map(note => '<article class="saved-note"><small>' + escapeHTML(note.hero) + ' · ' + (note.demo ? 'Sample match' : '#' + escapeHTML(note.matchId)) + '</small><p>' + escapeHTML(note.text) + '</p><button type="button" class="delete-note" data-delete-note="' + escapeHTML(note.id) + '">Delete</button></article>').join('') + '<button type="button" class="export-button" id="export-notes">Export all notes ↓</button></div>' : ''}
  </section>`;
}

function currentCoaching() {
  return coachingReport(state.match, selectedPlayer(), state.heroes, {
    role: state.coachRole,
    items: state.items
  });
}

function coachingPanel() {
  const report = currentCoaching();
  const roleChoices = [['unsure', 'Unsure'], ['core', 'Core'], ['support', 'Support']];
  const cards = report.cards.map((card, index) => {
    const moments = card.moments.map(moment =>
      '<button type="button" class="coach-moment" data-coach-event="' + moment.eventId + '">Inspect ' + clock(moment.time) + ' ↗</button>'
    ).join('');
    return '<article class="coach-card">' +
      '<div class="coach-card-heading"><span class="coach-priority">' + (index + 1) + '</span><h4>' + escapeHTML(card.title) + '</h4></div>' +
      '<p class="coach-evidence">' + escapeHTML(card.observation) + '</p>' +
      '<p class="coach-action"><strong>Try next game</strong> ' + escapeHTML(card.action) + '</p>' +
      '<p class="coach-target"><strong>Track over three games</strong> ' + escapeHTML(card.measure) + '</p>' +
      '<details class="coach-details"><summary>Review drill and evidence limits</summary><p>' + escapeHTML(card.drill) + '</p><p>' + escapeHTML(card.context) + '</p></details>' +
      '<div class="coach-moments">' + moments + '</div>' +
      '<button type="button" class="save-plan" data-coach-plan="' + card.id + '">Save this practice plan ↗</button>' +
      '</article>';
  }).join('');
  let empty = '';
  if (!report.cards.length) {
    empty = report.hasReplay
      ? '<div class="coach-empty"><strong>No clear priority from the current checks.</strong><p>Select Core for lane-farm guidance where applicable, or choose a moment from the timeline to review. A match with no triggered rule does not establish that every decision was good.</p></div>'
      : '<div class="coach-empty"><strong>Replay data is needed for an evidence-based practice plan.</strong><p>Use Request replay analysis above. Final totals alone cannot identify the timing or cause of a mistake.</p></div>';
  }
  return '<section class="panel coaching-panel" id="coaching" aria-label="Next-game coaching">' +
    '<div class="panel-head"><div><p class="eyebrow">FROM REVIEW TO PRACTICE</p><h3>Your next-game plan</h3><p>Choose one focus. Try it deliberately. Check the result.</p></div>' +
    '<div class="coach-role"><span>Your role this match</span><div class="segmented">' +
    roleChoices.map(([key, label]) => '<button type="button" data-coach-role="' + key + '" class="' + (state.coachRole === key ? 'selected' : '') + '" aria-pressed="' + (state.coachRole === key) + '">' + label + '</button>').join('') +
    '</div></div></div>' +
    '<p class="coach-explainer">Suggestions come from recorded patterns and a small set of coaching rules. Confirm the cause in your Dota replay before treating a pattern as a mistake.</p>' +
    cards + empty + '</section>';
}

function saveCoachingPlan(id) {
  const card = currentCoaching().cards.find(entry => entry.id === id);
  if (!card) return;
  const textarea = $('#takeaway');
  try {
    const value = appendPracticePlan(textarea.value, practicePlan(card, hero(selectedPlayer())));
    textarea.value = value;
    state.drafts.set(noteId(), value);
    saveTakeaway();
  } catch (error) {
    toast(error.message);
  }
}

function render() {
  const player = selectedPlayer();
  $('#match-content').innerHTML = matchSummary(player) + replayNotice() + '<div class="review-grid"><div>' + coachingPanel() + timeline(player) + baselinePanel(player) + '<p class="data-footnote">' + (state.match.demo ? 'Sample data is fictional and is provided to demonstrate the interface. Load a match ID for real OpenDota data.' : 'OpenDota data can be incomplete or arrive after a delay. No conclusions are inferred from missing fields.') + '</p></div><div>' + playerPanel() + notebook(player) + '</div></div>';
  $('#notes-count').textContent = String(state.notes.length);
  document.querySelectorAll('.hero-portrait img, .mini-portrait img, .event-icon img').forEach(image => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });
}

function saveTakeaway() {
  const value = $('#takeaway').value.trim();
  if (!value) return toast('Write a takeaway before saving.');
  const player = selectedPlayer();
  const entry = { id: noteId(), matchId: state.match.match_id, slot: state.slot, hero: hero(player), text: value, demo: Boolean(state.match.demo), savedAt: Date.now() };
  const next = [entry, ...state.notes.filter(note => note.id !== entry.id)].slice(0, 100);
  if (!saveNotes(next)) return;
  state.drafts.delete(entry.id);
  render();
  toast('Takeaway saved. Bring it into the next game.');
}

function exportNotes() {
  const file = new Blob([JSON.stringify({ version: 1, notes: state.notes }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'aftermatch-field-notes.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#match-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = $('#match-id').value.trim();
  if (!/^\d{1,16}$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    return showStatus('Enter a positive numeric match ID, such as 8460019988.', 'error');
  }
  loadMatch(id);
});
$('#demo-button').addEventListener('click', loadDemo);
$('#json-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return showStatus('Choose a JSON file smaller than 10 MB.', 'error');
  matchRequest?.abort();
  cancelReplay();
  cancelBaseline();
  const request = new AbortController();
  matchRequest = request;
  setLoading(true);
  try {
    const match = validateMatch(JSON.parse(await file.text()));
    if (request !== matchRequest) return;
    if (match.match_id === undefined || match.match_id === null || typeof match.match_id === 'object') {
      throw new Error('The match JSON needs a match_id.');
    }
    beginMatch(match);
    showStatus('Opened a local JSON file. The file contents stay in your browser.');
    const url = new URL(location.href);
    url.searchParams.delete('match');
    history.replaceState(null, '', url);
  } catch (error) {
    if (request === matchRequest) showStatus(error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message, 'error');
  } finally {
    if (request === matchRequest) setLoading(false);
  }
});

$('#match-content').addEventListener('input', event => {
  if (event.target.id === 'takeaway') state.drafts.set(noteId(), event.target.value);
});

$('#match-content').addEventListener('click', event => {
  const target = event.target.closest('button, [data-event]');
  if (!target) return;
  if (target.dataset.player !== undefined) {
    choosePlayer(Number(target.dataset.player));
  } else if (target.dataset.coachRole) {
    state.coachRole = target.dataset.coachRole;
    render();
  } else if (target.dataset.coachPlan) {
    saveCoachingPlan(target.dataset.coachPlan);
  } else if (target.dataset.coachEvent !== undefined) {
    state.eventId = Number(target.dataset.coachEvent);
    state.filter = 'death';
    state.metric = 'gold_t';
    render();
    $('#timeline').scrollIntoView({ block: 'start' });
  } else if (target.dataset.metric) {
    state.metric = target.dataset.metric;
    render();
  } else if (target.dataset.filter) {
    state.filter = target.dataset.filter;
    render();
  } else if (target.dataset.event !== undefined) {
    const scroll = $('.events')?.scrollTop || 0;
    state.eventId = Number(target.dataset.event);
    render();
    if ($('.events')) $('.events').scrollTop = scroll;
  } else if (target.id === 'request-replay') {
    requestCurrentReplay();
  } else if (target.id === 'refresh-match') {
    loadMatch(String(state.match.match_id));
  } else if (target.id === 'baseline-button') {
    loadBaseline();
  } else if (target.id === 'save-note') {
    saveTakeaway();
  } else if (target.id === 'export-notes') {
    exportNotes();
  } else if (target.dataset.deleteNote) {
    if (saveNotes(state.notes.filter(note => note.id !== target.dataset.deleteNote))) {
      state.drafts.delete(target.dataset.deleteNote);
      render();
      toast('Note deleted.');
    }
  }
});
$('#match-content').addEventListener('keydown', event => {
  const point = event.target.closest('[data-event][role="button"]');
  if (point && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    point.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

async function init() {
  state.notes = initialNotes();
  try {
    [state.heroes, state.items] = await Promise.all([fetchJSON('./data/heroes.json'), fetchJSON('./data/items.json')]);
    const id = new URL(location.href).searchParams.get('match');
    if (id && /^\d{1,16}$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0) {
      await loadDemo();
      $('#match-id').value = id;
      await loadMatch(id);
    } else {
      await loadDemo();
    }
  } catch {
    showStatus('The app could not load its data dictionaries. Reload to try again.', 'error');
    $('#match-content').innerHTML = '<div class="empty-state">Unable to initialize AfterMatch.</div>';
  }
}
init();
