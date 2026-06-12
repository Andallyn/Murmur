import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDefaultTitle,
  formatBytes,
  formatDuration,
  getAudioExtension,
  matchesMemo,
  normalizeTitle,
  sortMemosByNewest,
} from './memoUtils';
import {
  deleteMemo,
  getAllMemos,
  saveMemo,
  updateMemo,
} from './memoStore';
import type { DraftMemo, VoiceMemo } from './types';
import './styles.css';

const TIMER_INTERVAL_MS = 250;
const RECORDING_TIMESLICE_MS = 1_000;

type RecordingState = 'idle' | 'recording' | 'paused';

const preferredMimeTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function getSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }

  return (
    preferredMimeTypes.find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    ) ?? ''
  );
}

function createDrafts(memos: VoiceMemo[]): Record<string, DraftMemo> {
  return memos.reduce<Record<string, DraftMemo>>((drafts, memo) => {
    drafts[memo.id] = {
      title: memo.title,
      notes: memo.notes,
    };

    return drafts;
  }, {});
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'murmur-memo';
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function MemoAudio({ memo }: { memo: VoiceMemo }) {
  const source = useMemo(() => URL.createObjectURL(memo.blob), [memo.blob]);

  useEffect(() => {
    return () => URL.revokeObjectURL(source);
  }, [source]);

  return <audio controls preload="metadata" src={source} />;
}

export default function App() {
  const [memos, setMemos] = useState<VoiceMemo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftMemo>>({});
  const [query, setQuery] = useState('');
  const [recordingState, setRecordingState] =
    useState<RecordingState>('idle');
  const [recordingMs, setRecordingMs] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const elapsedBeforeCurrentRunRef = useRef(0);
  const finalDurationRef = useRef(0);

  useEffect(() => {
    let isMounted = true;

    getAllMemos()
      .then((loadedMemos) => {
        if (!isMounted) {
          return;
        }

        setMemos(loadedMemos);
        setDrafts(createDrafts(loadedMemos));
      })
      .catch(() => {
        if (isMounted) {
          setError('Unable to load saved memos from this browser.');
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
      stopStream(streamRef.current);
    };
  }, []);

  const filteredMemos = useMemo(
    () => memos.filter((memo) => matchesMemo(memo, query)),
    [memos, query],
  );

  const totalDurationMs = useMemo(
    () => memos.reduce((total, memo) => total + memo.durationMs, 0),
    [memos],
  );

  const getCurrentRecordingMs = () => {
    if (!recordingStartedAtRef.current) {
      return elapsedBeforeCurrentRunRef.current;
    }

    return (
      elapsedBeforeCurrentRunRef.current +
      Date.now() -
      recordingStartedAtRef.current
    );
  };

  const clearTimer = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = () => {
    clearTimer();
    timerRef.current = window.setInterval(() => {
      setRecordingMs(getCurrentRecordingMs());
    }, TIMER_INTERVAL_MS);
  };

  const resetRecordingRefs = () => {
    chunksRef.current = [];
    recorderRef.current = null;
    streamRef.current = null;
    recordingStartedAtRef.current = null;
    elapsedBeforeCurrentRunRef.current = 0;
    finalDurationRef.current = 0;
  };

  const persistRecording = async (mimeType: string) => {
    clearTimer();
    stopStream(streamRef.current);

    const blob = new Blob(chunksRef.current, {
      type: mimeType || 'audio/webm',
    });

    if (!blob.size) {
      resetRecordingRefs();
      setRecordingMs(0);
      setError('No audio was captured. Please try recording again.');
      return;
    }

    const createdAt = new Date();
    const memo: VoiceMemo = {
      id: crypto.randomUUID(),
      title: createDefaultTitle(createdAt),
      notes: '',
      createdAt: createdAt.toISOString(),
      durationMs: finalDurationRef.current,
      blob,
      mimeType: blob.type,
      size: blob.size,
    };

    try {
      const savedMemo = await saveMemo(memo);
      setMemos((currentMemos) =>
        sortMemosByNewest([savedMemo, ...currentMemos]),
      );
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [savedMemo.id]: {
          title: savedMemo.title,
          notes: savedMemo.notes,
        },
      }));
      setRecordingMs(0);
      setError('');
    } catch {
      setError('Recording finished, but it could not be saved locally.');
    } finally {
      resetRecordingRefs();
    }
  };

  const startRecording = async () => {
    setError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support microphone recording.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setError('This browser does not support the MediaRecorder API.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );

      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();
      elapsedBeforeCurrentRunRef.current = 0;
      finalDurationRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void persistRecording(recorder.mimeType);
      };
      recorder.onerror = () => {
        setError('The recorder stopped unexpectedly.');
      };

      recorder.start(RECORDING_TIMESLICE_MS);
      setRecordingMs(0);
      setRecordingState('recording');
      startTimer();
    } catch {
      stopStream(streamRef.current);
      resetRecordingRefs();
      setError('Microphone access was blocked or unavailable.');
    }
  };

  const pauseRecording = () => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state !== 'recording') {
      return;
    }

    recorder.pause();
    elapsedBeforeCurrentRunRef.current = getCurrentRecordingMs();
    recordingStartedAtRef.current = null;
    setRecordingMs(elapsedBeforeCurrentRunRef.current);
    setRecordingState('paused');
    clearTimer();
  };

  const resumeRecording = () => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state !== 'paused') {
      return;
    }

    recorder.resume();
    recordingStartedAtRef.current = Date.now();
    setRecordingState('recording');
    startTimer();
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return;
    }

    finalDurationRef.current = getCurrentRecordingMs();
    setRecordingMs(finalDurationRef.current);
    clearTimer();
    setRecordingState('idle');
    recorder.stop();
  };

  const updateDraft = (
    memoId: string,
    field: keyof DraftMemo,
    value: string,
  ) => {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [memoId]: {
        ...currentDrafts[memoId],
        [field]: value,
      },
    }));
  };

  const saveDraft = async (memo: VoiceMemo) => {
    const draft = drafts[memo.id];

    if (!draft) {
      return;
    }

    const updates = {
      title: normalizeTitle(draft.title),
      notes: draft.notes.trim(),
    };

    try {
      const updatedMemo = await updateMemo(memo.id, updates);
      setMemos((currentMemos) =>
        sortMemosByNewest(
          currentMemos.map((currentMemo) =>
            currentMemo.id === updatedMemo.id ? updatedMemo : currentMemo,
          ),
        ),
      );
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [updatedMemo.id]: {
          title: updatedMemo.title,
          notes: updatedMemo.notes,
        },
      }));
      setError('');
    } catch {
      setError('Unable to update this memo.');
    }
  };

  const removeMemo = async (memo: VoiceMemo) => {
    const shouldDelete = window.confirm(`Delete "${memo.title}"?`);

    if (!shouldDelete) {
      return;
    }

    try {
      await deleteMemo(memo.id);
      setMemos((currentMemos) =>
        currentMemos.filter((currentMemo) => currentMemo.id !== memo.id),
      );
      setDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[memo.id];
        return nextDrafts;
      });
      setError('');
    } catch {
      setError('Unable to delete this memo.');
    }
  };

  const exportMemo = (memo: VoiceMemo) => {
    const url = URL.createObjectURL(memo.blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `${sanitizeFileName(memo.title)}.${getAudioExtension(
      memo.mimeType,
    )}`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Private voice notes</p>
          <h1>Murmur</h1>
          <p className="hero-copy">
            Capture quick thoughts, meeting takeaways, and reminders. Memos
            stay in this browser and can be replayed or exported anytime.
          </p>
        </div>
        <div className="stats-card" aria-label="Memo library stats">
          <span>{memos.length}</span>
          <p>{memos.length === 1 ? 'saved memo' : 'saved memos'}</p>
          <small>{formatDuration(totalDurationMs)} total audio</small>
        </div>
      </section>

      <section className="recorder-panel" aria-labelledby="recorder-title">
        <div>
          <p className="eyebrow">Recorder</p>
          <h2 id="recorder-title">New memo</h2>
        </div>
        <div className="timer" aria-live="polite">
          {formatDuration(recordingMs)}
        </div>
        <div className="recording-controls">
          {recordingState === 'idle' ? (
            <button className="primary-button" onClick={startRecording}>
              Start recording
            </button>
          ) : (
            <>
              {recordingState === 'recording' ? (
                <button className="secondary-button" onClick={pauseRecording}>
                  Pause
                </button>
              ) : (
                <button className="secondary-button" onClick={resumeRecording}>
                  Resume
                </button>
              )}
              <button className="danger-button" onClick={stopRecording}>
                Save recording
              </button>
            </>
          )}
        </div>
        <p className="status-text">
          {recordingState === 'idle'
            ? 'Ready when you are.'
            : recordingState === 'paused'
              ? 'Paused. Resume to keep recording.'
              : 'Recording from your microphone...'}
        </p>
      </section>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <section className="memo-toolbar" aria-label="Memo search">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Your memos</h2>
        </div>
        <label>
          <span className="sr-only">Search memos</span>
          <input
            type="search"
            placeholder="Search titles or notes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </section>

      {isLoading ? (
        <p className="empty-state">Loading saved memos...</p>
      ) : filteredMemos.length ? (
        <section className="memo-grid" aria-label="Saved voice memos">
          {filteredMemos.map((memo) => {
            const draft = drafts[memo.id] ?? {
              title: memo.title,
              notes: memo.notes,
            };
            const hasChanges =
              draft.title !== memo.title || draft.notes !== memo.notes;

            return (
              <article className="memo-card" key={memo.id}>
                <div className="memo-card-header">
                  <div>
                    <label>
                      <span>Title</span>
                      <input
                        value={draft.title}
                        onChange={(event) =>
                          updateDraft(memo.id, 'title', event.target.value)
                        }
                      />
                    </label>
                    <time dateTime={memo.createdAt}>
                      {new Date(memo.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <span className="duration-pill">
                    {formatDuration(memo.durationMs)}
                  </span>
                </div>

                <MemoAudio memo={memo} />

                <label>
                  <span>Notes</span>
                  <textarea
                    placeholder="Add context, keywords, or a transcript..."
                    value={draft.notes}
                    onChange={(event) =>
                      updateDraft(memo.id, 'notes', event.target.value)
                    }
                  />
                </label>

                <div className="memo-meta">
                  <span>{formatBytes(memo.size)}</span>
                  <span>{memo.mimeType || 'audio/webm'}</span>
                </div>

                <div className="memo-actions">
                  <button
                    className="secondary-button"
                    disabled={!hasChanges}
                    onClick={() => void saveDraft(memo)}
                  >
                    Save details
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => exportMemo(memo)}
                  >
                    Export
                  </button>
                  <button
                    className="text-danger-button"
                    onClick={() => void removeMemo(memo)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <p className="empty-state">
          {query
            ? 'No memos match your search.'
            : 'Record your first memo to start your library.'}
        </p>
      )}
    </main>
  );
}
