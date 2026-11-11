import type { VoiceChunk } from './types';
export function packProgress(chunks: VoiceChunk[]) {
  const total = chunks.length;
  const initialRequired = total ? Math.ceil(total * .2) : 0;
  return { total, ready: chunks.filter(c => c.ready).length, initialRequired,
    canStart: total > 0 && chunks.slice(0, initialRequired).every(c => c.ready) };
}
