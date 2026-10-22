// The memory twin's "server": the rows of every platform table, the stored objects (bytes) and the mail it sent.
// Several MemoryBackends (browsers, tabs, devices) can share one store, each with its own session. Every write runs
// inside mutate(), which is atomic (rolled back when the operation throws, like a SQL transaction) and, when
// persistence is on, saved to localStorage under "viscera.platform.memory.v1" so the offline UI suite survives
// reloads. Object bytes are kept in memory and, when persisting, in an IndexedDB blob store.

import type { BlobCache } from "../blobCache";
import type { Asset, AssetStatus, IdentityProvider, ImportedObject, IsoDate, LibraryFileRole, LibraryItem, Plan, Profile, Project, ProjectVersion, Uuid } from "../types";

export interface MemoryMail {
  to: string;
  kind: "email_code" | "recovery" | "confirmation";
  /** The 6-digit code (email_code) or the token of the emailed link (recovery, confirmation). */
  code: string;
  sentAt: IsoDate;
}

export const MEMORY_STORAGE_KEY = "viscera.platform.memory.v1";
export const MEMORY_OBJECTS_DB = "viscera-platform-memory-objects";
const FORMAT = "viscera.platform.memory";

export interface MemoryUserRow {
  id: Uuid;
  /** Lower case. */
  email: string;
  passwordSalt: string;
  /** null for accounts made by an email code or a (simulated) OAuth provider. */
  passwordHash: string | null;
  emailConfirmedAt: IsoDate | null;
  providers: IdentityProvider[];
  createdAt: IsoDate;
  lastSignInAt: IsoDate | null;
  /** Incremented by "sign out everywhere": sessions carrying an older epoch end. */
  sessionEpoch: number;
}

/**
 * assets.status: "deleting" while the maintenance job removes an orphan's object (reserve answers asset_busy),
 * "rejected" after confirm found the stored object's size wrong (the next reserve reopens it). Clients only ever see
 * pending and ready rows.
 */
export type MemoryAssetStatus = AssetStatus | "deleting" | "rejected";

export interface MemoryAssetRow extends Omit<Asset, "status"> {
  status: MemoryAssetStatus;
  ownerId: Uuid;
  lastUsedAt: IsoDate;
  readyAt: IsoDate | null;
}

export interface MemoryObjectRow {
  path: string;
  byteSize: number;
  mimeType: string;
  createdAt: IsoDate;
}

export interface MemoryProjectRow extends Project {
  ownerId: Uuid;
  /** projects.draft_lab_schema_version / draft_app_build: what the lab reported with the draft (a restore keeps the
   *  draft as a version with them). Absent in rows persisted before they existed. */
  draftLabSchemaVersion?: number | null;
  draftAppBuild?: string | null;
}

export interface MemoryVersionRow extends ProjectVersion {
  ownerId: Uuid;
}

/** project_version_assets (parentId = version) and project_draft_assets (parentId = project). */
export interface MemoryAttachmentRow {
  parentId: Uuid;
  ownerId: Uuid;
  name: string;
  assetId: Uuid;
}

export interface MemoryLibraryRow extends Omit<LibraryItem, "files"> {
  ownerId: Uuid;
}

export interface MemoryLibraryFileRow {
  itemId: Uuid;
  ownerId: Uuid;
  filename: string;
  assetId: Uuid;
  role: LibraryFileRole;
  position: number;
}

export interface MemoryImportRow extends ImportedObject {
  ownerId: Uuid;
}

export interface MemoryCodeRow {
  email: string;
  kind: "email_code" | "recovery";
  code: string;
  sentAt: number;
  expiresAt: number;
  /** An email code may create the account it signs in to (signInWithOtp shouldCreateUser). */
  createUser: boolean;
}

/** A signed-in session of one client (kept by that client's MemoryAuth, not in the shared rows). */
export interface MemorySessionRow {
  userId: Uuid;
  epoch: number;
  issuedAt: number;
}

export interface MemoryState {
  format: typeof FORMAT;
  version: 1;
  plans: Plan[];
  users: MemoryUserRow[];
  profiles: Profile[];
  assets: MemoryAssetRow[];
  objects: MemoryObjectRow[];
  projects: MemoryProjectRow[];
  versions: MemoryVersionRow[];
  versionAssets: MemoryAttachmentRow[];
  draftAssets: MemoryAttachmentRow[];
  libraryItems: MemoryLibraryRow[];
  libraryFiles: MemoryLibraryFileRow[];
  imports: MemoryImportRow[];
  codes: MemoryCodeRow[];
}

