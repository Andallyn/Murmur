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
  createBackupFile,
  createBackupFileName,
  readBackupFile,
} from './backup';
import {
  deleteMemo,
  getAllMemos,
  saveMemo,
  updateMemo,
} from './memoStore';
import Logo from './Logo';
import {
  clearBiometric,
  clearPasscode,
  getPrivacyStatus,
  registerBiometric,
  setPasscode,
  verifyBiometric,
  verifyPasscode,
  type PrivacyStatus,
} from './privacy';
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
  const [backupStatus, setBackupStatus] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>({
    passcodeEnabled: false,
    biometricEnabled: false,
    biometricAvailable: false,
  });
  const [isPrivacyReady, setIsPrivacyReady] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [unlockPasscode, setUnlockPasscode] = useState('');
  const [setupPasscodeValue, setSetupPasscodeValue] = useState('');
  const [setupPasscodeConfirm, setSetupPasscodeConfirm] = useState('');
  const [privacyMessage, setPrivacyMessage] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
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

  useEffect(() => {
    let isMounted = true;

    getPrivacyStatus()
      .then((status) => {
        if (!isMounted) {
          return;
        }

        setPrivacyStatus(status);
        setIsLocked(status.passcodeEnabled || status.biometricEnabled);
      })
      .catch(() => {
        if (isMounted) {
          setPrivacyMessage('Privacy settings could not be loaded.');
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsPrivacyReady(true);
        }
      });

    return () => {
      isMounted = false;
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

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const exportBackup = async () => {
    if (!memos.length) {
      setBackupStatus('Record a memo before creating a backup.');
      return;
    }

    try {
      const backup = await createBackupFile(memos);
      downloadBlob(backup, createBackupFileName());
      setBackupStatus(
        `Backup created with ${memos.length} ${
          memos.length === 1 ? 'memo' : 'memos'
        }. Store it somewhere safe, like cloud storage.`,
      );
    } catch {
      setBackupStatus('Unable to create a backup file.');
    }
  };

  const importBackup = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    try {
      const backupMemos = await readBackupFile(file);
      await Promise.all(backupMemos.map((memo) => saveMemo(memo)));

      const loadedMemos = await getAllMemos();
      setMemos(loadedMemos);
      setDrafts(createDrafts(loadedMemos));
      setBackupStatus(
        `Restored ${backupMemos.length} ${
          backupMemos.length === 1 ? 'memo' : 'memos'
        } from backup.`,
      );
      setError('');
    } catch {
      setBackupStatus('Unable to restore this backup file.');
    } finally {
      if (backupInputRef.current) {
        backupInputRef.current.value = '';
      }
    }
  };

  const refreshPrivacyStatus = async () => {
    setPrivacyStatus(await getPrivacyStatus());
  };

  const savePasscode = async () => {
    if (setupPasscodeValue !== setupPasscodeConfirm) {
      setPrivacyMessage('Passcodes do not match.');
      return;
    }

    try {
      await setPasscode(setupPasscodeValue);
      setSetupPasscodeValue('');
      setSetupPasscodeConfirm('');
      await refreshPrivacyStatus();
      setPrivacyMessage('Passcode lock is enabled.');
    } catch (privacyError) {
      setPrivacyMessage(
        privacyError instanceof Error
          ? privacyError.message
          : 'Unable to save this passcode.',
      );
    }
  };

  const unlockWithPasscode = async () => {
    if (!(await verifyPasscode(unlockPasscode))) {
      setPrivacyMessage('Incorrect passcode.');
      return;
    }

    setUnlockPasscode('');
    setPrivacyMessage('');
    setIsLocked(false);
  };

  const unlockWithBiometric = async () => {
    try {
      if (!(await verifyBiometric())) {
        setPrivacyMessage('Biometric unlock was canceled.');
        return;
      }

      setPrivacyMessage('');
      setIsLocked(false);
    } catch {
      setPrivacyMessage('Biometric unlock failed.');
    }
  };

  const enableBiometric = async () => {
    try {
      await registerBiometric();
      await refreshPrivacyStatus();
      setPrivacyMessage('Biometric unlock is enabled on this device.');
    } catch (privacyError) {
      setPrivacyMessage(
        privacyError instanceof Error
          ? privacyError.message
          : 'Unable to enable biometric unlock.',
      );
    }
  };

  const disablePrivacy = async () => {
    const shouldDisable = window.confirm(
      'Disable passcode and biometric unlock for this browser?',
    );

    if (!shouldDisable) {
      return;
    }

    clearPasscode();
    clearBiometric();
    await refreshPrivacyStatus();
    setIsLocked(false);
    setPrivacyMessage('Privacy lock is disabled.');
  };

  const canLockApp =
    privacyStatus.passcodeEnabled || privacyStatus.biometricEnabled;

  if (!isPrivacyReady) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <Logo />
          <p className="eyebrow">Murmur privacy</p>
          <h1>Loading</h1>
          <p>Checking this browser&apos;s privacy settings...</p>
        </section>
      </main>
    );
  }

  if (isLocked) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <Logo />
          <p className="eyebrow">Murmur privacy</p>
          <h1>Locked</h1>
          <p>
            Unlock with your passcode or this device&apos;s biometric prompt to
            view local recordings.
          </p>
          {privacyStatus.passcodeEnabled ? (
            <form
              className="lock-form"
              onSubmit={(event) => {
                event.preventDefault();
                void unlockWithPasscode();
              }}
            >
              <label>
                <span>Passcode</span>
                <input
                  autoComplete="current-password"
                  type="password"
                  value={unlockPasscode}
                  onChange={(event) => setUnlockPasscode(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit">
                Unlock
              </button>
            </form>
          ) : null}
          {privacyStatus.biometricEnabled ? (
            <button
              className="secondary-button"
              onClick={() => void unlockWithBiometric()}
            >
              Use fingerprint / biometrics
            </button>
          ) : null}
          {privacyMessage ? (
            <p className="utility-status" role="alert">
              {privacyMessage}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-content">
          <div className="brand-lockup">
            <Logo />
            <div>
              <p className="eyebrow">Private voice notes</p>
              <h1>Murmur</h1>
            </div>
          </div>
          <p className="hero-copy">
            Capture quick thoughts, meeting takeaways, and reminders. Memos
            stay in this browser and can be replayed or exported anytime.
          </p>
          <div className="hero-badges" aria-label="Murmur highlights">
            <span>Local-first</span>
            <span>No account</span>
            <span>Export-ready</span>
          </div>
        </div>
        <div className="hero-visual" aria-label="Memo library stats">
          <div className="orbital-ring" />
          <div className="stats-card">
            <Logo size="small" />
            <span>{memos.length}</span>
            <p>{memos.length === 1 ? 'saved memo' : 'saved memos'}</p>
            <small>{formatDuration(totalDurationMs)} total audio</small>
          </div>
          <div className="wave-card" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>

      <section className="recorder-panel" aria-labelledby="recorder-title">
        <div className="section-heading">
          <p className="eyebrow">Recorder</p>
          <h2 id="recorder-title">New memo</h2>
          <p className="panel-copy">Tap record and let the idea land.</p>
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
          <span className={`status-dot status-${recordingState}`} />
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

      <section className="utility-grid" aria-label="Recovery and privacy">
        <article className="utility-card">
          <div className="section-heading">
            <p className="eyebrow">Recovery</p>
            <h2>Backup & restore</h2>
            <p className="panel-copy">
              Murmur saves recordings on this device. To recover after theft or
              a broken phone, export a backup and store it somewhere safe before
              anything happens.
            </p>
          </div>
          <div className="utility-actions">
            <button
              className="secondary-button"
              onClick={() => void exportBackup()}
            >
              Export backup
            </button>
            <button
              className="secondary-button"
              onClick={() => backupInputRef.current?.click()}
            >
              Restore backup
            </button>
            <input
              ref={backupInputRef}
              className="file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => void importBackup(event.target.files?.[0])}
            />
          </div>
          {backupStatus ? (
            <p className="utility-status" role="status">
              {backupStatus}
            </p>
          ) : null}
        </article>

        <article className="utility-card">
          <div className="section-heading">
            <p className="eyebrow">Privacy</p>
            <h2>App lock</h2>
            <p className="panel-copy">
              Add a passcode and optional device biometrics to keep casual
              access out of Murmur on this browser.
            </p>
          </div>
          <div className="privacy-status-list">
            <span>
              Passcode:{' '}
              {privacyStatus.passcodeEnabled ? 'Enabled' : 'Not enabled'}
            </span>
            <span>
              Biometrics:{' '}
              {privacyStatus.biometricEnabled
                ? 'Enabled'
                : privacyStatus.biometricAvailable
                  ? 'Available'
                  : 'Unavailable'}
            </span>
          </div>
          <div className="passcode-grid">
            <label>
              <span>New passcode</span>
              <input
                autoComplete="new-password"
                type="password"
                value={setupPasscodeValue}
                onChange={(event) => setSetupPasscodeValue(event.target.value)}
              />
            </label>
            <label>
              <span>Confirm passcode</span>
              <input
                autoComplete="new-password"
                type="password"
                value={setupPasscodeConfirm}
                onChange={(event) =>
                  setSetupPasscodeConfirm(event.target.value)
                }
              />
            </label>
          </div>
          <div className="utility-actions">
            <button
              className="secondary-button"
              onClick={() => void savePasscode()}
            >
              Save passcode
            </button>
            <button
              className="secondary-button"
              disabled={!privacyStatus.biometricAvailable}
              onClick={() => void enableBiometric()}
            >
              Enable fingerprint / biometrics
            </button>
            <button
              className="secondary-button"
              disabled={!canLockApp}
              onClick={() => setIsLocked(true)}
            >
              Lock now
            </button>
            <button
              className="text-danger-button"
              disabled={!canLockApp}
              onClick={() => void disablePrivacy()}
            >
              Disable lock
            </button>
          </div>
          {privacyMessage ? (
            <p className="utility-status" role="status">
              {privacyMessage}
            </p>
          ) : null}
        </article>
      </section>

      <section className="memo-toolbar" aria-label="Memo search">
        <div className="section-heading">
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
