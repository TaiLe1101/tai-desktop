import { gzipSync } from 'node:zlib';
import { net } from 'electron';
import { DubbingAuthOrQuotaError, parseDubbingBlockError } from '../shared/saas';
import { parseTimedtextPayload } from '../shared/subtitles';
import { formatSsmlRate } from '../shared/voices';
import type {
  DubbingCue,
  DubbingHealthResult,
  DubbingSegment,
  QuotaDto,
  ReportSessionsResponse,
  SoundCue,
  TelemetrySession,
  TtsSynthesizeRequest,
  TtsSynthesizeResponse
} from '../shared/types';
import type { WorkerSettings } from './voiceover';

export const MAX_SUBTITLE_PAYLOAD_CHARS = 2_000_000;
const SEGMENT_RETRIES = 2;
const SEGMENT_RETRY_DELAY_MS = 1_000;
const TTS_TIMEOUT_MS = 15_000;
const TTS_RETRIES = 2;
const TTS_RETRY_DELAY_MS = 200;
const SEGMENT_TIMEOUT_MS = 45_000;

export interface ServerSettings {
  serverUrl: string;
  apiKey: string;
  targetLang: string;
}

export interface DubbingAuthProvider {
  getAccessToken(): string;
  refreshSession(): Promise<string | null>;
  applyQuotaUpdate(quota: QuotaDto): void;
  markUnauthenticated(reason?: string): Promise<void>;
}

export class SubtitleDownloadFailedError extends Error {
  readonly code = 'SUBTITLE_DOWNLOAD_FAILED';
  constructor(message = 'Không thể tải phụ đề YouTube. Đang thử lại.') {
    super(message);
    this.name = 'SubtitleDownloadFailedError';
  }
}

class HttpStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export interface YoutubeSubtitlesResponse {
  videoId: string;
  targetLang: string;
  translationSource: 'youtube';
  totalSegments: number;
  segments: DubbingSegment[];
}

export interface SegmentFetchResponse {
  videoId: string;
  targetLang: string;
  translationSource: 'ai' | 'direct-worker';
  totalSegments: number;
  segment: DubbingSegment;
}

function normalizeOrigin(urlStr: string): string {
  try {
    return new URL(urlStr).origin;
  } catch {
    return '';
  }
}

/**
 * Origin-isolated fetch: NEVER attaches auth headers (Authorization / X-API-Key)
 * unless the resolved target URL strictly matches the configured API origin.
 */
