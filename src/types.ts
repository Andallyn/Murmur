export type AiStatus = 'idle' | 'processing' | 'complete' | 'failed';

export interface VoiceMemo {
  id: string;
  title: string;
  series: string;
  notes: string;
  transcript: string;
  summary: string;
  aiStatus: AiStatus;
  aiError: string;
  createdAt: string;
  durationMs: number;
  blob: Blob;
  mimeType: string;
  size: number;
}

export interface DraftMemo {
  title: string;
  series: string;
  notes: string;
}
