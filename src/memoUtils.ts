import type { VoiceMemo } from './types';

const DEFAULT_MEMO_TITLE = 'Untitled memo';

export function createDefaultTitle(createdAt: Date = new Date()): string {
  return `Memo ${createdAt.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeTitle(title: string): string {
  return title.trim() || DEFAULT_MEMO_TITLE;
}

export function sortMemosByNewest(memos: VoiceMemo[]): VoiceMemo[] {
  return [...memos].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function matchesMemo(memo: VoiceMemo, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return `${memo.title} ${memo.series} ${memo.notes} ${memo.summary} ${memo.transcript}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function getAudioExtension(mimeType: string): string {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return 'mp3';
  }

  if (mimeType.includes('ogg')) {
    return 'ogg';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  if (mimeType.includes('mp4')) {
    return 'm4a';
  }

  return 'webm';
}
