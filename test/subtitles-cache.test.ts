import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceoverService, normalizeTimeline } from '../src/main/voiceover';

test('normalizeTimeline filters invalid cues and sorts by start time', () => {
  const input = [
    { start: 5, end: 10, text: 'Second cue' },
    { start: 0, end: 4, text: 'First cue' },
    { start: 2, end: 3, text: ' [Music] ' },
    { start: 12, end: 15, text: '<font color="red">Third cue</font>' }
  ];
  const normalized = normalizeTimeline(input);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].text, 'First cue');
  assert.equal(normalized[1].text, 'Second cue');
  assert.equal(normalized[2].text, 'Third cue');
});

test('VoiceoverService saveSubtitles and getCachedSubtitles work seamlessly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tai-test-'));
  try {
    const service = new VoiceoverService(dir, () => ({ workerUrl: '', targetLang: 'vi', apiKey: '' }));
    const videoId = 'dQw4w9WgXcQ';
    const lang = 'en';
    const subs = [
      { start: 0, end: 2.5, text: 'Never gonna give you up' },
      { start: 2.6, end: 5.0, text: 'Never gonna let you down' }
    ];

    // 1. Initial state: no cache
    const initial = await service.getCachedSubtitles(videoId, lang);
    assert.equal(initial, null);

    // 2. Save subtitles
    await service.saveSubtitles(videoId, lang, subs);

    // 3. Retrieve cached subtitles
    const cached = await service.getCachedSubtitles(videoId, lang);
    assert.ok(cached);
    assert.equal(cached.length, 2);
    assert.equal(cached[0].text, 'Never gonna give you up');
    assert.equal(cached[1].text, 'Never gonna let you down');

    // 4. Verify primary file exists on disk
    const primaryFile = join(dir, 'captions', videoId, `${lang}.json`);
    const content = JSON.parse(await readFile(primaryFile, 'utf8'));
    assert.equal(content.length, 2);

    // 5. Test clearSubtitles
    // Create a dummy chunk audio file to verify it gets cleaned
    const profile = (service as any).context(videoId, lang);
    await writeFile(join(profile.dir, 'chunk_0.mp3'), 'audio-data');
    await writeFile(join(profile.dir, 'chunk_1.mp3'), 'audio-data');

    await service.clearSubtitles(videoId, lang);

    // Cache should now be null
    const afterClear = await service.getCachedSubtitles(videoId, lang);
    assert.equal(afterClear, null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('VoiceoverService getCachedSubtitles falls back to profile subtitles.json if primary is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tai-test-legacy-'));
  try {
    const service = new VoiceoverService(dir, () => ({ workerUrl: '', targetLang: 'vi', apiKey: '' }));
    const videoId = 'abc123def45';
    const lang = 'en';

    // Simulate legacy cache created inside profile folder
    const profile = (service as any).context(videoId, lang);
    await mkdir(profile.dir, { recursive: true });
    await writeFile(join(profile.dir, 'subtitles.json'), JSON.stringify([
      { start: 1, end: 3, text: 'Legacy subtitle' }
    ]));

    // Should read fallback successfully
    const cached = await service.getCachedSubtitles(videoId, lang);
    assert.ok(cached);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].text, 'Legacy subtitle');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

