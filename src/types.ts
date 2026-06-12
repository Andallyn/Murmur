export interface VoiceMemo {
  id: string;
  title: string;
  series: string;
  notes: string;
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
