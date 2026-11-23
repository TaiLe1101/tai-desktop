import type { DubbingCue } from '../shared/types';
import { cleanSubtitleText } from '../shared/subtitles';

export const MAX_AUDIO_CACHE_ENTRIES = 64;
export const STALE_PREFETCH_BYPASS_MS = 3_000;
export const PREFETCH_MAX_CUES = 12;
export const PREFETCH_WINDOW_SECONDS = 30;

export interface CachedAudioEntry {
  key: string;
  url: string;
  duration?: number;
}

interface PendingLoad {
  promise: Promise<CachedAudioEntry>;
  startedAt: number;
  generation: number;
}

export class TtsManager {
  private cache = new Map<string, CachedAudioEntry>();
  private durationCache = new Map<string, number>();
  private pendingLoads = new Map<string, PendingLoad>();
  private cacheGeneration = 0;

  static makeKey(lang: string, voice: string, rateStr: string, text: string): string {
    return `${lang}|${voice}|${rateStr}|${text}`;
  }

  peekDuration(key: string): number | undefined {
    return this.durationCache.get(key) ?? this.cache.get(key)?.duration;
  }

  peekDurations(keys: string[]): Array<number | undefined> {
    return keys.map(k => this.peekDuration(k));
  }

  clear(): void {
    this.cacheGeneration++;
    for (const entry of this.cache.values()) {
      URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    this.durationCache.clear();
    this.pendingLoads.clear();
  }

  private putCache(entry: CachedAudioEntry): void {
    if (this.cache.has(entry.key)) {
      const old = this.cache.get(entry.key)!;
      if (old.url !== entry.url) URL.revokeObjectURL(old.url);
      this.cache.delete(entry.key);
    }
    this.cache.set(entry.key, entry);
    if (entry.duration && Number.isFinite(entry.duration) && entry.duration > 0) {
      this.durationCache.set(entry.key, entry.duration);
    }
    // FIFO eviction at MAX_AUDIO_CACHE_ENTRIES (64)
    while (this.cache.size > MAX_AUDIO_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.cache.get(oldestKey);
      if (oldest) URL.revokeObjectURL(oldest.url);
      this.cache.delete(oldestKey);
      this.durationCache.delete(oldestKey);
    }
  }

  /**
   * Probes audio metadata duration ahead of playback when the server/worker
   * didn't supply `X-Audio-Duration`.
   */
  private probeDuration(key: string, url: string, gen: number): Promise<number | undefined> {
    const existing = this.durationCache.get(key);
    if (existing !== undefined) return Promise.resolve(existing);

    return new Promise(resolve => {
      const audio = new Audio();
      audio.preload = 'metadata';
      let done = false;
      const finish = (dur?: number) => {
        if (done) return;
        done = true;
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        audio.src = '';
        if (gen === this.cacheGeneration && dur && Number.isFinite(dur) && dur > 0) {
          this.durationCache.set(key, dur);
          const cached = this.cache.get(key);
          if (cached) cached.duration = dur;
        }
        resolve(dur);
      };
      const onLoaded = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined);
      const onError = () => finish(undefined);
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      setTimeout(() => finish(undefined), 2500);
      audio.src = url;
      audio.load();
    });
  }

