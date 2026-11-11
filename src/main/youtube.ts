import { BrowserWindow, WebContentsView } from 'electron';
import { VoiceoverService, normalizeTimeline } from './voiceover';
import { inspectVideo, requestNativeCaptions, stopNativeCaptions, fetchCapturedCaptions } from './youtube-scripts';
import { isCaptionLanguage, type SourceLanguage, type VideoSession, type SubtitleSegment } from '../shared/types';
import { packProgress } from '../shared/progress';

export const emptySession = (): VideoSession => ({ videoId: '', title: '', phase: 'IDLE', error: '', chunks: [], ready: 0, total: 0, initialRequired: 0, time: 0, paused: true, rate: 1, muted: false, volume: 1, cached: false, subtitlesCached: false });
export function youtubeUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) || url.username || url.password) throw new Error('Chỉ hỗ trợ URL HTTPS YouTube.');
  return url.href;
}
function isYoutubePage(value: string) {
  try { youtubeUrl(value); return true; } catch { return false; }
}
function canNavigate(value: string) {
  if (isYoutubePage(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (['accounts.google.com', 'accounts.youtube.com', 'consent.google.com', 'consent.youtube.com', 'myaccount.google.com'].includes(url.hostname)) return true;
    // Sign-in may set cookies on Google before returning to YouTube.
    return ['google.com', 'www.google.com', 'www.google.com.vn', 'www.google.co.th'].includes(url.hostname) && url.pathname.startsWith('/accounts/');
  } catch { return false; }
}
export class YoutubeSession {
  readonly view: WebContentsView;
  state = emptySession();
  private generation = 0;
  private busy = false;
  private released = false;
  private buffering = false;
  private loadedSubtitles: SubtitleSegment[] = [];
  private loadingCaptions = false;
  private captionCooldownUntil = 0;
  private captionRateLimitCount = 0;
  private captionData = new Map<string, { subtitles: SubtitleSegment[]; at: number }>();
  private htmlFullscreen = false;
  private layoutBounds: { x: number; y: number; width: number; height: number } | null = null;
  private readonly resizeView = () => {
    if (this.view.webContents.isDestroyed()) return;
    if (this.htmlFullscreen) {
      const [width, height] = this.window.getContentSize();
      this.view.setBounds({ x: 0, y: 0, width, height });
    } else if (this.layoutBounds) this.bounds(this.layoutBounds);
  };
  private capturedCaptions = new Map<string, { url: string; at: number }>();
  private captionWaiter: { videoId: string; language: SourceLanguage; resolve(url: string): void; reject(error: Error): void; timer: NodeJS.Timeout } | null = null;
  private timer: NodeJS.Timeout;
  constructor(private window: BrowserWindow, private service: VoiceoverService,
    view = new WebContentsView({ webPreferences: { partition: 'persist:tai-youtube-v2', nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } })) {
    this.view = view;
    window.contentView.addChildView(this.view);
    this.view.setVisible(false);
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (!canNavigate(url)) { this.navigationBlocked(url); return { action: 'deny' }; }
      // Keep Chromium's opener/POST flow intact; loadURL would destroy that flow.
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: this.window, width: 560, height: 780, autoHideMenuBar: true,
        webPreferences: { partition: 'persist:tai-youtube-v2', nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
      } };
    });
    wc.on('did-create-window', child => {
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', (event, url) => {
        if (!canNavigate(url)) { event.preventDefault(); this.navigationBlocked(url); }
      });
      child.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
        if (isMainFrame && !canNavigate(url)) { event.preventDefault(); this.navigationBlocked(url); }
      });
    });
    wc.session.setPermissionRequestHandler((contents, permission, cb) => cb(contents === wc && permission === 'fullscreen' && isYoutubePage(contents.getURL())));
    wc.session.setPermissionCheckHandler((contents, permission, origin) => contents === wc && permission === 'fullscreen' && isYoutubePage(origin));
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.window.setFullScreen(true);
      this.resizeView();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      this.window.setFullScreen(false);
      this.resizeView();
    });
    wc.on('before-input-event', (_event, input) => {
      if (this.htmlFullscreen && input.type === 'keyDown' && input.key === 'Escape') {
        void wc.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen();').catch(() => {});
      }
    });
    this.window.on('resize', this.resizeView);
    wc.session.on('will-download', event => event.preventDefault());
    wc.session.webRequest.onCompleted({ urls: ['https://*.youtube.com/api/timedtext*', 'https://youtube.com/api/timedtext*'] }, details => {
      if (details.webContentsId !== wc.id || details.method !== 'GET') return;
      const url = new URL(details.url);
      const id = url.searchParams.get('v');
      if (url.pathname !== '/api/timedtext' || !id || !/^[\w-]{11}$/.test(id)) return;
      // A default-track request can be rate-limited before the selected track
      // is requested, so handle 429 before filtering by language.
      if (details.statusCode === 429) {
        const header = Object.entries(details.responseHeaders || {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]?.[0];
        this.cancelCaptionWait(this.captionRateLimited(header));
        return;
      }
      const translated = url.searchParams.get('tlang');
      const code = translated || (url.searchParams.get('kind') === 'asr' ? url.searchParams.get('lang') : null);
      if (!isCaptionLanguage(code)) return;
      const language = this.captionWaiter && this.matchesSource(url, this.captionWaiter.language) ? this.captionWaiter.language : code;
      if (details.statusCode !== 200) {
        if (this.captionWaiter?.videoId === id && this.captionWaiter.language === language) this.cancelCaptionWait(new Error(`YouTube timedtext trả HTTP ${details.statusCode} (cách 2).`));
        return;
      }
      this.capturedCaptions.set(`${id}/${language}`, { url: details.url, at: Date.now() });
      if (this.capturedCaptions.size > 16) this.capturedCaptions.delete(this.capturedCaptions.keys().next().value!);
      const waiter = this.captionWaiter;
      if (waiter?.videoId === id && waiter.language === language) { clearTimeout(waiter.timer); this.captionWaiter = null; waiter.resolve(details.url); }
    });
    wc.on('will-navigate', (event, url) => {
      if (!canNavigate(url)) { event.preventDefault(); this.navigationBlocked(url); }
      else this.state.navigationError = '';
    });
    wc.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      // A top-level allowlist must not cancel Google's iframe redirects.
      if (!isMainFrame) return;
      if (!canNavigate(url)) { event.preventDefault(); this.navigationBlocked(url); }
      else this.state.navigationError = '';
    });
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.reset(); });
    wc.on('did-fail-load', (_e, code, message, _url, mainFrame) => {
      if (mainFrame && code !== -3) { this.state.phase = 'ERROR'; this.state.error = `Không tải được YouTube: ${message}`; }
    });
    wc.on('did-finish-load', () => {
      void wc.insertCSS(`
        ::-webkit-scrollbar { width: 8px !important; height: 8px !important; }
        ::-webkit-scrollbar-track { background: transparent !important; }
        ::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.2) !important; border-radius: 8px !important; border: 2px solid transparent !important; background-clip: padding-box !important; }
        ::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.35) !important; }
        ::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
        ::-webkit-scrollbar-corner { background: transparent !important; }
      `).catch(() => {});
    });
    this.timer = setInterval(() => { void this.tick(); }, 400);
  }
  reset() { this.generation++; this.cancelCaptionWait(new Error('Video hoặc phiên lấy phụ đề đã thay đổi.')); this.released = false; this.buffering = false; this.loadedSubtitles = []; this.state = { ...emptySession(), captionRetryAt: this.captionCooldownUntil }; }
  private captionRateLimited(retryAfter?: string | null) {
    const now = Date.now();
    if (now >= this.captionCooldownUntil) this.captionRateLimitCount++;
    const parsed = retryAfter ? (/^\d+$/.test(retryAfter.trim()) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter)) : NaN;
    const fallback = now + 60000 * 2 ** Math.min(3, Math.max(0, this.captionRateLimitCount - 1));
    this.captionCooldownUntil = Math.max(this.captionCooldownUntil, Number.isFinite(parsed) && parsed > now ? parsed : fallback);
    this.state.captionRetryAt = this.captionCooldownUntil;
    return new Error(`YouTube /api/timedtext trả HTTP 429. Tạm dừng lấy phụ đề; thử lại sau ${Math.ceil((this.captionCooldownUntil - now) / 1000)} giây. Đây không phải lỗi worker/Gemini.`);
  }
  private navigationBlocked(value: string) {
    let host = 'địa chỉ không hợp lệ';
    try { host = new URL(value).hostname; } catch { /* No URL parameters or auth tokens in the UI. */ }
    this.state.navigationError = `Ứng dụng đã chặn chuyển trang tới ${host}. Nếu đang đăng nhập, hãy báo tên miền này để kiểm tra.`;
  }
  private cancelCaptionWait(error: Error) {
    const waiter = this.captionWaiter;
    this.captionWaiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
  private matchesSource(url: URL, language: SourceLanguage) {
    const translated = url.searchParams.get('tlang');
    const actual = (translated || (url.searchParams.get('kind') === 'asr' ? url.searchParams.get('lang') : '') || '').toLowerCase();
    return actual === language.toLowerCase() || (language === 'zh' && actual.split('-')[0] === 'zh');
  }
  private async subtitlesFromNetwork(id: string, language: SourceLanguage) {
    const wc = this.view.webContents;
    const generation = this.generation;
    try {
    let url: string;
    const capturedCaption = this.capturedCaptions.get(`${id}/${language}`);
    if (capturedCaption && Date.now() - capturedCaption.at < 120000) {
      url = capturedCaption.url;
      await wc.executeJavaScript(requestNativeCaptions(language, id), true);
    } else {
      const captured = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => this.cancelCaptionWait(new Error(`Chưa bắt được phụ đề Dịch tự động (${language}) sau 30 giây. Kiểm tra tùy chọn Dịch tự động của video rồi thử lại.`)), 30000);
        this.captionWaiter = { videoId: id, language, resolve, reject, timer };
      });
      try {
        // Register the waiter before toggling CC so fast requests cannot be missed.
        [url] = await Promise.all([captured, wc.executeJavaScript(requestNativeCaptions(language, id), true)]);
      } finally { this.cancelCaptionWait(new Error('Đã kết thúc chờ request phụ đề.')); }
    }
    // Read the full payload before disabling CC; stopping earlier can cancel it.
    if (Date.now() < this.captionCooldownUntil) throw new Error('YouTube đang giới hạn request phụ đề. Hãy chờ hết thời gian trước khi thử lại.');
    const input = await wc.executeJavaScript(fetchCapturedCaptions(url, id, language));
    if (input?.captionRateLimited) throw this.captionRateLimited(input.retryAfter);
    return input;
    } finally {
      // Also turn CC off on failure, without touching a newly navigated video.
      if (!wc.isDestroyed() && generation === this.generation) {
        await wc.executeJavaScript(stopNativeCaptions(id), true).catch(() => {});
      }
    }
  }
  async navigate(url: string) { await this.view.webContents.loadURL(youtubeUrl(url)); }
  bounds(b: { x: number; y: number; width: number; height: number } | null) {
    this.layoutBounds = b;
    if (this.htmlFullscreen) { this.resizeView(); return; }
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
  async loadSubtitles(id: string, language?: SourceLanguage, forceRefresh: boolean = false) {
    if (this.loadingCaptions) return;
    this.loadingCaptions = true;
    try { await this.loadSubtitlesOnce(id, language, forceRefresh); }
    finally { this.loadingCaptions = false; }
  }
  private async loadSubtitlesOnce(id: string, language?: SourceLanguage, forceRefresh: boolean = false) {
    language = language || this.state.detectedSourceLanguage;
    if (!isCaptionLanguage(language)) throw new Error('Chưa nhận diện được ngôn ngữ video. Hãy chọn ngôn ngữ phụ đề trước.');
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Chọn một video trước khi lấy phụ đề.');
    const allowed = ['IDLE', 'CAPTIONS_READY', 'ERROR', 'NO_SUBTITLES'];
    if (!allowed.includes(this.state.phase)) return;
    const key = `${id}/${language}`;

    const generation = this.generation;
    const info = await this.view.webContents.executeJavaScript(inspectVideo);
    if (generation !== this.generation || info.id !== id || !info.valid) throw new Error('Video đã thay đổi hoặc chưa tải xong.');
    if (!allowed.includes(this.state.phase)) return;
    if (info.ad) throw new Error('Chờ quảng cáo kết thúc rồi lấy phụ đề.');

    if (!forceRefresh) {
      const memCached = this.captionData.get(key);
      const cached = memCached?.subtitles || await this.service.getCachedSubtitles(id, language);
      if (cached && cached.length) {
        this.reset();
        this.state.sourceLanguage = language;
        this.state.videoId = id;
        this.state.title = info.title;
        this.loadedSubtitles = cached;
        this.captionData.set(key, { subtitles: cached, at: Date.now() });
        this.state.chunks = this.loadedSubtitles.map((s, id) => ({ ...s, id, ready: false }));
        this.state.total = this.loadedSubtitles.length;
        this.state.phase = 'CAPTIONS_READY';
        this.state.subtitlesCached = true;
        return;
      }
    } else {
      this.captionData.delete(key);
      await this.service.clearSubtitles(id, language);
    }

    if (Date.now() < this.captionCooldownUntil) {
      throw new Error(`YouTube đang giới hạn lấy phụ đề. Chờ ${Math.ceil((this.captionCooldownUntil - Date.now()) / 1000)} giây trước khi thử lại.`);
    }

    this.reset();
    this.state.sourceLanguage = language;
    this.state.videoId = id; this.state.title = info.title;
    if (info.live) { this.state.phase = 'NO_SUBTITLES'; this.state.error = 'V2 chưa hỗ trợ livestream.'; return; }
    this.state.phase = 'EXTRACTING';
    const token = this.generation;
    try {
      const input = await this.subtitlesFromNetwork(id, language);
      if (token !== this.generation) return;
      this.loadedSubtitles = normalizeTimeline(input);
      if (this.loadedSubtitles.length) {
        this.captionData.delete(key);
        this.captionData.set(key, { subtitles: this.loadedSubtitles, at: Date.now() });
        if (this.captionData.size > 8) this.captionData.delete(this.captionData.keys().next().value!);
        await this.service.saveSubtitles(id, language, this.loadedSubtitles);
      }
      this.state.chunks = this.loadedSubtitles.map((s, id) => ({ ...s, id, ready: false }));
      this.state.total = this.loadedSubtitles.length;
      this.state.phase = this.loadedSubtitles.length ? 'CAPTIONS_READY' : 'NO_SUBTITLES';
      this.state.subtitlesCached = false;
    } catch (e) {
      if (token === this.generation) { this.state.phase = 'ERROR'; this.state.error = e instanceof Error ? e.message : String(e); }
    }
  }
  async startTranslation(id: string) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Chọn một video trước khi dịch.');
    if (!['CAPTIONS_READY', 'ERROR'].includes(this.state.phase)) return;
    if (!this.loadedSubtitles.length) throw new Error('Nhấn Lấy phụ đề thành công trước khi dịch.');
    const generation = this.generation;
    const info = await this.view.webContents.executeJavaScript(inspectVideo);
    if (id === this.state.videoId && !['CAPTIONS_READY', 'ERROR'].includes(this.state.phase)) return;
    if (generation !== this.generation || info.id !== id || !info.valid) throw new Error('Video đã thay đổi hoặc chưa tải xong. Hãy chọn lại video.');
    if (info.ad) throw new Error('Chờ quảng cáo kết thúc rồi nhấn Dịch.');
    if (!['CAPTIONS_READY', 'ERROR'].includes(this.state.phase)) return;
    const subtitles = this.loadedSubtitles;
    const language = this.state.sourceLanguage || 'en';
    this.reset();
    this.state.sourceLanguage = language;
    this.loadedSubtitles = subtitles;
    this.state.videoId = id; this.state.title = info.title;
    if (info.live) { this.state.phase = 'NO_SUBTITLES'; this.state.error = 'V2 chưa hỗ trợ livestream.'; return; }
    this.state.phase = 'BUFFERING';
    const token = this.generation;
    await this.playback('pause');
    if (token === this.generation) void this.prepare(id, token);
  }
  private async prepare(id: string, token: number) {
    try {
      const cached = await this.service.snapshot(id, this.state.sourceLanguage);
      if (token !== this.generation) return;
      this.state.cached = cached.chunks.length > 0 && cached.chunks.every(c => c.ready);
      if (this.state.cached) { this.state.phase = 'BUFFERING'; return; }
      const subs = cached.chunks.length ? undefined : this.loadedSubtitles;
      if (token !== this.generation) return;
      if (subs && !subs.length) { this.state.phase = 'NO_SUBTITLES'; return; }
      await this.service.start(id, subs, this.state.sourceLanguage);
      if (token === this.generation) this.state.phase = 'BUFFERING';
    } catch (e) { if (token === this.generation) { this.state.phase = 'ERROR'; this.state.error = e instanceof Error ? e.message : String(e); } }
  }
  private async tick() {
    if (this.busy || this.view.webContents.isDestroyed()) return;
    // Do not inject player scripts into Google authentication pages.
    if (!isYoutubePage(this.view.webContents.getURL())) return;
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
      this.state.captionLanguages = info.captionLanguages || [];
      this.state.detectedSourceLanguage = isCaptionLanguage(info.detectedSourceLanguage) ? info.detectedSourceLanguage : '';
      if (['IDLE', 'CAPTIONS_READY'].includes(this.state.phase)) return;
      if (this.state.phase === 'BUFFERING') await this.playback('pause');
      if (['ERROR', 'NO_SUBTITLES', 'EXTRACTING'].includes(this.state.phase)) return;
      const current = this.generation;
      const result = await this.service.snapshot(info.id, this.state.sourceLanguage);
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
  async persistSession() {
    if (this.view.webContents.isDestroyed()) return;
    const session = this.view.webContents.session;
    session.flushStorageData();
    await session.cookies.flushStore();
  }
  close() {
    clearInterval(this.timer); this.generation++;
    this.window.removeListener('resize', this.resizeView);
    this.cancelCaptionWait(new Error('Đã đóng phiên YouTube.'));
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.session.webRequest.onCompleted(null);
      this.view.webContents.close();
    }
  }
}
