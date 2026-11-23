import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSubtitleText,
  dedupeAndSortSounds,
  extractSoundsFromText,
  nextMissingSegment,
  parseTimedtextPayload,
  planSegmentLoad,
  segmentAt,
  selectActiveCue
} from '../src/shared/subtitles';
import type { DubbingCue, DubbingSegment } from '../src/shared/types';

describe('cleanSubtitleText and sound extraction', () => {
  it('strips brackets and short non-numeric leading/trailing parentheticals', () => {
    assert.equal(cleanSubtitleText('[Music] Hello world!'), 'Hello world!');
    assert.equal(cleanSubtitleText('【拍手】 (sighs softly) Welcome back (laughs)'), 'Welcome back');
    assert.equal(cleanSubtitleText('- (crowd cheering) Let us start!'), 'Let us start!');
    assert.equal(cleanSubtitleText('<i>[Applause]</i>'), '');
  });

  it('preserves numeric parentheticals and long (> 4 words) parentheticals', () => {
    assert.equal(cleanSubtitleText('Released (2025) today'), 'Released (2025) today');
    assert.equal(cleanSubtitleText('(2025) New release'), '(2025) New release');
    assert.equal(
      cleanSubtitleText('Check this (this is a five word note)'),
      'Check this (this is a five word note)'
    );
  });

  it('extracts and deduplicates sounds sorted by start', () => {
    assert.deepEqual(extractSoundsFromText('[Music] (laughs) Hello'), ['[Music]', '(laughs)']);
    const deduped = dedupeAndSortSounds([
      { start: 5, duration: 2, text: '[Applause]' },
      { start: 2, duration: 2, text: '[Music]' },
      { start: 2, duration: 3, text: '[Music]' }
    ]);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].start, 2);
    assert.equal(deduped[1].start, 5);
  });
});

describe('selectActiveCue', () => {
  it('picks the overlapping cue with the latest start time', () => {
    const cues: DubbingCue[] = [
      { start: 1, duration: 4, end: 5, text: 'First' },
      { start: 2.5, duration: 3, end: 5.5, text: 'Second' },
      { start: 6, duration: 2, end: 8, text: 'Third' }
    ];
    assert.equal(selectActiveCue(cues, 1.5)?.text, 'First');
    assert.equal(selectActiveCue(cues, 3.0)?.text, 'Second');
    assert.equal(selectActiveCue(cues, 5.7), null);
    assert.equal(selectActiveCue(cues, 6.5)?.text, 'Third');
  });
});

describe('segmentAt, planSegmentLoad, and nextMissingSegment', () => {
  const seg0: DubbingSegment = { index: 0, start: 5, end: 50, cues: [], sounds: [] };
  const seg1: DubbingSegment = { index: 1, start: 55, end: 100, cues: [], sounds: [] };
  const seg2: DubbingSegment = { index: 2, start: 110, end: 150, mappedFrom: 102, cues: [], sounds: [] };

  it('bridges intro before seg0, inter-segment silence gaps, mappedFrom, and tail end', () => {
    const loaded = new Map<number, DubbingSegment>([
      [0, seg0],
      [1, seg1]
    ]);
    // Before seg0 start is covered because index === 0
    assert.equal(segmentAt(1, loaded, 3)?.index, 0);
    // Gap 52 between seg0 and seg1 is covered because seg0 (index - 1) is loaded
    assert.equal(segmentAt(52, loaded, 3)?.index, 1);
    // Uncovered jump to 120
    assert.equal(segmentAt(120, loaded, 3), null);

    // Add seg2 with mappedFrom = 102
    loaded.set(2, seg2);
    assert.equal(segmentAt(105, loaded, 3)?.index, 2);
    // Past seg2.end is covered when total - 1 is loaded
    assert.equal(segmentAt(165, loaded, 3)?.index, 2);
  });

  it('plans seek-on-demand, 30s lookahead, and null when complete', () => {
    const loaded = new Map<number, DubbingSegment>([[0, seg0]]);
    // Far from seg0.end (50 - 30 = 20): no load needed yet
    assert.equal(planSegmentLoad(10, loaded, 3), null);
    // Within 30s lookahead (>= 20): prefetch segment 1
    assert.deepEqual(planSegmentLoad(25, loaded, 3), { segment: 1 });
    // Uncovered seek jump: load by currentTime
    assert.deepEqual(planSegmentLoad(120, loaded, 3), { currentTime: 120 });

    loaded.set(1, seg1);
    loaded.set(2, seg2);
    assert.equal(planSegmentLoad(25, loaded, 3), null);
  });

  it('returns lowest missing segment index for eager transcript backfill', () => {
    const loaded = new Map<number, DubbingSegment>([[0, seg0], [2, seg2]]);
    assert.equal(nextMissingSegment(loaded, 3), 1);
    loaded.set(1, seg1);
    assert.equal(nextMissingSegment(loaded, 3), null);
  });
});

describe('parseTimedtextPayload', () => {
  it('parses JSON3 payloads, separates sounds, and partitions segments', () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '[Music] Hello there' }] },
        { tStartMs: 50000, dDurationMs: 3000, segs: [{ utf8: '(laughs) Second segment' }] }
      ]
    });
    const parsed = parseTimedtextPayload(json3, 45);
    assert.equal(parsed.cues.length, 2);
    assert.equal(parsed.cues[0].text, 'Hello there');
    assert.equal(parsed.cues[1].text, 'Second segment');
    assert.equal(parsed.sounds.length, 2);
    assert.equal(parsed.segments.length, 2);
  });

  it('parses XML payloads safely without DOMParser', () => {
    const xml = '<transcript><text start="1.5" dur="2.5">[Applause] Hi &amp; welcome</text></transcript>';
    const parsed = parseTimedtextPayload(xml);
    assert.equal(parsed.cues.length, 1);
    assert.equal(parsed.cues[0].text, 'Hi & welcome');
    assert.equal(parsed.sounds[0].text, '[Applause]');
  });
});