/** The subset of the Web Storage API the twin needs (localStorage, or a stand-in in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function emptyMemoryState(plans: readonly Plan[]): MemoryState {
  return {
    format: FORMAT,
    version: 1,
    plans: plans.map((plan) => ({ ...plan })),
    users: [],
    profiles: [],
    assets: [],
    objects: [],
    projects: [],
    versions: [],
    versionAssets: [],
    draftAssets: [],
    libraryItems: [],
    libraryFiles: [],
    imports: [],
    codes: [],
  };
}

const TABLES = [
  "users", "profiles", "assets", "objects", "projects", "versions", "versionAssets", "draftAssets", "libraryItems",
  "libraryFiles", "imports", "codes",
] as const;

function parseState(text: string | null): MemoryState | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    const state = parsed as Partial<MemoryState>;
    if (state.format !== FORMAT || state.version !== 1 || !Array.isArray(state.plans)) return null;
    for (const table of TABLES) if (!Array.isArray(state[table])) return null;
    return state as MemoryState;
  } catch {
    return null;
  }
}

/** Deterministic UUIDs for tests: 00000000-0000-4000-8000-000000000001, …002, … */
export function sequentialIds(start = 1): () => Uuid {
  let next = start;
  return () => `00000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`;
}

/** A clock that advances by `stepMs` on every reading, so no two rows share a timestamp. */
export function steppingClock(startIso = "2026-01-01T00:00:00.000Z", stepMs = 1000): () => number {
  let current = Date.parse(startIso);
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

function randomId(): Uuid {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface MemoryStoreOptions {
  plans: readonly Plan[];
  now?: () => number;
  ids?: () => Uuid;
  /** Where to persist rows (null = keep them in memory only). */
  storage?: StorageLike | null;
  storageKey?: string;
  /** Persistent object bytes (null = memory only). */
  objects?: BlobCache | null;
}

export class MemoryStore {
  state: MemoryState;
  /** Every email sent, oldest first (not persisted). */
  readonly outbox: MemoryMail[] = [];
  /**
   * A simulated maintenance run in progress: after this many asset_busy answers the collection finishes on its own
   * (null = only an explicit finish does). Not persisted.
   */
  collectionFinishesAfterBusyAnswers: number | null = null;
  private readonly bytes = new Map<string, Blob>();
  private readonly clock: () => number;
  private readonly ids: () => Uuid;
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly objectCache: BlobCache | null;

  constructor(options: MemoryStoreOptions) {
    this.clock = options.now ?? Date.now;
    this.ids = options.ids ?? randomId;
    this.storage = options.storage ?? null;
    this.storageKey = options.storageKey ?? MEMORY_STORAGE_KEY;
    this.objectCache = options.objects ?? null;
    let restored: MemoryState | null = null;
    if (this.storage) {
      try {
        restored = parseState(this.storage.getItem(this.storageKey));
      } catch {
        restored = null;
      }
    }
    this.state = restored ?? emptyMemoryState(options.plans);
  }

  now(): number {
    return this.clock();
  }

  timestamp(): IsoDate {
    return new Date(this.clock()).toISOString();
  }

  newId(): Uuid {
    return this.ids();
  }

  /** Runs a write atomically: on error every row is restored, like a rolled-back transaction. */
  mutate<T>(operation: (state: MemoryState) => T): T {
    const before = structuredClone(this.state);
    try {
      const result = operation(this.state);
      this.persist();
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  read<T>(operation: (state: MemoryState) => T): T {
    return operation(this.state);
  }

  persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // storage full or unavailable: the twin keeps working in memory
    }
  }

  /** The session a persisted client left behind (null without persistence). */
  loadSession(): MemorySessionRow | null {
    if (!this.storage) return null;
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(`${this.storageKey}.session`) ?? "null");
      if (parsed === null || typeof parsed !== "object") return null;
      const row = parsed as Partial<MemorySessionRow>;
      return typeof row.userId === "string" && typeof row.epoch === "number" && typeof row.issuedAt === "number"
        ? { userId: row.userId, epoch: row.epoch, issuedAt: row.issuedAt }
        : null;
    } catch {
      return null;
    }
  }

  saveSession(session: MemorySessionRow | null): void {
    if (!this.storage) return;
    try {
      if (session) this.storage.setItem(`${this.storageKey}.session`, JSON.stringify(session));
      else this.storage.removeItem(`${this.storageKey}.session`);
    } catch {
      // the session then lasts until the page closes
    }
  }

  async putObject(path: string, blob: Blob): Promise<void> {
    this.bytes.set(path, blob);
    if (this.objectCache) await this.objectCache.put(path, blob);
  }

  async getObject(path: string): Promise<Blob | null> {
    const blob = this.bytes.get(path);
    if (blob) return blob;
    if (!this.objectCache) return null;
    const stored = await this.objectCache.get(path);
    if (stored) this.bytes.set(path, stored);
    return stored;
  }

  async deleteObjects(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      this.bytes.delete(path);
      if (this.objectCache) await this.objectCache.delete(path);
    }
  }

  /** Forget every row and object (and the persisted copy). */
  async clear(plans: readonly Plan[]): Promise<void> {
    this.state = emptyMemoryState(plans);
    this.outbox.length = 0;
    this.bytes.clear();
    if (this.objectCache) await this.objectCache.clear();
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey);
        this.storage.removeItem(`${this.storageKey}.session`);
      } catch {
        // nothing to remove
      }
    }
  }
}
