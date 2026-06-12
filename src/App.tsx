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
import {
  connectSia,
  downloadSiaBackup,
  getStoredSiaBackup,
  hasStoredSiaConnection,
  listSiaBackups,
  reconnectSia,
  uploadSiaBackup,
  type SiaBackupRecord,
} from './siaStorage';
import type { DraftMemo, VoiceMemo } from './types';
import './styles.css';

const TIMER_INTERVAL_MS = 250;
const RECORDING_TIMESLICE_MS = 1_000;
const WELCOME_DISMISSED_KEY = 'murmur.welcomeDismissedDate.v1';
const REMINDER_SETTINGS_KEY = 'murmur.reminders.v1';
const INCOMPLETE_REMINDER_COOLDOWN_MS = 5 * 60 * 1_000;

type RecordingState = 'idle' | 'recording' | 'paused';
type MenuPanel = 'settings' | 'storage' | 'privacy' | null;

interface ReminderSettings {
  dailyEnabled: boolean;
  dailyTime: string;
}

const defaultReminderSettings: ReminderSettings = {
  dailyEnabled: false,
  dailyTime: '09:00',
};

const reminderSeriesIdeas = [
  {
    series: 'Daily affirmations',
    prompt: 'Record one affirmation you want to carry today.',
  },
  {
    series: 'To-do list',
    prompt: 'Talk through your top priorities before the day gets busy.',
  },
  {
    series: 'Gratitude log',
    prompt: 'Save one thing you are grateful for right now.',
  },
  {
    series: 'Idea journal',
    prompt: 'Capture a rough idea before it disappears.',
  },
  {
    series: 'Mood check-in',
    prompt: 'Name how you feel and what you need next.',
  },
  {
    series: 'Meeting recap',
    prompt: 'Summarize decisions, blockers, and follow-ups.',
  },
  {
    series: 'Voice diary',
    prompt: 'Leave a short note for your future self.',
  },
];

const recorderPrompts = [
  'drop the thought 🎙️',
  'brain dump in 3... 2...',
  'vent, plan, or just vibe',
  'say it before it disappears',
  'main character monologue?',
  'tiny thought, big energy',
];

const moodTags = [
  '🔥 idea',
  '😮‍💨 vent',
  '🧠 deep thought',
  '📋 reminder',
  '✨ random',
  '💭 diary',
];

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
      series: memo.series ?? '',
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

function getStoredReminderSettings(): ReminderSettings {
  const storedSettings = localStorage.getItem(REMINDER_SETTINGS_KEY);

  if (!storedSettings) {
    return defaultReminderSettings;
  }

  try {
    return {
      ...defaultReminderSettings,
      ...(JSON.parse(storedSettings) as Partial<ReminderSettings>),
    };
  } catch {
    return defaultReminderSettings;
  }
}

function saveReminderSettings(settings: ReminderSettings): void {
  localStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify(settings));
}

function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) {
    return 'unsupported';
  }

  return Notification.permission;
}

function getDelayUntilReminder(time: string): number {
  const [hour = '9', minute = '0'] = time.split(':');
  const now = new Date();
  const nextReminder = new Date();

  nextReminder.setHours(Number(hour), Number(minute), 0, 0);

  if (nextReminder <= now) {
    nextReminder.setDate(nextReminder.getDate() + 1);
  }

  return nextReminder.getTime() - now.getTime();
}

function showBrowserNotification(title: string, body: string): boolean {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return false;
  }

  new Notification(title, {
    body,
    icon: '/murmur-mark.svg',
    badge: '/murmur-mark.svg',
  });

  return true;
}

