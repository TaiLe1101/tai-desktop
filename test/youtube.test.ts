import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { YoutubeSession } from '../src/main/youtube';
import { inspectVideo, extractCaptions } from '../src/main/youtube-scripts';
import type { BrowserWindow, WebContentsView } from 'electron';
import type { VoiceoverService } from '../src/main/voiceover';

test('video discovery and navigation never prepare translation until explicitly requested', async () => {
  let info = { id: 'abcdefghijk', title: 'Video A', valid: true, ad: false, live: false, time: 12, paused: false, rate: 1, muted: false, volume: 1 };
  const calls: string[] = [];
  const wc = Object.assign(new EventEmitter(), {
    session: Object.assign(new EventEmitter(), { setPermissionRequestHandler() {} }),
    setWindowOpenHandler() {}, isDestroyed: () => false, isLoading: () => false, close() {},
    async executeJavaScript(script: string) {
      if (script === inspectVideo) return { ...info };
      if (script === extractCaptions) { calls.push('captions'); return [{ start: 0, end: 2, text: 'Hello.' }]; }
      calls.push('playback');
    }
  });
  const view = { webContents: wc, setVisible() {} } as unknown as WebContentsView;
  const window = { contentView: { addChildView() {} } } as unknown as BrowserWindow;
  const service = {
    async snapshot() { calls.push('cache'); return { chunks: [], error: '', processing: false }; },
    async start() { calls.push('worker'); }
  } as unknown as VoiceoverService;
  const controller = new YoutubeSession(window, service, view);
  const tick = () => (controller as unknown as { tick(): Promise<void> }).tick();
  try {
    await tick(); await tick();
    assert.equal(controller.state.videoId, info.id);
    assert.equal(controller.state.phase, 'IDLE');
    assert.deepEqual(calls, [], 'browsing must not pause, read captions/cache or start worker');
    await Promise.all([controller.startTranslation(info.id), controller.startTranslation(info.id)]);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(calls.filter(c => c === 'worker').length, 1);
    assert.equal(calls.filter(c => c === 'captions').length, 1);
    info = { ...info, id: 'lmnopqrstuv', title: 'Video B' };
    calls.length = 0;
    await tick(); await tick();
    assert.equal(controller.state.phase, 'IDLE');
    assert.equal(controller.state.videoId, info.id);
    assert.deepEqual(calls, [], 'each new video requires a separate user action');
    await assert.rejects(controller.startTranslation('abcdefghijk'), /Video/);
    assert.deepEqual(calls, []);
  } finally { controller.close(); }
});
