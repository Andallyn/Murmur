import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  getAudioExtension,
  matchesMemo,
  normalizeTitle,
  sortMemosByNewest,
} from './memoUtils';
import type { VoiceMemo } from './types';

function createMemo(overrides: Partial<VoiceMemo>): VoiceMemo {
  return {
    id: 'memo-1',
    title: 'Standup recap',
    series: 'Launch diary',
    notes: 'Ship the recording UI',
    transcript: 'We agreed to polish the onboarding flow.',
    summary: 'Polish onboarding before launch.',
    aiStatus: 'complete',
    aiError: '',
    createdAt: '2026-06-12T14:21:00.000Z',
    durationMs: 61_000,
    blob: new Blob(['audio']),
    mimeType: 'audio/webm',
    size: 5,
    ...overrides,
  };
}

describe('memo utilities', () => {
  it('formats durations as minute and second timestamps', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9_499)).toBe('0:09');
    expect(formatDuration(61_000)).toBe('1:01');
  });

  it('formats bytes into readable units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('normalizes blank memo titles', () => {
    expect(normalizeTitle('  ')).toBe('Untitled memo');
    expect(normalizeTitle('  Field idea  ')).toBe('Field idea');
  });

  it('searches across titles and notes', () => {
    const memo = createMemo({});

    expect(matchesMemo(memo, 'standup')).toBe(true);
    expect(matchesMemo(memo, 'launch')).toBe(true);
    expect(matchesMemo(memo, 'recording')).toBe(true);
    expect(matchesMemo(memo, 'onboarding')).toBe(true);
    expect(matchesMemo(memo, 'budget')).toBe(false);
  });

  it('sorts memos newest first', () => {
    const olderMemo = createMemo({
      id: 'older',
      createdAt: '2026-06-10T12:00:00.000Z',
    });
    const newerMemo = createMemo({
      id: 'newer',
      createdAt: '2026-06-12T12:00:00.000Z',
    });

    expect(sortMemosByNewest([olderMemo, newerMemo])).toEqual([
      newerMemo,
      olderMemo,
    ]);
  });

  it('chooses practical file extensions from audio mime types', () => {
    expect(getAudioExtension('audio/mpeg')).toBe('mp3');
    expect(getAudioExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(getAudioExtension('audio/mp4')).toBe('m4a');
    expect(getAudioExtension('audio/webm')).toBe('webm');
  });
});
