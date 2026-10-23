import { apiUrl } from "../api";

export type AccountDeployment = "browser-local" | "server";

export type SavedItemKind =
  | "tissue-material"
  | "studio-project"
  | "blood-simulation"
  | "adipose-study"
  | "workspace-snapshot";

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface SavedWorkspaceItemMeta {
  id: string;
  userId: string;
  title: string;
  kind: SavedItemKind;
  summary: string;
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedWorkspaceItem extends SavedWorkspaceItemMeta {
  payload: Record<string, unknown>;
}

export interface SaveWorkspaceInput {
  title: string;
  kind: SavedItemKind;
  summary: string;
  payload: Record<string, unknown>;
}

const DB_NAME = "viscera-accounts-v1";
const DB_VERSION = 1;
const SESSION_STORAGE_KEY = "viscera.account.session.v1";
const SERVER_TOKEN_STORAGE_KEY = "viscera.account.serverToken.v1";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PBKDF2_ITERATIONS = 100_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

interface StoredUserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
}

interface StoredSessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface StoredItemRecord extends SavedWorkspaceItemMeta {
  payloadJson: string;
}

// Fallback in-memory stores when localStorage or IndexedDB is unavailable
let memorySessionToken: string | null = null;
let memoryServerToken: string | null = null;
const memoryUsers = new Map<string, StoredUserRecord>();
const memorySessions = new Map<string, StoredSessionRecord>();
const memoryItems = new Map<string, StoredItemRecord>();

function readSessionToken(key = SESSION_STORAGE_KEY): string | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const value = window.localStorage.getItem(key);
      if (value) return value;
    }
  } catch {
    /* localStorage blocked */
  }
  return key === SERVER_TOKEN_STORAGE_KEY ? memoryServerToken : memorySessionToken;
}

function writeSessionToken(token: string | null, key = SESSION_STORAGE_KEY): void {
  if (key === SERVER_TOKEN_STORAGE_KEY) memoryServerToken = token;
  else memorySessionToken = token;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      if (token) window.localStorage.setItem(key, token);
      else window.localStorage.removeItem(key);
    }
  } catch {
    /* localStorage blocked */
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const saltBytes = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function validateEmail(email: string): string {
  const cleaned = email.trim().toLowerCase();
  if (!cleaned || cleaned.length > 254 || !EMAIL_RE.test(cleaned)) {
    throw new Error("Enter a valid email address.");
  }
  return cleaned;
}

export function validateName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) {
    throw new Error("Enter your name to create an account.");
  }
  if (cleaned.length > 120) {
    throw new Error("Name must be 120 characters or fewer.");
  }
  return cleaned;
}

export function validatePassword(password: string): string {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (password.length > 256) {
    throw new Error("Password must be 256 characters or fewer.");
  }
  return password;
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

async function openAccountDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("users")) {
        const users = db.createObjectStore("users", { keyPath: "id" });
        users.createIndex("by_email", "email", { unique: true });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "tokenHash" });
        sessions.createIndex("by_user", "userId", { unique: false });
      }
      if (!db.objectStoreNames.contains("items")) {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("by_user", "userId", { unique: false });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Cannot open browser account storage."));
    request.onblocked = () => reject(new Error("Account storage is busy in another tab."));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Account database request failed."));
  });
}

async function withDb<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openAccountDb();
  try {
    const tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Account storage transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Account storage transaction was aborted."));
    });
    const result = await work(tx);
    await done;
    return result;
  } finally {
    db.close();
  }
}

function toPublicUser(record: StoredUserRecord): AccountUser {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    createdAt: record.createdAt,
  };
}

