import test from 'node:test';
import assert from 'node:assert/strict';
import { coachingReport, practicePlan, appendPracticePlan } from '../dist/coach.js';

const heroes = {
  93: { name: 'npc_dota_hero_slark', localized_name: 'Slark' },
  14: { name: 'npc_dota_hero_pudge', localized_name: 'Pudge' }
};
function fixture() {
  const player = {
    player_slot: 4, hero_id: 93, deaths: 6, kills: 4, assists: 12,
    times: [0, 600, 1200], gold_t: [0, 3400, 6500], lh_t: [0, 25, 72],
    purchase_log: [], kills_log: []
  };
  const enemy = {
    player_slot: 128, hero_id: 14,
    kills_log: [87, 251, 372, 441, 1250, 1516].map(time => ({ time, key: 'npc_dota_hero_slark' }))
  };
  return { player, match: { match_id: 1, duration: 3032, players: [player, enemy] } };
}

test('four early deaths produce a specific priority, evidence, and a personal practice target', () => {
  const { match, player } = fixture();
  const result = coachingReport(match, player, heroes);
  assert.equal(result.cards[0].id, 'early-deaths');
  assert.match(result.cards[0].observation, /4 recorded deaths/);
  assert.match(result.cards[0].observation, /Pudge.*4/);
  assert.deepEqual(result.cards[0].moments.map(moment => moment.time), [87, 251, 372, 441]);
  assert.match(result.cards[0].measure, /at most 3 deaths/);
  assert.ok(result.cards[0].action.length > 30);
  assert.match(result.cards[0].context, /Review your Dota replay/);
});

test('core farm guidance is enabled explicitly and has a personal goal instead of an assumed universal target', () => {
  const { match, player } = fixture();
  assert.ok(!coachingReport(match, player, heroes, { role: 'support' }).cards.some(card => card.id === 'lane-farm'));
  assert.ok(!coachingReport(match, player, heroes).cards.some(card => card.id === 'lane-farm'));
  const farm = coachingReport(match, player, heroes, { role: 'core' }).cards.find(card => card.id === 'lane-farm');
  assert.match(farm.measure, /at least 30 last hits/);
  assert.match(farm.context, /app heuristic/);
});

test('incomplete death logs do not produce a falsely precise numerical survival target', () => {
  const { match, player } = fixture();
  match.players[1].kills_log = match.players[1].kills_log.slice(0, 3);
  const card = coachingReport(match, player, heroes).cards[0];
  assert.match(card.context, /3 of 6/);
  assert.doesNotMatch(card.measure, /at most/);
});

test('farm guidance needs an actual ten-minute sample and does not infer one from final totals', () => {
  const { match, player } = fixture();
  player.times = [0, 540, 660];
  player.lh_t = [0, 23, 30];
  assert.ok(!coachingReport(match, player, heroes, { role: 'core' }).cards.some(card => card.id === 'lane-farm'));
});

test('missing item-use data is distinct from a recorded zero', () => {
  const { match, player } = fixture();
  player.purchase_log = [{ key: 'black_king_bar', time: 1000 }];
  assert.ok(!coachingReport(match, player, heroes).cards.some(card => card.id === 'active-item'));
  player.item_uses = { black_king_bar: 0 };
  const card = coachingReport(match, player, heroes).cards.find(entry => entry.id === 'active-item');
  assert.ok(card);
  assert.match(card.context, /cannot establish/);
  player.item_uses.black_king_bar = 1;
  assert.ok(!coachingReport(match, player, heroes).cards.some(card => card.id === 'active-item'));
});

test('summary-only matches do not produce a fabricated practice diagnosis', () => {
  const player = { hero_id: 93, player_slot: 4, kills: 4, deaths: 6 };
  const report = coachingReport({ duration: 3032, players: [player] }, player, heroes);
  assert.equal(report.hasReplay, false);
  assert.equal(report.cards.length, 0);
});

test('three later deaths to one opponent can raise a repeated-opponent review', () => {
  const { match, player } = fixture();
  match.players[1].kills_log = [1000, 1300, 1500].map(time => ({ time, key: 'npc_dota_hero_slark' }));
  const report = coachingReport(match, player, heroes);
  assert.equal(report.cards[0].id, 'repeated-killer');
  assert.match(report.cards[0].action, /last known location/);
});

test('saving a plan preserves the existing note, avoids duplicates, and rejects overflow', () => {
  const { match, player } = fixture();
  const plan = practicePlan(coachingReport(match, player, heroes).cards[0], 'Slark');
  const note = appendPracticePlan('My original note.', plan);
  assert.ok(note.startsWith('My original note.'));
  assert.ok(note.includes('Next game:'));
  assert.equal(appendPracticePlan(note, plan), note);
  assert.throws(() => appendPracticePlan('x'.repeat(999), plan), /1,000/);
});
