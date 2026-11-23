import type { OriginalAudioMode } from './types';

// Exact realtime audio-video alignment constants from autodub-example spec
export const TAIL_GRACE_SECONDS = 0.55;
export const MAX_TAIL_SECONDS = 1.5;
export const NEXT_CUE_MARGIN_SECONDS = 0.1;
export const AUDIO_RATE_MAX = 1.25;
export const AUDIO_RATE_SMOOTHING = 0.25;
export const AUDIO_RATE_STEP = 0.05;
export const VIDEO_MIN_RATE_FACTOR = 0.6;
export const LATE_CAP_SECONDS = 1.5;
export const MIN_PLAY_SECONDS = 0.5;
export const LOOKAHEAD_CUES = 3;
export const TAIL_OVERLAP_SECONDS = 0;
export const CUTOFF_MARGIN_SECONDS = 0.25;
export const VIDEO_REFINE_HYSTERESIS = 0.03;

// Ducking & volume ownership constants
export const SPEECH_GAP_RESTORE_SECONDS = 1.0;
export const VOLUME_EPSILON = 0.001;

export interface LookaheadCueMetric {
  cueStart: number;
  cueEnd: number;
  nextCueStart?: number;
  audioDuration: number;
}

export interface AlignmentInput {
  now: number;
  cueEnd: number;
  nextCueStart?: number;
  audioDuration: number;
  userVideoRate: number;
  prevAudioRate: number;
  lookahead?: LookaheadCueMetric[];
}

export type AlignmentLevel = 'fit' | 'video-slow' | 'late';

