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
can only be restored if the user previously exported a Murmur backup and saved
it somewhere safe, such as cloud storage.

The app lock protects casual access to Murmur in the current browser with a
passcode and, where supported, the device's platform biometric prompt. A future
account/cloud sync backend would be required for automatic cross-device restore.