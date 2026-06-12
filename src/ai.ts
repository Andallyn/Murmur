export interface MemoAnalysis {
  transcript: string;
  summary: string;
}

interface ApiError {
  error?: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export async function analyzeRecording(
  blob: Blob,
  mimeType: string,
): Promise<MemoAnalysis> {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audioBase64: await blobToBase64(blob),
      mimeType,
      fileName: `murmur-memo.${mimeType.includes('mp4') ? 'm4a' : 'webm'}`,
    }),
  });

  if (!response.ok) {
    let message = 'Unable to analyze this recording.';

    try {
      const data = (await response.json()) as ApiError;
      message = data.error || message;
    } catch {
      // Keep the generic message when the API does not return JSON.
    }

    throw new Error(message);
  }

  const data = (await response.json()) as Partial<MemoAnalysis>;

  return {
    transcript: data.transcript?.trim() || '',
    summary: data.summary?.trim() || '',
  };
}
