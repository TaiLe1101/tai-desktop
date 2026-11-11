import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { VoiceoverService } from '../src/main/voiceover';
import { packProgress } from '../src/shared/progress';
const id = 'abcdefghijk';
const subs = Array.from({ length: 6 }, (_, i) => ({ start: i * 2 + .001, end: i * 2 + 1.999, text: `Sentence ${i}.` }));
async function cleanTestDirectory(root: string) {
  const absolute = resolve(root);
  assert.equal(dirname(absolute).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(basename(absolute).startsWith('tai-v2-'));
  await rm(absolute, { recursive: true, force: true });
}
async function settled(service: VoiceoverService) {
  const deadline = Date.now() + 3000;
  while (service.activeJobs && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(service.activeJobs, 0, 'job must complete');
}
test('20% gate requires the first consecutive packs, rounds up, rejects empty timeline', () => {
  const chunks = subs.map((s, id) => ({ ...s, id, ready: id > 1 }));
  assert.equal(packProgress(chunks).initialRequired, 2);
  assert.equal(packProgress(chunks).canStart, false);
  chunks[0].ready = chunks[1].ready = true;
  assert.equal(packProgress(chunks).canStart, true);
  assert.equal(packProgress([]).canStart, false);
  assert.equal(packProgress(chunks.slice(0, 1)).initialRequired, 1);
});
test('desktop worker pipeline preserves exact timestamps; cache survives tunnel changes and isolates languages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tai-v2-'));
  let calls = 0, workerUrl = 'https://worker.invalid', targetLang = 'vi';
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    calls++; assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(init!.body as string).target_lang, targetLang);
    return new Response(new Uint8Array([73, 68, 51, 1]), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const service = new VoiceoverService(root, () => ({ workerUrl, targetLang, apiKey: 'test-key' }));
  try {
    await Promise.all([service.start(id, subs), service.start(id, subs)]);
    await settled(service);
    const result = await service.snapshot(id);
    assert.deepEqual(result.chunks.map(({ start, end, text }) => ({ start, end, text })), subs);
    assert.ok(result.chunks.every(c => c.ready)); assert.equal(calls, subs.length);
    workerUrl = 'https://new-tunnel.invalid'; await service.start(id); await settled(service);
    assert.equal(calls, subs.length);
    assert.deepEqual([...await service.readAudio(id, 0)], [73, 68, 51, 1]);
    targetLang = 'ja'; assert.equal((await service.snapshot(id)).chunks.length, 0);
    await assert.rejects(service.readAudio('../escape', 0));
    await assert.rejects(service.readAudio(id, -1));
  } finally { await service.stop(); await cleanTestDirectory(root); }
});
test('worker failure stops at the failed pack; retry resumes without requesting completed packs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tai-v2-'));
  const requested: string[] = []; let fail = true;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const text = JSON.parse(init!.body as string).text; requested.push(text);
    if (fail && text === subs[1].text) return new Response('busy', { status: 503 });
    return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const service = new VoiceoverService(root, () => ({ workerUrl: 'https://worker.invalid', targetLang: 'vi', apiKey: '' }));
  try {
    await service.start(id, subs); await settled(service);
    const failed = await service.snapshot(id);
    assert.match(failed.error, /HTTP 503/); assert.equal(failed.chunks.filter(c => c.ready).length, 1);
    fail = false; await service.start(id); await settled(service);
    assert.equal((await service.snapshot(id)).error, '');
    assert.equal(requested.filter(x => x === subs[0].text).length, 1);
    assert.equal(requested.length, subs.length + 1);
  } finally { await service.stop(); await cleanTestDirectory(root); }
});
