import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceLanguages, type SourceLanguage, type SubtitleSegment, type VoiceChunk } from '../shared/types';
import { ensureAudioDirectory } from './storage';
import { ApiError, videoId } from './errors';
export { ApiError, videoId } from './errors';

export type WorkerSettings = { workerUrl: string; targetLang: string; apiKey: string };
export function normalizeTimeline(input: unknown): SubtitleSegment[] {
  if (!Array.isArray(input) || input.length > 20000) throw new ApiError(400, 'Danh sách phụ đề không hợp lệ.');
  const valid: SubtitleSegment[] = input.map((s) => {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > 604800 || typeof s.text !== 'string' || s.text.length > 10000) throw new ApiError(400, 'Đoạn phụ đề không hợp lệ.');
    return { start: s.start, end: s.end, text: s.text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() };
  }).filter(s => s.text && !/^\[.*\]$/.test(s.text)).sort((a, b) => a.start - b.start);
  return valid;
}

async function exists(file: string) {
  try { return (await stat(file)).size > 0; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export class VoiceoverService {
  private jobs = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private controllers = new Set<AbortController>();
  private stopping = false;
  private changingDirectory = false;
  lastError = '';
  constructor(private storageRoot: string, private settings: () => WorkerSettings) {}
  get root() { return this.storageRoot; }
  get activeJobs() { return this.jobs.size; }
  async changeAudioDirectory(directory: string, persist: () => Promise<void>) {
    if (this.stopping || this.activeJobs || this.changingDirectory) throw new Error('Hãy chờ các video xử lý xong trước khi đổi thư mục audio.');
    this.changingDirectory = true;
    try {
      await ensureAudioDirectory(directory);
      await persist();
      this.storageRoot = directory;
      this.errors.clear();
      this.lastError = '';
    } finally { this.changingDirectory = false; }
  }
  private context(id: string, sourceLanguage: SourceLanguage = 'en') {
    videoId(id);
    if (!sourceLanguages.some(s => s.value === sourceLanguage)) throw new Error('Ngôn ngữ nguồn không hợp lệ.');
    const settings = this.settings();
    const profile = createHash('sha256').update(JSON.stringify([settings.targetLang, sourceLanguage, 'desktop-caption-source-v3'])).digest('hex').slice(0, 16);
    return { id, sourceLanguage, settings, profile, key: `${profile}/${id}`, dir: join(this.root, profile, id) };
  }
  private captionsFile(id: string, sourceLanguage: SourceLanguage) {
    return join(this.root, 'captions', id, `${sourceLanguage}.json`);
  }
  private async subtitles(dir: string): Promise<SubtitleSegment[]> {
    try { return JSON.parse(await readFile(join(dir, 'subtitles.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  async getCachedSubtitles(id: string, sourceLanguage: SourceLanguage = 'en'): Promise<SubtitleSegment[] | null> {
    try {
      const primaryFile = this.captionsFile(id, sourceLanguage);
      if (await exists(primaryFile)) {
        const parsed = JSON.parse(await readFile(primaryFile, 'utf8'));
        const normalized = normalizeTimeline(parsed);
        if (normalized.length) return normalized;
      }
    } catch {}
    try {
      const ctx = this.context(id, sourceLanguage);
      const fallback = await this.subtitles(ctx.dir);
      if (fallback.length) return fallback;
    } catch {}
    return null;
  }
  async saveSubtitles(id: string, sourceLanguage: SourceLanguage, input: SubtitleSegment[]): Promise<void> {
    const subs = normalizeTimeline(input);
    if (!subs.length) return;
    const json = JSON.stringify(subs);
    const primaryPath = this.captionsFile(id, sourceLanguage);
    await mkdir(join(this.root, 'captions', id), { recursive: true });
    await writeFile(`${primaryPath}.tmp`, json);
    await rename(`${primaryPath}.tmp`, primaryPath);

    const ctx = this.context(id, sourceLanguage);
    await mkdir(ctx.dir, { recursive: true });
    await writeFile(join(ctx.dir, 'subtitles.json.tmp'), json);
    await rename(join(ctx.dir, 'subtitles.json.tmp'), join(ctx.dir, 'subtitles.json'));
  }
  async clearSubtitles(id: string, sourceLanguage: SourceLanguage): Promise<void> {
    const primaryPath = this.captionsFile(id, sourceLanguage);
    await unlink(primaryPath).catch(() => {});
    const ctx = this.context(id, sourceLanguage);
    await unlink(join(ctx.dir, 'subtitles.json')).catch(() => {});
    try {
      const files = await readdir(ctx.dir);
      for (const f of files) {
        if (/^chunk_\d+\.mp3(\.tmp)?$/.test(f)) {
          await unlink(join(ctx.dir, f)).catch(() => {});
        }
      }
    } catch {}
    this.errors.delete(ctx.key);
  }
  async start(id: string, input?: unknown, sourceLanguage: SourceLanguage = 'en') {
    if (this.changingDirectory) throw new ApiError(503, 'Đang đổi thư mục audio. Vui lòng thử lại sau.');
    const ctx = this.context(id, sourceLanguage);
    if (this.jobs.has(ctx.key)) return { status: 'PROCESSING' };
    if (this.stopping || this.jobs.size >= 4) throw new ApiError(429, 'Đang xử lý nhiều video. Vui lòng thử lại sau.');
    // Register before the first await so simultaneous starts cannot overwrite a timeline.
    this.lastError = '';
    const task = this.prepare(ctx, input);
    this.jobs.set(ctx.key, task);
    void task.catch(e => { this.lastError = e instanceof Error ? e.message : 'Lỗi xử lý'; this.errors.set(ctx.key, this.lastError); })
      .finally(() => this.jobs.delete(ctx.key));
    return { status: 'PROCESSING' };
  }
  private async prepare(ctx: ReturnType<VoiceoverService['context']>, input: unknown) {
    this.errors.delete(ctx.key);
    let subs = await this.subtitles(ctx.dir);
    if (!subs.length) {
      const cached = await this.getCachedSubtitles(ctx.id, ctx.sourceLanguage);
      if (cached?.length) {
        subs = cached;
        await mkdir(ctx.dir, { recursive: true });
        await writeFile(join(ctx.dir, 'subtitles.json.tmp'), JSON.stringify(subs));
        await rename(join(ctx.dir, 'subtitles.json.tmp'), join(ctx.dir, 'subtitles.json'));
      }
    }
    if (!subs.length) {
      if (input === undefined || input === null) throw new ApiError(422, 'Không lấy được phụ đề từ YouTube. Hãy bật phụ đề và thử lại.');
      // Keep YouTube's exact cue boundaries, including short and overlapping cues.
      subs = normalizeTimeline(input);
      if (!subs.length) throw new ApiError(422, 'Video không có phụ đề có thể đọc.');
      await this.saveSubtitles(ctx.id, ctx.sourceLanguage, subs);
    }
    for (let i = 0; i < subs.length && !this.stopping; i++) {
      const file = join(ctx.dir, `chunk_${i}.mp3`);
      if (await exists(file)) continue;
      if (!ctx.settings.workerUrl) throw new ApiError(503, 'Mở TAI Desktop và cấu hình URL AI worker trước.');
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await fetch(`${ctx.settings.workerUrl}/process-tts`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(ctx.settings.apiKey ? { Authorization: `Bearer ${ctx.settings.apiKey}` } : {}) },
          body: JSON.stringify({ text: subs[i].text, target_lang: ctx.settings.targetLang })
        });
        if (!response.ok) throw new Error(`AI worker trả HTTP ${response.status} ở đoạn ${i}.`);
        if (!/^audio\/(mpeg|mp3)(;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('AI worker phải trả audio/mpeg (MP3).');
        const parts: Uint8Array[] = [];
        let size = 0;
        if (!response.body) throw new Error('AI worker trả âm thanh rỗng.');
        for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += part.length;
          if (size > 20 * 1024 * 1024) { controller.abort(); throw new Error('Đoạn âm thanh vượt 20 MB.'); }
          parts.push(part);
        }
        if (!size) throw new Error('AI worker trả âm thanh rỗng.');
        await writeFile(`${file}.tmp`, Buffer.concat(parts));
        await rename(`${file}.tmp`, file);
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }
  }
  async stop() {
    this.stopping = true;
    for (const c of this.controllers) c.abort();
    await Promise.allSettled(this.jobs.values());
  }
  async snapshot(id: string, sourceLanguage: SourceLanguage = 'en') {
    const ctx = this.context(id, sourceLanguage);
    const subs = await this.subtitles(ctx.dir);
    const chunks: VoiceChunk[] = await Promise.all(subs.map(async (s, id) => ({ ...s, id, ready: await exists(join(ctx.dir, `chunk_${id}.mp3`)) })));
    return { chunks, error: this.errors.get(ctx.key) || '', processing: this.jobs.has(ctx.key) };
  }
  async readAudio(id: string, chunk: number, sourceLanguage: SourceLanguage = 'en') {
    if (!Number.isInteger(chunk) || chunk < 0 || chunk >= 20000) throw new Error('Pack không hợp lệ.');
    return readFile(join(this.context(id, sourceLanguage).dir, `chunk_${chunk}.mp3`));
  }
}
