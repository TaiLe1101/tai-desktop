import { BrowserWindow, WebContentsView } from 'electron';
import { DubbingClient, MAX_SUBTITLE_PAYLOAD_CHARS, SubtitleDownloadFailedError } from './dubbing-client';
import { VoiceoverService } from './voiceover';
import {
  controlVideoScript,
  downloadTimedtextInPageScript,
  inspectVideo,
  pollPlayerMetadataScript,
  revertCaptionsToggleScript,
  toggleCaptionsForCaptureScript,
  updateOverlayScript
} from './youtube-scripts';
import {
  buildSourceTimedtextUrl,
  findYouTubeLanguage,
  hasTimedtextPot,
  isSameSpokenLanguage,
  isTimedtextUrlUsable,
  selectSourceTrack
} from '../shared/languages';
import {
  dedupeAndSortSounds,
  nextMissingSegment,
  planSegmentLoad
} from '../shared/subtitles';
import {
  isCaptionLanguage,
  type CaptionTrackInfo,
  type DubbingCue,
  type DubbingSegment,
  type OverlayAnchor,
  type OverlayStatePayload,
  type SoundCue,
  type SourceLanguage,
  type StartDubbingOptions,
  type TranslationLanguageInfo,
  type VideoControlCommand,
  type VideoSession
} from '../shared/types';

// Exact constants from autodub-example spec
const AUTO_TRANSLATE_429_COOLDOWN_MS = 1_800_000; // 30 minutes
const PASSIVE_TIMEDTEXT_WAIT_MS = 1_500;
const ACTIVE_TIMEDTEXT_WAIT_MS = 15_000;
const SEGMENT_PLAN_CADENCE_MS = 1_000;
const PLAYER_POLL_MS = 100;

interface ObservedTimedtext {
  url: string;
  videoId: string;
  source: 'page' | 'background' | 'potless';
  hasPot: boolean;
  at: number;
}

export const emptySession = (): VideoSession => ({
  videoId: '',
  title: '',
  phase: 'IDLE',
  error: '',
  chunks: [],
  ready: 0,
  total: 0,
  initialRequired: 0,
  time: 0,
  paused: true,
  rate: 1,
  muted: false,
  volume: 1,
  cached: false,
  subtitlesCached: false,
  duration: 0,
  ended: false,
  buffering: false,
  adShowing: false,
  seekVersion: 0,
  totalSegments: 0,
  loadedSegments: 0,
  cues: [],
  sounds: [],
  tracks: [],
  dubbingActive: false
});

export function youtubeUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Chỉ hỗ trợ URL HTTPS YouTube.');
  }
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
    return ['google.com', 'www.google.com', 'www.google.com.vn', 'www.google.co.th'].includes(url.hostname) && url.pathname.startsWith('/accounts/');
  } catch { return false; }
}

