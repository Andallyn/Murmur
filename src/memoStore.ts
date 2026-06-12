import type { VoiceMemo } from './types';
import { sortMemosByNewest } from './memoUtils';

const DATABASE_NAME = 'murmur-voice-memos';
const DATABASE_VERSION = 1;
const STORE_NAME = 'memos';

function ensureIndexedDb(): IDBFactory {
  if (!window.indexedDB) {
    throw new Error('IndexedDB is not available in this browser.');
  }

  return window.indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = ensureIndexedDb().open(DATABASE_NAME, DATABASE_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    return await promisifyRequest(callback(store));
  } finally {
    database.close();
  }
}

export async function getAllMemos(): Promise<VoiceMemo[]> {
  const memos = await withStore('readonly', (store) =>
    store.getAll(),
  );

  return sortMemosByNewest(memos);
}

export async function saveMemo(memo: VoiceMemo): Promise<VoiceMemo> {
  await withStore('readwrite', (store) => store.put(memo));

  return memo;
}

export async function updateMemo(
  id: string,
  updates: Pick<VoiceMemo, 'title' | 'notes'>,
): Promise<VoiceMemo> {
  const currentMemo = await withStore('readonly', (store) =>
    store.get(id),
  );

  if (!currentMemo) {
    throw new Error('Memo not found.');
  }

  const updatedMemo = {
    ...currentMemo,
    ...updates,
  };

  await saveMemo(updatedMemo);

  return updatedMemo;
}

export async function deleteMemo(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}
