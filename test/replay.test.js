import test from 'node:test';
import assert from 'node:assert/strict';
import { requestReplay } from '../dist/replay.js';
import { hasReplayData, summaryFacts } from '../dist/model.js';

const summary = {
  match_id: 9076934306,
  duration: 3032,
  radiant_score: 51,
  dire_score: 32,
  players: [{ player_slot: 4, hero_id: 93, kills: 4, assists: 12, hero_damage: 12149, tower_damage: 2577 }],
  od_data: { has_parsed: false }
};
const parsed = {
  ...summary,
  players: [{ ...summary.players[0], times: [0, 60], gold_t: [0, 250] }]
};

test('unparsed metadata and final statistics do not become a fabricated timeline', () => {
  assert.equal(hasReplayData(summary), false);
  assert.equal(hasReplayData({ ...summary, od_data: { has_parsed: true } }), false);
  assert.equal(hasReplayData(parsed), true);
});

test('summary report derives participation from team kills and preserves missing and zero values', () => {
  const facts = summaryFacts(summary, summary.players[0]);
  assert.equal(facts.killParticipation, 16 / 51 * 100);
  assert.equal(facts.heroDamage, 12149);
  assert.equal(facts.towerDamage, 2577);
  const missing = summaryFacts({ ...summary, radiant_score: 0 }, { player_slot: 4, hero_damage: 0 });
  assert.equal(missing.killParticipation, null);
  assert.equal(missing.heroDamage, 0);
  assert.equal(missing.towerDamage, null);
});

test('analysis submits once and only completes after actual replay data arrives', async () => {
  const calls = [];
  let reads = 0;
  const progress = [];
  const result = await requestReplay(summary.match_id, {
    pause: async () => {},
    onProgress: message => progress.push(message),
    request: async (path, signal, options) => {
      calls.push({ path, method: options?.method || 'GET' });
      if (options?.method === 'POST') return { job: { jobId: 12 } };
      if (path === '/request/12') return null;
      return ++reads === 1 ? summary : parsed;
    }
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.match, parsed);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(reads, 2);
  assert.ok(progress.length >= 2);
});

test('a finished or missing job without replay data remains pending', async () => {
  let reads = 0;
  const result = await requestReplay(summary.match_id, {
    attempts: 2,
    pause: async () => {},
    request: async (path, signal, options) => {
      if (options?.method === 'POST') return { job: { jobId: 12 } };
      if (path === '/request/12') return null;
      reads++;
      return summary;
    }
  });
  assert.equal(result.status, 'pending');
  assert.equal(reads, 2);
});

test('a cancellation stops polling and never delivers a match for the new selection', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(requestReplay(summary.match_id, {
    signal: controller.signal,
    pause: async () => controller.abort(),
    request: async (path, signal, options) => {
      if (options?.method === 'POST') return { job: { jobId: 12 } };
      reads++;
      return parsed;
    }
  }), { name: 'AbortError' });
  assert.equal(reads, 0);
});

test('failed jobs and invalid queue responses are surfaced', async () => {
  await assert.rejects(requestReplay(summary.match_id, {
    pause: async () => {},
    request: async (path, signal, options) => options?.method === 'POST'
      ? { job: { jobId: 12 } }
      : { state: 'failed' }
  }), /could not analyze/);
  await assert.rejects(requestReplay(summary.match_id, {
    request: async () => ({})
  }), /did not return an analysis job/);
});

test('polling rejects a response for another match', async () => {
  await assert.rejects(requestReplay(summary.match_id, {
    pause: async () => {},
    request: async (path, signal, options) => {
      if (options?.method === 'POST') return { job: { jobId: 12 } };
      if (path === '/request/12') return null;
      return { ...parsed, match_id: 1 };
    }
  }), /different match/);
});
