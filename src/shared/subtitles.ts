import type { DubbingCue, DubbingSegment, SoundCue } from './types';

export const SEGMENT_LOOKAHEAD_SECONDS = 30;
export const DEFAULT_SEGMENT_WINDOW_SECONDS = 45;

const LEADING_PAREN_RE = /^[-–—ー]?\s*[(（]([^()（）]{1,40})[)）]\s*/;
const TRAILING_PAREN_RE = /(^|[\s.!?,。！？，、])[(（]([^()（）]{1,40})[)）]\s*$/;
const BRACKET_SOUND_RE = /\[([^\]]+)\]|【([^】]+)】/g;

function isShortNonNumericAnnotation(inner: string): boolean {
  const trimmed = inner.trim();
  if (!trimmed || /\d/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length <= 4;
}

/**
 * Cleans subtitle text for speech synthesis:
 * - Strips HTML tags
 * - Strips [...] and 【...】 globally
 * - Iteratively strips leading/trailing parentheticals (...) / （...） ONLY when
 *   inner text contains no digits and has <= 4 words.
 */
export function cleanSubtitleText(raw: string): string {
  if (!raw) return '';
  let text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(BRACKET_SOUND_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let changed = true;
  while (changed && text) {
    changed = false;
    const lead = text.match(LEADING_PAREN_RE);
    if (lead && isShortNonNumericAnnotation(lead[1])) {
      text = text.slice(lead[0].length).trim();
      changed = true;
      continue;
    }
    const trail = text.match(TRAILING_PAREN_RE);
    if (trail && isShortNonNumericAnnotation(trail[2])) {
      text = (text.slice(0, text.length - trail[0].length) + trail[1]).trim();
      changed = true;
    }
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts non-speech annotations ([Music], 【Applause】, short non-numeric parentheticals)
 * from raw cue text so they can be rendered in speech gaps when in bilingual mode.
 */
export function extractSoundsFromText(raw: string): string[] {
  if (!raw) return [];
  const sounds: string[] = [];
  const plain = raw.replace(/<[^>]+>/g, ' ');

  for (const match of plain.matchAll(BRACKET_SOUND_RE)) {
    const inner = (match[1] || match[2] || '').trim();
    if (inner) sounds.push(`[${inner}]`);
  }

  const withoutBrackets = plain.replace(BRACKET_SOUND_RE, ' ').replace(/\s+/g, ' ').trim();
  let cursor = withoutBrackets;
  let changed = true;
  while (changed && cursor) {
    changed = false;
    const lead = cursor.match(LEADING_PAREN_RE);
    if (lead && isShortNonNumericAnnotation(lead[1])) {
      sounds.push(`(${lead[1].trim()})`);
      cursor = cursor.slice(lead[0].length).trim();
      changed = true;
      continue;
    }
    const trail = cursor.match(TRAILING_PAREN_RE);
    if (trail && isShortNonNumericAnnotation(trail[2])) {
      sounds.push(`(${trail[2].trim()})`);
      cursor = (cursor.slice(0, cursor.length - trail[0].length) + trail[1]).trim();
      changed = true;
    }
  }

  return sounds;
}

/**
 * Deduplicates sounds by `${start}|${text}` and sorts ascending by `start`.
 */
export function dedupeAndSortSounds(sounds: SoundCue[]): SoundCue[] {
  const seen = new Set<string>();
  const out: SoundCue[] = [];
  for (const s of sounds) {
    const text = (s.text || '').trim();
    if (!text || !Number.isFinite(s.start)) continue;
    const key = `${s.start}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      start: s.start,
      duration: Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 2,
      text
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Picks the active speech cue at `currentTime`.
 * Cues are expected sorted by `start`; among all cues with
 * `cue.start <= currentTime <= cue.start + cue.duration`, returns the one with the latest `start`.
 */
export function selectActiveCue(cues: DubbingCue[], currentTime: number): DubbingCue | null {
  if (!cues.length || !Number.isFinite(currentTime)) return null;
  let active: DubbingCue | null = null;
  for (const cue of cues) {
    const end = cue.end ?? (cue.start + cue.duration);
    if (cue.start <= currentTime && currentTime <= end) {
      if (!active || cue.start >= active.start) {
        active = cue;
      }
    }
  }
  return active;
}

export function selectActiveSound(sounds: SoundCue[], currentTime: number): SoundCue | null {
  if (!sounds.length || !Number.isFinite(currentTime)) return null;
  let active: SoundCue | null = null;
  for (const s of sounds) {
    if (s.start <= currentTime && currentTime <= s.start + s.duration) {
      if (!active || s.start >= active.start) active = s;
    }
  }
  return active;
}

export function findNextCue(cues: DubbingCue[], currentTime: number, afterCue?: DubbingCue | null): DubbingCue | null {
  for (const cue of cues) {
    if (afterCue && cue === afterCue) continue;
    if (afterCue && cue.start <= afterCue.start) continue;
    if (cue.start > currentTime) return cue;
  }
  return null;
}

/**
 * Matches the loaded segment covering timestamp `t`:
 * Finds the loaded segment with smallest `end >= t` and treats `t` as covered when:
 * - `t >= seg.start`
 * - `seg.index === 0`
 * - `seg.index - 1` is loaded (bridges inter-segment silence gaps)
 * - `seg.mappedFrom !== undefined && t >= seg.mappedFrom`
 * - Or `t` is past the last loaded segment's end when `total - 1` is loaded.
 */
export function segmentAt(
  t: number,
  loaded: Map<number, DubbingSegment>,
  total: number
): DubbingSegment | null {
  if (loaded.size === 0 || !Number.isFinite(t)) return null;
  const sorted = [...loaded.values()].sort((a, b) => a.index - b.index);

  // Find loaded segment with smallest end >= t
  let candidate: DubbingSegment | null = null;
  for (const seg of sorted) {
    if (seg.end >= t) {
      if (!candidate || seg.end < candidate.end) {
        candidate = seg;
      }
    }
  }

  if (candidate) {
    const covered = t >= candidate.start
      || candidate.index === 0
      || loaded.has(candidate.index - 1)
      || (candidate.mappedFrom !== undefined && t >= candidate.mappedFrom);
    return covered ? candidate : null;
  }

  // Past the end of all loaded segments: covered only if the final segment is loaded
  if (total > 0 && loaded.has(total - 1)) {
    return loaded.get(total - 1)!;
  }
  return null;
}

export type SegmentLoadPlan =
  | { currentTime: number }
  | { segment: number }
  | null;

/**
 * Plans the next progressive segment fetch:
 * - Returns null if all segments are loaded
 * - Returns `{ currentTime: max(0, t) }` on an uncovered seek jump
 * - Returns `{ segment: seg.index + 1 }` when within 30s lookahead of segment end
 */
export function planSegmentLoad(
  t: number,
  loaded: Map<number, DubbingSegment>,
  total: number,
  lookaheadSeconds = SEGMENT_LOOKAHEAD_SECONDS
): SegmentLoadPlan {
  if (total > 0 && loaded.size >= total) return null;
  const safeTime = Math.max(0, Number.isFinite(t) ? t : 0);

  const current = segmentAt(safeTime, loaded, total);
  if (!current) {
    return { currentTime: safeTime };
  }

  const nextIdx = current.index + 1;
  if (total > 0 && nextIdx < total && !loaded.has(nextIdx) && safeTime >= current.end - lookaheadSeconds) {
    return { segment: nextIdx };
  }
  return null;
}

export function nextMissingSegment(loaded: Map<number, DubbingSegment>, total: number): number | null {
  if (total <= 0) return null;
  for (let i = 0; i < total; i++) {
    if (!loaded.has(i)) return i;
  }
  return null;
}

export interface ParsedTimedtext {
  cues: DubbingCue[];
  sounds: SoundCue[];
  segments: DubbingSegment[];
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

/**
 * Parses YouTube JSON3 or XML timedtext payloads into cleaned cues, deduped sounds,
 * and ~45s progressive segments. Safe to run in Node (no DOMParser dependency).
 */
export function parseTimedtextPayload(
  raw: string,
  segmentWindowSeconds = DEFAULT_SEGMENT_WINDOW_SECONDS
): ParsedTimedtext {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { cues: [], sounds: [], segments: [] };

  const rawEntries: Array<{ start: number; duration: number; text: string }> = [];

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as {
      events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
    };
    for (const ev of parsed.events || []) {
      if (!ev || !Array.isArray(ev.segs) || !Number.isFinite(ev.tStartMs)) continue;
      const start = (ev.tStartMs as number) / 1000;
      const duration = Number.isFinite(ev.dDurationMs) && (ev.dDurationMs as number) > 0
        ? (ev.dDurationMs as number) / 1000
        : 2;
      const text = ev.segs.map(s => s.utf8 || '').join('').trim();
      if (text) rawEntries.push({ start, duration, text });
    }
  } else {
    const tagRe = /<(?:text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/gi;
    for (const match of trimmed.matchAll(tagRe)) {
      const attrs = match[1] || '';
      const body = decodeXmlEntities((match[2] || '').replace(/<[^>]+>/g, ' ')).trim();
      if (!body) continue;
      const startMatch = attrs.match(/\bstart="([^"]+)"/i);
      const tMatch = attrs.match(/\bt="([^"]+)"/i);
      const durMatch = attrs.match(/\bdur="([^"]+)"/i);
      const dMatch = attrs.match(/\bd="([^"]+)"/i);
      const start = startMatch ? Number(startMatch[1]) : (tMatch ? Number(tMatch[1]) / 1000 : NaN);
      const duration = durMatch ? Number(durMatch[1]) : (dMatch ? Number(dMatch[1]) / 1000 : 2);
      if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
        rawEntries.push({ start, duration, text: body });
      }
    }
  }

  rawEntries.sort((a, b) => a.start - b.start);

  const cues: DubbingCue[] = [];
  const soundsRaw: SoundCue[] = [];

  for (const entry of rawEntries) {
    const extractedSounds = extractSoundsFromText(entry.text);
    for (const st of extractedSounds) {
      soundsRaw.push({ start: entry.start, duration: entry.duration, text: st });
    }
    const cleaned = cleanSubtitleText(entry.text);
    if (!cleaned) continue;
    cues.push({
      start: entry.start,
      duration: entry.duration,
      end: entry.start + entry.duration,
      text: cleaned,
      sourceText: cleaned
    });
  }

  const sounds = dedupeAndSortSounds(soundsRaw);
  const segments = partitionIntoSegments(cues, sounds, segmentWindowSeconds);
  return { cues, sounds, segments };
}

export function partitionIntoSegments(
  cues: DubbingCue[],
  sounds: SoundCue[],
  windowSeconds = DEFAULT_SEGMENT_WINDOW_SECONDS
): DubbingSegment[] {
  if (!cues.length && !sounds.length) return [];
  const segments: DubbingSegment[] = [];
  let bucketCues: DubbingCue[] = [];
  let segStart = cues.length ? cues[0].start : sounds[0].start;

  const flush = () => {
    if (!bucketCues.length) return;
    const start = bucketCues[0].start;
    const end = bucketCues.reduce((maxEnd, c) => Math.max(maxEnd, c.start + c.duration), start);
    const index = segments.length;
    segments.push({ index, start, end, cues: bucketCues, sounds: [] });
    bucketCues = [];
  };

  for (const cue of cues) {
    if (bucketCues.length > 0 && cue.start - segStart >= windowSeconds) {
      flush();
      segStart = cue.start;
    }
    bucketCues.push(cue);
  }
  flush();

  if (!segments.length && sounds.length) {
    const start = sounds[0].start;
    const end = sounds.reduce((m, s) => Math.max(m, s.start + s.duration), start);
    segments.push({ index: 0, start, end, cues: [], sounds });
    return segments;
  }

  for (const sound of sounds) {
    let target = segments[segments.length - 1];
    for (const seg of segments) {
      if (sound.start <= seg.end) {
        target = seg;
        break;
      }
    }
    target.sounds.push(sound);
  }

  return segments;
}