  /**
   * Loads audio for a cue with:
   * - 64-entry FIFO cache
   * - `cacheGeneration` invalidation across `clear()`
   * - `pendingLoads` deduplication
   * - 3,000ms stale-prefetch bypass when called from active `speak()`
   */
  async loadAudio(params: {
    text: string;
    lang: string;
    voice: string;
    rateStr: string;
    sig?: string;
    allowStaleBypass?: boolean;
  }): Promise<CachedAudioEntry> {
    const key = TtsManager.makeKey(params.lang, params.voice, params.rateStr, params.text);
    const cached = this.cache.get(key);
    if (cached) {
      if (!cached.duration) {
        void this.probeDuration(key, cached.url, this.cacheGeneration);
      }
      return cached;
    }

    const gen = this.cacheGeneration;
    const pending = this.pendingLoads.get(key);
    if (pending && pending.generation === gen) {
      const age = Date.now() - pending.startedAt;
      if (!params.allowStaleBypass || age <= STALE_PREFETCH_BYPASS_MS) {
        return pending.promise;
      }
      // Active speak() bypasses a hung prefetch older than 3,000ms
    }

    const startedAt = Date.now();
    const promise = (async (): Promise<CachedAudioEntry> => {
      const res = await window.tai.synthesizeTts({
        text: params.text,
        lang: params.lang,
        voice: params.voice,
        rate: params.rateStr,
        sig: params.sig,
        inline: true
      });
      const bytes = res.audio instanceof Uint8Array ? res.audio : new Uint8Array(res.audio);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);

      if (gen !== this.cacheGeneration) {
        URL.revokeObjectURL(url);
        throw new Error('TTS cache invalidated');
      }

      const entry: CachedAudioEntry = {
        key,
        url,
        duration: res.duration && Number.isFinite(res.duration) && res.duration > 0 ? res.duration : undefined
      };
      this.putCache(entry);

      if (!entry.duration) {
        const probed = await this.probeDuration(key, url, gen);
        if (probed) entry.duration = probed;
      }
      return entry;
    })();

    const record: PendingLoad = { promise, startedAt, generation: gen };
    this.pendingLoads.set(key, record);
    void promise.finally(() => {
      if (this.pendingLoads.get(key) === record) {
        this.pendingLoads.delete(key);
      }
    });
    return promise;
  }

  /**
   * Prefetches up to 12 upcoming cues within +30s of `anchorTime` so both audio
   * blobs and probed durations are ready before playback reaches them.
   */
  prefetchAhead(
    cues: DubbingCue[],
    anchorTime: number,
    lang: string,
    voice: string,
    rateStr: string
  ): void {
    const horizon = anchorTime + PREFETCH_WINDOW_SECONDS;
    let scheduled = 0;
    for (const cue of cues) {
      if (cue.start < anchorTime) continue;
      if (cue.start > horizon || scheduled >= PREFETCH_MAX_CUES) break;
      const cleaned = cleanSubtitleText(cue.text);
      if (!cleaned) continue;
      const key = TtsManager.makeKey(lang, voice, rateStr, cleaned);
      if (this.cache.has(key) || this.pendingLoads.has(key)) {
        scheduled++;
        continue;
      }
      scheduled++;
      void this.loadAudio({
        text: cleaned,
        lang,
        voice,
        rateStr,
        sig: cleaned === cue.text ? cue.sig : undefined,
        allowStaleBypass: false
      }).catch(() => {});
    }
  }
}

/**
 * Fallback synthesizer using WebSpeech (`window.speechSynthesis`) when backend/worker TTS fails.
 */
export function speakWithWebSpeech(params: {
  text: string;
  lang: string;
  rate: number;
  volume: number;
  canStart: () => boolean;
  onStart: () => void;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      reject(new Error('WebSpeech unavailable'));
      return;
    }
    if (!params.canStart() || params.signal.aborted) {
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(params.text);
    utterance.lang = params.lang;
    utterance.rate = Math.min(2, Math.max(0.5, params.rate));
    utterance.volume = Math.min(1, Math.max(0, params.volume));

    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const onAbort = () => {
      try { window.speechSynthesis.cancel(); } catch {}
      finish();
    };
    params.signal.addEventListener('abort', onAbort, { once: true });

    utterance.onstart = () => {
      if (!params.canStart() || params.signal.aborted) {
        try { window.speechSynthesis.cancel(); } catch {}
        finish();
        return;
      }
      params.onStart();
    };
    utterance.onend = () => finish();
    utterance.onerror = ev => finish(new Error(ev.error || 'WebSpeech error'));

    try {
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
