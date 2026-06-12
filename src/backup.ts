import type { VoiceMemo } from './types';
import { sortMemosByNewest } from './memoUtils';

const BACKUP_APP_ID = 'murmur';
const BACKUP_VERSION = 1;

interface BackupMemo {
  id: string;
  title: string;
  notes: string;
  createdAt: string;
  durationMs: number;
  mimeType: string;
  size: number;
  audioData: string;
}

interface BackupFile {
  app: typeof BACKUP_APP_ID;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  memoCount: number;
  memos: BackupMemo[];
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);

  if (!response.ok) {
    throw new Error('Unable to read audio data from backup.');
  }

  return response.blob();
}

function assertBackupFile(value: unknown): asserts value is BackupFile {
  if (!value || typeof value !== 'object') {
    throw new Error('Backup file is empty or invalid.');
  }

  const backup = value as Partial<BackupFile>;

  if (
    backup.app !== BACKUP_APP_ID ||
    backup.version !== BACKUP_VERSION ||
    !Array.isArray(backup.memos)
  ) {
    throw new Error('This is not a supported Murmur backup file.');
  }
}

export async function createBackupFile(memos: VoiceMemo[]): Promise<Blob> {
  const backupMemos = await Promise.all(
    memos.map(async (memo) => ({
      id: memo.id,
      title: memo.title,
      notes: memo.notes,
      createdAt: memo.createdAt,
      durationMs: memo.durationMs,
      mimeType: memo.mimeType,
      size: memo.size,
      audioData: await blobToDataUrl(memo.blob),
    })),
  );

  const backup: BackupFile = {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    memoCount: backupMemos.length,
    memos: backupMemos,
  };

  return new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json',
  });
}

export async function readBackupFile(file: File): Promise<VoiceMemo[]> {
  const rawBackup = JSON.parse(await file.text()) as unknown;
  assertBackupFile(rawBackup);

  const restoredMemos = await Promise.all(
    rawBackup.memos.map(async (memo) => {
      const blob = await dataUrlToBlob(memo.audioData);

      return {
        id: memo.id,
        title: memo.title,
        notes: memo.notes,
        createdAt: memo.createdAt,
        durationMs: memo.durationMs,
        blob,
        mimeType: memo.mimeType || blob.type || 'audio/webm',
        size: memo.size || blob.size,
      };
    }),
  );

  return sortMemosByNewest(restoredMemos);
}

export function createBackupFileName(date = new Date()): string {
  return `murmur-backup-${date.toISOString().slice(0, 10)}.json`;
}
