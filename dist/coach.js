import { eventLog, heroName, itemName, seriesFor, clock, hasReplayData } from './model.js';

export function coachingReport(match, player, heroes, { role = 'unsure', items = {} } = {}) {
  const events = eventLog(match, player, heroes, items);
  const deaths = events.filter(event => event.type === 'death');
  const earlyDeaths = deaths.filter(event => event.time < 600);
  const completeDeaths = Number.isFinite(player.deaths) && deaths.length === player.deaths;
  const lastHitsAtTen = seriesFor(player, 'lh_t', match.duration).find(point => point.time === 600)?.value;
  const name = heroName(player.hero_id, heroes);
  const cards = [];
  const deathCoverage = Number.isFinite(player.deaths)
    ? deaths.length + ' of ' + player.deaths + ' death times are available.'
    : deaths.length + ' death times are available.';
  const deathTarget = completeDeaths ? 'Try at most ' + Math.max(0, earlyDeaths.length - 1) + ' deaths before 10:00.' : 'Track deaths before 10:00 once complete event data is available.';

  if (earlyDeaths.length >= 3) {
    const killers = new Map();
    for (const death of earlyDeaths) {
      const killer = death.title.replace('Killed by ', '');
      killers.set(killer, (killers.get(killer) || 0) + 1);
    }
    const [killer, count] = [...killers.entries()].sort((a, b) => b[1] - a[1])[0];
    cards.push({
      id: 'early-deaths',
      title: 'Break the pattern of early deaths',
      observation: earlyDeaths.length + ' recorded deaths before 10:00. ' + killer + ' was credited with ' + count + ' of them.',
      context: deathCoverage + ' The logs identify the killer and time. Review your Dota replay to establish positioning, vision, and ability use.',
      action: 'After an early death, locate the hero that killed you before returning to the same exposed area. If their location is unknown, choose a safer available route or position and coordinate with a nearby ally.',
      drill: 'Review the 20 seconds before each marked death. Identify one situation that repeats, then change how you approach that situation in your next three games.',
      measure: deathTarget + (Number.isFinite(lastHitsAtTen) && role === 'core' ? ' Keep at least your current ' + lastHitsAtTen + ' last hits at 10:00 while working on survival.' : ''),
      moments: earlyDeaths.map(event => ({ time: event.time, eventId: event.id, type: event.type }))
    });
  } else if (deaths.length >= 3) {
    const counts = new Map();
    for (const death of deaths) counts.set(death.title, (counts.get(death.title) || 0) + 1);
    const [killer, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count >= 3) {
      cards.push({
        id: 'repeated-killer',
        title: 'Plan around the opponent catching you repeatedly',
        observation: killer.replace('Killed by ', '') + ' was credited with ' + count + ' recorded deaths.',
        context: deathCoverage + ' Being credited with a kill does not identify which spell or decision caused the death.',
        action: 'Before entering an exposed area, check the last known location of this opponent and nearby allies. Choose one change to your route, positioning, or timing after reviewing the repeated encounters.',
        drill: 'Compare the marked deaths in your Dota replay. Name the repeated setup and the response you want to practice.',
        measure: 'For your next three ' + name + ' games, record whether you repeated that setup and how the encounter ended.',
        moments: deaths.filter(event => event.title === killer).map(event => ({ time: event.time, eventId: event.id, type: event.type }))
      });
    }
  }

  if (role === 'core' && Number.isFinite(lastHitsAtTen) && lastHitsAtTen < 40 && match.duration >= 600) {
    cards.push({
      id: 'lane-farm',
      title: 'Build a more consistent first ten minutes of farm',
      observation: lastHitsAtTen + ' last hits were recorded at 10:00.',
      context: 'This practice prompt is enabled for your Core selection and a lane result below 40 last hits at 10:00. That trigger is an app heuristic; lane matchups and skill levels vary.',
      action: 'Warm up with five minutes of last-hit practice on this hero. During the next game, prioritize securing reachable last hits and avoid paying for optional trades with repeated missed creeps.',
      drill: 'Use one small goal for the next three games: improve your own 10:00 last-hit count while also recording early deaths.',
      measure: 'Try at least ' + (lastHitsAtTen + 5) + ' last hits at 10:00, up from ' + lastHitsAtTen + '.' + (completeDeaths ? ' Keep deaths before 10:00 at or below ' + earlyDeaths.length + '.' : ''),
      moments: []
    });
  }

  const bkbPurchase = (player.purchase_log || []).find(event => event.key === 'black_king_bar' && Number.isFinite(event.time) && event.time >= 0);
  const bkbUses = player.item_uses?.black_king_bar;
  const afterPurchaseDeaths = bkbPurchase ? deaths.filter(event => event.time > bkbPurchase.time) : [];
  if (bkbPurchase && bkbUses === 0 && match.duration - bkbPurchase.time >= 300 && afterPurchaseDeaths.length) {
    cards.push({
      id: 'active-item',
      title: 'Prepare an activation cue for Black King Bar',
      observation: itemName('black_king_bar', items) + ' was purchased at ' + clock(bkbPurchase.time) + ', with zero activations recorded and ' + afterPurchaseDeaths.length + ' recorded deaths afterward.',
      context: 'These records cannot establish whether an activation would have prevented a death. Confirm the item was usable and the fight context in your replay.',
      action: 'Rehearse the item’s hotkey in demo mode. Before your next fight with the item available, decide the specific threat that will be your activation cue.',
      drill: 'Review the marked post-purchase deaths and note whether activation was available, relevant, and deliberate.',
      measure: 'For the next three games where you buy the item, record planned activations and missed activation opportunities confirmed in replay.',
      moments: afterPurchaseDeaths.map(event => ({ time: event.time, eventId: event.id, type: event.type }))
    });
  }

  if (!cards.length && deaths.length) {
    const death = deaths[0];
    cards.push({
      id: 'single-review',
      title: 'Turn one death into a deliberate adjustment',
      observation: 'A death is recorded at ' + clock(death.time) + ': ' + death.title.toLowerCase() + '.',
      context: 'The current checks did not identify a strong repeated pattern. This is a review prompt for one available event.',
      action: 'Open the preceding 20 seconds in your Dota replay. Choose one change to the information you checked, your position, or the timing of your commitment.',
      drill: 'Write the situation and your intended response in one sentence. Use that response deliberately in your next three games.',
      measure: 'Record whether the same situation recurred, what you changed, and the result.',
      moments: [{ time: death.time, eventId: death.id, type: death.type }]
    });
  }

  return {
    cards: cards.slice(0, 3),
    hasReplay: hasReplayData(match),
    deathCoverage,
    role,
    lastHitsAtTen: lastHitsAtTen ?? null
  };
}

export function practicePlan(card, hero) {
  return hero + ' · ' + card.title + '\nNext game: ' + card.action + '\nPractice: ' + card.drill + '\nTrack: ' + card.measure;
}

export function appendPracticePlan(existing, plan) {
  const current = String(existing || '').trim();
  if (current.includes(plan)) return current;
  const combined = current ? current + '\n\n' + plan : plan;
  if (combined.length > 1000) throw new Error('This plan and your note exceed 1,000 characters. Shorten the existing note first.');
  return combined;
}