function getReminderSeriesIdea(date = new Date()) {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor(
    (date.getTime() - startOfYear.getTime()) / 86_400_000,
  );

  return reminderSeriesIdeas[dayOfYear % reminderSeriesIdeas.length];
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
  const [recorderPrompt] = useState(
    () => recorderPrompts[Math.floor(Math.random() * recorderPrompts.length)],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeMenuPanel, setActiveMenuPanel] = useState<MenuPanel>(null);
  const [showWelcome, setShowWelcome] = useState(
    () =>
      localStorage.getItem(WELCOME_DISMISSED_KEY) !==
      new Date().toDateString(),
  );
  const [reminderSettings, setReminderSettings] = useState(
    getStoredReminderSettings,
  );
  const [notificationPermission, setNotificationPermission] = useState(
    getNotificationPermission,
  );
  const [reminderStatus, setReminderStatus] = useState('');
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
  const [isSiaConnected, setIsSiaConnected] = useState(false);
  const [isSiaReady, setIsSiaReady] = useState(false);
  const [isSiaBusy, setIsSiaBusy] = useState(false);
  const [isSiaSyncing, setIsSiaSyncing] = useState(false);
  const [siaStatus, setSiaStatus] = useState('');
  const [siaApprovalUrl, setSiaApprovalUrl] = useState('');
  const [siaRecoveryPhrase, setSiaRecoveryPhrase] = useState('');
  const [siaRecoveryPhraseToUse, setSiaRecoveryPhraseToUse] = useState('');
  const [latestSiaBackup, setLatestSiaBackup] =
    useState<SiaBackupRecord | null>(() => getStoredSiaBackup());

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const incompleteReminderSentAtRef = useRef(0);
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

    const initializeSia = async () => {
      if (!hasStoredSiaConnection()) {
        return;
      }

      try {
        await reconnectSia();

        if (!isMounted) {
          return;
        }

        setIsSiaConnected(true);
        const records = await listSiaBackups();

        if (!isMounted) {
          return;
        }

        if (records[0]) {
          setLatestSiaBackup(records[0]);
        }
      } catch {
        if (isMounted) {
          setSiaStatus('Reconnect to Sia to use Murmur storage.');
        }
      }
    };

    void initializeSia()
      .finally(() => {
        if (isMounted) {
          setIsSiaReady(true);
        }
      });

    return () => {
      isMounted = false;
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

  useEffect(() => {
    if (
      !reminderSettings.dailyEnabled ||
      notificationPermission !== 'granted'
    ) {
      return;
    }

    let isActive = true;
    let timeoutId: number | null = null;

    const scheduleReminder = () => {
      timeoutId = window.setTimeout(() => {
        if (!isActive) {
          return;
        }

        const idea = getReminderSeriesIdea();

        showBrowserNotification(
          'Time to record in Murmur',
          `${idea.series}: ${idea.prompt}`,
        );
        setReminderStatus('Daily reminder sent.');
        scheduleReminder();
      }, getDelayUntilReminder(reminderSettings.dailyTime));
    };

    scheduleReminder();

    return () => {
      isActive = false;

      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    reminderSettings.dailyEnabled,
    reminderSettings.dailyTime,
    notificationPermission,
  ]);

  useEffect(() => {
    if (recordingState === 'idle') {
      return;
    }

    const notifyIncompleteRecording = () => {
      const now = Date.now();

      if (
        now - incompleteReminderSentAtRef.current <
        INCOMPLETE_REMINDER_COOLDOWN_MS
      ) {
        return;
      }

      incompleteReminderSentAtRef.current = now;

      const didNotify = showBrowserNotification(
        'Finish your Murmur recording',
        'You have a recording in progress. Return to save it before leaving.',
      );

      if (didNotify) {
        setReminderStatus('Sent an unfinished recording reminder.');
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        notifyIncompleteRecording();
      }
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      notifyIncompleteRecording();
      event.preventDefault();
      event.returnValue = '';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [recordingState]);

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

  const syncMemosToSia = async (
    memosToSync: VoiceMemo[],
    successMessage: string,
  ) => {
    setIsSiaSyncing(true);
    setSiaStatus('Syncing recordings to Sia...');

    try {
      const record = await uploadSiaBackup(memosToSync);
      setLatestSiaBackup(record);
      setSiaStatus(successMessage);
      setIsSiaConnected(true);
    } catch (siaError) {
      setSiaStatus(
        siaError instanceof Error
          ? siaError.message
          : 'Unable to sync recordings to Sia.',
      );
      throw siaError;
    } finally {
      setIsSiaSyncing(false);
    }
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
      series: '',
      notes: '',
      createdAt: createdAt.toISOString(),
      durationMs: finalDurationRef.current,
      blob,
      mimeType: blob.type,
      size: blob.size,
    };

    try {
      const savedMemo = await saveMemo(memo);
      const nextMemos = sortMemosByNewest([savedMemo, ...memos]);

      setMemos(nextMemos);
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [savedMemo.id]: {
          title: savedMemo.title,
          series: savedMemo.series,
          notes: savedMemo.notes,
        },
      }));
      await syncMemosToSia(nextMemos, 'Recording saved and synced to Sia.');
      setRecordingMs(0);
      setError('');
    } catch {
      setError('Recording finished, but it could not be saved to Sia.');
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

  const handleMicButtonClick = () => {
    if (recordingState === 'idle') {
      void startRecording();
      return;
    }

    stopRecording();
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
      series: draft.series.trim(),
      notes: draft.notes.trim(),
    };

    try {
      const updatedMemo = await updateMemo(memo.id, updates);
      const nextMemos = sortMemosByNewest(
        memos.map((currentMemo) =>
          currentMemo.id === updatedMemo.id ? updatedMemo : currentMemo,
        ),
      );

      setMemos(nextMemos);
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [updatedMemo.id]: {
          title: updatedMemo.title,
          series: updatedMemo.series,
          notes: updatedMemo.notes,
        },
      }));
      await syncMemosToSia(nextMemos, 'Recording details synced to Sia.');
      setError('');
    } catch {
      setError('Unable to sync this recording update to Sia.');
    }
  };

  const removeMemo = async (memo: VoiceMemo) => {
    const shouldDelete = window.confirm(`Delete "${memo.title}"?`);

    if (!shouldDelete) {
      return;
    }

    try {
      await deleteMemo(memo.id);
      const nextMemos = memos.filter((currentMemo) => currentMemo.id !== memo.id);

      setMemos(nextMemos);
      setDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[memo.id];
        return nextDrafts;
      });
      await syncMemosToSia(nextMemos, 'Recording removed and Sia updated.');
      setError('');
    } catch {
      setError('Unable to sync this deletion to Sia.');
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
      await syncMemosToSia(loadedMemos, 'Restored recordings synced to Sia.');
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

  const connectSiaStorage = async () => {
    setIsSiaBusy(true);
    setSiaStatus('Opening Sia approval flow...');
    setSiaApprovalUrl('');
    setSiaRecoveryPhrase('');

    try {
      const result = await connectSia(siaRecoveryPhraseToUse, (url) => {
        setSiaApprovalUrl(url);
        setSiaStatus('Approve Murmur in Sia, then return here.');
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      const records = await listSiaBackups();

      setIsSiaConnected(true);
      setSiaRecoveryPhrase(result.recoveryPhrase);
      setLatestSiaBackup(records[0] ?? getStoredSiaBackup());
      setSiaStatus(
        siaRecoveryPhraseToUse.trim()
          ? 'Connected to Sia with your recovery phrase.'
          : 'Connected to Sia. Save the recovery phrase shown below before relying on cloud restore.',
      );
    } catch (siaError) {
      setSiaStatus(
        siaError instanceof Error
          ? siaError.message
          : 'Unable to connect to Sia storage.',
      );
    } finally {
      setIsSiaBusy(false);
    }
  };

  const uploadCloudBackup = async () => {
    if (!memos.length) {
      setSiaStatus('Record something before syncing to Sia.');
      return;
    }

    try {
      await syncMemosToSia(memos, 'All recordings are synced to Sia.');
    } catch (siaError) {
      setSiaStatus(
        siaError instanceof Error
          ? siaError.message
          : 'Unable to upload backup to Sia.',
      );
    }
  };

  const restoreCloudBackup = async () => {
    setIsSiaBusy(true);
    setSiaStatus('Looking for the latest Murmur backup on Sia...');

    try {
      const records = await listSiaBackups();
      const record = records[0] ?? latestSiaBackup;

      if (!record) {
        setSiaStatus('No Murmur backups were found on Sia for this app key.');
        return;
      }

      const backupFile = await downloadSiaBackup(record.objectId);
      await importBackup(backupFile);
      setLatestSiaBackup(record);
      setSiaStatus(
        `Restored Sia backup from ${new Date(
          record.uploadedAt,
        ).toLocaleString()}.`,
      );
    } catch (siaError) {
      setSiaStatus(
        siaError instanceof Error
          ? siaError.message
          : 'Unable to restore from Sia.',
      );
    } finally {
      setIsSiaBusy(false);
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

  const requestReminderPermission = async () => {
    if (!('Notification' in window)) {
      setReminderStatus('This browser does not support notifications.');
      setNotificationPermission('unsupported');
      return false;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    if (permission !== 'granted') {
      setReminderStatus('Notifications are blocked for Murmur.');
      return false;
    }

    setReminderStatus('Notifications are enabled.');
    return true;
  };

  const updateDailyReminder = async (dailyEnabled: boolean) => {
    if (dailyEnabled && notificationPermission !== 'granted') {
      const didGrantPermission = await requestReminderPermission();

      if (!didGrantPermission) {
        return;
      }
    }

    const nextSettings = {
      ...reminderSettings,
      dailyEnabled,
    };

    saveReminderSettings(nextSettings);
    setReminderSettings(nextSettings);
    setReminderStatus(
      dailyEnabled
        ? `Daily reminders set for ${nextSettings.dailyTime}.`
        : 'Daily reminders are off.',
    );
  };

  const updateReminderTime = (dailyTime: string) => {
    const nextSettings = {
      ...reminderSettings,
      dailyTime,
    };

    saveReminderSettings(nextSettings);
    setReminderSettings(nextSettings);

    if (nextSettings.dailyEnabled) {
      setReminderStatus(`Daily reminders set for ${dailyTime}.`);
    }
  };

  const sendTestReminder = async () => {
    if (notificationPermission !== 'granted') {
      const didGrantPermission = await requestReminderPermission();

      if (!didGrantPermission) {
        return;
      }
    }

    const idea = getReminderSeriesIdea();
    const didNotify = showBrowserNotification(
      'Murmur reminder test',
      `${idea.series}: ${idea.prompt}`,
    );

    setReminderStatus(
      didNotify
        ? 'Test notification sent.'
        : 'Notifications are not available right now.',
    );
  };

  const dismissWelcome = () => {
    localStorage.setItem(WELCOME_DISMISSED_KEY, new Date().toDateString());
    setShowWelcome(false);
  };

  const openMenuPanel = (panel: Exclude<MenuPanel, null>) => {
    setActiveMenuPanel((currentPanel) =>
      currentPanel === panel ? null : panel,
    );
    setIsMenuOpen(false);
  };

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

  if (!isSiaReady) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <Logo />
          <p className="eyebrow">Sia storage partner</p>
          <h1>Connecting</h1>
          <p>Preparing Murmur&apos;s Sia storage connection...</p>
        </section>
      </main>
    );
  }

  if (!isSiaConnected) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <Logo />
          <p className="eyebrow">Sia storage partner</p>
          <h1>Set up storage</h1>
          <p>
            Murmur stores recordings with Sia. Connect through the Sia approval
            flow before recording, or paste your saved recovery phrase to
            restore storage on this device.
          </p>
          <label>
            <span>Sia recovery phrase</span>
            <textarea
              className="compact-textarea"
              placeholder="Paste your saved phrase to restore, or leave blank to create a new Sia storage identity."
              value={siaRecoveryPhraseToUse}
              onChange={(event) =>
                setSiaRecoveryPhraseToUse(event.target.value)
              }
            />
          </label>
          <button
            className="primary-button"
            disabled={isSiaBusy}
            onClick={() => void connectSiaStorage()}
          >
            {isSiaBusy ? 'Waiting for Sia approval...' : 'Set up Sia storage'}
          </button>
          {siaApprovalUrl ? (
            <p className="utility-status">
              Approval page:{' '}
              <a href={siaApprovalUrl} target="_blank" rel="noreferrer">
                Open Sia approval
              </a>
            </p>
          ) : null}
          {siaRecoveryPhrase ? (
            <div className="recovery-phrase" role="status">
              <span>Save this Sia recovery phrase:</span>
              <code>{siaRecoveryPhrase}</code>
            </div>
          ) : null}
          {siaStatus ? (
            <p className="utility-status" role="status">
              {siaStatus}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <Logo size="small" />
          <div>
            <p className="eyebrow">Private voice notes</p>
            <h1>Murmur</h1>
          </div>
        </div>
        <div className="menu-wrap">
          <button
            className="menu-button"
            aria-expanded={isMenuOpen}
            aria-label="Open menu"
            onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
          >
            <span />
            <span />
            <span />
          </button>
          {isMenuOpen ? (
            <div className="menu-popover" role="menu">
              <button role="menuitem" onClick={() => openMenuPanel('settings')}>
                Settings
              </button>
              <button role="menuitem" onClick={() => openMenuPanel('storage')}>
                Storage & restore
              </button>
              <button role="menuitem" onClick={() => openMenuPanel('privacy')}>
                Privacy lock
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {showWelcome ? (
        <section className="welcome-card" aria-label="Welcome message">
          <div>
            <p className="eyebrow">Welcome back</p>
            <h2>Tap the mic. Catch the chaos.</h2>
            <p className="panel-copy">
              Name it and mood-tag it after. Just capture the thought first.
            </p>
          </div>
          <button className="secondary-button" onClick={dismissWelcome}>
            Got it
          </button>
        </section>
      ) : null}

      <section className="recorder-panel" aria-labelledby="recorder-title">
        <div className="section-heading">
          <p className="eyebrow">Recorder</p>
          <h2 id="recorder-title">Instant capture</h2>
          <p className="panel-copy">
            No forms. No setup. Just tap and talk.
          </p>
        </div>
        <div className="record-hero">
          <div
            className={`waveform-ring ${
              recordingState === 'recording' ? 'waveform-active' : ''
            }`}
            aria-hidden="true"
          >
            {Array.from({ length: 18 }).map((_, index) => (
              <span key={index} />
            ))}
          </div>
          <button
            className={`mic-button mic-${recordingState}`}
            aria-label={
              recordingState === 'idle'
                ? 'Start recording'
                : 'Save recording'
            }
            onClick={handleMicButtonClick}
          >
            <span className="mic-icon" aria-hidden="true">
              🎙️
            </span>
            <span>
              {recordingState === 'idle'
                ? 'record'
                : recordingState === 'paused'
                  ? 'save'
                  : 'save'}
            </span>
          </button>
        </div>
        <div className="recording-footer">
          <div className="timer" aria-live="polite">
            {formatDuration(recordingMs)}
          </div>
          {recordingState !== 'idle' ? (
            <div className="recording-controls">
              {recordingState === 'recording' ? (
                <button className="secondary-button" onClick={pauseRecording}>
                  Pause
                </button>
              ) : (
                <button className="secondary-button" onClick={resumeRecording}>
                  Resume
                </button>
              )}
            </div>
          ) : null}
        </div>
        <p className="status-text prompt-text">
          <span className={`status-dot status-${recordingState}`} />
          {recordingState === 'idle'
            ? recorderPrompt
            : recordingState === 'paused'
              ? 'paused. save it or keep spilling.'
              : 'live. let it out.'}
        </p>
      </section>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {activeMenuPanel ? (
        <div
          className="settings-drawer-backdrop"
          role="presentation"
          onClick={() => setActiveMenuPanel(null)}
        >
          <aside
            className="settings-drawer"
            aria-label="Menu panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="menu-panel-heading">
            <p className="eyebrow">
              {activeMenuPanel === 'settings'
                ? 'Settings'
                : activeMenuPanel === 'storage'
                  ? 'Storage & restore'
                  : 'Privacy'}
            </p>
            <button
              className="text-danger-button"
              onClick={() => setActiveMenuPanel(null)}
            >
              Close
            </button>
          </div>

          {activeMenuPanel === 'settings' ? (
            <article className="utility-card">
              <div className="section-heading">
                <h2>App settings</h2>
                <p className="panel-copy">
                  Quick status without crowding the recorder.
                </p>
              </div>
              <div className="privacy-status-list">
                <span>{memos.length} recordings</span>
                <span>{formatDuration(totalDurationMs)} total audio</span>
                <span>
                  Sync:{' '}
                  {isSiaSyncing
                    ? 'In progress'
                    : latestSiaBackup
                      ? 'Current'
                      : 'Waiting for first recording'}
                </span>
              </div>
              <div className="utility-actions">
                <button
                  className="secondary-button"
                  disabled={isSiaBusy || isSiaSyncing}
                  onClick={() => void uploadCloudBackup()}
                >
                  Sync now
                </button>
                <button
                  className="secondary-button"
                  disabled={!canLockApp}
                  onClick={() => setIsLocked(true)}
                >
                  Lock app
                </button>
              </div>
              <div className="reminder-settings">
                <div className="section-heading">
                  <h3>Recording reminders</h3>
                  <p className="panel-copy">
                    Get a daily nudge to record. Murmur also warns you if you
                    leave with an unsaved recording in progress.
                  </p>
                  <p className="panel-copy">
                    Suggestions rotate through ideas like Daily affirmations,
                    To-do list, Gratitude log, Idea journal, and Voice diary.
                  </p>
                </div>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={reminderSettings.dailyEnabled}
                    onChange={(event) =>
                      void updateDailyReminder(event.target.checked)
                    }
                  />
                  <span>Daily recording reminder</span>
                </label>
                <label>
                  <span>Reminder time</span>
                  <input
                    type="time"
                    value={reminderSettings.dailyTime}
                    onChange={(event) =>
                      updateReminderTime(event.target.value)
                    }
                  />
                </label>
                <div className="utility-actions">
                  <button
                    className="secondary-button"
                    onClick={() => void requestReminderPermission()}
                  >
                    Enable notifications
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => void sendTestReminder()}
                  >
                    Send test
                  </button>
                </div>
                <div className="privacy-status-list">
                  <span>Permission: {notificationPermission}</span>
                </div>
                {reminderStatus ? (
                  <p className="utility-status" role="status">
                    {reminderStatus}
                  </p>
                ) : null}
              </div>
              {siaStatus ? (
                <p className="utility-status" role="status">
                  {siaStatus}
                </p>
              ) : null}
            </article>
          ) : null}

          {activeMenuPanel === 'storage' ? (
            <article className="utility-card">
              <div className="section-heading">
                <h2>Storage & restore</h2>
                <p className="panel-copy">
                  Recording changes sync to Sia automatically. Use these
                  controls only when you need a manual export or restore.
                </p>
              </div>
              <div className="privacy-status-list">
                <span>Sia: Connected</span>
                <span>
                  Latest snapshot:{' '}
                  {latestSiaBackup
                    ? new Date(latestSiaBackup.uploadedAt).toLocaleDateString()
                    : 'None'}
                </span>
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
                  Restore file
                </button>
                <button
                  className="secondary-button"
                  disabled={isSiaBusy || isSiaSyncing}
                  onClick={() => void restoreCloudBackup()}
                >
                  Restore from Sia
                </button>
                <input
                  ref={backupInputRef}
                  className="file-input"
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) =>
                    void importBackup(event.target.files?.[0])
                  }
                />
              </div>
              {latestSiaBackup ? (
                <p className="utility-status">
                  Latest Sia object: <code>{latestSiaBackup.objectId}</code>
                </p>
              ) : null}
              {backupStatus ? (
                <p className="utility-status" role="status">
                  {backupStatus}
                </p>
              ) : null}
              {siaStatus ? (
                <p className="utility-status" role="status">
                  {siaStatus}
                </p>
              ) : null}
            </article>
          ) : null}

          {activeMenuPanel === 'privacy' ? (
            <article className="utility-card">
              <div className="section-heading">
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
                    onChange={(event) =>
                      setSetupPasscodeValue(event.target.value)
                    }
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
          ) : null}
          </aside>
        </div>
      ) : null}

      <section className="memo-toolbar" aria-label="Memo search">
        <div className="section-heading">
          <p className="eyebrow">Library</p>
          <h2>Your memos</h2>
        </div>
        <label>
          <span className="sr-only">Search memos</span>
          <input
            type="search"
            placeholder="Search titles, moods, or notes"
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
              series: memo.series,
              notes: memo.notes,
            };
            const hasChanges =
              draft.title !== memo.title ||
              draft.series !== memo.series ||
              draft.notes !== memo.notes;

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

                <div className="mood-picker">
                  <span>Mood tag</span>
                  <div className="mood-chip-row" role="list">
                    {moodTags.map((mood) => (
                      <button
                        className={`mood-chip ${
                          draft.series === mood ? 'mood-chip-selected' : ''
                        }`}
                        key={mood}
                        type="button"
                        onClick={() =>
                          updateDraft(
                            memo.id,
                            'series',
                            draft.series === mood ? '' : mood,
                          )
                        }
                      >
                        {mood}
                      </button>
                    ))}
                  </div>
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
                  {memo.series ? <span>{memo.series}</span> : null}
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
