const NAME = "viscera-tissue-appearance-v1";
const STORE = "models";

/** A single optional browser-local model; no upload, credential or remote fetch. */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error ?? new Error("Cannot open local model storage"));
    request.onblocked = () => reject(new Error("Local model storage is busy in another tab"));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    let result: T;
    const transaction = db.transaction(STORE, mode), request = action(transaction.objectStore(STORE));
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? request.error ?? new Error("Local model storage failed")); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Local model storage was cancelled")); };
  });
}
export const readStoredAppearance = () => transact<string | undefined>("readonly", store => store.get("active"));
export const storeAppearance = (source: string) => transact("readwrite", store => store.put(source, "active"));
export const removeStoredAppearance = () => transact("readwrite", store => store.delete("active"));
