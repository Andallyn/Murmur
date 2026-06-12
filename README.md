# Murmur

Murmur is a private, browser-based voice memo recorder. It lets you capture
audio from your microphone, replay saved memos, add searchable notes, and export
recordings from the browser.

## Features

- Record, pause, resume, and save voice memos with the MediaRecorder API
- Store recordings locally in IndexedDB
- Search across memo titles and notes
- Edit memo details after recording
- Replay and export individual audio files
- Export and restore a Murmur backup file for device replacement
- Pin encrypted backup snapshots to Sia decentralized storage
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

Murmur is local-first: recordings live in the browser on the device where they
were captured. If that phone or computer is lost, stolen, or broken, recordings
can only be restored if the user previously exported a Murmur backup or uploaded
a backup snapshot to Sia.

Sia cloud backup uses the `@siafoundation/sia-storage` SDK and the Sia indexer
approval flow. Murmur uploads its backup JSON as a pinned Sia object and stores
the Sia app key in the current browser for reconnects. Users must save the Sia
recovery phrase shown during setup; without it, a replacement device cannot
recover the same Sia app key.

The app lock protects casual access to Murmur in the current browser with a
passcode and, where supported, the device's platform biometric prompt. A future
account/cloud sync backend would be required for fully automatic cross-device
restore without a user-managed recovery phrase.