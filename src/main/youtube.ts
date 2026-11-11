import { BrowserWindow, WebContentsView } from 'electron';
import { VoiceoverService } from './voiceover';
import { inspectVideo, extractCaptions } from './youtube-scripts';
import type { VideoSession } from '../shared/types';
import { packProgress } from '../shared/progress';

export const emptySession = (): VideoSession => ({ videoId: '', title: '', phase: 'IDLE', error: '', chunks: [], ready: 0, total: 0, initialRequired: 0, time: 0, paused: true, rate: 1, muted: false, volume: 1, cached: false });
export function youtubeUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) || url.username || url.password) throw new Error('Chỉ hỗ trợ URL HTTPS YouTube.');
  return url.href;
}
export class YoutubeSession {
  readonly view: WebContentsView;
  state = emptySession();
  private generation = 0;
  private busy = false;
  private released = false;
  private buffering = false;
  private timer: NodeJS.Timeout;
  constructor(private window: BrowserWindow, private service: VoiceoverService,
    view = new WebContentsView({ webPreferences: { partition: 'persist:tai-youtube-v2', nodeIntegration: false, contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } })) {
    this.view = view;
    window.contentView.addChildView(this.view);
    this.view.setVisible(false);
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    wc.session.on('will-download', event => event.preventDefault());
    wc.on('will-navigate', (event, url) => { try { youtubeUrl(url); } catch { event.preventDefault(); } });
    wc.on('will-redirect', (event, url) => { try { youtubeUrl(url); } catch { event.preventDefault(); } });
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.reset(); });
    wc.on('did-fail-load', (_e, code, message, _url, mainFrame) => {
      if (mainFrame && code !== -3) { this.state.phase = 'ERROR'; this.state.error = `Không tải được YouTube: ${message}`; }
    });
    this.timer = setInterval(() => { void this.tick(); }, 400);
  }
  reset() { this.generation++; this.released = false; this.buffering = false; this.state = emptySession(); }
  async navigate(url: string) { await this.view.webContents.loadURL(youtubeUrl(url)); }
  bounds(b: { x: number; y: number; width: number; height: number } | null) {
    if (!b) { this.view.setVisible(false); void this.playback('pause'); return; }
    if (!Object.values(b).every(Number.isFinite)) throw new Error('Kích thước không hợp lệ.');
    const [w, h] = this.window.getContentSize();
    const x = Math.max(0, Math.min(w, Math.round(b.x))), y = Math.max(0, Math.min(h, Math.round(b.y)));
    this.view.setBounds({ x, y, width: Math.max(0, Math.min(w - x, Math.round(b.width))), height: Math.max(0, Math.min(h - y, Math.round(b.height))) });
    this.view.setVisible(true);
  }
  async playback(action: 'pause' | 'play' | 'seek', time?: number) {
    if (action === 'seek' && (!Number.isFinite(time) || time! < 0)) throw new Error('Mốc thời gian không hợp lệ.');
    const command = action === 'seek' ? `v.currentTime = ${Number(time)}` : action === 'play' ? 'await v.play()' : action === 'pause' ? 'v.pause()' : '';
    if (!command) throw new Error('Thao tác không hợp lệ.');
    await this.view.webContents.executeJavaScript(`(async () => { const v = document.querySelector('video'); if(v) { ${command}; } })()`, true).catch(() => {});
  }
  async retry() { await this.startTranslation(this.state.videoId); }
  async startTranslation(id: string) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Chọn một video trước khi dịch.');
    if (!['IDLE', 'ERROR', 'NO_SUBTITLES'].includes(this.state.phase)) return;
    const generation = this.generation;
    const info = await this.view.webContents.executeJavaScript(inspectVideo);
    if (id === this.state.videoId && !['IDLE', 'ERROR', 'NO_SUBTITLES'].includes(this.state.phase)) return;
    if (generation !== this.generation || info.id !== id || !info.valid) throw new Error('Video đã thay đổi hoặc chưa tải xong. Hãy chọn lại video.');
    if (info.ad) throw new Error('Chờ quảng cáo kết thúc rồi nhấn Dịch.');
    if (!['IDLE', 'ERROR', 'NO_SUBTITLES'].includes(this.state.phase)) return;
    this.reset();
    this.state.videoId = id; this.state.title = info.title;
    if (info.live) { this.state.phase = 'NO_SUBTITLES'; this.state.error = 'V2 chưa hỗ trợ livestream.'; return; }
    this.state.phase = 'EXTRACTING';
    const token = this.generation;
    await this.playback('pause');
    if (token === this.generation) void this.prepare(id, token);
  }
  private async prepare(id: string, token: number) {
    try {
      const cached = await this.service.snapshot(id);
      if (token !== this.generation) return;
      this.state.cached = cached.chunks.length > 0 && cached.chunks.every(c => c.ready);
      if (this.state.cached) { this.state.phase = 'BUFFERING'; return; }
      const subs = cached.chunks.length ? undefined : await this.view.webContents.executeJavaScript(extractCaptions);
      if (token !== this.generation) return;
      if (subs && !subs.length) { this.state.phase = 'NO_SUBTITLES'; return; }
      await this.service.start(id, subs);
      if (token === this.generation) this.state.phase = 'BUFFERING';
    } catch (e) { if (token === this.generation) { this.state.phase = 'ERROR'; this.state.error = e instanceof Error ? e.message : String(e); } }
  }
  private async tick() {
    if (this.busy || this.view.webContents.isDestroyed()) return;
    this.busy = true;
    const token = this.generation;
    try {
      const info = await this.view.webContents.executeJavaScript(inspectVideo);
      if (token !== this.generation) return;
      if (!/^[\w-]{11}$/.test(info.id)) { if (this.state.videoId) this.reset(); return; }
      if (info.id !== this.state.videoId) {
        this.reset(); this.state.videoId = info.id; this.state.title = info.title;
      }
      Object.assign(this.state, { time: info.time, paused: info.paused, rate: info.rate, muted: info.muted, volume: info.volume });
      if (!info.valid || info.ad) { this.state.paused = true; return; }
      this.state.title = info.title;
      if (this.state.phase === 'IDLE') return;
      if (['EXTRACTING', 'BUFFERING'].includes(this.state.phase)) await this.playback('pause');
      if (['ERROR', 'NO_SUBTITLES', 'EXTRACTING'].includes(this.state.phase)) return;
      const current = this.generation;
      const result = await this.service.snapshot(info.id);
      if (current !== this.generation) return;
      const chunks = result.chunks, total = chunks.length;
      const progress = packProgress(chunks);
      Object.assign(this.state, { chunks, total, ready: progress.ready, initialRequired: progress.initialRequired });
      if (result.error) { this.state.phase = 'ERROR'; this.state.error = result.error; await this.playback('pause'); return; }
      if (!total) return;
      const initialReady = progress.canStart;
      if (!this.released && initialReady) {
        this.released = true; await this.playback('seek', 0); await this.playback('play');
      }
      if (this.released) {
        // Pause when playback/seek reaches an unfinished pack, resume only this automatic pause.
        const missing = chunks.find(c => !c.ready && c.start <= info.time + .5 && c.end > info.time);
        if (missing && !this.buffering && !info.paused) { this.buffering = true; await this.playback('pause'); }
        if (this.buffering && !missing) { this.buffering = false; await this.playback('play'); }
        this.state.phase = this.buffering ? 'BUFFERING' : this.state.ready === total ? 'COMPLETE' : 'PLAYING';
      }
    } catch (e) { if (token === this.generation && !this.view.webContents.isLoading()) { this.state.error = String(e); } }
    finally { this.busy = false; }
  }
  close() { clearInterval(this.timer); this.generation++; if (!this.view.webContents.isDestroyed()) this.view.webContents.close(); }
}
