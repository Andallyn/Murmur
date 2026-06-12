# Murmur

Murmur is a private, browser-based voice memo recorder built with Sia Foundation
as the storage partner. It lets you instantly capture recordings, name them
afterward, tag them with expressive moods, replay saved audio, add searchable
notes, and restore Sia-backed snapshots on a new device.

## Features

- Record, pause, resume, and save voice memos with the MediaRecorder API
- Require Sia storage setup before recording
- Automatically sync recording snapshots to Sia decentralized storage
- Start recording instantly from a large mic-first capture screen
- Name recordings after capture and tag them with emoji moods
- Store a local working copy in IndexedDB for fast playback
- Search across memo titles, moods, and notes
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

Murmur requires Sia storage setup before the recorder is available. Recordings
keep a local IndexedDB working copy for playback, and each create/edit/delete
operation uploads a pinned Sia backup snapshot so the library can be restored on
a replacement device.

Sia storage uses the `@siafoundation/sia-storage` SDK and the Sia indexer
approval flow. Murmur uploads its backup JSON as a pinned Sia object and stores
the Sia app key in the current browser for reconnects. Users must save the
recovery phrase shown during setup; without it, a replacement device cannot
recover the same Sia app key.

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