async function originIsolatedFetch(
  baseUrl: string,
  path: string,
  init: RequestInit,
  authHeaders: Record<string, string>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const baseOrigin = normalizeOrigin(baseUrl);
  if (!baseOrigin) throw new Error('Invalid API base URL.');

  const targetUrl = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  const targetOrigin = normalizeOrigin(targetUrl);

  const headers = new Headers(init.headers || {});
  if (targetOrigin === baseOrigin) {
    for (const [k, v] of Object.entries(authHeaders)) {
      if (v) headers.set(k, v);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    return await net.fetch(targetUrl, {
      ...init,
      headers,
      redirect: 'error',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

function workerAuthHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

function normalizeServerCues(rawCues: Array<{ start: number; duration: number; text: string; sourceText?: string; sig?: string }>): DubbingCue[] {
  return (rawCues || []).map((c, idx) => ({
    id: idx,
    start: Number(c.start) || 0,
    duration: Number(c.duration) > 0 ? Number(c.duration) : 1.5,
    end: (Number(c.start) || 0) + (Number(c.duration) > 0 ? Number(c.duration) : 1.5),
    text: String(c.text || '').trim(),
    sourceText: typeof c.sourceText === 'string' ? c.sourceText : undefined,
    sig: typeof c.sig === 'string' ? c.sig : undefined
  })).filter(c => c.text.length > 0);
}

function normalizeServerSegment(raw: {
  index: number;
  start: number;
  end: number;
  mappedFrom?: number;
  cues: Array<{ start: number; duration: number; text: string; sourceText?: string; sig?: string }>;
  sounds?: SoundCue[];
}): DubbingSegment {
  return {
    index: Number(raw.index) || 0,
    start: Number(raw.start) || 0,
    end: Number(raw.end) || 0,
    ...(Number.isFinite(raw.mappedFrom) ? { mappedFrom: Number(raw.mappedFrom) } : {}),
    cues: normalizeServerCues(raw.cues),
    sounds: Array.isArray(raw.sounds) ? raw.sounds : []
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class DubbingClient {
  private serverDownUntil = 0;

  constructor(
    private readonly getServer: () => ServerSettings,
    private readonly getWorker: () => WorkerSettings,
    private readonly auth?: DubbingAuthProvider
  ) {}

  private buildServerHeaders(tokenOverride?: string): Record<string, string> {
    const server = this.getServer();
    const headers: Record<string, string> = {};
    const bearer = tokenOverride ?? this.auth?.getAccessToken() ?? '';
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    } else if (server.apiKey) {
      headers.Authorization = `Bearer ${server.apiKey}`;
    }
    if (server.apiKey) {
      headers['x-api-key'] = server.apiKey;
    }
    return headers;
  }

  private canTryServer(): boolean {
    const { serverUrl } = this.getServer();
    return Boolean(serverUrl) && Date.now() >= this.serverDownUntil;
  }

  private markServerUnavailable() {
    this.serverDownUntil = Date.now() + 30_000;
  }

  /**
   * Executes a SERVER_URL request with:
   * - Origin-isolated Bearer auth header
   * - Automatic single 401 refresh + retry
   * - Typed `DubbingAuthOrQuotaError` on 401 AUTH_REQUIRED / 402 QUOTA_EXCEEDED|SUBSCRIPTION_EXPIRED|NO_SUBSCRIPTION / 403 TENANT_SUSPENDED
   *   (never silently bypassed to unauthenticated direct worker!)
   */
  private async fetchServerWithAuth(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Response> {
    const server = this.getServer();
    let res = await originIsolatedFetch(
      server.serverUrl,
      path,
      init,
      this.buildServerHeaders(),
      timeoutMs,
      signal
    );

    if (res.status === 401 && this.auth) {
      const nextToken = await this.auth.refreshSession();
      if (nextToken) {
        res = await originIsolatedFetch(
          server.serverUrl,
          path,
          init,
          this.buildServerHeaders(nextToken),
          timeoutMs,
          signal
        );
      }
    }

    if (res.status === 401 || res.status === 402 || res.status === 403) {
      const cloned = res.clone();
      const body = await cloned.json().catch(() => null);
      const blockErr = parseDubbingBlockError(res.status, body);
      if (blockErr) {
        if (blockErr.quota) this.auth?.applyQuotaUpdate(blockErr.quota);
        if (blockErr.code === 'AUTH_REQUIRED') {
          await this.auth?.markUnauthenticated('AUTH_REQUIRED');
        }
        throw blockErr;
      }
    }

    return res;
  }

  async health(): Promise<DubbingHealthResult> {
    const server = this.getServer();
    if (server.serverUrl) {
      try {
        const res = await originIsolatedFetch(
          server.serverUrl,
          '/api/v1/dubbing/health',
          { method: 'GET' },
          this.buildServerHeaders(),
          8_000
        );
        if (res.ok) {
          const data = await res.json() as { status?: string; protocol?: string; worker?: { ok?: boolean; capabilities?: string[] } };
          if (data.status === 'ok') {
            this.serverDownUntil = 0;
            return {
              ok: true,
              mode: 'server',
              protocol: data.protocol || 'tai-dubbing-v2',
              capabilities: data.worker?.capabilities || []
            };
          }
        }
      } catch {
        // Fall through to direct worker health check
      }
    }

    const worker = this.getWorker();
    if (worker.workerUrl && worker.apiKey) {
      try {
        const res = await originIsolatedFetch(
          worker.workerUrl,
          '/health',
          { method: 'GET' },
          workerAuthHeaders(worker.apiKey),
          8_000
        );
        if (res.ok) {
          const data = await res.json() as { status?: string; protocol?: string; capabilities?: string[] };
          if (data.status === 'ok') {
            return {
              ok: true,
              mode: 'worker',
              protocol: data.protocol || 'tai-tts-v1',
              capabilities: data.capabilities || []
            };
          }
        }
      } catch (err) {
        return {
          ok: false,
          mode: 'offline',
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    return { ok: false, mode: 'offline', error: 'Không kết nối được server hoặc AI worker.' };
  }

  /**
   * Fast Path: sends client-downloaded YouTube native/auto-translated captions
   * compressed with gzip (`Content-Type: application/gzip`) to `POST /api/v1/dubbing/youtube-subtitles`.
   * Never bypasses `DubbingAuthOrQuotaError`.
   */
  async submitYoutubeSubtitles(payload: {
    videoId: string;
    targetLang: string;
    sourceLang?: string;
    subtitleText: string;
    sourceText?: string;
  }): Promise<YoutubeSubtitlesResponse> {
    if (payload.subtitleText.length > MAX_SUBTITLE_PAYLOAD_CHARS) {
      throw new Error(`Phụ đề vượt quá giới hạn ${MAX_SUBTITLE_PAYLOAD_CHARS.toLocaleString()} ký tự.`);
    }
    if (payload.sourceText && payload.sourceText.length > MAX_SUBTITLE_PAYLOAD_CHARS) {
      payload = { ...payload, sourceText: undefined };
    }

    if (this.canTryServer()) {
      try {
        const json = JSON.stringify(payload);
        if (json.length > MAX_SUBTITLE_PAYLOAD_CHARS * 2) {
          throw new Error('Gói dữ liệu phụ đề quá lớn.');
        }
        const compressed = gzipSync(Buffer.from(json, 'utf8'));
        const res = await this.fetchServerWithAuth(
          '/api/v1/dubbing/youtube-subtitles',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/gzip'
            },
            body: new Uint8Array(compressed)
          },
          SEGMENT_TIMEOUT_MS
        );
        if (res.ok) {
          const data = await res.json() as {
            videoId: string;
            targetLang: string;
            totalSegments: number;
            segments: Parameters<typeof normalizeServerSegment>[0][];
          };
          return {
            videoId: data.videoId || payload.videoId,
            targetLang: data.targetLang || payload.targetLang,
            translationSource: 'youtube',
            totalSegments: data.totalSegments || data.segments.length,
            segments: (data.segments || []).map(normalizeServerSegment)
          };
        }
        if (res.status >= 500 || res.status === 404) {
          this.markServerUnavailable();
        } else {
          const jsonErr = await res.json().catch(() => null) as { message?: string } | null;
          throw new HttpStatusError(res.status, jsonErr?.message || 'Không thể xử lý phụ đề trên máy chủ.');
        }
      } catch (error) {
        if (error instanceof DubbingAuthOrQuotaError) throw error;
        if (error instanceof HttpStatusError && error.status >= 400 && error.status < 500) {
          throw error;
        }
        this.markServerUnavailable();
      }
    }

    // Local fallback ONLY when SERVER_URL is unset or unreachable (never on auth/quota block)
    const parsedTarget = parseTimedtextPayload(payload.subtitleText);
    const parsedSource = payload.sourceText ? parseTimedtextPayload(payload.sourceText) : null;
    if (parsedSource && parsedSource.cues.length) {
      for (const seg of parsedTarget.segments) {
        for (const cue of seg.cues) {
          const match = parsedSource.cues.find(sc => Math.abs(sc.start - cue.start) < 1.2);
          if (match) cue.sourceText = match.text;
        }
      }
    }
    return {
      videoId: payload.videoId,
      targetLang: payload.targetLang,
      translationSource: 'youtube',
      totalSegments: parsedTarget.segments.length,
      segments: parsedTarget.segments
    };
  }

  /**
   * Segmented AI Path: `POST /api/v1/dubbing/segments` with 2 retries x 1,000ms.
   * Immediately aborts retries on `SUBTITLE_DOWNLOAD_FAILED` and `DubbingAuthOrQuotaError`.
   */
  async fetchSegment(
    payload: {
      videoId?: string;
      subtitleUrl?: string;
      subtitleText?: string;
      targetLang: string;
      sourceLang?: string;
      currentTime?: number;
      segment?: number;
    },
    signal?: AbortSignal
  ): Promise<SegmentFetchResponse> {
    if (this.canTryServer()) {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
        if (signal?.aborted) throw new Error('Aborted');
        try {
          const res = await this.fetchServerWithAuth(
            '/api/v1/dubbing/segments',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            },
            SEGMENT_TIMEOUT_MS,
            signal
          );
          if (res.status === 422) {
            const body = await res.json().catch(() => ({})) as { code?: string; message?: string };
            if (body.code === 'SUBTITLE_DOWNLOAD_FAILED') {
              throw new SubtitleDownloadFailedError(body.message || 'SUBTITLE_DOWNLOAD_FAILED');
            }
            throw new Error(body.message || 'Server segments trả HTTP 422.');
          }
          if (res.ok) {
            const data = await res.json() as {
              videoId?: string;
              targetLang?: string;
              totalSegments: number;
              segment: Parameters<typeof normalizeServerSegment>[0];
            };
            return {
              videoId: data.videoId || payload.videoId || '',
              targetLang: data.targetLang || payload.targetLang,
              translationSource: 'ai',
              totalSegments: data.totalSegments,
              segment: normalizeServerSegment(data.segment)
            };
          }
          if (res.status === 404 || res.status >= 500) {
            lastErr = new HttpStatusError(res.status, 'Không thể kết nối đến máy chủ');
          } else {
            const jsonErr = await res.json().catch(() => null) as { message?: string } | null;
            throw new HttpStatusError(res.status, jsonErr?.message || 'Không thể tải đoạn dịch từ máy chủ.');
          }
        } catch (err) {
          if (err instanceof DubbingAuthOrQuotaError || err instanceof SubtitleDownloadFailedError || isAbortError(err)) {
            throw err;
          }
          if (err instanceof HttpStatusError && err.status >= 400 && err.status < 500 && err.status !== 404) {
            throw err;
          }
          lastErr = err;
        }
        if (attempt < SEGMENT_RETRIES) {
          await sleep(SEGMENT_RETRY_DELAY_MS);
        }
      }
      this.markServerUnavailable();
      if (!payload.subtitleText) {
        throw lastErr instanceof Error ? lastErr : new Error('Không thể tải segment từ server.');
      }
    }

    return this.translateSegmentViaWorker(payload, signal);
  }

  private async translateSegmentViaWorker(
    payload: {
      videoId?: string;
      subtitleText?: string;
      targetLang: string;
      sourceLang?: string;
      currentTime?: number;
      segment?: number;
    },
    signal?: AbortSignal
  ): Promise<SegmentFetchResponse> {
    if (!payload.subtitleText) {
      throw new SubtitleDownloadFailedError('Không có nội dung phụ đề để gửi trực tiếp tới worker.');
    }
    const parsed = parseTimedtextPayload(payload.subtitleText);
    if (!parsed.segments.length) {
      throw new Error('Không có đoạn phụ đề hợp lệ để dịch.');
    }

    let idx = 0;
    let mappedFrom: number | undefined;
    if (typeof payload.segment === 'number') {
      idx = Math.min(parsed.segments.length - 1, Math.max(0, payload.segment));
    } else if (typeof payload.currentTime === 'number') {
      const t = Math.max(0, payload.currentTime);
      const found = parsed.segments.findIndex(s => s.end >= t);
      idx = found >= 0 ? found : parsed.segments.length - 1;
      if (t < parsed.segments[idx].start) mappedFrom = t;
    }

    const seg = parsed.segments[idx];
    const prevSeg = idx > 0 ? parsed.segments[idx - 1] : null;
    const nextSeg = idx + 1 < parsed.segments.length ? parsed.segments[idx + 1] : null;

    const worker = this.getWorker();
    if (!worker.workerUrl || !worker.apiKey) {
      throw new Error('Chưa cấu hình WORKER_URL hoặc WORKER_API_KEY.');
    }

    const res = await originIsolatedFetch(
      worker.workerUrl,
      '/translate-segment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cues: seg.cues.map(c => ({ start: c.start, duration: c.duration, text: c.text })),
          target_lang: payload.targetLang,
          source_lang: payload.sourceLang,
          context_prev: prevSeg ? prevSeg.cues.slice(-3).map(c => c.text) : undefined,
          context_next: nextSeg ? nextSeg.cues.slice(0, 3).map(c => c.text) : undefined
        })
      },
      workerAuthHeaders(worker.apiKey),
      SEGMENT_TIMEOUT_MS,
      signal
    );

    if (!res.ok) {
      throw new HttpStatusError(res.status, 'Không thể dịch đoạn phụ đề lúc này.');
    }

    const data = await res.json() as {
      cues: Array<{ start: number; duration: number; text: string; sourceText?: string }>;
    };

    const translatedCues: DubbingCue[] = (data.cues || []).map((c, i) => ({
      id: i,
      start: Number(c.start),
      duration: Number(c.duration) > 0 ? Number(c.duration) : 1.5,
      end: Number(c.start) + (Number(c.duration) > 0 ? Number(c.duration) : 1.5),
      text: String(c.text || '').trim(),
      sourceText: typeof c.sourceText === 'string' ? c.sourceText : seg.cues[i]?.text
    })).filter(c => c.text.length > 0);

    return {
      videoId: payload.videoId || '',
      targetLang: payload.targetLang,
      translationSource: 'direct-worker',
      totalSegments: parsed.segments.length,
      segment: {
        index: seg.index,
        start: seg.start,
        end: seg.end,
        ...(mappedFrom !== undefined ? { mappedFrom } : {}),
        cues: translatedCues,
        sounds: seg.sounds
      }
    };
  }

  /**
   * Inline TTS synthesis:
   * - Calls `POST /api/v1/dubbing/tts` when server is available and `sig` is present.
   * - NEVER bypasses `DubbingAuthOrQuotaError` (401/402/403) to direct worker.
   * - Falls back to direct worker `POST /synthesize-tts` ONLY on network/5xx/missing-server.
   */
  async synthesizeTts(req: TtsSynthesizeRequest, signal?: AbortSignal): Promise<TtsSynthesizeResponse> {
    const rateStr = typeof req.rate === 'number' ? formatSsmlRate(req.rate) : (req.rate || '+50%');
    const useServer = this.canTryServer() && Boolean(req.sig);

    if (useServer) {
      try {
        return await this.fetchServerTtsWithRetry(
          {
            text: req.text,
            lang: req.lang,
            voice: req.voice,
            rate: rateStr,
            sig: req.sig,
            inline: req.inline !== false
          },
          signal
        );
      } catch (err) {
        if (err instanceof DubbingAuthOrQuotaError || isAbortError(err)) throw err;
        const isClient4xx = err instanceof HttpStatusError && err.status >= 400 && err.status < 500 && err.status !== 404;
        if (!isClient4xx) {
          this.markServerUnavailable();
        }
      }
    }

    const worker = this.getWorker();
    if (!worker.workerUrl || !worker.apiKey) {
      throw new Error('Chưa cấu hình AI Worker cho TTS.');
    }

    try {
      return await this.fetchTtsWithRetry(
        worker.workerUrl,
        '/synthesize-tts',
        {
          text: req.text,
          lang: req.lang,
          voice: req.voice,
          rate: rateStr
        },
        workerAuthHeaders(worker.apiKey),
        signal
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      const isMissingEndpoint = err instanceof HttpStatusError && (err.status === 404 || err.status === 405);
      if (!isMissingEndpoint) throw err;
      return this.fetchTtsWithRetry(
        worker.workerUrl,
        '/process-tts',
        {
          text: req.text,
          target_lang: req.lang,
          voice: req.voice,
          rate: rateStr
        },
        workerAuthHeaders(worker.apiKey),
        signal
      );
    }
  }

  private async fetchServerTtsWithRetry(
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<TtsSynthesizeResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TTS_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error('Aborted');
      try {
        const res = await this.fetchServerWithAuth(
          '/api/v1/dubbing/tts',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          },
          TTS_TIMEOUT_MS,
          signal
        );

        if (!res.ok) {
          const err = new HttpStatusError(res.status, res.status >= 500 ? 'Không thể kết nối đến máy chủ' : 'Không thể tạo giọng đọc lúc này.');
          if (res.status >= 500 && attempt < TTS_RETRIES) {
            lastError = err;
            await sleep(TTS_RETRY_DELAY_MS);
            continue;
          }
          throw err;
        }
        return await this.parseTtsResponse(res);
      } catch (err) {
        if (err instanceof DubbingAuthOrQuotaError || isAbortError(err)) throw err;
        lastError = err;
        const isHttp4xx = err instanceof HttpStatusError && err.status >= 400 && err.status < 500;
        if (isHttp4xx || attempt >= TTS_RETRIES) throw err;
        await sleep(TTS_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Không thể tạo giọng đọc lúc này.');
  }

  private async fetchTtsWithRetry(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
    authHeaders: Record<string, string>,
    signal?: AbortSignal
  ): Promise<TtsSynthesizeResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TTS_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error('Aborted');
      try {
        const res = await originIsolatedFetch(
          baseUrl,
          path,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          },
          authHeaders,
          TTS_TIMEOUT_MS,
          signal
        );

        if (!res.ok) {
          const err = new HttpStatusError(res.status, 'Không thể tạo giọng đọc lúc này.');
          if (res.status >= 500 && attempt < TTS_RETRIES) {
            lastError = err;
            await sleep(TTS_RETRY_DELAY_MS);
            continue;
          }
          throw err;
        }
        return await this.parseTtsResponse(res);
      } catch (err) {
        lastError = err;
        if (isAbortError(err)) throw err;
        const isHttp4xx = err instanceof HttpStatusError && err.status >= 400 && err.status < 500;
        if (isHttp4xx || attempt >= TTS_RETRIES) throw err;
        await sleep(TTS_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Không thể tạo giọng đọc lúc này.');
  }

  private async parseTtsResponse(res: Response): Promise<TtsSynthesizeResponse> {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const headerDuration = Number(res.headers.get('x-audio-duration'));
    const voice = res.headers.get('x-tts-voice') || undefined;
    const rate = res.headers.get('x-tts-rate') || undefined;
    const cache = res.headers.get('x-cache') || undefined;

    if (contentType.startsWith('audio/')) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) throw new Error('TTS trả audio rỗng.');
      return {
        audio: buf,
        duration: Number.isFinite(headerDuration) && headerDuration > 0 ? headerDuration : undefined,
        voice,
        rate,
        cache
      };
    }

    const json = await res.json() as { audioBase64?: string; url?: string; duration?: number; voice?: string; rate?: string };
    if (json.audioBase64) {
      const buf = new Uint8Array(Buffer.from(json.audioBase64, 'base64'));
      return {
        audio: buf,
        duration: Number.isFinite(json.duration) && (json.duration as number) > 0 ? json.duration : undefined,
        voice: json.voice || voice,
        rate: json.rate || rate,
        cache
      };
    }
    if (json.url) {
      const cdnController = new AbortController();
      const cdnTimer = setTimeout(() => cdnController.abort(), TTS_TIMEOUT_MS);
      try {
        const cdnRes = await net.fetch(json.url, { signal: cdnController.signal });
        if (!cdnRes.ok) throw new Error(`CDN audio HTTP ${cdnRes.status}`);
        const buf = new Uint8Array(await cdnRes.arrayBuffer());
        return {
          audio: buf,
          duration: Number.isFinite(json.duration) ? json.duration : undefined,
          voice: json.voice || voice,
          rate: json.rate || rate,
          cache
        };
      } finally {
        clearTimeout(cdnTimer);
      }
    }
    throw new Error('TTS response không chứa dữ liệu âm thanh.');
  }

  async reportSessions(sessions: TelemetrySession[]): Promise<ReportSessionsResponse> {
    const trimmed = sessions.slice(0, 20);
    if (!trimmed.length || !this.canTryServer()) return { accepted: 0 };
    try {
      const res = await this.fetchServerWithAuth(
        '/api/v1/dubbing/sessions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessions: trimmed })
        },
        8_000
      );
      if (!res.ok) return { accepted: 0 };
      const data = await res.json() as { accepted?: number; quota?: QuotaDto };
      if (data.quota) {
        this.auth?.applyQuotaUpdate(data.quota);
      }
      return {
        accepted: Number(data.accepted) || trimmed.length,
        ...(data.quota ? { quota: data.quota } : {})
      };
    } catch {
      return { accepted: 0 };
    }
  }
}
