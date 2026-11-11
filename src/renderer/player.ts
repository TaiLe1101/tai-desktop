import type { VideoSession } from '../shared/types';
// Audio remains in the trusted app, never exposing the worker key to YouTube.
export class VoicePlayer {
  private audio: HTMLAudioElement | null = null;
  private key = '';
  private url = '';
  private generation = 0;
  private loading = false;
  private failed = new Set<string>();
  stop() { this.generation++; this.audio?.pause(); this.audio = null; this.key = ''; this.loading = false; if (this.url) URL.revokeObjectURL(this.url); this.url = ''; void window.tai.voice(false); }
  async sync(s: VideoSession, enabled: boolean) {
    const chunk = s.chunks.find(c => c.ready && s.time >= c.start && s.time < c.end);
    if (!enabled || !chunk || !['PLAYING', 'COMPLETE'].includes(s.phase)) { this.stop(); return; }
    const key = `${s.videoId}/${s.sourceLanguage || 'en'}/${chunk.id}`;
    if (key !== this.key) {
      this.stop(); this.key = key; this.loading = true;
      const token = this.generation;
      try {
        const bytes = await window.tai.audio(s.videoId, chunk.id, s.sourceLanguage);
        if (token !== this.generation) return;
        this.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }));
        this.audio = new Audio(this.url); this.audio.preload = 'auto'; this.audio.load();
      } catch (e) {
        if (!this.failed.has(key)) { this.failed.add(key); throw new Error('Không tải được giọng dịch của đoạn này.'); }
      }
      finally { if (token === this.generation) this.loading = false; }
    }
    const a = this.audio;
    if (a?.error) { this.stop(); throw new Error('Không đọc được MP3 của pack. Kiểm tra worker và thử lại.'); }
    if (!a || this.loading || !Number.isFinite(a.duration)) return;
    const speed = Math.min(4, Math.max(.5, a.duration / (chunk.end - chunk.start)));
    const offset = Math.min(a.duration, (s.time - chunk.start) * speed);
    a.playbackRate = Math.min(4, Math.max(.25, speed * s.rate)); a.muted = s.muted; a.volume = s.volume;
    if (Math.abs(a.currentTime - offset) > .3) a.currentTime = offset;
    if (s.paused) a.pause(); else if (offset < a.duration && a.paused) await a.play().then(() => {
      if (a === this.audio && key === this.key) return window.tai.voice(true);
      a.pause();
    }).catch(() => {});
  }
}
