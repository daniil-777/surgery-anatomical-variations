import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import {
  createAccountClient,
  type AccountDeployment,
  type AccountUser,
  type SavedItemKind,
  type SavedWorkspaceItemMeta,
} from "./accountStorage";
import "./account.css";

export interface AccountWorkspaceAdapter {
  kind: SavedItemKind;
  defaultTitle: string;
  summary: string;
  capture: () => Record<string, unknown>;
  restore: (payload: Record<string, unknown>) => Promise<void> | void;
}

interface AccountContextValue {
  user: AccountUser | null;
  items: SavedWorkspaceItemMeta[];
  mode: AccountDeployment;
  setMode: (mode: AccountDeployment) => void;
  adapter: AccountWorkspaceAdapter | null;
  registerAdapter: (adapter: AccountWorkspaceAdapter | null) => void;
  refresh: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue>({
  user: null,
  items: [],
  mode: "browser-local",
  setMode: () => {},
  adapter: null,
  registerAdapter: () => {},
  refresh: async () => {},
});

const KIND_LABELS: Record<SavedItemKind, string> = {
  "tissue-material": "Layered tissue",
  "studio-project": "Organ studio",
  "blood-simulation": "Blood simulation",
  "adipose-study": "Adipose study",
  "workspace-snapshot": "Workspace",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AccountDeployment>("browser-local");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [items, setItems] = useState<SavedWorkspaceItemMeta[]>([]);
  const [adapter, setAdapter] = useState<AccountWorkspaceAdapter | null>(null);
  const client = useMemo(() => createAccountClient(mode), [mode]);

  const refresh = useCallback(async () => {
    try {
      const current = await client.currentUser();
      setUser(current);
      if (current) {
        const list = await client.listItems();
        setItems(list);
      } else {
        setItems([]);
      }
    } catch {
      setUser(null);
      setItems([]);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AccountContextValue>(
    () => ({
      user,
      items,
      mode,
      setMode,
      adapter,
      registerAdapter: setAdapter,
      refresh,
    }),
    [user, items, mode, adapter, refresh],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useRegisterAccountWorkspace(adapter: AccountWorkspaceAdapter): void {
  const { registerAdapter } = useContext(AccountContext);
  const latest = useRef(adapter);
  latest.current = adapter;

  const stableAdapter = useMemo<AccountWorkspaceAdapter>(
    () => ({
      get kind() {
        return latest.current.kind;
      },
      get defaultTitle() {
        return latest.current.defaultTitle;
      },
      get summary() {
        return latest.current.summary;
      },
      capture: () => latest.current.capture(),
      restore: (payload) => latest.current.restore(payload),
    }),
    [],
  );

  useEffect(() => {
    registerAdapter(stableAdapter);
    return () => registerAdapter(null);
  }, [registerAdapter, stableAdapter]);
}

export function AccountControl() {
  const { user, items, mode, setMode, adapter, refresh } = useContext(AccountContext);
  const client = useMemo(() => createAccountClient(mode), [mode]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  const [authTab, setAuthTab] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saveTitle, setSaveTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirmDeleteItemId, setConfirmDeleteItemId] = useState<string | null>(null);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);

  const openDialog = () => {
    setError("");
    setStatus("");
    setConfirmDeleteItemId(null);
    setConfirmDeleteAccount(false);
    if (!saveTitle.trim() && adapter?.defaultTitle) {
      setSaveTitle(adapter.defaultTitle);
    }
    void refresh();
    dialogRef.current?.showModal();
  };

  const handleAuthSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const authed =
        authTab === "register"
          ? await client.register(email, name, password)
          : await client.login(email, password);
      setPassword("");
      await refresh();
      if (adapter?.defaultTitle) setSaveTitle(adapter.defaultTitle);
      setStatus(
        authTab === "register"
          ? `Account created for ${authed.name} (${authed.email}).`
          : `Signed in as ${authed.name}.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await client.logout();
      await refresh();
      setConfirmDeleteItemId(null);
      setConfirmDeleteAccount(false);
      setStatus("Signed out. Your saved items stay in your account.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const activeKind = adapter?.kind ?? "workspace-snapshot";
      const activeSummary =
        adapter?.summary ?? `VISCERA workspace (${window.location.pathname}${window.location.search})`;
      const payload = adapter
        ? adapter.capture()
        : {
            url: window.location.href,
            savedAt: new Date().toISOString(),
          };
      const titleToUse = saveTitle.trim() || adapter?.defaultTitle || "Saved VISCERA study";
      const saved = await client.saveItem({
        title: titleToUse,
        kind: activeKind,
        summary: activeSummary,
        payload,
      });
      await refresh();
      setStatus(`Saved "${saved.title}" to your account.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleLoadItem = async (itemId: string) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const fullItem = await client.getItem(itemId);
      if (adapter) {
        await adapter.restore(fullItem.payload);
      }
      setStatus(`Loaded "${fullItem.title}" into the active workspace.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleExportItem = async (itemId: string) => {
    setBusy(true);
    setError("");
    try {
      const fullItem = await client.getItem(itemId);
      const slug = fullItem.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "saved-study";
      const blob = new Blob([JSON.stringify(fullItem, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${slug}.viscera-saved.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setStatus(`Exported "${fullItem.title}".`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await client.deleteItem(itemId);
      setConfirmDeleteItemId(null);
      await refresh();
      setStatus("Deleted saved item from your account.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAccount = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await client.deleteAccount();
      setConfirmDeleteAccount(false);
      setConfirmDeleteItemId(null);
      await refresh();
      setStatus("Account and all saved items permanently deleted.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`account-trigger${user ? " is-authenticated" : ""}`}
        aria-label="Account and storage"
        data-testid="account-trigger"
        title={
          user
            ? `Signed in as ${user.name} (${user.email}) · ${items.length} saved`
            : "Sign in or create an account to save materials and projects"
        }
        onClick={openDialog}
      >
        <span className="account-trigger-dot" aria-hidden="true" />
        <span>{user ? user.name.split(" ")[0] : "Account"}</span>
        {user && <span className="account-trigger-count">{items.length}</span>}
      </button>

      <dialog
        ref={dialogRef}
        className="account-dialog"
        data-testid="account-dialog"
        aria-labelledby={headingId}
        onCancel={(event) => event.stopPropagation()}
        onClose={(event) => {
          event.stopPropagation();
          const focused = document.activeElement;
          if (!focused || focused === document.body || dialogRef.current?.contains(focused)) {
            triggerRef.current?.focus();
          }
        }}
      >
        <header className="account-dialog-header">
          <div>
            <span className="account-eyebrow">VISCERA · ACCOUNT &amp; STORAGE</span>
            <h2 id={headingId}>
              {user ? `${user.name}’s workspace storage` : "Sign in or create an account"}
            </h2>
          </div>
          <button
            type="button"
            className="account-close-btn"
            aria-label="Close account dialog"
            data-testid="account-close"
            onClick={() => dialogRef.current?.close()}
          >
            <X size={20} />
          </button>
        </header>

        <p className="account-copy">
          Save tissue studies, material recipes, and studio scenes under your own account. Each
          account’s saved items are isolated and protected by PBKDF2-SHA256 password hashing.
        </p>

        <div className="account-mode-bar">
          <label>
            Storage backend
            <select
              aria-label="Storage backend"
              data-testid="account-mode-select"
              value={mode}
              disabled={busy}
              onChange={(event) => {
                setError("");
                setStatus("");
                setMode(event.target.value as AccountDeployment);
              }}
            >
              <option value="browser-local">Browser storage · IndexedDB (this device)</option>
              <option value="server">Account server · /api/account (SQLite)</option>
            </select>
          </label>
          <span className="account-item-badge">
            {mode === "browser-local" ? "ON-DEVICE" : "SERVER API"}
          </span>
        </div>

        {error && (
          <div className="account-alert" role="alert" data-testid="account-error">
            {error}
          </div>
        )}
        {status && (
          <div className="account-status" role="status" data-testid="account-status">
            {status}
          </div>
        )}

        {!user ? (
          <div>
            <div className="account-tabs" role="tablist" aria-label="Account authentication mode">
              <button
                type="button"
                role="tab"
                aria-selected={authTab === "login"}
                data-testid="account-tab-login"
                onClick={() => {
                  setAuthTab("login");
                  setError("");
                  setStatus("");
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authTab === "register"}
                data-testid="account-tab-register"
                onClick={() => {
                  setAuthTab("register");
                  setError("");
                  setStatus("");
                }}
              >
                Create account
              </button>
            </div>

            <form className="account-form" onSubmit={(event) => void handleAuthSubmit(event)}>
              {authTab === "register" && (
                <label className="account-field">
                  Full name
                  <input
                    type="text"
                    aria-label="Full name"
                    data-testid="account-name-input"
                    autoComplete="name"
                    placeholder="Dr. Ada Lovelace"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}

              <label className="account-field">
                Email address
                <input
                  type="email"
                  aria-label="Email address"
                  data-testid="account-email-input"
                  autoComplete="email"
                  placeholder="researcher@institution.org"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label className="account-field">
                Password (at least 8 characters)
                <input
                  type="password"
                  aria-label="Password"
                  data-testid="account-password-input"
                  autoComplete={authTab === "register" ? "new-password" : "current-password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              <button
                type="submit"
                className="account-primary"
                data-testid="account-submit"
                disabled={busy}
              >
                {busy
                  ? "Working…"
                  : authTab === "register"
                    ? "Create account"
                    : "Sign in"}
              </button>
            </form>
          </div>
        ) : (
          <div>
            <section className="account-section" aria-label="Signed-in account">
              <div className="account-user-row">
                <div className="account-user-meta">
                  <strong data-testid="account-user-name">{user.name}</strong>
                  <span data-testid="account-user-email">{user.email}</span>
                </div>
                <button
                  type="button"
                  data-testid="account-logout"
                  disabled={busy}
                  onClick={() => void handleLogout()}
                >
                  Sign out
                </button>
              </div>
            </section>

            <section className="account-section" aria-label="Save current workspace">
              <h3>Save current workspace</h3>
              <p className="account-item-summary">
                {adapter
                  ? `${KIND_LABELS[adapter.kind]} · ${adapter.summary}`
                  : "Current workspace state"}
              </p>
              <form
                className="account-save-row"
                onSubmit={(event) => void handleSaveWorkspace(event)}
              >
                <input
                  type="text"
                  aria-label="Saved item title"
                  data-testid="account-save-title"
                  placeholder={adapter?.defaultTitle ?? "Study title"}
                  value={saveTitle}
                  onChange={(event) => setSaveTitle(event.target.value)}
                />
                <button
                  type="submit"
                  className="account-primary"
                  data-testid="account-save-button"
                  disabled={busy}
                >
                  Save to account
                </button>
              </form>
            </section>

            <section className="account-section" aria-label="Saved items">
              <h3>
                Saved items ({items.length})
              </h3>
              {items.length === 0 ? (
                <p className="account-item-summary" data-testid="account-empty-items">
                  No saved items in this account yet. Save the current workspace above to store it.
                </p>
              ) : (
                <ul className="account-items-list" data-testid="account-items-list">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="account-item-card"
                      data-testid={`account-item-${item.id}`}
                    >
                      <div className="account-item-top">
                        <strong>{item.title}</strong>
                        <span className="account-item-badge">
                          {KIND_LABELS[item.kind] ?? item.kind}
                        </span>
                      </div>
                      <p className="account-item-summary">
                        {item.summary} · {formatBytes(item.bytes)} ·{" "}
                        {item.updatedAt.slice(0, 19).replace("T", " ")} UTC
                      </p>
                      <div className="account-item-actions">
                        <button
                          type="button"
                          className="account-primary"
                          data-testid={`account-load-${item.id}`}
                          disabled={busy}
                          onClick={() => void handleLoadItem(item.id)}
                        >
                          Load into workspace
                        </button>
                        <button
                          type="button"
                          data-testid={`account-export-${item.id}`}
                          disabled={busy}
                          onClick={() => void handleExportItem(item.id)}
                        >
                          Export JSON
                        </button>
                        {confirmDeleteItemId === item.id ? (
                          <>
                            <button
                              type="button"
                              className="account-danger"
                              data-testid={`account-confirm-delete-${item.id}`}
                              disabled={busy}
                              onClick={() => void handleDeleteItem(item.id)}
                            >
                              Confirm delete
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteItemId(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            data-testid={`account-delete-${item.id}`}
                            disabled={busy}
                            onClick={() => setConfirmDeleteItemId(item.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="account-danger-zone">
              <span className="account-item-summary">
                Deleting your account removes your login and all saved items permanently.
              </span>
              {confirmDeleteAccount ? (
                <div className="account-item-actions">
                  <button
                    type="button"
                    className="account-danger"
                    data-testid="account-confirm-delete-user"
                    disabled={busy}
                    onClick={() => void handleDeleteAccount()}
                  >
                    Confirm delete account
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDeleteAccount(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="account-danger"
                  data-testid="account-delete-user"
                  disabled={busy}
                  onClick={() => setConfirmDeleteAccount(true)}
                >
                  Delete account
                </button>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

