import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, videoId } from './errors';
import type { WorkerSettings } from './voiceover';

interface Segment { id: number; start: number; end: number; text: string; translatedText: string; audioUrl: string; status: 'READY' }
interface AudioWindow { start: number; end: number; segments: Segment[] }
interface Manifest { windows: Record<string, AudioWindow> }
interface Job { status: 'PROCESSING' | 'READY' | 'ERROR'; segments?: Segment[]; error?: string }
export class AudioService {
  private jobs = new Map<string, Job>();
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private blockedUntil = 0;
  lastError = '';
  constructor(private root: () => string, private settings: () => WorkerSettings, private locked: () => boolean) {}
  get activeJobs() { return this.task ? 1 : 0; }
  async health() {
    const settings = this.settings();
    if (!settings.workerUrl || !settings.apiKey) throw new ApiError(503, 'Nhập URL worker và Worker access key trong app trước.');
    try {
      const response = await fetch(`${settings.workerUrl}/health`, { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error(`Worker HTTP ${response.status}; kiểm tra URL và Worker access key.`);
      const result = await response.json();
      if (result.protocol !== 'tai-audio-v1' || !result.asr_ready) throw new Error('Worker chưa hỗ trợ ASR hoặc chưa tải model xong. Chạy notebook TAI mới.');
      return { status: 'ok', protocol: result.protocol };
    } catch (error) { throw new ApiError(503, error instanceof Error ? error.message : 'Không kết nối được worker.'); }
  }
  private context(id: string) {
    videoId(id);
    const settings = this.settings();
    // A temporary Colab tunnel URL must not invalidate already translated audio.
    const profile = createHash('sha256').update(JSON.stringify(['asr-v1', settings.targetLang])).digest('hex').slice(0, 16);
    return { profile, dir: join(this.root(), profile, id), settings, id };
  }
  private async manifest(dir: string): Promise<Manifest> {
    try { return JSON.parse(await readFile(join(dir, 'audio-manifest.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { windows: {} }; throw error; }
  }
  async enqueue(input: any) {
    if (this.locked()) throw new ApiError(503, 'App đang đổi thư mục hoặc dừng.');
    if (this.task) throw new ApiError(429, 'Đang xử lý một đoạn audio. Hãy đợi kết quả trước khi gửi tiếp.');
    if (!input || !Number.isFinite(input.start) || input.start < 0 || input.start > 604800 || typeof input.audioBase64 !== 'string' || input.audioBase64.length > 900000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64)) throw new ApiError(400, 'Đoạn audio không hợp lệ.');
    const data = Buffer.from(input.audioBase64, 'base64');
    if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1 || data.readUInt32LE(24) !== 16000 || data.readUInt16LE(34) !== 16 || data.toString('ascii', 36, 40) !== 'data') throw new ApiError(400, 'Cần WAV PCM16 mono 16000 Hz.');
    const samples = data.readUInt32LE(40);
    const duration = samples / 32000;
    if (samples !== data.length - 44 || duration < 0.1 || duration > 20) throw new ApiError(400, 'Đoạn WAV phải dài từ 0.1 đến 20 giây.');
    const ctx = this.context(videoId(input.videoId));
    const start = Math.round(input.start * 1000) / 1000;
    const jobId = randomUUID();
    const job: Job = { status: 'PROCESSING' };
    this.jobs.set(jobId, job);
    this.lastError = '';
    // Register synchronously before any disk IO; only one window can mutate a manifest.
    this.task = this.process(ctx, start, duration, input.audioBase64, job).catch(error => {
      job.status = 'ERROR'; job.error = error instanceof Error ? error.message : 'Audio job failed'; this.lastError = job.error;
    }).finally(() => { this.task = null; this.controller = null; });
    for (const [key, value] of this.jobs) if (this.jobs.size > 50 && value.status !== 'PROCESSING') this.jobs.delete(key);
    return { jobId, status: job.status };
  }
  private async process(ctx: ReturnType<AudioService['context']>, start: number, duration: number, encoded: string, job: Job) {
    const manifest = await this.manifest(ctx.dir);
    const windowKey = String(Math.round(start * 1000));
    const existing = manifest.windows[windowKey];
    if (existing && Math.abs(existing.end - start - duration) < 0.1 && await Promise.all(existing.segments.map(s => stat(join(ctx.dir, `chunk_${s.id}.mp3`)).then(v => v.size > 0).catch(() => false))).then(v => v.every(Boolean))) {
      job.status = 'READY'; job.segments = existing.segments; return;
    }
    if (Date.now() < this.blockedUntil) throw new Error(`Worker đang tạm nghỉ. Thử lại sau ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} giây.`);
    if (!ctx.settings.workerUrl || !ctx.settings.apiKey) throw new Error('Cấu hình URL và Worker access key trong TAI Desktop trước.');
    if (this.locked()) throw new Error('Ứng dụng đang dừng; chưa gửi audio tới worker.');
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), 180000);
    try {
      const response = await fetch(`${ctx.settings.workerUrl}/process-audio`, {
        method: 'POST', redirect: 'error', signal: this.controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.settings.apiKey}` },
        body: JSON.stringify({ audio_base64: encoded, target_lang: ctx.settings.targetLang })
      });
      if (!response.ok) {
        const header = response.headers.get('retry-after');
        const retry = header ? Number(header) : NaN;
        this.blockedUntil = Date.now() + Math.max(5, Number.isFinite(retry) ? retry : 60) * 1000;
        throw new Error(`Worker HTTP ${response.status}. Kiểm tra khóa truy cập, quota hoặc log Colab; không tự thử lại.`);
      }
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Worker cần trả JSON cho /process-audio. Hãy chạy notebook mới.');
      const buffers = []; let bytes = 0;
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += part.length;
        if (bytes > 12 * 1024 * 1024) throw new Error('Phản hồi worker vượt 12 MB.');
        buffers.push(part);
      }
      const result = JSON.parse(Buffer.concat(buffers).toString());
      if (!Number.isFinite(result.duration) || Math.abs(result.duration - duration) > 0.1 || !Array.isArray(result.segments) || result.segments.length > 100) throw new Error('Worker trả timeline audio không hợp lệ.');
      const segments: Segment[] = [];
      await mkdir(ctx.dir, { recursive: true });
      for (const [index, s] of result.segments.entries()) {
        if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > duration + 0.05 || typeof s.text !== 'string' || typeof s.translatedText !== 'string' || typeof s.audioBase64 !== 'string' || s.audioBase64.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s.audioBase64)) throw new Error('Đoạn giọng đọc worker không hợp lệ.');
        const id = Math.round(start * 1000) * 100 + index;
        const audio = Buffer.from(s.audioBase64, 'base64');
        if (!audio.length) throw new Error('Worker trả audio rỗng.');
        const file = join(ctx.dir, `chunk_${id}.mp3`);
        await writeFile(`${file}.tmp`, audio); await rename(`${file}.tmp`, file);
        segments.push({ id, start: start + s.start, end: start + s.end, text: s.text, translatedText: s.translatedText, status: 'READY', audioUrl: `/audio/${ctx.profile}/${ctx.id}/chunk_${id}.mp3` });
      }
      manifest.windows[windowKey] = { start, end: start + duration, segments };
      await writeFile(join(ctx.dir, 'audio-manifest.json.tmp'), JSON.stringify(manifest));
      await rename(join(ctx.dir, 'audio-manifest.json.tmp'), join(ctx.dir, 'audio-manifest.json'));
      job.status = 'READY'; job.segments = segments;
    } finally { clearTimeout(timer); }
  }
  status(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new ApiError(404, 'Không tìm thấy audio job. Kiểm tra cache trước khi gửi lại.');
    return job;
  }
  async chunks(id: string, from: number) {
    const ctx = this.context(id);
    const manifest = await this.manifest(ctx.dir);
    const windows = Object.values(manifest.windows).sort((a, b) => a.start - b.start);
    const chunks = windows.flatMap(w => w.segments).filter(s => s.end > from).sort((a, b) => a.start - b.start).slice(0, 20);
    let preparedUntil = 0;
    for (const w of windows) { if (w.start > preparedUntil + 0.25) break; preparedUntil = Math.max(preparedUntil, w.end); }
    return { chunks, hasAudioCache: windows.length > 0, preparedUntil, windows: windows.map(w => ({ start: w.start, end: w.end })), status: 'READY', hasSubtitles: false };
  }
  async stop() { this.controller?.abort(); await this.task; }
}
