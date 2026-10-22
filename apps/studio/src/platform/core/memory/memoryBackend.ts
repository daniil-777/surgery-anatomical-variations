// MemoryBackend: the in-memory twin of the Supabase backend (DESIGN.md D12). Same ports, same rules, same error codes,
// no network: unit tests, the backend contract suite and the offline UI suite (platform.json { backend: "memory" })
// run against it. Ids and the clock are injectable for deterministic tests. Several backends can share one server
// (`new MemoryBackend({ server: other.server })`): separate sessions — browsers, tabs, devices — over the same rows.
// Persistence (localStorage rows + IndexedDB bytes + this client's session) is off unless asked for, and on for the
// browser configuration so e2e state survives reloads.

import { createAssetPort, type PlatformAssetPort } from "../assets";
import { createBlobCache, createMemoryBlobCache, type BlobCache } from "../blobCache";
import { DEFAULT_PROVIDERS, type MemoryPlatformConfig, type PlatformProviders } from "../config";
import { platformError } from "../errors";
import type { AccountPort, ImportPort, LibraryPort, OAuthProvider, Plan, PlatformBackend, ProjectPort, Session, Uuid } from "../types";
import { MemoryAuth, randomSixDigitCode } from "./memoryAuth";
import { finishAssetCollection, markAssetsDeleting, MemoryAccount, MemoryImports, MemoryLibrary, MemoryProjects, MemoryTransport } from "./memoryData";
import { MEMORY_OBJECTS_DB, MEMORY_STORAGE_KEY, MemoryStore, type MemoryMail, type StorageLike } from "./memoryStore";
import { DEFAULT_PLANS } from "./rules";

export interface MemoryPersistence {
  /** Rows and the session (default: localStorage when it is usable). */
  storage?: StorageLike | null;
  key?: string;
  /** Object bytes (default: IndexedDB "viscera-platform-memory-objects" when available, else memory). */
  objects?: BlobCache | null;
}

export interface MemoryBackendOptions {
  /** Share the rows of another backend (another client of the same server). Plans, ids, clock and row persistence
   *  then come from that server. */
  server?: MemoryStore;
  now?: () => number;
  ids?: () => Uuid;
  /** 6-digit email codes (default: random). */
  codes?: () => string;
  plans?: readonly Plan[];
  /** false (default) keeps everything in memory; true persists to localStorage + IndexedDB. */
  persist?: boolean | MemoryPersistence;
  providers?: Partial<PlatformProviders>;
  /** Mail reaches people (platform.json emailDelivery); false refuses codes and resets like the shell hides them. */
  emailDelivery?: boolean;
  emailConfirmation?: boolean;
  /** "simulate" (default) signs in with a stand-in identity instead of navigating to the provider. */
  oauth?: "simulate" | "disabled";
  oauthEmail?: (provider: OAuthProvider) => string;
  /** Receives every email this client causes (codes, recovery and confirmation links). */
  mailbox?: (mail: MemoryMail) => void;
  minPasswordLength?: number;
  /** Artificial latency per call, for UI suites that want to see pending states. */
  latencyMs?: number;
  /** Cache for downloaded bytes (default: in memory; the twin never needs IndexedDB for it). */
  assetCache?: BlobCache | null;
  /** Pauses before put() starts over after asset_busy (default short: nothing here takes seconds to collect). */
  busyRetryDelaysMs?: readonly number[];
}

/** Short pauses: a simulated collection finishes at once (see MemoryBackend.collectAssets). */
const MEMORY_BUSY_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80];

function usableLocalStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!storage) return null;
    const probe = "viscera.platform.memory.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export class MemoryBackend implements PlatformBackend {
  readonly kind = "memory" as const;
  readonly server: MemoryStore;
  readonly auth: MemoryAuth;
  readonly assets: PlatformAssetPort;
  readonly projects: ProjectPort;
  readonly library: LibraryPort;
  readonly imports: ImportPort;
  readonly account: AccountPort;

  private readonly plans: readonly Plan[];

  constructor(options: MemoryBackendOptions = {}) {
    let persistSession = false;
    if (options.server) {
      this.server = options.server;
      this.plans = options.server.state.plans;
      persistSession = Boolean(options.persist);
    } else {
      this.plans = options.plans ?? DEFAULT_PLANS;
      let storage: StorageLike | null = null;
      let objects: BlobCache | null = null;
      let key = MEMORY_STORAGE_KEY;
      if (options.persist) {
        const persistence: MemoryPersistence = options.persist === true ? {} : options.persist;
        storage = persistence.storage === undefined ? usableLocalStorage() : persistence.storage;
        objects = persistence.objects === undefined ? createBlobCache({ name: MEMORY_OBJECTS_DB, maxBytes: Number.POSITIVE_INFINITY }) : persistence.objects;
        key = persistence.key ?? MEMORY_STORAGE_KEY;
        persistSession = storage !== null;
      }
      const storeOptions: ConstructorParameters<typeof MemoryStore>[0] = { plans: this.plans, storage, storageKey: key, objects };
      if (options.now) storeOptions.now = options.now;
      if (options.ids) storeOptions.ids = options.ids;
      this.server = new MemoryStore(storeOptions);
    }

    const latency = options.latencyMs ?? 0;
    const delay = (): Promise<void> => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
    const authOptions: ConstructorParameters<typeof MemoryAuth>[1] = {
      providers: { ...DEFAULT_PROVIDERS, ...options.providers },
      emailDelivery: options.emailDelivery ?? true,
      emailConfirmation: options.emailConfirmation ?? false,
      oauth: options.oauth ?? "simulate",
      oauthEmail: options.oauthEmail ?? ((provider) => `${provider}.user@example.test`),
      minPasswordLength: options.minPasswordLength ?? 8,
      codes: options.codes ?? randomSixDigitCode,
      delay,
      persistSession,
    };
    if (options.mailbox) authOptions.mailbox = options.mailbox;
    this.auth = new MemoryAuth(this.server, authOptions);
    const transport = new MemoryTransport(this.server, this.auth, delay);
    this.assets = createAssetPort(transport, {
      cache: options.assetCache === undefined ? createMemoryBlobCache() : options.assetCache,
      retryDelaysMs: [],
      busyRetryDelaysMs: options.busyRetryDelaysMs ?? MEMORY_BUSY_RETRY_DELAYS_MS,
    });
    this.projects = new MemoryProjects(this.server, this.auth, delay);
    this.library = new MemoryLibrary(this.server, this.auth, delay);
    this.imports = new MemoryImports(this.server, this.auth, delay);
    this.account = new MemoryAccount(this.server, this.auth, transport, delay);
    this.auth.onChange((event) => {
      if (event === "signed_out") this.assets.reset();
    });
  }

  /** The backend for platform.json { backend: "memory" } (persistent in a browser unless persist: false). */
  static fromConfig(config: MemoryPlatformConfig, options: MemoryBackendOptions = {}): MemoryBackend {
    return new MemoryBackend({ persist: config.persist, providers: config.providers, emailDelivery: config.emailDelivery, ...options });
  }

  // test and e2e helpers -----------------------------------------------------------------------------------------------

  /** Every email the server sent, oldest first. */
  get outbox(): readonly MemoryMail[] {
    return this.server.outbox;
  }

  /** The newest 6-digit code mailed to `email` (sign-in or recovery code unless `kind` narrows it), or null. */
  latestCode(email: string, kind?: "email_code" | "recovery"): string | null {
    const to = email.trim().toLowerCase();
    for (let index = this.server.outbox.length - 1; index >= 0; index -= 1) {
      const mail = this.server.outbox[index] as MemoryMail;
      if (mail.to === to && (kind === undefined ? mail.kind !== "confirmation" : mail.kind === kind)) return mail.code;
    }
    return null;
  }

  /** Follows the newest recovery mail sent to `email` (signs in; emits "password_recovery"). */
  openRecoveryLink(email: string): Promise<Session> {
    const to = email.trim().toLowerCase();
    const mail = [...this.server.outbox].reverse().find((candidate) => candidate.to === to && candidate.kind === "recovery");
    if (!mail) return Promise.reject(platformError("not_found", { status: 404, detail: "no recovery mail" }));
    return this.auth.verifyRecoveryCode(to, mail.code);
  }

  /** Moves an account to another plan (as the operator's SQL does), e.g. a tiny plan to test quotas. */
  setPlan(userIdOrEmail: string, planId: string): void {
    this.server.mutate((state) => {
      if (!state.plans.some((plan) => plan.id === planId)) throw platformError("not_found", { status: 404, detail: "plan" });
      const target = userIdOrEmail.trim().toLowerCase();
      const user = state.users.find((candidate) => candidate.id === target || candidate.email === target);
      const profile = user ? state.profiles.find((candidate) => candidate.id === user.id) : undefined;
      if (!profile) throw platformError("not_found", { status: 404, detail: "profile" });
      profile.planId = planId;
    });
  }

  /**
   * Starts collecting assets as the maintenance job does with orphans (DESIGN.md §15.3), without its grace period:
   * the unreferenced ones become "deleting" and reserving their bytes answers asset_busy until finishCollection() —
   * or, with `finishAfterBusyAnswers`, until that many such answers were given (a run finishing while clients retry).
   * Returns the ids now being collected; referenced assets are left alone.
   */
  collectAssets(assetIds: readonly Uuid[], options: { finishAfterBusyAnswers?: number } = {}): Uuid[] {
    const marked = markAssetsDeleting(this.server, assetIds);
    const after = options.finishAfterBusyAnswers;
    if (after !== undefined) this.server.collectionFinishesAfterBusyAnswers = Math.max(1, Math.floor(after));
    return marked;
  }

  /** Finishes a collection: the objects of assets being collected are removed, then their rows. Returns their ids. */
  finishCollection(): Promise<Uuid[]> {
    return finishAssetCollection(this.server);
  }

  /** Forgets every account, row and stored byte (and the persisted copy). */
  async reset(): Promise<void> {
    await this.server.clear(this.plans);
    this.assets.reset();
  }
}
