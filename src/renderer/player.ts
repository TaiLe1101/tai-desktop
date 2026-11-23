import {
  AUDIO_RATE_MAX,
  LOOKAHEAD_CUES,
  PlaybackClock,
  TAIL_OVERLAP_SECONDS,
  computeTargetVolume,
  decideAlignment,
  isAlignmentRate,
  isInSpeechGap,
  isOurVolume,
  recoverUserRate,
  refineVideoRateFactor,
  toAlignmentRate,
  type LookaheadCueMetric
} from '../shared/alignment-policy';
import { cleanSubtitleText, findNextCue, selectActiveCue, selectActiveSound } from '../shared/subtitles';
import { computeEffectiveSpeechRate, formatSsmlRate, getSelectedVoice } from '../shared/voices';
import type {
  DubbingCue,
  DubbingPreferences,
  DubbingRuntimeStatus,
  OverlayStatePayload,
  TelemetrySession,
  VideoSession
} from '../shared/types';
import { TtsManager, speakWithWebSpeech } from './tts-manager';

const MAX_PENDING_SPEECHES = 6;
const STUCK_GATE_WATCHDOG_MS = 20_000;
const TELEMETRY_STORAGE_KEY = 'tai:telemetry-queue';
const MAX_TELEMETRY_QUEUE = 20;

interface QueuedSpeech {
  id: number;
  cue: DubbingCue;
  cueKey: string;
  controller: AbortController;
}

interface ActiveSpeech {
  id: number;
  cue: DubbingCue;
  audio: HTMLAudioElement | null;
  isWebSpeech: boolean;
  deadline: number;
  cutoffTime: number;
  audioRate: number;
  videoRateFactor: number;
  controller: AbortController;
}

export interface DubbingControllerCallbacks {
  onStatusChange?: (status: DubbingRuntimeStatus) => void;
  onToast?: (message: string) => void;
  onFirstAudioStart?: () => void;
}

