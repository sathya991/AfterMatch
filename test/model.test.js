import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateMatch, eventLog, seriesFor, comparison, momentContext, outcome, clock, itemName
} from '../dist/model.js';

const match = JSON.parse(await readFile(new URL('../dist/data/demo-match.json', import.meta.url)));
const heroes = JSON.parse(await readFile(new URL('../dist/data/heroes.json', import.meta.url)));
const slark = match.players[0];

test('sample data passes validation and team outcomes match player slots', () => {
  assert.equal(validateMatch(match), match);
  assert.equal(outcome(match, slark), 'Victory');
  assert.equal(outcome(match, match.players[5]), 'Defeat');
  assert.equal(outcome({ ...match, radiant_win: null }, slark), 'Result unavailable');
});

test('malformed files fail before replacing the current match', () => {
  assert.throws(() => validateMatch(null), /OpenDota match/);
  assert.throws(() => validateMatch({ ...match, duration: -1 }), /duration/);
  assert.throws(() => validateMatch({ ...match, players: [slark, slark] }), /duplicate/);
  assert.throws(() => validateMatch({ ...match, players: [{ ...slark, purchase_log: {} }] }), /purchase_log/);
});

test('death events use the victim identity in opposing kill logs', () => {
  const deaths = eventLog(match, slark, heroes).filter(event => event.type === 'death');
  assert.deepEqual(deaths.map(event => event.time), [515, 798, 1240, 1535]);
  assert.equal(deaths[1].title, 'Killed by Shadow Fiend');
  assert.equal(eventLog({ ...match, players: [{ ...slark, kills_log: [] }] }, slark, heroes).filter(event => event.type === 'death').length, 0);
});

test('timeline ignores pregame purchases and reads objectives separately', () => {
  const events = eventLog(match, slark, heroes);
  assert.ok(events.every(event => event.time >= 0 && event.time <= match.duration));
  assert.ok(!events.some(event => event.title === 'Tango'));
  assert.equal(events.filter(event => event.type === 'objective').length, 3);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
});

test('missing parsed data remains absent and corrupt series points are ignored', () => {
  assert.deepEqual(seriesFor({}, 'gold_t', 120), []);
  assert.deepEqual(seriesFor({ times: [-60, 0, 60, 120, 180], gold_t: [9, 0, null, 100, 200] }, 'gold_t', 120), [
    { time: 0, value: 0 }, { time: 120, value: 100 }
  ]);
});

test('baseline excludes current match and other heroes and averages only valid observations', () => {
  const rows = [
    { match_id: match.match_id, hero_id: 93, gold_per_min: 2000 },
    { match_id: 1, hero_id: 93, gold_per_min: 400, deaths: 4 },
    { match_id: 2, hero_id: 93, gold_per_min: 600, deaths: 6 },
    { match_id: 3, hero_id: 5, gold_per_min: 1500, deaths: 0 },
    { match_id: 4, hero_id: 93, gold_per_min: null, deaths: null }
  ];
  const baseline = comparison(rows, match, slark);
  assert.equal(baseline.count, 3);
  assert.equal(baseline.gpm, 500);
  assert.equal(baseline.deaths, 5);
  assert.equal(baseline.xpm, null);
});

test('moment context uses the last earlier gold sample and never future purchases', () => {
  const context = momentContext({ time: 798 }, slark, match);
  assert.equal(context.gold.time, 780);
  assert.deepEqual(context.nearbyItems.map(item => item.key), ['echo_sabre']);
  assert.ok(context.nearbyItems.every(item => item.time <= 798));
});

test('formatters preserve zero and negative pregame times', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(-61), '−1:01');
  assert.equal(clock(2280), '38:00');
  assert.equal(itemName('black_king_bar'), 'Black King Bar');
});

test('OpenDota building_kill events identify tower destruction', () => {
  const data = { ...match, objectives: [
    { time: 300, type: 'building_kill', key: 'npc_dota_badguys_tower1_mid' },
    { time: 400, type: 'building_kill', key: 'npc_dota_badguys_melee_rax_mid' }
  ] };
  const objectives = eventLog(data, slark, heroes).filter(event => event.type === 'objective');
  assert.equal(objectives.length, 1);
  assert.equal(objectives[0].title, 'Tower destroyed');
});

test('item constants supply user-facing names while unknown items have a readable fallback', () => {
  assert.equal(itemName('sheepstick', { sheepstick: { dname: 'Scythe of Vyse' } }), 'Scythe of Vyse');
  assert.equal(itemName('unknown_new_item'), 'Unknown New Item');
});