function toItemMeta(record: StoredItemRecord): SavedWorkspaceItemMeta {
  return {
    id: record.id,
    userId: record.userId,
    title: record.title,
    kind: record.kind,
    summary: record.summary,
    bytes: record.bytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ============================================================================
// Browser-Local Account & Storage Engine (IndexedDB + WebCrypto PBKDF2)
// ============================================================================

async function createLocalSession(userId: string): Promise<string> {
  const token = `vsc_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 86400 * 1000);
  const session: StoredSessionRecord = {
    tokenHash,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  if (hasIndexedDb()) {
    await withDb(["sessions"], "readwrite", async (tx) => {
      await idbReq(tx.objectStore("sessions").put(session));
    });
  } else {
    memorySessions.set(tokenHash, session);
  }
  writeSessionToken(token, SESSION_STORAGE_KEY);
  return token;
}

export async function localCurrentUser(): Promise<AccountUser | null> {
  const token = readSessionToken(SESSION_STORAGE_KEY);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();

  if (hasIndexedDb()) {
    return withDb(["sessions", "users"], "readwrite", async (tx) => {
      const session = (await idbReq(
        tx.objectStore("sessions").get(tokenHash),
      )) as StoredSessionRecord | undefined;
      if (!session) {
        writeSessionToken(null, SESSION_STORAGE_KEY);
        return null;
      }
      if (session.expiresAt <= nowIso) {
        await idbReq(tx.objectStore("sessions").delete(tokenHash));
        writeSessionToken(null, SESSION_STORAGE_KEY);
        return null;
      }
      const user = (await idbReq(
        tx.objectStore("users").get(session.userId),
      )) as StoredUserRecord | undefined;
      if (!user) {
        await idbReq(tx.objectStore("sessions").delete(tokenHash));
        writeSessionToken(null, SESSION_STORAGE_KEY);
        return null;
      }
      return toPublicUser(user);
    });
  }

  const session = memorySessions.get(tokenHash);
  if (!session || session.expiresAt <= nowIso) {
    memorySessions.delete(tokenHash);
    writeSessionToken(null, SESSION_STORAGE_KEY);
    return null;
  }
  const user = memoryUsers.get(session.userId);
  if (!user) {
    memorySessions.delete(tokenHash);
    writeSessionToken(null, SESSION_STORAGE_KEY);
    return null;
  }
  return toPublicUser(user);
}

export async function localRegister(
  email: string,
  name: string,
  password: string,
): Promise<AccountUser> {
  const cleanEmail = validateEmail(email);
  const cleanName = validateName(name);
  const validPw = validatePassword(password);
  const saltHex = randomHex(16);
  const passwordHash = await hashPassword(validPw, saltHex);
  const userRecord: StoredUserRecord = {
    id: `usr_${randomHex(12)}`,
    email: cleanEmail,
    name: cleanName,
    passwordHash,
    passwordSalt: saltHex,
    createdAt: new Date().toISOString(),
  };

  if (hasIndexedDb()) {
    await withDb(["users"], "readwrite", async (tx) => {
      const store = tx.objectStore("users");
      const existing = (await idbReq(
        store.index("by_email").get(cleanEmail),
      )) as StoredUserRecord | undefined;
      if (existing) {
        throw new Error("An account with this email already exists.");
      }
      await idbReq(store.add(userRecord));
    });
  } else {
    for (const u of memoryUsers.values()) {
      if (u.email === cleanEmail) {
        throw new Error("An account with this email already exists.");
      }
    }
    memoryUsers.set(userRecord.id, userRecord);
  }

  await createLocalSession(userRecord.id);
  return toPublicUser(userRecord);
}

export async function localLogin(email: string, password: string): Promise<AccountUser> {
  const cleanEmail = validateEmail(email);
  if (!password) {
    throw new Error("Invalid email or password.");
  }

  let userRecord: StoredUserRecord | undefined;
  if (hasIndexedDb()) {
    userRecord = await withDb(["users"], "readonly", async (tx) => {
      return (await idbReq(
        tx.objectStore("users").index("by_email").get(cleanEmail),
      )) as StoredUserRecord | undefined;
    });
  } else {
    for (const u of memoryUsers.values()) {
      if (u.email === cleanEmail) {
        userRecord = u;
        break;
      }
    }
  }

  if (!userRecord) {
    await hashPassword(password.slice(0, 256), "0123456789abcdef0123456789abcdef");
    throw new Error("Invalid email or password.");
  }

  const candidateHash = await hashPassword(password.slice(0, 256), userRecord.passwordSalt);
  if (!timingSafeHexEqual(candidateHash, userRecord.passwordHash)) {
    throw new Error("Invalid email or password.");
  }

  await createLocalSession(userRecord.id);
  return toPublicUser(userRecord);
}

export async function localLogout(): Promise<void> {
  const token = readSessionToken(SESSION_STORAGE_KEY);
  writeSessionToken(null, SESSION_STORAGE_KEY);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  if (hasIndexedDb()) {
    await withDb(["sessions"], "readwrite", async (tx) => {
      await idbReq(tx.objectStore("sessions").delete(tokenHash));
    });
  } else {
    memorySessions.delete(tokenHash);
  }
}

export async function localDeleteAccount(): Promise<void> {
  const user = await localCurrentUser();
  if (!user) throw new Error("Sign in to delete your account.");

  if (hasIndexedDb()) {
    await withDb(["users", "sessions", "items"], "readwrite", async (tx) => {
      await idbReq(tx.objectStore("users").delete(user.id));

      const sessionStore = tx.objectStore("sessions");
      const userSessions = (await idbReq(
        sessionStore.index("by_user").getAllKeys(user.id),
      )) as IDBValidKey[];
      for (const key of userSessions) {
        await idbReq(sessionStore.delete(key));
      }

      const itemStore = tx.objectStore("items");
      const userItems = (await idbReq(
        itemStore.index("by_user").getAllKeys(user.id),
      )) as IDBValidKey[];
      for (const key of userItems) {
        await idbReq(itemStore.delete(key));
      }
    });
  } else {
    memoryUsers.delete(user.id);
    for (const [k, s] of memorySessions.entries()) {
      if (s.userId === user.id) memorySessions.delete(k);
    }
    for (const [k, item] of memoryItems.entries()) {
      if (item.userId === user.id) memoryItems.delete(k);
    }
  }
  writeSessionToken(null, SESSION_STORAGE_KEY);
}

export async function localSaveItem(input: SaveWorkspaceInput): Promise<SavedWorkspaceItem> {
  const user = await localCurrentUser();
  if (!user) throw new Error("Sign in to save items to your account.");

  const cleanTitle = input.title.trim();
  if (!cleanTitle) throw new Error("Enter a title before saving to your account.");
  if (cleanTitle.length > 160) throw new Error("Saved item title must be 160 characters or fewer.");

  const cleanSummary = input.summary.trim().slice(0, 400);
  const payloadJson = JSON.stringify(input.payload);
  const bytes = new TextEncoder().encode(payloadJson).byteLength;
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error("Saved item exceeds the 16 MiB account storage limit.");
  }

  const now = new Date().toISOString();
  const record: StoredItemRecord = {
    id: `item_${randomHex(12)}`,
    userId: user.id,
    title: cleanTitle,
    kind: input.kind,
    summary: cleanSummary,
    bytes,
    payloadJson,
    createdAt: now,
    updatedAt: now,
  };

  if (hasIndexedDb()) {
    await withDb(["items"], "readwrite", async (tx) => {
      await idbReq(tx.objectStore("items").add(record));
    });
  } else {
    memoryItems.set(record.id, record);
  }

  return {
    ...toItemMeta(record),
    payload: JSON.parse(payloadJson) as Record<string, unknown>,
  };
}

export async function localListItems(): Promise<SavedWorkspaceItemMeta[]> {
  const user = await localCurrentUser();
  if (!user) throw new Error("Sign in to access your saved items.");

  let records: StoredItemRecord[];
  if (hasIndexedDb()) {
    records = await withDb(["items"], "readonly", async (tx) => {
      return (await idbReq(
        tx.objectStore("items").index("by_user").getAll(user.id),
      )) as StoredItemRecord[];
    });
  } else {
    records = [...memoryItems.values()].filter((r) => r.userId === user.id);
  }

  return records
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .map(toItemMeta);
}

export async function localGetItem(itemId: string): Promise<SavedWorkspaceItem> {
  const user = await localCurrentUser();
  if (!user) throw new Error("Sign in to access your saved items.");

  let record: StoredItemRecord | undefined;
  if (hasIndexedDb()) {
    record = await withDb(["items"], "readonly", async (tx) => {
      return (await idbReq(tx.objectStore("items").get(itemId))) as StoredItemRecord | undefined;
    });
  } else {
    record = memoryItems.get(itemId);
  }

  if (!record || record.userId !== user.id) {
    throw new Error("Saved item not found.");
  }

  return {
    ...toItemMeta(record),
    payload: JSON.parse(record.payloadJson) as Record<string, unknown>,
  };
}

export async function localDeleteItem(itemId: string): Promise<void> {
  const user = await localCurrentUser();
  if (!user) throw new Error("Sign in to access your saved items.");

  if (hasIndexedDb()) {
    await withDb(["items"], "readwrite", async (tx) => {
      const store = tx.objectStore("items");
      const existing = (await idbReq(store.get(itemId))) as StoredItemRecord | undefined;
      if (!existing || existing.userId !== user.id) {
        throw new Error("Saved item not found.");
      }
      await idbReq(store.delete(itemId));
    });
  } else {
    const existing = memoryItems.get(itemId);
    if (!existing || existing.userId !== user.id) {
      throw new Error("Saved item not found.");
    }
    memoryItems.delete(itemId);
  }
}

export async function clearAllLocalAccountDataForTests(): Promise<void> {
  writeSessionToken(null, SESSION_STORAGE_KEY);
  writeSessionToken(null, SERVER_TOKEN_STORAGE_KEY);
  memoryUsers.clear();
  memorySessions.clear();
  memoryItems.clear();
  if (hasIndexedDb()) {
    await withDb(["users", "sessions", "items"], "readwrite", async (tx) => {
      await idbReq(tx.objectStore("users").clear());
      await idbReq(tx.objectStore("sessions").clear());
      await idbReq(tx.objectStore("items").clear());
    });
  }
}

// ============================================================================
// Unified Account Client (Browser-Local IndexedDB + Optional FastAPI Server)
// ============================================================================

async function serverRequest<T>(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = readSessionToken(SERVER_TOKEN_STORAGE_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(apiUrl(`/api/account${path}`), {
    method,
    headers,
    credentials: "include",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json().catch(() => null)) as
    | ({ ok?: boolean; error?: string; detail?: string } & T)
    | null;
  if (!response.ok || !data || data.ok === false) {
    if (response.status === 401) writeSessionToken(null, SERVER_TOKEN_STORAGE_KEY);
    throw new Error(data?.error || data?.detail || `Account request failed (${response.status}).`);
  }
  return data;
}

export function createAccountClient(mode: AccountDeployment = "browser-local") {
  if (mode === "server") {
    return {
      mode: "server" as const,
      async currentUser(signal?: AbortSignal): Promise<AccountUser | null> {
        const res = await serverRequest<{ user: AccountUser | null }>("/me", "GET", undefined, signal);
        return res.user;
      },
      async register(email: string, name: string, password: string): Promise<AccountUser> {
        const res = await serverRequest<{ user: AccountUser; sessionToken?: string }>(
          "/register",
          "POST",
          { email, name, password },
        );
        if (res.sessionToken) writeSessionToken(res.sessionToken, SERVER_TOKEN_STORAGE_KEY);
        return res.user;
      },
      async login(email: string, password: string): Promise<AccountUser> {
        const res = await serverRequest<{ user: AccountUser; sessionToken?: string }>(
          "/login",
          "POST",
          { email, password },
        );
        if (res.sessionToken) writeSessionToken(res.sessionToken, SERVER_TOKEN_STORAGE_KEY);
        return res.user;
      },
      async logout(): Promise<void> {
        try {
          await serverRequest("/logout", "POST");
        } finally {
          writeSessionToken(null, SERVER_TOKEN_STORAGE_KEY);
        }
      },
      async deleteAccount(): Promise<void> {
        await serverRequest("", "DELETE");
        writeSessionToken(null, SERVER_TOKEN_STORAGE_KEY);
      },
      async listItems(): Promise<SavedWorkspaceItemMeta[]> {
        const res = await serverRequest<{ items: SavedWorkspaceItemMeta[] }>("/items", "GET");
        return res.items;
      },
      async getItem(id: string): Promise<SavedWorkspaceItem> {
        const res = await serverRequest<{ item: SavedWorkspaceItem }>(
          `/items/${encodeURIComponent(id)}`,
          "GET",
        );
        return res.item;
      },
      async saveItem(input: SaveWorkspaceInput): Promise<SavedWorkspaceItem> {
        const res = await serverRequest<{ item: SavedWorkspaceItem }>("/items", "POST", input);
        return res.item;
      },
      async deleteItem(id: string): Promise<void> {
        await serverRequest(`/items/${encodeURIComponent(id)}`, "DELETE");
      },
    };
  }

  return {
    mode: "browser-local" as const,
    currentUser: () => localCurrentUser(),
    register: (email: string, name: string, password: string) => localRegister(email, name, password),
    login: (email: string, password: string) => localLogin(email, password),
    logout: () => localLogout(),
    deleteAccount: () => localDeleteAccount(),
    listItems: () => localListItems(),
    getItem: (id: string) => localGetItem(id),
    saveItem: (input: SaveWorkspaceInput) => localSaveItem(input),
    deleteItem: (id: string) => localDeleteItem(id),
  };
}

