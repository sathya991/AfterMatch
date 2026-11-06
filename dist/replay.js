import { hasReplayData, validateMatch } from './model.js';

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function requestReplay(matchId, {
  request,
  signal,
  onProgress = () => {},
  pause = wait,
  attempts = 18,
  interval = 5000
}) {
  const id = String(matchId);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error('Replay analysis requires a numeric OpenDota match ID.');
  }
  signal?.throwIfAborted();
  const queued = await request('/request/' + id, signal, { method: 'POST' });
  const jobId = queued?.job?.jobId;
  if (!jobId || !/^\d+$/.test(String(jobId))) {
    throw new Error('OpenDota did not return an analysis job. Try the match page on OpenDota.');
  }
  onProgress('Replay analysis requested. Waiting for OpenDota to retrieve and parse the replay…');
  for (let attempt = 0; attempt < attempts; attempt++) {
    await pause(interval, signal);
    signal?.throwIfAborted();
    const job = await request('/request/' + jobId, signal);
    if (job?.state === 'failed' || job?.status === 'failed') {
      throw new Error('OpenDota could not analyze this replay. The replay may be unavailable. Try the match page on OpenDota.');
    }
    const match = validateMatch(await request('/matches/' + id, signal));
    if (String(match.match_id) !== id) {
      throw new Error('OpenDota returned a different match while checking analysis.');
    }
    if (hasReplayData(match)) return { status: 'complete', match, jobId };
    onProgress('Still waiting for replay data from OpenDota. Check ' + (attempt + 1) + ' of ' + attempts + '.');
  }
  return { status: 'pending', jobId };
}