function cueIdentity(cue: DubbingCue): string {
  return `${Math.round(cue.start * 1000)}|${cue.text}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function setPreservesPitch(audio: HTMLAudioElement, value: boolean): void {
  const a = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  a.preservesPitch = value;
  a.mozPreservesPitch = value;
  a.webkitPreservesPitch = value;
}

/**
 * Realtime Dubbing Controller implementing all autodub-example runtime techniques:
 * - 100ms tracking loop with `tickInFlight` guard
 * - 3-cue lookahead `decideAlignment` (EMA 0.25, slew ±0.05, preservesPitch=true, max 1.25x)
 * - Closed-loop video rate refinement (0.03 hysteresis) + sentinel `.xx1` rate tagging
 * - Bounded FIFO speech queue (max 6) + serial overlap gate (10-100ms adaptive wake + 20s watchdog)
 * - 4-point `canStart` gate + `pausedSuppressedCue`
 * - Smooth volume ducking (4 modes, volume ownership guard, 1.0s speech-gap anti-pumping)
 * - Ad/buffering/pause/seek resilience (`pausedSeekId` race guard)
 * - In-player subtitle overlay sync + WebSpeech fallback + `PlaybackClock` telemetry
 */
export class VoicePlayer {
  private readonly tts = new TtsManager();
  private readonly clock = new PlaybackClock();

  private latestSession: VideoSession | null = null;
  private latestPrefs: DubbingPreferences | null = null;
  private enabled = false;

  private tickInFlight = false;
  private generation = 0;
  private nextSpeechId = 1;

  // Speech queue & overlap gate
  private pendingSpeeches: QueuedSpeech[] = [];
  private activeSpeech: ActiveSpeech | null = null;
  private gateWaiters: Array<() => void> = [];
  private spokenCues = new Set<string>();
  private pausedSuppressedCue: DubbingCue | null = null;
  private prevAudioRate = 1.0;

  // Rate & volume ownership
  private userVideoRate = 1.0;
  private activeVideoRateFactor = 1.0;
  private appliedAlignmentRate: number | null = null;
  private userVolume = 1.0;
  private duckedTo: number | null = null;

  // Lifecycle tracking
  private lastVideoId = '';
  private lastSeekVersion = 0;
  private lastTime = 0;
  private wasAdShowing = false;
  private wasPaused = true;
  private wasBuffering = false;
  private pausedSeekId = 0;
  private firstAudioEmitted = false;

  // Overlay diff guard & status
  private lastOverlayHash = '';
  private status: DubbingRuntimeStatus = 'idle';

  // Telemetry stats for active video session
  private sessionStartedAt = 0;
  private stats = {
    dubbedCues: 0,
    truncatedCues: 0,
    gateForced: 0,
    fallbackCues: 0
  };

  constructor(private callbacks: DubbingControllerCallbacks = {}) {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.handlePageHide);
    }
  }

  private readonly handlePageHide = () => {
    this.flushTelemetry(true);
  };

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.handlePageHide);
    }
    this.stop();
  }

  private setStatus(next: DubbingRuntimeStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.callbacks.onStatusChange?.(next);
  }

  /**
   * Live-updates dubVolume on any active `<audio>` element without interrupting playback.
   */
  applyDubVolumeLive(dubVolumePct: number): void {
    if (this.activeSpeech?.audio) {
      this.activeSpeech.audio.volume = clamp(dubVolumePct / 100, 0, 1);
    }
  }

  /**
   * Immediately interrupts active speech and clears pending queue.
   */
  interruptSpeech(): void {
    for (const q of this.pendingSpeeches) q.controller.abort();
    this.pendingSpeeches = [];

    if (this.activeSpeech) {
      const active = this.activeSpeech;
      this.activeSpeech = null;
      active.controller.abort();
      if (active.audio) {
        active.audio.pause();
        active.audio.src = '';
      }
      if (active.isWebSpeech && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try { window.speechSynthesis.cancel(); } catch {}
      }
    }
    this.wakeGate();
  }

  stop(): void {
    this.flushTelemetry(false);
    this.generation++;
    this.enabled = false;
    this.interruptSpeech();
    this.tts.clear();
    this.spokenCues.clear();
    this.pausedSuppressedCue = null;
    this.prevAudioRate = 1.0;
    this.firstAudioEmitted = false;
    this.restoreVideoRate();
    this.restoreVideoVolume();
    this.setStatus('idle');
    this.pushOverlay({
      mode: this.latestPrefs?.subtitleMode || 'bilingual',
      translatedText: '',
      sourceText: '',
      soundText: '',
      status: 'idle',
      dubbingActive: false
    });
  }

  private wakeGate(): void {
    const waiters = this.gateWaiters.splice(0, this.gateWaiters.length);
    for (const fn of waiters) fn();
  }

  private getActiveRemainingSeconds(): number {
    const a = this.activeSpeech?.audio;
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) {
      return this.activeSpeech ? 0.5 : 0;
    }
    const rem = Math.max(0, a.duration - a.currentTime);
    const rate = a.playbackRate > 0 ? a.playbackRate : 1;
    return rem / rate;
  }

  private canStartPlayback(gen: number): boolean {
    const s = this.latestSession;
    if (!this.enabled || gen !== this.generation || !s || !s.dubbingActive) return false;
    if (s.paused || s.buffering || s.adShowing) return false;
    return true;
  }

  private restoreVideoRate(): void {
    if (this.appliedAlignmentRate !== null || this.activeVideoRateFactor !== 1.0) {
      this.appliedAlignmentRate = null;
      this.activeVideoRateFactor = 1.0;
      void window.tai.controlVideo({ type: 'setRate', value: this.userVideoRate }).catch(() => {});
    }
  }

  private setVideoAlignmentFactor(factor: number): void {
    this.activeVideoRateFactor = factor;
    if (factor >= 0.999) {
      this.restoreVideoRate();
      return;
    }
    const encoded = toAlignmentRate(this.userVideoRate * factor);
    if (this.appliedAlignmentRate !== encoded) {
      this.appliedAlignmentRate = encoded;
      void window.tai.controlVideo({ type: 'setRate', value: encoded }).catch(() => {});
    }
  }

  private restoreVideoVolume(): void {
    if (this.duckedTo === null) return;
    const s = this.latestSession;
    // Volume ownership guard: only restore if user hasn't manually changed volume
    if (!s || isOurVolume(s.volume, this.duckedTo)) {
      void window.tai.controlVideo({ type: 'setVolume', value: this.userVolume }).catch(() => {});
    }
    this.duckedTo = null;
  }

  private syncDucking(s: VideoSession, prefs: DubbingPreferences, activeCue: DubbingCue | null): void {
    if (!this.enabled || !s.dubbingActive || s.adShowing) {
      this.restoreVideoVolume();
      return;
    }

    // Track user volume whenever current player volume is not our ducked level
    if (this.duckedTo === null || !isOurVolume(s.volume, this.duckedTo)) {
      if (Number.isFinite(s.volume)) {
        this.userVolume = clamp(s.volume, 0, 1);
      }
    }

    const isSpeaking = Boolean(this.activeSpeech);
    const nextCue = findNextCue(s.cues || [], s.time, activeCue);
    const inGap = isInSpeechGap(s.time, nextCue?.start);
    const target = computeTargetVolume(
      prefs.originalAudioMode,
      this.userVolume,
      prefs.duckLevel,
      isSpeaking,
      inGap
    );

    if (Math.abs(target - this.userVolume) < 0.001) {
      this.restoreVideoVolume();
      return;
    }

    if (this.duckedTo === null || Math.abs(target - this.duckedTo) >= 0.001 || !isOurVolume(s.volume, target)) {
      this.duckedTo = target;
      void window.tai.controlVideo({ type: 'setVolume', value: target }).catch(() => {});
    }
  }

  private pushOverlay(payload: OverlayStatePayload): void {
    const hash = JSON.stringify(payload);
    if (hash === this.lastOverlayHash) return;
    this.lastOverlayHash = hash;
    void window.tai.updateOverlay(payload).catch(() => {});
  }

  private readTelemetryQueue(): TelemetrySession[] {
    try {
      const raw = localStorage.getItem(TELEMETRY_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  private writeTelemetryQueue(queue: TelemetrySession[]): void {
    try {
      localStorage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify(queue.slice(-MAX_TELEMETRY_QUEUE)));
    } catch {}
  }

  private flushTelemetry(isUnload: boolean): void {
    const watched = this.clock.watchedSeconds;
    const queue = this.readTelemetryQueue();
    if (this.lastVideoId && watched > 0.5) {
      queue.push({
        sessionId: `${this.lastVideoId}-${this.sessionStartedAt || Date.now()}`,
        videoId: this.lastVideoId,
        sourceLang: this.latestSession?.sourceLanguage,
        targetLang: this.latestPrefs?.targetLang || this.latestSession?.targetLang || 'vi',
        translationSource: this.latestSession?.translationSource,
        watchedSeconds: watched,
        dubbedCues: this.stats.dubbedCues,
        truncatedCues: this.stats.truncatedCues,
        gateForced: this.stats.gateForced,
        fallbackCues: this.stats.fallbackCues,
        startedAt: this.sessionStartedAt || Date.now(),
        endedAt: Date.now()
      });
      this.clock.reset();
      this.stats = { dubbedCues: 0, truncatedCues: 0, gateForced: 0, fallbackCues: 0 };
      this.sessionStartedAt = Date.now();
    }

    const bounded = queue.slice(-MAX_TELEMETRY_QUEUE);
    if (!bounded.length) return;
    this.writeTelemetryQueue(bounded);

    if (isUnload) {
      void window.tai.reportSessions(bounded).catch(() => {});
      return;
    }
    void window.tai.reportSessions(bounded)
      .then(res => {
        if (res.accepted > 0) this.writeTelemetryQueue([]);
      })
      .catch(() => {});
  }

  /**
   * Called every 100ms by renderer tracking loop. Protected by `tickInFlight` guard.
   */
  async sync(s: VideoSession, enabled: boolean, prefs: DubbingPreferences): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      this.latestSession = s;
      this.latestPrefs = prefs;
      this.enabled = enabled;

      // Video changed: flush telemetry and reset per-video state
      if (s.videoId !== this.lastVideoId) {
        if (this.lastVideoId) this.flushTelemetry(false);
        this.lastVideoId = s.videoId;
        this.sessionStartedAt = Date.now();
        this.generation++;
        this.interruptSpeech();
        this.tts.clear();
        this.spokenCues.clear();
        this.pausedSuppressedCue = null;
        this.prevAudioRate = 1.0;
        this.firstAudioEmitted = false;
        this.lastSeekVersion = s.seekVersion || 0;
        this.lastTime = s.time;
        this.wasAdShowing = Boolean(s.adShowing);
        this.wasPaused = s.paused;
        this.wasBuffering = Boolean(s.buffering);
        this.userVideoRate = recoverUserRate(s.rate, 1.0);
        if (isAlignmentRate(s.rate)) {
          // Recover cleanly from stale `.xx1` rate on reload
          void window.tai.controlVideo({ type: 'setRate', value: this.userVideoRate }).catch(() => {});
        }
      }

      // Track user's manual playbackRate (ignoring our sentinel `.xx1` alignment rates)
      if (!isAlignmentRate(s.rate) && Number.isFinite(s.rate) && s.rate > 0) {
        this.userVideoRate = s.rate;
      }

      // Accumulate watched seconds (0 < dt <= 2s, immune to seeks/ads/pauses)
      const isActivelyWatching = Boolean(enabled && s.dubbingActive && !s.paused && !s.buffering && !s.adShowing);
      this.clock.tick(s.time, isActivelyWatching);

      // Ad transitions
      const adNow = Boolean(s.adShowing);
      if (adNow && !this.wasAdShowing) {
        this.interruptSpeech();
        this.restoreVideoRate();
        this.restoreVideoVolume();
      } else if (!adNow && this.wasAdShowing) {
        this.spokenCues.clear();
      }
      this.wasAdShowing = adNow;

      // Seek detection (explicit seekVersion bump OR jump > 1.5s)
      const seekVersion = s.seekVersion || 0;
      const jumped = Math.abs(s.time - this.lastTime) > 1.5;
      if (seekVersion !== this.lastSeekVersion || jumped) {
        this.lastSeekVersion = seekVersion;
        this.interruptSpeech();
        this.restoreVideoRate();
        this.spokenCues.clear();
        this.pausedSuppressedCue = null;
        if (s.paused) {
          // Preview cue/sound while paused with pausedSeekId race guard
          const seekToken = ++this.pausedSeekId;
          const previewCue = selectActiveCue(s.cues || [], s.time);
          const previewSound = previewCue ? null : selectActiveSound(s.sounds || [], s.time);
          if (seekToken === this.pausedSeekId) {
            this.pushOverlay({
              mode: prefs.subtitleMode,
              translatedText: previewCue?.text || '',
              sourceText: previewCue?.sourceText || '',
              soundText: previewSound?.text || '',
              status: 'idle',
              dubbingActive: Boolean(enabled && s.dubbingActive),
              anchor: prefs.overlayAnchor
            });
          }
        }
      }
      this.lastTime = s.time;

      // Buffering pause/resume
      const bufferingNow = Boolean(s.buffering);
      if (bufferingNow && !this.wasBuffering && this.activeSpeech?.audio) {
        this.activeSpeech.audio.pause();
      } else if (!bufferingNow && this.wasBuffering && !s.paused && this.activeSpeech?.audio) {
        void this.activeSpeech.audio.play().catch(() => {});
      }
      this.wasBuffering = bufferingNow;

      // Pause / resume (do NOT pause TTS if video naturally ended while finishing final sentence)
      if (s.paused && !this.wasPaused && !s.ended) {
        if (this.activeSpeech?.audio) this.activeSpeech.audio.pause();
      } else if (!s.paused && this.wasPaused) {
        if (this.activeSpeech?.audio) {
          void this.activeSpeech.audio.play().catch(() => {});
        }
      }
      this.wasPaused = s.paused;

      const cues = s.cues || [];
      const sounds = s.sounds || [];
      const activeCue = selectActiveCue(cues, s.time);
      const activeSound = activeCue ? null : selectActiveSound(sounds, s.time);

      // Update live status
      if (!enabled || !s.dubbingActive) {
        if (this.activeSpeech) this.interruptSpeech();
        this.restoreVideoRate();
        this.restoreVideoVolume();
        this.setStatus('idle');
        this.pushOverlay({
          mode: prefs.subtitleMode,
          translatedText: activeCue?.text || '',
          sourceText: activeCue?.sourceText || '',
          soundText: activeSound?.text || '',
          status: 'idle',
          dubbingActive: false,
          anchor: prefs.overlayAnchor
        });
        return;
      }

      if (s.phase === 'EXTRACTING' || s.phase === 'BUFFERING') {
        this.setStatus('preparing');
      } else if (bufferingNow) {
        this.setStatus('buffering');
      } else if (this.activeSpeech) {
        this.setStatus('speaking');
      } else if (s.phase === 'ERROR') {
        this.setStatus('error');
      } else {
        this.setStatus(cues.length ? 'idle' : 'preparing');
      }

      // Sync overlay with currently spoken cue (or active cue / gap sound)
      const displayCue = this.activeSpeech?.cue || activeCue;
      this.pushOverlay({
        mode: prefs.subtitleMode,
        translatedText: displayCue?.text || '',
        sourceText: displayCue?.sourceText || '',
        soundText: displayCue ? '' : (activeSound?.text || ''),
        status: this.status,
        dubbingActive: true,
        anchor: prefs.overlayAnchor
      });

      // Closed-loop alignment refinement + hard cutoff for currently playing speech
      if (this.activeSpeech && !s.paused && !bufferingNow && !adNow) {
        const active = this.activeSpeech;
        if (s.time > active.cutoffTime) {
          // Hard cutoff exceeded
          this.stats.truncatedCues++;
          this.interruptSpeech();
          this.restoreVideoRate();
        } else {
          const remainingAudio = this.getActiveRemainingSeconds();
          const remainingBudget = Math.max(active.deadline, s.time + 0.5) - s.time;
          const refined = refineVideoRateFactor(
            remainingAudio,
            remainingBudget,
            this.userVideoRate,
            this.activeVideoRateFactor
          );
          if (refined !== this.activeVideoRateFactor) {
            this.setVideoAlignmentFactor(refined);
          }
        }
      } else if (!this.activeSpeech) {
        this.restoreVideoRate();
      }

      // Smooth ducking & speech-gap anti-pumping
      this.syncDucking(s, prefs, activeCue);

      // Skip queueing new speech during ads, pause, or buffering
      if (adNow || s.paused || bufferingNow) {
        if (activeCue && !this.spokenCues.has(cueIdentity(activeCue)) && (s.paused || bufferingNow)) {
          this.pausedSuppressedCue = activeCue;
        }
        return;
      }

      // Re-trigger suppressed cue upon resume, or trigger active cue
      const candidate = this.pausedSuppressedCue || activeCue;
      if (candidate) {
        const key = cueIdentity(candidate);
        if (!this.spokenCues.has(key)) {
          this.pausedSuppressedCue = null;
          this.enqueueCue(candidate, cues, prefs);
        } else if (this.pausedSuppressedCue === candidate) {
          this.pausedSuppressedCue = null;
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private enqueueCue(cue: DubbingCue, allCues: DubbingCue[], prefs: DubbingPreferences): void {
    const cleaned = cleanSubtitleText(cue.text);
    if (!cleaned) return;
    const key = cueIdentity(cue);
    this.spokenCues.add(key);

    const lang = this.latestSession?.targetLang || prefs.targetLang || 'vi';
    const voice = getSelectedVoice(lang, prefs.voiceByLang);
    const effRate = computeEffectiveSpeechRate(prefs.speechRate, this.userVideoRate);
    const rateStr = formatSsmlRate(effRate);

    // Lookahead TTS prefetch: up to 12 upcoming cues within +30s
    this.tts.prefetchAhead(allCues, cue.start, lang, voice, rateStr);

    // Bounded FIFO queue (max 6): drop & abort oldest
    while (this.pendingSpeeches.length >= MAX_PENDING_SPEECHES) {
      const dropped = this.pendingSpeeches.shift();
      dropped?.controller.abort();
    }

    const speech: QueuedSpeech = {
      id: this.nextSpeechId++,
      cue,
      cueKey: key,
      controller: new AbortController()
    };
    this.pendingSpeeches.push(speech);
    void this.runQueuedSpeech(speech, cleaned, allCues, lang, voice, rateStr, prefs);
  }

  private async waitForOverlapGate(speech: QueuedSpeech, gen: number): Promise<boolean> {
    const startedWaitAt = Date.now();

    while (true) {
      if (speech.controller.signal.aborted || gen !== this.generation || !this.enabled) {
        return false;
      }

      const isHead = this.pendingSpeeches[0]?.id === speech.id;
      const s = this.latestSession;
      const playable = Boolean(s && !s.paused && !s.buffering && !s.adShowing);
      const remaining = this.getActiveRemainingSeconds();
      const gateClear = !this.activeSpeech || remaining <= TAIL_OVERLAP_SECONDS;

      if (isHead && playable && gateClear) {
        return true;
      }

      // 20,000ms stuck-gate watchdog forces release
      if (isHead && playable && Date.now() - startedWaitAt >= STUCK_GATE_WATCHDOG_MS) {
        this.stats.gateForced++;
        if (this.activeSpeech) {
          const stuck = this.activeSpeech;
          this.activeSpeech = null;
          stuck.controller.abort();
          stuck.audio?.pause();
        }
        return true;
      }

      const waitMs = clamp(Math.min(100, remaining * 1000), 10, 100);
      await new Promise<void>(resolve => {
        let done = false;
        const wake = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, waitMs);
        this.gateWaiters.push(wake);
      });
    }
  }

  private buildLookaheadMetrics(
    cue: DubbingCue,
    allCues: DubbingCue[],
    lang: string,
    voice: string,
    rateStr: string
  ): LookaheadCueMetric[] {
    const idx = allCues.indexOf(cue);
    if (idx < 0) return [];
    const metrics: LookaheadCueMetric[] = [];
    for (let i = idx + 1; i < allCues.length && metrics.length < LOOKAHEAD_CUES; i++) {
      const next = allCues[i];
      const cleaned = cleanSubtitleText(next.text);
      if (!cleaned) continue;
      const key = TtsManager.makeKey(lang, voice, rateStr, cleaned);
      const dur = this.tts.peekDuration(key);
      if (dur && Number.isFinite(dur) && dur > 0) {
        metrics.push({
          cueStart: next.start,
          cueEnd: next.end ?? (next.start + next.duration),
          nextCueStart: allCues[i + 1]?.start,
          audioDuration: dur
        });
      }
    }
    return metrics;
  }

  private async runQueuedSpeech(
    speech: QueuedSpeech,
    cleanedText: string,
    allCues: DubbingCue[],
    lang: string,
    voice: string,
    rateStr: string,
    prefs: DubbingPreferences
  ): Promise<void> {
    const gen = this.generation;
    const removeFromPending = () => {
      const idx = this.pendingSpeeches.findIndex(p => p.id === speech.id);
      if (idx >= 0) this.pendingSpeeches.splice(idx, 1);
    };

    const suppressForResume = () => {
      if (!speech.controller.signal.aborted && gen === this.generation && this.enabled) {
        this.spokenCues.delete(speech.cueKey);
        this.pausedSuppressedCue = speech.cue;
      }
    };

    try {
      // Gate 1: before fetch
      if (!this.canStartPlayback(gen) || speech.controller.signal.aborted) {
        suppressForResume();
        return;
      }

      let audioEntry: { url: string; duration?: number } | null = null;
      let useFallback = false;

      try {
        audioEntry = await this.tts.loadAudio({
          text: cleanedText,
          lang,
          voice,
          rateStr,
          sig: cleanedText === speech.cue.text ? speech.cue.sig : undefined,
          allowStaleBypass: true
        });
      } catch (err) {
        if (speech.controller.signal.aborted || gen !== this.generation) return;
        useFallback = true;
      }

      // Gate 2: after fetch
      if (!this.canStartPlayback(gen) || speech.controller.signal.aborted) {
        suppressForResume();
        return;
      }

      // Serial overlap gate
      const passedGate = await this.waitForOverlapGate(speech, gen);
      if (!passedGate) return;

      // Gate 3: after overlap gate
      if (!this.canStartPlayback(gen) || speech.controller.signal.aborted) {
        suppressForResume();
        return;
      }

      removeFromPending();

      const now = this.latestSession?.time ?? speech.cue.start;
      const nextCue = findNextCue(allCues, speech.cue.start, speech.cue);
      const cueEnd = speech.cue.end ?? (speech.cue.start + speech.cue.duration);
      const lookahead = this.buildLookaheadMetrics(speech.cue, allCues, lang, voice, rateStr);

      if (!useFallback && audioEntry) {
        const audio = new Audio(audioEntry.url);
        audio.preload = 'auto';
        audio.volume = clamp((this.latestPrefs?.dubVolume ?? prefs.dubVolume) / 100, 0, 1);
        setPreservesPitch(audio, true);

        const audioDur = audioEntry.duration || Math.max(0.5, cueEnd - speech.cue.start);
        const decision = decideAlignment({
          now,
          cueEnd,
          nextCueStart: nextCue?.start,
          audioDuration: audioDur,
          userVideoRate: this.userVideoRate,
          prevAudioRate: this.prevAudioRate,
          lookahead
        });

        this.prevAudioRate = decision.audioRate;
        audio.playbackRate = clamp(decision.audioRate, 1.0, AUDIO_RATE_MAX);

        const active: ActiveSpeech = {
          id: speech.id,
          cue: speech.cue,
          audio,
          isWebSpeech: false,
          deadline: decision.deadline,
          cutoffTime: decision.cutoffTime,
          audioRate: decision.audioRate,
          videoRateFactor: decision.videoRateFactor,
          controller: speech.controller
        };
        this.activeSpeech = active;
        this.setVideoAlignmentFactor(decision.videoRateFactor);

        await new Promise<void>((resolve, reject) => {
          let finished = false;
          const done = (err?: Error) => {
            if (finished) return;
            finished = true;
            audio.onended = null;
            audio.onerror = null;
            speech.controller.signal.removeEventListener('abort', onAbort);
            if (this.activeSpeech?.id === speech.id) {
              this.activeSpeech = null;
              this.restoreVideoRate();
              this.wakeGate();
            }
            if (err) reject(err);
            else resolve();
          };
          const onAbort = () => {
            audio.pause();
            done();
          };
          speech.controller.signal.addEventListener('abort', onAbort, { once: true });
          audio.onended = () => done();
          audio.onerror = () => done(new Error('Audio element decode error'));

          audio.play().then(() => {
            // Gate 4: inside audio.play().then(...)
            if (!this.canStartPlayback(gen) || speech.controller.signal.aborted || this.activeSpeech?.id !== speech.id) {
              audio.pause();
              if (!this.canStartPlayback(gen)) suppressForResume();
              done();
              return;
            }
            this.stats.dubbedCues++;
            this.setStatus('speaking');
            if (!this.firstAudioEmitted) {
              this.firstAudioEmitted = true;
              this.callbacks.onFirstAudioStart?.();
            }
          }).catch(err => done(err instanceof Error ? err : new Error(String(err))));
        });
      } else {
        // Fallback: WebSpeech + non-fatal 5s toast
        this.stats.fallbackCues++;
        this.callbacks.onToast?.("This line couldn't be voiced. Dubbing continues.");
        const active: ActiveSpeech = {
          id: speech.id,
          cue: speech.cue,
          audio: null,
          isWebSpeech: true,
          deadline: cueEnd + 1.5,
          cutoffTime: cueEnd + 3.0,
          audioRate: 1.0,
          videoRateFactor: 1.0,
          controller: speech.controller
        };
        this.activeSpeech = active;
        try {
          await speakWithWebSpeech({
            text: cleanedText,
            lang,
            rate: computeEffectiveSpeechRate(prefs.speechRate, this.userVideoRate),
            volume: clamp((this.latestPrefs?.dubVolume ?? prefs.dubVolume) / 100, 0, 1),
            canStart: () => this.canStartPlayback(gen),
            onStart: () => {
              this.setStatus('speaking');
              if (!this.firstAudioEmitted) {
                this.firstAudioEmitted = true;
                this.callbacks.onFirstAudioStart?.();
              }
            },
            signal: speech.controller.signal
          });
        } finally {
          if (this.activeSpeech?.id === speech.id) {
            this.activeSpeech = null;
            this.wakeGate();
          }
        }
      }
    } catch {
      if (!speech.controller.signal.aborted && gen === this.generation) {
        this.callbacks.onToast?.("This line couldn't be voiced. Dubbing continues.");
      }
    } finally {
      removeFromPending();
      this.wakeGate();
    }
  }
}
