import {
  AppKey,
  Builder,
  PinnedObject,
  generateRecoveryPhrase,
  initSia,
  validateRecoveryPhrase,
  type AppMetadata,
  type ObjectEvent,
  type Sdk,
} from '@siafoundation/sia-storage';
import { createBackupFile } from './backup';
import type { VoiceMemo } from './types';

const SIA_INDEXER_URL = 'https://sia.storage';
const SIA_APP_KEY_STORAGE_KEY = 'murmur.sia.appKey.v1';
const SIA_LATEST_BACKUP_KEY = 'murmur.sia.latestBackup.v1';
const MURMUR_SIA_APP_ID =
  '16beb61297fd9c60ae0097545d5964b42a297fcead349ed7941871e16c3f4129';

interface MurmurSiaMetadata {
  type: 'murmur-backup';
  version: 1;
  uploadedAt: string;
  memoCount: number;
  size: number;
}

export interface SiaBackupRecord extends MurmurSiaMetadata {
  objectId: string;
}

export interface SiaConnectionResult {
  appKeyHex: string;
  recoveryPhrase: string;
}

let activeSdk: Sdk | null = null;

function getAppMetadata(): AppMetadata {
  const origin = window.location.origin;

  return {
    appId: MURMUR_SIA_APP_ID,
    name: 'Murmur',
    description: 'Private voice memo backups on Sia decentralized storage',
    serviceUrl: origin,
    logoUrl: `${origin}/murmur-mark.svg`,
    callbackUrl: undefined,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

function saveAppKey(appKey: AppKey): string {
  const appKeyHex = bytesToHex(appKey.export());
  localStorage.setItem(SIA_APP_KEY_STORAGE_KEY, appKeyHex);

  return appKeyHex;
}

function saveLatestBackup(record: SiaBackupRecord): void {
  localStorage.setItem(SIA_LATEST_BACKUP_KEY, JSON.stringify(record));
}

function parseMetadata(objectId: string, metadata: Uint8Array): SiaBackupRecord | null {
  if (!metadata.length) {
    return null;
  }

  try {
    const parsedMetadata = JSON.parse(
      new TextDecoder().decode(metadata),
    ) as Partial<MurmurSiaMetadata>;

    if (
      parsedMetadata.type !== 'murmur-backup' ||
      parsedMetadata.version !== 1 ||
      !parsedMetadata.uploadedAt ||
      typeof parsedMetadata.memoCount !== 'number' ||
      typeof parsedMetadata.size !== 'number'
    ) {
      return null;
    }

    return {
      objectId,
      type: parsedMetadata.type,
      version: parsedMetadata.version,
      uploadedAt: parsedMetadata.uploadedAt,
      memoCount: parsedMetadata.memoCount,
      size: parsedMetadata.size,
    };
  } catch {
    return null;
  }
}

async function getConnectedSdk(): Promise<Sdk> {
  if (activeSdk) {
    return activeSdk;
  }

  const appKeyHex = localStorage.getItem(SIA_APP_KEY_STORAGE_KEY);

  if (!appKeyHex) {
    throw new Error('Connect Murmur to Sia before using cloud backups.');
  }

  await initSia();

  const builder = new Builder(SIA_INDEXER_URL, getAppMetadata());
  const sdk = await builder.connected(new AppKey(hexToBytes(appKeyHex)));

  if (!sdk) {
    localStorage.removeItem(SIA_APP_KEY_STORAGE_KEY);
    throw new Error('Sia connection expired. Please connect again.');
  }

  activeSdk = sdk;
  return sdk;
}

export function hasStoredSiaConnection(): boolean {
  return Boolean(localStorage.getItem(SIA_APP_KEY_STORAGE_KEY));
}

export function getStoredSiaBackup(): SiaBackupRecord | null {
  const storedBackup = localStorage.getItem(SIA_LATEST_BACKUP_KEY);

  return storedBackup ? (JSON.parse(storedBackup) as SiaBackupRecord) : null;
}

export async function reconnectSia(): Promise<boolean> {
  if (!hasStoredSiaConnection()) {
    return false;
  }

  await getConnectedSdk();

  return true;
}

export async function connectSia(
  recoveryPhrase: string,
  onApprovalUrl: (url: string) => void,
): Promise<SiaConnectionResult> {
  await initSia();

  const phrase = recoveryPhrase.trim() || generateRecoveryPhrase();

  validateRecoveryPhrase(phrase);

  const builder = new Builder(SIA_INDEXER_URL, getAppMetadata());
  await builder.requestConnection();
  onApprovalUrl(builder.responseUrl());
  await builder.waitForApproval();

  const sdk = await builder.register(phrase);
  activeSdk = sdk;

  return {
    appKeyHex: saveAppKey(sdk.appKey()),
    recoveryPhrase: phrase,
  };
}

export async function uploadSiaBackup(
  memos: VoiceMemo[],
): Promise<SiaBackupRecord> {
  const sdk = await getConnectedSdk();
  const backup = await createBackupFile(memos);
  const uploadedAt = new Date().toISOString();
  const metadata: MurmurSiaMetadata = {
    type: 'murmur-backup',
    version: 1,
    uploadedAt,
    memoCount: memos.length,
    size: backup.size,
  };
  const object = await sdk.upload(new PinnedObject(), backup.stream(), {
    maxInflight: 10,
  });

  object.updateMetadata(
    new TextEncoder().encode(JSON.stringify(metadata, null, 2)),
  );
  await sdk.pinObject(object);
  await sdk.updateObjectMetadata(object);

  const record: SiaBackupRecord = {
    objectId: object.id(),
    ...metadata,
  };

  saveLatestBackup(record);

  return record;
}

export async function listSiaBackups(): Promise<SiaBackupRecord[]> {
  const sdk = await getConnectedSdk();
  const events = await sdk.objectEvents(null, 100);
  const records = events
    .filter((event: ObjectEvent) => !event.deleted && event.object)
    .map((event) => parseMetadata(event.id, event.object?.metadata() ?? new Uint8Array()))
    .filter((record): record is SiaBackupRecord => Boolean(record))
    .sort(
      (left, right) =>
        new Date(right.uploadedAt).getTime() -
        new Date(left.uploadedAt).getTime(),
    );

  const storedBackup = getStoredSiaBackup();

  if (
    storedBackup &&
    !records.some((record) => record.objectId === storedBackup.objectId)
  ) {
    records.push(storedBackup);
  }

  return records;
}

export async function downloadSiaBackup(objectId: string): Promise<File> {
  const sdk = await getConnectedSdk();
  const object = await sdk.object(objectId);
  const stream = sdk.download(object);
  const blob = await new Response(stream).blob();

  return new File([blob], 'murmur-sia-backup.json', {
    type: 'application/json',
  });
}

export function clearSiaConnection(): void {
  activeSdk = null;
  localStorage.removeItem(SIA_APP_KEY_STORAGE_KEY);
}
