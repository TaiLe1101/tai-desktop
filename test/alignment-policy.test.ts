import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_RATE_MAX,
  AUDIO_RATE_SMOOTHING,
  AUDIO_RATE_STEP,
  CUTOFF_MARGIN_SECONDS,
  LATE_CAP_SECONDS,
  LOOKAHEAD_CUES,
  MAX_TAIL_SECONDS,
  MIN_PLAY_SECONDS,
  NEXT_CUE_MARGIN_SECONDS,
  PlaybackClock,
  SPEECH_GAP_RESTORE_SECONDS,
  TAIL_GRACE_SECONDS,
  TAIL_OVERLAP_SECONDS,
  VIDEO_MIN_RATE_FACTOR,
  VIDEO_REFINE_HYSTERESIS,
  VOLUME_EPSILON,
  computeCueDeadline,
  computeTargetVolume,
  decideAlignment,
  isAlignmentRate,
  isInSpeechGap,
  isOurVolume,
  recoverUserRate,
  refineVideoRateFactor,
  toAlignmentRate
} from '../src/shared/alignment-policy';

describe('alignment-policy constants', () => {
  it('matches exact autodub-example constants', () => {
    assert.equal(TAIL_GRACE_SECONDS, 0.55);
    assert.equal(MAX_TAIL_SECONDS, 1.5);
    assert.equal(NEXT_CUE_MARGIN_SECONDS, 0.1);
    assert.equal(AUDIO_RATE_MAX, 1.25);
    assert.equal(AUDIO_RATE_SMOOTHING, 0.25);
    assert.equal(AUDIO_RATE_STEP, 0.05);
    assert.equal(VIDEO_MIN_RATE_FACTOR, 0.6);
    assert.equal(LATE_CAP_SECONDS, 1.5);
    assert.equal(MIN_PLAY_SECONDS, 0.5);
    assert.equal(LOOKAHEAD_CUES, 3);
    assert.equal(TAIL_OVERLAP_SECONDS, 0);
    assert.equal(CUTOFF_MARGIN_SECONDS, 0.25);
    assert.equal(VIDEO_REFINE_HYSTERESIS, 0.03);
    assert.equal(SPEECH_GAP_RESTORE_SECONDS, 1.0);
    assert.equal(VOLUME_EPSILON, 0.001);
  });
});

describe('computeCueDeadline', () => {
  it('uses cueEnd + 0.55 when no next cue exists', () => {
    assert.ok(Math.abs(computeCueDeadline(10) - 10.55) < 1e-9);
  });

  it('clamps tail between 0.55s grace and 1.5s max tail respecting 0.1s next-cue margin', () => {
    // Next cue far away -> capped at cueEnd + 1.5
    assert.ok(Math.abs(computeCueDeadline(10, 20) - 11.5) < 1e-9);
    // Next cue at 11.2 -> 11.2 - 0.1 = 11.1 (between 10.55 and 11.5)
    assert.ok(Math.abs(computeCueDeadline(10, 11.2) - 11.1) < 1e-9);
    // Next cue immediately at 10.2 -> floor at 10.55 grace
    assert.ok(Math.abs(computeCueDeadline(10, 10.2) - 10.55) < 1e-9);
  });
});

describe('decideAlignment', () => {
  it('keeps 1.0x audio and 1.0x video when audio comfortably fits', () => {
    const d = decideAlignment({
      now: 10,
      cueEnd: 13,
      nextCueStart: 15,
      audioDuration: 2.0,
      userVideoRate: 1.0,
      prevAudioRate: 1.0
    });
    assert.equal(d.level, 'fit');
    assert.equal(d.audioRate, 1.0);
    assert.equal(d.videoRateFactor, 1.0);
    assert.ok(Math.abs(d.deadline - 14.5) < 1e-9);
    assert.ok(Math.abs(d.cutoffTime - 14.75) < 1e-9);
  });

  it('slows video first before ramping audio rate when moderate overrun occurs', () => {
    // avail = 10.55 - 8.55 = 2.0s; audioDur = 2.5s -> video slow factor = 2.0 / 2.5 = 0.8 >= 0.6
    const d = decideAlignment({
      now: 8.55,
      cueEnd: 10,
      nextCueStart: 10.1,
      audioDuration: 2.5,
      userVideoRate: 1.0,
      prevAudioRate: 1.0
    });
    assert.equal(d.level, 'video-slow');
    assert.equal(d.audioRate, 1.0);
    assert.ok(Math.abs(d.videoRateFactor - 0.8) < 1e-6);
  });

  it('applies 3-cue lookahead with EMA (0.25) and slew-limiting (±0.05) up to 1.25x', () => {
    const d = decideAlignment({
      now: 0,
      cueEnd: 2,
      nextCueStart: 2.1,
      audioDuration: 1.5,
      userVideoRate: 1.0,
      prevAudioRate: 1.0,
      lookahead: [
        { cueStart: 2.1, cueEnd: 3.0, nextCueStart: 3.1, audioDuration: 6.0 }
      ]
    });
    // Desired ramps to 1.25; EMA from 1.0 is 1.0 + 0.25 * 0.25 = 1.0625; slew-limited to 1.0 + 0.05 = 1.05
    assert.ok(Math.abs(d.audioRate - 1.05) < 1e-9);
  });

  it('marks late and caps cutoffTime when audio exceeds both 1.25x audio and 0.6x video', () => {
    const d = decideAlignment({
      now: 10,
      cueEnd: 11,
      nextCueStart: 11.1,
      audioDuration: 8.0,
      userVideoRate: 1.0,
      prevAudioRate: 1.25
    });
    assert.equal(d.level, 'late');
    assert.equal(d.audioRate, 1.25);
    assert.equal(d.videoRateFactor, 0.6);
    // deadline = 11.55 -> cutoffTime = max(11.55 + 1.5, 10 + 0.5) = 13.05
    assert.ok(Math.abs(d.cutoffTime - 13.05) < 1e-9);
  });
});