function pickBestTimedtext(candidates: ObservedTimedtext[], videoId: string): ObservedTimedtext | null {
  const now = Date.now();
  const usable = candidates.filter(c => c.videoId === videoId && isTimedtextUrlUsable(c.url, videoId, now));
  const priority: Array<ObservedTimedtext['source']> = ['page', 'background', 'potless'];
  for (const src of priority) {
    const matches = usable.filter(c => c.source === src);
    if (matches.length) {
      return matches.sort((a, b) => b.at - a.at)[0];
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class YoutubeSession {
  readonly view: WebContentsView;
  state = emptySession();

  private generation = 0;
  private busy = false;
  private htmlFullscreen = false;
  private layoutBounds: { x: number; y: number; width: number; height: number } | null = null;
  private timer: NodeJS.Timeout;

  // Dual-layer timedtext observation (Layer 2: background webRequest + Layer 1: in-page PerformanceObserver)
  private bgObservedTimedtext: ObservedTimedtext[] = [];
  private pageObservedTimedtext: ObservedTimedtext[] = [];
  private autoTranslatePausedUntil = 0;

  // Progressive streaming state
  private dubbingActive = false;
  private transcriptOpen = true;
  private targetLang = 'vi';
  private activeSourceUrl = '';
  private activeSourceText = '';
  private activeSourceLang = '';
  private loadedSegments = new Map<number, DubbingSegment>();
  private totalSegments = 0;
  private segmentLoadInFlight = false;
  private segmentAbortController: AbortController | null = null;
  private lastSegmentPlanAt = 0;
  private lastSeekVersion = 0;
  private overlayAnchor: OverlayAnchor | null = null;

  private readonly resizeView = () => {
    if (this.view.webContents.isDestroyed()) return;
    if (this.htmlFullscreen) {
      const [width, height] = this.window.getContentSize();
      this.view.setBounds({ x: 0, y: 0, width, height });
    } else if (this.layoutBounds) this.bounds(this.layoutBounds);
  };

  constructor(
    private window: BrowserWindow,
    private service: VoiceoverService,
    private dubbingClient: DubbingClient,
    private getDefaultTargetLang: () => string = () => 'vi',
    view = new WebContentsView({
      webPreferences: {
        partition: 'persist:tai-youtube-v2',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
  ) {
    this.view = view;
    window.contentView.addChildView(this.view);
    this.view.setVisible(false);
    const wc = this.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      if (!canNavigate(url)) { this.navigationBlocked(url); return { action: 'deny' }; }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.window,
          width: 560,
          height: 780,
          autoHideMenuBar: true,
          webPreferences: {
            partition: 'persist:tai-youtube-v2',
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false
          }
        }
      };
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

    wc.session.setPermissionRequestHandler((contents, permission, cb) =>
      cb(contents === wc && permission === 'fullscreen' && isYoutubePage(contents.getURL()))
    );
    wc.session.setPermissionCheckHandler((contents, permission, origin) =>
      contents === wc && permission === 'fullscreen' && isYoutubePage(origin)
    );

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

    // Layer 2: Background webRequest.onCompleted timedtext sniffer (accepted as 'background' when usable + hasPot)
    wc.session.webRequest.onCompleted(
      { urls: ['https://*.youtube.com/api/timedtext*', 'https://youtube.com/api/timedtext*'] },
      details => {
        if (details.webContentsId !== wc.id || details.method !== 'GET') return;
        try {
          const url = new URL(details.url);
          const id = url.searchParams.get('v') || '';
          if (!/^[\w-]{11}$/.test(id)) return;
          if (details.statusCode === 429 && url.searchParams.get('tlang')) {
            this.autoTranslatePausedUntil = Date.now() + AUTO_TRANSLATE_429_COOLDOWN_MS;
            this.state.autoTranslatePausedUntil = this.autoTranslatePausedUntil;
            return;
          }
          if (details.statusCode !== 200) return;
          if (!isTimedtextUrlUsable(details.url, id)) return;
          const hasPot = hasTimedtextPot(details.url);
          this.bgObservedTimedtext.push({
            url: details.url,
            videoId: id,
            source: hasPot ? 'background' : 'potless',
            hasPot,
            at: Date.now()
          });
          if (this.bgObservedTimedtext.length > 32) {
            this.bgObservedTimedtext.splice(0, this.bgObservedTimedtext.length - 32);
          }
        } catch {}
      }
    );

    wc.on('will-navigate', (event, url) => {
      if (!canNavigate(url)) { event.preventDefault(); this.navigationBlocked(url); }
      else this.state.navigationError = '';
    });
    wc.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (!canNavigate(url)) { event.preventDefault(); this.navigationBlocked(url); }
      else this.state.navigationError = '';
    });
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.reset();
    });
    wc.on('did-fail-load', (_e, code, message, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        this.state.phase = 'ERROR';
        this.state.error = `Không tải được YouTube: ${message}`;
      }
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

    // 100ms responsive tracking cadence
    this.timer = setInterval(() => { void this.tick(); }, PLAYER_POLL_MS);
  }

  reset() {
    const prevVideoId = this.state.videoId;
    this.generation++;
    this.segmentAbortController?.abort();
    this.segmentAbortController = null;
    this.segmentLoadInFlight = false;
    this.dubbingActive = false;
    this.activeSourceUrl = '';
    this.activeSourceText = '';
    this.activeSourceLang = '';
    this.loadedSegments.clear();
    this.totalSegments = 0;
    this.lastSegmentPlanAt = 0;
    this.state = {
      ...emptySession(),
      autoTranslatePausedUntil: this.autoTranslatePausedUntil,
      overlayAnchor: this.overlayAnchor || undefined
    };
    if (prevVideoId && !this.view.webContents.isDestroyed()) {
      void this.view.webContents.executeJavaScript(revertCaptionsToggleScript(prevVideoId), true).catch(() => {});
      void this.updateOverlay({
        mode: 'hidden',
        translatedText: '',
        sourceText: '',
        soundText: '',
        status: 'idle',
        dubbingActive: false
      }).catch(() => {});
    }
  }

  private navigationBlocked(value: string) {
    let host = 'địa chỉ không hợp lệ';
    try { host = new URL(value).hostname; } catch {}
    this.state.navigationError = `Ứng dụng đã chặn chuyển trang tới ${host}. Nếu đang đăng nhập, hãy báo tên miền này để kiểm tra.`;
  }

  async navigate(url: string) {
    await this.view.webContents.loadURL(youtubeUrl(url));
  }

  bounds(b: { x: number; y: number; width: number; height: number } | null) {
    this.layoutBounds = b;
    if (this.htmlFullscreen) { this.resizeView(); return; }
    if (!b) { this.view.setVisible(false); void this.playback('pause'); return; }
    if (!Object.values(b).every(Number.isFinite)) throw new Error('Kích thước không hợp lệ.');
    const [w, h] = this.window.getContentSize();
    const x = Math.max(0, Math.min(w, Math.round(b.x)));
    const y = Math.max(0, Math.min(h, Math.round(b.y)));
    this.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(w - x, Math.round(b.width))),
      height: Math.max(0, Math.min(h - y, Math.round(b.height)))
    });
    this.view.setVisible(true);
  }

  async playback(action: 'pause' | 'play' | 'seek', time?: number) {
    if (action === 'seek' && (!Number.isFinite(time) || time! < 0)) throw new Error('Mốc thời gian không hợp lệ.');
    await this.controlVideo({ type: action, value: time });
  }

  async controlVideo(cmd: VideoControlCommand) {
    if (this.view.webContents.isDestroyed()) return;
    await this.view.webContents.executeJavaScript(controlVideoScript(cmd), true).catch(() => {});
  }

  async updateOverlay(payload: OverlayStatePayload) {
    if (this.view.webContents.isDestroyed() || !isYoutubePage(this.view.webContents.getURL())) return;
    await this.view.webContents.executeJavaScript(updateOverlayScript(payload), true).catch(() => {});
  }

  getOverlayAnchor(): OverlayAnchor | null {
    return this.overlayAnchor;
  }

  setTranscriptOpen(open: boolean) {
    this.transcriptOpen = Boolean(open);
  }

  async stopDubbing() {
    const id = this.state.videoId;
    const title = this.state.title;
    this.segmentAbortController?.abort();
    this.segmentAbortController = null;
    this.segmentLoadInFlight = false;
    this.dubbingActive = false;
    this.state.dubbingActive = false;
    if (this.state.phase === 'PLAYING' || this.state.phase === 'BUFFERING' || this.state.phase === 'EXTRACTING') {
      this.state.phase = this.state.cues?.length ? 'CAPTIONS_READY' : 'IDLE';
    }
    this.state.videoId = id;
    this.state.title = title;
    if (id && !this.view.webContents.isDestroyed()) {
      await this.view.webContents.executeJavaScript(revertCaptionsToggleScript(id), true).catch(() => {});
    }
  }

  /**
   * Dual-layer timedtext URL capture:
   * 1. Passive wait (up to 1,500ms unless `fresh: true`) for Layer 1 (`page`) or Layer 2 (`background`).
   * 2. Active CC toggle (off -> 150ms -> on) + up to 15,000ms wait.
   * 3. Priority selection: `['page', 'background', 'potless']`.
   */
  private async captureTimedtextUrl(
    videoId: string,
    fallbackBaseUrl: string | undefined,
    token: number,
    options: { fresh?: boolean } = {}
  ): Promise<string> {
    const wc = this.view.webContents;
    const minAt = options.fresh ? Date.now() : 0;

    const findCandidate = () => {
      const all = [...this.pageObservedTimedtext, ...this.bgObservedTimedtext].filter(c => c.at >= minAt);
      return pickBestTimedtext(all, videoId);
    };

    // Step 1: passive wait (1,500ms) when not forcing a fresh capture
    if (!options.fresh) {
      const passiveEnd = Date.now() + PASSIVE_TIMEDTEXT_WAIT_MS;
      while (Date.now() < passiveEnd) {
        if (token !== this.generation) throw new Error('Video đã thay đổi.');
        const hit = findCandidate();
        if (hit && (hit.source === 'page' || hit.source === 'background')) {
          return buildSourceTimedtextUrl(hit.url, null);
        }
        await sleep(150);
      }
    }

    // Step 2: active toggle of YouTube CC button
    await wc.executeJavaScript(toggleCaptionsForCaptureScript(videoId, Boolean(options.fresh)), true).catch(() => {});

    const activeEnd = Date.now() + ACTIVE_TIMEDTEXT_WAIT_MS;
    try {
      while (Date.now() < activeEnd) {
        if (token !== this.generation) throw new Error('Video đã thay đổi.');
        const hit = findCandidate();
        if (hit && (hit.source === 'page' || hit.source === 'background')) {
          return buildSourceTimedtextUrl(hit.url, null);
        }
        await sleep(200);
      }
    } finally {
      if (!wc.isDestroyed() && token === this.generation) {
        await wc.executeJavaScript(revertCaptionsToggleScript(videoId), true).catch(() => {});
      }
    }

    // Step 3: accept potless observation or track.baseUrl fallback
    const finalHit = findCandidate();
    if (finalHit) return buildSourceTimedtextUrl(finalHit.url, null);
    if (fallbackBaseUrl) return buildSourceTimedtextUrl(fallbackBaseUrl, null);
    throw new Error('Không bắt được URL phụ đề YouTube (/api/timedtext).');
  }

  private async downloadTimedtextInPage(url: string, videoId: string): Promise<{
    ok: boolean;
    status: number;
    text?: string;
    rateLimited?: boolean;
    retryAfter?: string | null;
    error?: string;
  }> {
    return this.view.webContents.executeJavaScript(downloadTimedtextInPageScript(url, videoId), true);
  }

  private rebuildMergedTimeline() {
    const ordered = [...this.loadedSegments.values()].sort((a, b) => a.index - b.index);
    const cues: DubbingCue[] = [];
    const soundsRaw: SoundCue[] = [];
    let nextId = 0;

    for (const seg of ordered) {
      for (const cue of seg.cues) {
        cues.push({
          ...cue,
          id: nextId++,
          end: cue.end ?? (cue.start + cue.duration)
        });
      }
      for (const s of seg.sounds || []) {
        soundsRaw.push(s);
      }
    }

    cues.sort((a, b) => a.start - b.start);
    const sounds = dedupeAndSortSounds(soundsRaw);

    this.state.cues = cues;
    this.state.sounds = sounds;
    this.state.loadedSegments = this.loadedSegments.size;
    this.state.totalSegments = this.totalSegments;
    // Keep legacy chunks view synced so sidebar progress & list always work seamlessly
    this.state.chunks = cues.map((c, idx) => ({
      id: idx,
      start: c.start,
      end: c.end,
      text: c.text,
      sourceText: c.sourceText,
      sig: c.sig,
      ready: true
    }));
    this.state.total = Math.max(this.totalSegments, cues.length ? this.totalSegments || 1 : 0);
    this.state.ready = this.loadedSegments.size;
    this.state.initialRequired = 1;
  }

  /**
   * Main v2 Progressive Realtime Dubbing entry point:
   * - Polls player metadata (3s / 300ms retry)
   * - Selects source track (`selectSourceTrack`) & checks language match (`findYouTubeLanguage`, `isSameSpokenLanguage`)
   * - Fast Path: native human target track (`tlang=null`) -> YouTube auto-translate (`tlang`, respecting 30-min 429 breaker) -> gzip `POST /youtube-subtitles`
   * - Segmented AI Path: progressive on-demand `POST /segments` starting at current playback time (no 20% wait from 0!)
   */
  async startDubbing(id: string, options: StartDubbingOptions = {}) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Chọn một video YouTube trước khi bật lồng tiếng.');
    const token = ++this.generation;
    this.segmentAbortController?.abort();
    this.segmentAbortController = new AbortController();
    this.segmentLoadInFlight = false;
    this.loadedSegments.clear();
    this.totalSegments = 0;
    this.activeSourceUrl = '';
    this.activeSourceText = '';
    this.lastSegmentPlanAt = 0;

    const targetLang = options.targetLang || this.getDefaultTargetLang() || 'vi';
    this.targetLang = targetLang;
    if (options.transcriptOpen !== undefined) this.transcriptOpen = options.transcriptOpen;
    this.dubbingActive = true;

    this.state = {
      ...this.state,
      videoId: id,
      targetLang,
      phase: 'EXTRACTING',
      error: '',
      cues: [],
      sounds: [],
      chunks: [],
      ready: 0,
      total: 0,
      loadedSegments: 0,
      totalSegments: 0,
      dubbingActive: true,
      autoTranslatePausedUntil: this.autoTranslatePausedUntil
    };

    try {
      const meta = await this.view.webContents.executeJavaScript(pollPlayerMetadataScript(id), true) as {
        ok: boolean;
        title?: string;
        live?: boolean;
        originalAudioLanguage?: string;
        tracks?: CaptionTrackInfo[];
        translationLanguages?: TranslationLanguageInfo[];
      };

      if (token !== this.generation) return;
      if (!meta?.ok) throw new Error('Chưa đọc được thông tin video từ YouTube Player. Hãy thử lại.');
      if (meta.live) {
        this.dubbingActive = false;
        this.state.dubbingActive = false;
        this.state.phase = 'NO_SUBTITLES';
        this.state.error = 'Chưa hỗ trợ livestream trực tiếp.';
        return;
      }

      const tracks = meta.tracks || [];
      const translationLanguages = meta.translationLanguages || [];
      this.state.title = meta.title || this.state.title;
      this.state.tracks = tracks;
      this.state.detectedSourceLanguage = meta.originalAudioLanguage || '';

      if (!tracks.length) {
        this.dubbingActive = false;
        this.state.dubbingActive = false;
        this.state.phase = 'NO_SUBTITLES';
        this.state.error = 'Video này không có phụ đề khả dụng.';
        return;
      }

      const preferredSourceLang = options.sourceLang || meta.originalAudioLanguage || undefined;
      const sourceTrack = selectSourceTrack(tracks, preferredSourceLang);
      if (!sourceTrack) {
        this.dubbingActive = false;
        this.state.dubbingActive = false;
        this.state.phase = 'NO_SUBTITLES';
        this.state.error = 'Không tìm thấy track phụ đề nguồn phù hợp.';
        return;
      }

      this.activeSourceLang = sourceTrack.languageCode;
      this.state.sourceLanguage = sourceTrack.languageCode;

      // Capture authorized source URL (dual-layer sniffer with pot + 60s expiry validation)
      const capturedUrl = await this.captureTimedtextUrl(id, sourceTrack.baseUrl, token, {
        fresh: Boolean(options.forceRefresh)
      });
      if (token !== this.generation) return;
      this.activeSourceUrl = capturedUrl;

      // Download source text once client-side for bilingual pairing & worker fallback
      let sourceText: string | undefined;
      const srcDl = await this.downloadTimedtextInPage(capturedUrl, id);
      if (token !== this.generation) return;
      if (srcDl.ok && srcDl.text) {
        sourceText = srcDl.text;
        this.activeSourceText = srcDl.text;
      }

      // === FAST PATH 1: Native target track (tlang=null) ===
      const manualTargetCodes = tracks.filter(t => !t.isAutoGenerated).map(t => t.languageCode);
      const nativeTargetCode = findYouTubeLanguage(targetLang, manualTargetCodes);
      const nativeTargetTrack = nativeTargetCode
        ? tracks.find(t => !t.isAutoGenerated && t.languageCode === nativeTargetCode)
        : undefined;

      // Also if source track itself is already in the target spoken language
      const sourceAlreadyTarget = isSameSpokenLanguage(sourceTrack.languageCode, targetLang);

      if (nativeTargetTrack?.baseUrl || (sourceAlreadyTarget && sourceText)) {
        let targetText = sourceAlreadyTarget ? sourceText : undefined;
        if (!targetText && nativeTargetTrack?.baseUrl) {
          const nativeUrl = buildSourceTimedtextUrl(nativeTargetTrack.baseUrl, null);
          const nativeDl = await this.downloadTimedtextInPage(nativeUrl, id);
          if (token !== this.generation) return;
          if (nativeDl.ok && nativeDl.text && nativeDl.text.length <= MAX_SUBTITLE_PAYLOAD_CHARS) {
            targetText = nativeDl.text;
          }
        }
        if (targetText && targetText.length <= MAX_SUBTITLE_PAYLOAD_CHARS) {
          const fastResult = await this.dubbingClient.submitYoutubeSubtitles({
            videoId: id,
            targetLang,
            sourceLang: sourceTrack.languageCode,
            subtitleText: targetText,
            sourceText: sourceAlreadyTarget ? undefined : sourceText
          });
          if (token !== this.generation) return;
          this.applyAllSegments(fastResult.segments, fastResult.totalSegments, 'youtube');
          return;
        }
      }

      // === FAST PATH 2: YouTube Auto-Translate (tlang) if 30-min 429 breaker is NOT tripped ===
      const canAutoTranslate = Date.now() >= this.autoTranslatePausedUntil && sourceTrack.isTranslatable;
      const tlangCode = canAutoTranslate
        ? findYouTubeLanguage(targetLang, translationLanguages.map(l => l.languageCode))
        : null;

      if (tlangCode) {
        const autoUrl = buildSourceTimedtextUrl(capturedUrl, tlangCode);
        const autoDl = await this.downloadTimedtextInPage(autoUrl, id);
        if (token !== this.generation) return;

        if (autoDl.rateLimited || autoDl.status === 429) {
          this.autoTranslatePausedUntil = Date.now() + AUTO_TRANSLATE_429_COOLDOWN_MS;
          this.state.autoTranslatePausedUntil = this.autoTranslatePausedUntil;
        } else if (autoDl.ok && autoDl.text && autoDl.text.length <= MAX_SUBTITLE_PAYLOAD_CHARS) {
          const fastResult = await this.dubbingClient.submitYoutubeSubtitles({
            videoId: id,
            targetLang,
            sourceLang: sourceTrack.languageCode,
            subtitleText: autoDl.text,
            sourceText
          });
          if (token !== this.generation) return;
          if (fastResult.segments.length > 0) {
            this.applyAllSegments(fastResult.segments, fastResult.totalSegments, 'youtube');
            return;
          }
        }
      }

      // === SEGMENTED AI PATH: Progressive on-demand streaming from current playback time ===
      this.state.phase = 'BUFFERING';
      await this.loadSegmentNow({ currentTime: Math.max(0, this.state.time) }, token);
    } catch (err) {
      if (token === this.generation) {
        this.dubbingActive = false;
        this.state.dubbingActive = false;
        this.state.phase = 'ERROR';
        this.state.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  private applyAllSegments(
    segments: DubbingSegment[],
    totalSegments: number,
    translationSource: 'youtube' | 'ai' | 'direct-worker'
  ) {
    this.loadedSegments.clear();
    for (const seg of segments) {
      this.loadedSegments.set(seg.index, seg);
    }
    this.totalSegments = Math.max(totalSegments, segments.length);
    this.state.translationSource = translationSource;
    this.rebuildMergedTimeline();
    this.state.phase = this.state.cues && this.state.cues.length > 0 ? 'COMPLETE' : 'NO_SUBTITLES';
  }

  /**
   * Single-flight progressive segment fetcher:
   * - Calls `DubbingClient.fetchSegment` (2 retries x 1000ms)
   * - On `SUBTITLE_DOWNLOAD_FAILED`, immediately recaptures a fresh `pot` URL & retries once.
   */
  private async loadSegmentNow(
    plan: { currentTime: number } | { segment: number },
    token: number
  ): Promise<void> {
    if (this.segmentLoadInFlight || token !== this.generation || !this.dubbingActive) return;
    this.segmentLoadInFlight = true;
    const signal = this.segmentAbortController?.signal;

    try {
      const requestOnce = () => this.dubbingClient.fetchSegment({
        videoId: this.state.videoId,
        subtitleUrl: this.activeSourceUrl || undefined,
        subtitleText: this.activeSourceText || undefined,
        targetLang: this.targetLang,
        sourceLang: this.activeSourceLang || undefined,
        ...plan
      }, signal);

      let result;
      try {
        result = await requestOnce();
      } catch (err) {
        if (err instanceof SubtitleDownloadFailedError && token === this.generation) {
          // Capture fresh `pot` URL if pot was present (or refresh source text) and retry once
          const sourceTrack = selectSourceTrack(this.state.tracks || [], this.activeSourceLang);
          const freshUrl = await this.captureTimedtextUrl(
            this.state.videoId,
            sourceTrack?.baseUrl,
            token,
            { fresh: true }
          );
          if (token !== this.generation) return;
          this.activeSourceUrl = freshUrl;
          const freshDl = await this.downloadTimedtextInPage(freshUrl, this.state.videoId);
          if (freshDl.ok && freshDl.text) this.activeSourceText = freshDl.text;
          result = await requestOnce();
        } else {
          throw err;
        }
      }

      if (token !== this.generation) return;
      this.totalSegments = Math.max(this.totalSegments, result.totalSegments);
      this.loadedSegments.set(result.segment.index, result.segment);
      this.state.translationSource = result.translationSource;
      this.rebuildMergedTimeline();

      if (this.loadedSegments.size >= this.totalSegments && this.totalSegments > 0) {
        this.state.phase = 'COMPLETE';
      } else {
        this.state.phase = 'PLAYING';
      }
    } catch (err) {
      if (token === this.generation && !(err instanceof Error && err.message === 'Aborted')) {
        // Keep playing already loaded segments if we have them; only fail hard if 0 loaded
        if (this.loadedSegments.size === 0) {
          this.dubbingActive = false;
          this.state.dubbingActive = false;
          this.state.phase = 'ERROR';
          this.state.error = err instanceof Error ? err.message : String(err);
        } else {
          this.state.error = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      this.segmentLoadInFlight = false;
    }
  }

  // Backward-compatible IPC hooks routed to v2 realtime dubbing
  async loadSubtitles(id: string, language?: SourceLanguage, forceRefresh = false) {
    await this.startDubbing(id, {
      sourceLang: language,
      targetLang: this.getDefaultTargetLang(),
      forceRefresh
    });
  }

  async startTranslation(id: string) {
    await this.startDubbing(id, {
      sourceLang: this.state.sourceLanguage,
      targetLang: this.getDefaultTargetLang()
    });
  }

  async retry() {
    if (!this.state.videoId) return;
    await this.startDubbing(this.state.videoId, {
      sourceLang: this.state.sourceLanguage,
      targetLang: this.targetLang || this.getDefaultTargetLang(),
      forceRefresh: true
    });
  }

  private async tick() {
    if (this.busy || this.view.webContents.isDestroyed()) return;
    if (!isYoutubePage(this.view.webContents.getURL())) return;
    this.busy = true;
    const token = this.generation;
    try {
      const info = await this.view.webContents.executeJavaScript(inspectVideo);
      if (token !== this.generation) return;

      if (!/^[\w-]{11}$/.test(info.id)) {
        if (this.state.videoId) this.reset();
        return;
      }

      if (info.id !== this.state.videoId) {
        this.reset();
        this.state.videoId = info.id;
        this.state.title = info.title;
      }

      if (Array.isArray(info.observedTimedtext)) {
        this.pageObservedTimedtext = info.observedTimedtext;
      }
      if (info.overlayAnchor && typeof info.overlayAnchor.pct === 'number') {
        this.overlayAnchor = info.overlayAnchor;
      }

      Object.assign(this.state, {
        time: info.time,
        duration: info.duration,
        paused: info.paused,
        ended: info.ended,
        buffering: info.buffering,
        adShowing: info.ad,
        rate: info.rate,
        muted: info.muted,
        volume: info.volume,
        seekVersion: info.seekVersion,
        overlayAnchor: this.overlayAnchor || undefined
      });

      if (!info.valid) {
        this.state.paused = true;
        return;
      }

      this.state.title = info.title;
      this.state.captionLanguages = info.captionLanguages || [];
      this.state.tracks = info.tracks || [];
      this.state.detectedSourceLanguage = isCaptionLanguage(info.detectedSourceLanguage)
        ? info.detectedSourceLanguage
        : '';

      // Progressive segment planner: 1,000ms cadence + immediate reset on seeked; skipped during ads
      if (this.dubbingActive && !info.ad && !this.segmentLoadInFlight && this.totalSegments > 0) {
        if (info.seekVersion !== this.lastSeekVersion) {
          this.lastSeekVersion = info.seekVersion;
          this.lastSegmentPlanAt = 0; // immediate fetch on seek
        }

        const now = Date.now();
        if (now - this.lastSegmentPlanAt >= SEGMENT_PLAN_CADENCE_MS) {
          this.lastSegmentPlanAt = now;
          const plan = planSegmentLoad(info.time, this.loadedSegments, this.totalSegments);
          if (plan) {
            void this.loadSegmentNow(plan, token);
          } else if (this.transcriptOpen) {
            // Eager transcript backfill when transcript panel is open
            const missing = nextMissingSegment(this.loadedSegments, this.totalSegments);
            if (missing !== null) {
              void this.loadSegmentNow({ segment: missing }, token);
            }
          }
        }
      }
    } catch (e) {
      if (token === this.generation && !this.view.webContents.isLoading()) {
        this.state.error = String(e);
      }
    } finally {
      this.busy = false;
    }
  }

  async persistSession() {
    if (this.view.webContents.isDestroyed()) return;
    const session = this.view.webContents.session;
    session.flushStorageData();
    await session.cookies.flushStore();
  }

  close() {
    clearInterval(this.timer);
    this.generation++;
    this.segmentAbortController?.abort();
    this.window.removeListener('resize', this.resizeView);
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.session.webRequest.onCompleted(null);
      this.view.webContents.close();
    }
  }
}
