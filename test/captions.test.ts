import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { extractCaptions, inspectVideo } from '../src/main/youtube-scripts';
function context(player: unknown, data: unknown = { events: [] }) {
  return { URL, location: { href: 'https://www.youtube.com/watch?v=abcdefghijk', pathname: '/watch' },
    window: { ytInitialPlayerResponse: player },
    document: { title: 'Video', querySelector: () => null },
    AbortSignal, setTimeout, fetch: async () => ({ ok: true, text: async () => JSON.stringify(data) }) };
}
test('caption reader handles JSON3 ASR and authored captions without changing boundaries', async () => {
  for (const kind of ['asr', undefined]) {
    const player = { videoDetails: { videoId: 'abcdefghijk' }, captions: { playerCaptionsTracklistRenderer: {
      captionTracks: [{ kind, languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk' }]
    } } };
    const result = await runInNewContext(extractCaptions, context(player, { events: [
      { tStartMs: 125, dDurationMs: 789, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 914, dDurationMs: 0, segs: [{ utf8: '\n' }] }
    ] }));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ start: .125, end: .914, text: 'Hello world' }]);
  }
});
test('no captions returns empty; untrusted caption URLs are rejected', async () => {
  const p = { videoDetails: { videoId: 'abcdefghijk' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [] as unknown[] } } };
  assert.equal((await runInNewContext(extractCaptions, context(p))).length, 0);
  p.captions.playerCaptionsTracklistRenderer.captionTracks = [{ baseUrl: 'https://attacker.invalid/subtitles' }];
  await assert.rejects(runInNewContext(extractCaptions, context(p)), /URL/);
});
test('SPA navigation does not use a stale player response for a new video', () => {
  const s = runInNewContext(inspectVideo, context({ videoDetails: { videoId: 'oldvideo123', title: 'Old title' } }));
  assert.equal(s.id, 'abcdefghijk'); assert.equal(s.valid, false); assert.equal(s.title, 'Video');
});