describe('refineVideoRateFactor', () => {
  it('ignores deltas smaller than 0.03 hysteresis and updates when >= 0.03', () => {
    // budget 1.98 / needed 2.0 = 0.99; delta from 1.0 is 0.01 < 0.03 -> unchanged
    assert.equal(refineVideoRateFactor(2.0, 1.98, 1.0, 1.0), 1.0);
    // budget 1.5 / needed 2.0 = 0.75; delta 0.25 >= 0.03 -> updates to 0.75
    assert.ok(Math.abs(refineVideoRateFactor(2.0, 1.5, 1.0, 1.0) - 0.75) < 1e-9);
    // never drops below VIDEO_MIN_RATE_FACTOR (0.6)
    assert.equal(refineVideoRateFactor(5.0, 1.0, 1.0, 1.0), 0.6);
  });
});

describe('sentinel playbackRate encoding', () => {
  it('encodes alignment rates with .xx1 sentinel and detects/recovers them cleanly', () => {
    const encoded = toAlignmentRate(0.75);
    assert.equal(encoded, 0.751);
    assert.equal(isAlignmentRate(encoded), true);
    assert.equal(isAlignmentRate(1.0), false);
    assert.equal(isAlignmentRate(1.25), false);
    assert.equal(isAlignmentRate(1.5), false);
    assert.equal(recoverUserRate(0.801, 1.0), 1.0);
    assert.equal(recoverUserRate(1.5, 1.0), 1.5);
  });
});

describe('ducking, volume ownership, and 1.0s speech-gap anti-pumping', () => {
  it('detects our volume within 0.001 epsilon', () => {
    assert.equal(isOurVolume(0.2504, 0.25), true);
    assert.equal(isOurVolume(0.26, 0.25), false);
    assert.equal(isOurVolume(0.25, null), false);
  });

  it('implements 1.0s speech-gap anti-pumping', () => {
    assert.equal(isInSpeechGap(10.0, 10.5), true);
    assert.equal(isInSpeechGap(10.0, 10.99), true);
    assert.equal(isInSpeechGap(10.0, 11.0), false);
    assert.equal(isInSpeechGap(10.0, 12.5), false);
    assert.equal(isInSpeechGap(10.0, undefined), false);
  });

  it('computes target volume across all 4 modes without exceeding userVolume', () => {
    assert.equal(computeTargetVolume('keep', 0.8, 25, true, false), 0.8);
    assert.equal(computeTargetVolume('silence', 0.8, 25, false, false), 0);
    assert.ok(Math.abs(computeTargetVolume('duckAlways', 0.8, 25, false, false) - 0.2) < 1e-9);
    assert.ok(Math.abs(computeTargetVolume('duck', 0.8, 25, true, false) - 0.2) < 1e-9);
    assert.ok(Math.abs(computeTargetVolume('duck', 0.8, 25, false, true) - 0.2) < 1e-9);
    assert.equal(computeTargetVolume('duck', 0.8, 25, false, false), 0.8);
  });
});

describe('PlaybackClock', () => {
  it('accumulates only forward steps with 0 < dt <= 2s', () => {
    const clock = new PlaybackClock();
    clock.tick(10.0, true);
    clock.tick(10.5, true); // +0.5
    clock.tick(12.0, true); // +1.5
    clock.tick(25.0, true); // jump > 2s -> ignored
    clock.tick(24.5, true); // backward seek -> ignored
    clock.tick(25.5, true); // +1.0
    clock.tick(26.0, false); // paused -> ignored
    clock.tick(26.5, true); // first tick after pause -> anchor only
    clock.tick(27.0, true); // +0.5
    assert.ok(Math.abs(clock.watchedSeconds - 3.5) < 1e-9);
  });
});
