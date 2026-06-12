# Murmur

Murmur is a private, browser-based voice memo recorder. It lets you instantly
capture recordings, name them afterward, tag them with expressive moods, replay
saved audio, add searchable notes, and restore backed-up snapshots on a new
device.

## Features

- Record, pause, resume, and save voice memos with the MediaRecorder API
- Require storage setup before recording
- Automatically sync recording snapshots for restore
- Start recording instantly from a large mic-first capture screen
- Name recordings after capture and tag them with emoji moods
- Store a local working copy in IndexedDB for fast playback
- Search across memo titles, moods, and notes
- Browse memos in compact date-grouped cards with relative timestamps
- Edit memo details after recording
- Replay and export individual audio files
- Set browser notifications for daily recording reminders
- Warn users when leaving with an unsaved recording in progress
- Export and restore a Murmur backup file for device replacement
- Add a local app lock with passcode and supported device biometrics

## Getting started

```bash
npm install
npm run dev
```

## Scripts

- `npm run dev` - start the Vite dev server
- `npm run build` - type-check and build for production
- `npm run lint` - run ESLint
- `npm test` - run the Vitest suite

## Recovery and privacy

Murmur requires storage setup before the recorder is available. Recordings
keep a local IndexedDB working copy for playback, and each create/edit/delete
operation updates a backup snapshot so the library can be restored on a
replacement device.

Users must save the recovery phrase shown during setup; without it, a
replacement device cannot recover the same storage identity.

The app lock protects casual access to Murmur in the current browser with a
passcode and, where supported, the device's platform biometric prompt. A future
account/cloud sync backend would be required for fully automatic cross-device
restore without a user-managed recovery phrase.

## Reminders

Murmur can request browser notification permission from Settings. When enabled,
daily recording reminders are scheduled while the app is available in the
browser. Reminder notifications rotate suggested series ideas such as daily
affirmations, to-do lists, gratitude logs, idea journals, mood check-ins, meeting
recaps, and voice diaries. If a recording is active or paused and the user
backgrounds or closes the page before saving, Murmur sends an
unfinished-recording reminder and asks the browser to confirm before leaving.

Browser notifications depend on the user's permission and platform behavior;
fully reliable closed-app reminders would require a push notification service.