export interface AlignmentDecision {
  audioRate: number;
  videoRateFactor: number;
  deadline: number;
  cutoffTime: number;
  level: AlignmentLevel;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes cue playback deadline:
 * - With next cue: max(cueEnd + 0.55, min(cueEnd + 1.5, nextCueStart - 0.1))
 * - Without next cue: cueEnd + 0.55
 */
export function computeCueDeadline(cueEnd: number, nextCueStart?: number): number {
  const graceEnd = cueEnd + TAIL_GRACE_SECONDS;
  if (nextCueStart === undefined || !Number.isFinite(nextCueStart)) {
    return graceEnd;
  }
  return Math.max(graceEnd, Math.min(cueEnd + MAX_TAIL_SECONDS, nextCueStart - NEXT_CUE_MARGIN_SECONDS));
}

/**
 * 3-cue lookahead pitch-preserving audio speedup + video slowdown alignment policy.
 * Video slowdown absorbs up to 1/0.6 = 1.67x before audio rate ramps up (max 1.25x),
 * smoothed via EMA (0.25) and slew-limited (±0.05).
 */
export function decideAlignment(input: AlignmentInput): AlignmentDecision {
  const userVideoRate = Number.isFinite(input.userVideoRate) && input.userVideoRate > 0 ? input.userVideoRate : 1;
  const audioDur = Number.isFinite(input.audioDuration) && input.audioDuration > 0 ? input.audioDuration : 0.1;
  const prevRate = clamp(Number.isFinite(input.prevAudioRate) ? input.prevAudioRate : 1.0, 1.0, AUDIO_RATE_MAX);

  const deadline = computeCueDeadline(input.cueEnd, input.nextCueStart);
  const avail = Math.max(0.05, deadline - input.now);

  // Let video slowdown absorb up to 1/VIDEO_MIN_RATE_FACTOR first
  let desired = (audioDur * userVideoRate / avail) * VIDEO_MIN_RATE_FACTOR;

  const lookahead = (input.lookahead || []).slice(0, LOOKAHEAD_CUES);
  for (const upcoming of lookahead) {
    if (!Number.isFinite(upcoming.audioDuration) || upcoming.audioDuration <= 0) continue;
    const uDeadline = computeCueDeadline(upcoming.cueEnd, upcoming.nextCueStart);
    const uAvail = Math.max(0.3, uDeadline - upcoming.cueStart);
    const uDesired = (upcoming.audioDuration * userVideoRate / uAvail) * VIDEO_MIN_RATE_FACTOR;
    if (uDesired > desired) desired = uDesired;
  }

  desired = clamp(desired, 1.0, AUDIO_RATE_MAX);

  // EMA smoothing with 0.01 snap threshold
  const ema = Math.abs(desired - prevRate) < 0.01
    ? desired
    : prevRate + AUDIO_RATE_SMOOTHING * (desired - prevRate);

  // Slew-limit to prevRate ± AUDIO_RATE_STEP
  const slewed = clamp(ema, prevRate - AUDIO_RATE_STEP, prevRate + AUDIO_RATE_STEP);
  const audioRate = clamp(slewed, 1.0, AUDIO_RATE_MAX);

  const neededVideoTime = (audioDur / audioRate) * userVideoRate;
  const rawVideoFactor = avail / neededVideoTime;
  const videoRateFactor = clamp(rawVideoFactor, VIDEO_MIN_RATE_FACTOR, 1.0);

  const fits = neededVideoTime * VIDEO_MIN_RATE_FACTOR <= avail + 1e-9;
  if (fits) {
    const level: AlignmentLevel = videoRateFactor < 0.999 ? 'video-slow' : 'fit';
    const cutoffTime = deadline + CUTOFF_MARGIN_SECONDS;
    return { audioRate, videoRateFactor, deadline, cutoffTime, level };
  }

  const cutoffTime = Math.max(deadline + LATE_CAP_SECONDS, input.now + MIN_PLAY_SECONDS);
  return { audioRate, videoRateFactor: VIDEO_MIN_RATE_FACTOR, deadline, cutoffTime, level: 'late' };
}

/**
 * Closed-loop video rate factor refinement called every 100ms tick.
 * Applies VIDEO_REFINE_HYSTERESIS (0.03) to avoid jittery rate oscillation.
 */
export function refineVideoRateFactor(
  activeRemainingSeconds: number,
  remainingVideoBudget: number,
  userVideoRate: number,
  currentFactor: number
): number {
  const safeUserRate = Number.isFinite(userVideoRate) && userVideoRate > 0 ? userVideoRate : 1;
  const safeCurrent = clamp(Number.isFinite(currentFactor) ? currentFactor : 1, VIDEO_MIN_RATE_FACTOR, 1.0);
  if (!Number.isFinite(activeRemainingSeconds) || activeRemainingSeconds <= 0) {
    return Math.abs(1.0 - safeCurrent) >= VIDEO_REFINE_HYSTERESIS ? 1.0 : safeCurrent;
  }
  const budget = Math.max(0.05, remainingVideoBudget);
  const needed = activeRemainingSeconds * safeUserRate;
  const desired = clamp(budget / needed, VIDEO_MIN_RATE_FACTOR, 1.0);
  if (Math.abs(desired - safeCurrent) < VIDEO_REFINE_HYSTERESIS) {
    return safeCurrent;
  }
  return desired;
}

/**
 * Sentinel-encodes an alignment-controlled video playbackRate so it ends in `.xx1`,
 * cleanly distinguishing app-applied slowdowns from manual user rate changes.
 */
export function toAlignmentRate(rate: number): number {
  const clamped = clamp(Number.isFinite(rate) ? rate : 1, 0.25, 4.0);
  return Number((Math.round(100 * clamped) / 100 + 0.001).toFixed(3));
}

export function isAlignmentRate(rate: number): boolean {
  if (!Number.isFinite(rate)) return false;
  return Math.round(1000 * rate) % 10 === 1;
}

/**
 * Recovers a clean user video rate on reload when the player still carries a stale `.xx1` rate.
 */
export function recoverUserRate(rate: number, fallback = 1.0): number {
  if (!Number.isFinite(rate) || rate <= 0) return fallback;
  return isAlignmentRate(rate) ? fallback : rate;
}

/**
 * Volume ownership guard: returns true if the player's current volume matches
 * what the dubbing controller last ducked it to (within 0.001).
 */
export function isOurVolume(currentVolume: number, duckedTo: number | null): boolean {
  if (duckedTo === null || !Number.isFinite(currentVolume)) return false;
  return Math.abs(currentVolume - duckedTo) < VOLUME_EPSILON;
}

/**
 * 1.0s speech-gap anti-pumping: in 'duck' mode, keep original audio ducked between
 * consecutive sentences when the next cue starts less than 1.0s away.
 */
export function isInSpeechGap(now: number, nextCueStart?: number): boolean {
  if (nextCueStart === undefined || !Number.isFinite(nextCueStart) || !Number.isFinite(now)) {
    return false;
  }
  const gap = nextCueStart - now;
  return gap >= 0 && gap < SPEECH_GAP_RESTORE_SECONDS;
}

/**
 * Computes target YouTube <video>.volume given mode, user's base volume, duckLevel (0..90%),
 * active speech state, and speech-gap state. Never raises volume above userVolume.
 */
export function computeTargetVolume(
  mode: OriginalAudioMode,
  userVolume: number,
  duckLevelPercent: number,
  isSpeaking: boolean,
  inSpeechGap: boolean
): number {
  const base = clamp(Number.isFinite(userVolume) ? userVolume : 1, 0, 1);
  const ratio = clamp((Number.isFinite(duckLevelPercent) ? duckLevelPercent : 25) / 100, 0, 0.9);
  switch (mode) {
    case 'keep':
      return base;
    case 'silence':
      return 0;
    case 'duckAlways':
      return Math.min(base, base * ratio);
    case 'duck':
      return (isSpeaking || inSpeechGap) ? Math.min(base, base * ratio) : base;
  }
}

/**
 * Telemetry PlaybackClock: accumulates only small forward playback steps (0 < dt <= 2s),
 * making watchedSeconds immune to seeks, ads, pauses, and tab throttling spikes.
 */
export class PlaybackClock {
  private lastTime: number | null = null;
  private totalSeconds = 0;

  get watchedSeconds(): number {
    return Math.round(this.totalSeconds * 100) / 100;
  }

  tick(currentTime: number, isPlaying: boolean): void {
    if (!isPlaying || !Number.isFinite(currentTime)) {
      this.lastTime = null;
      return;
    }
    if (this.lastTime !== null) {
      const dt = currentTime - this.lastTime;
      if (dt > 0 && dt <= 2) {
        this.totalSeconds += dt;
      }
    }
    this.lastTime = currentTime;
  }

  reset(): void {
    this.lastTime = null;
    this.totalSeconds = 0;
  }
}
