import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb',
    },
  },
};

interface TranscribeRequest extends IncomingMessage {
  body?: unknown;
}

interface TranscribeBody {
  audioBase64: string;
  mimeType?: string;
  fileName?: string;
}

interface WhisperResponse {
  text?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}

function parseBody(body: unknown): TranscribeBody | null {
  const parsedBody =
    typeof body === 'string' ? (JSON.parse(body) as unknown) : body;

  if (!parsedBody || typeof parsedBody !== 'object') {
    return null;
  }

  const candidate = parsedBody as Partial<TranscribeBody>;

  if (typeof candidate.audioBase64 !== 'string') {
    return null;
  }

  return {
    audioBase64: candidate.audioBase64,
    mimeType: candidate.mimeType,
    fileName: candidate.fileName,
  };
}

function stripDataUrlPrefix(value: string): string {
  return value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
}

function fallbackSummary(transcript: string): string {
  const firstSentence = transcript.match(/.*?[.!?](\s|$)/)?.[0]?.trim();
  const fallback = firstSentence || transcript.trim();

  return fallback.length > 150 ? `${fallback.slice(0, 147)}...` : fallback;
}

async function summarizeTranscript(
  transcript: string,
  apiKey: string,
): Promise<string> {
  if (!transcript.trim()) {
    return '';
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 48,
      messages: [
        {
          role: 'system',
          content:
            'Summarize voice memo transcripts in one short, useful line. Keep it under 18 words.',
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
    }),
  });

  if (!response.ok) {
    return fallbackSummary(transcript);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const summary = data.choices?.[0]?.message?.content?.trim();

  return summary || fallbackSummary(transcript);
}

export default async function handler(
  request: TranscribeRequest,
  response: ServerResponse,
) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    sendJson(response, 500, {
      error: 'OPENAI_API_KEY is not configured for transcription.',
    });
    return;
  }

  let body: TranscribeBody | null = null;

  try {
    body = parseBody(request.body);
  } catch {
    sendJson(response, 400, { error: 'Invalid JSON body.' });
    return;
  }

  if (!body) {
    sendJson(response, 400, { error: 'Missing audio payload.' });
    return;
  }

  const audioBytes = Buffer.from(stripDataUrlPrefix(body.audioBase64), 'base64');

  if (!audioBytes.length) {
    sendJson(response, 400, { error: 'Audio payload is empty.' });
    return;
  }

  const formData = new FormData();
  const audioBlob = new Blob([audioBytes], {
    type: body.mimeType || 'audio/webm',
  });

  formData.append('file', audioBlob, body.fileName || 'murmur-memo.webm');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'json');

  const transcriptionResponse = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
  );

  if (!transcriptionResponse.ok) {
    sendJson(response, transcriptionResponse.status, {
      error: 'Unable to transcribe this recording.',
    });
    return;
  }

  const transcriptionData =
    (await transcriptionResponse.json()) as WhisperResponse;
  const transcript = transcriptionData.text?.trim() || '';
  const summary = await summarizeTranscript(transcript, apiKey);

  sendJson(response, 200, {
    transcript,
    summary,
  });
}
