// Settings ▸ Profile: photo (optional), name and username. Name and username are saved together with Save Changes,
// so a half-typed username is never claimed; the username's availability is checked while typing.

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Profile, Session } from "../../core/types";
import { Avatar, Button, FormGroup, FormRow, Icon, TextField, useToast } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorMessage, isSilentError } from "../../app/messages";
import { invalidate, setQueryData } from "../../app/query";
import { ACCOUNT_KEY_PREFIX, accountDisplayName, profileKey, useAssetUrl } from "../../app/shell/queries";
import { normalizeUsernameInput, usernameProblem } from "../auth/identifier";
import { useUsernameAvailability } from "../auth/useUsernameAvailability";
import { AvatarError, prepareAvatar } from "./avatar";

export function ProfileSection({ id, profile, session }: { id: string; profile: Profile; session: Session }) {
  const { backend, config } = usePlatform();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [username, setUsername] = useState(profile.username ?? "");
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState<"upload" | "remove" | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const avatarUrl = useAssetUrl(profile.avatarAssetId);

  // a profile saved elsewhere (another tab, the appearance sync) replaces untouched fields
  const saved = useRef(profile);
  useEffect(() => {
    if (displayName === (saved.current.displayName ?? "")) setDisplayName(profile.displayName ?? "");
    if (username === (saved.current.username ?? "")) setUsername(profile.username ?? "");
    saved.current = profile;
    // only a new profile from the server should do this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const name = normalizeUsernameInput(username);
  const shapeProblem = usernameProblem(name);
  const availability = useUsernameAvailability(shapeProblem ? "" : name, { current: profile.username });
  const nameChanged = displayName.trim() !== (profile.displayName ?? "");
  const usernameChanged = name !== (profile.username ?? "");
  const dirty = nameChanged || usernameChanged;
  const blocked = (usernameChanged && (shapeProblem !== null || availability === "taken" || availability === "checking")) || displayName.trim().length > 80;

  const save = async () => {
    if (!dirty || blocked || saving) return;
    setSaving(true);
    setUsernameError(null);
    try {
      const updated = await backend.account.updateProfile({
        ...(nameChanged ? { displayName: displayName.trim() || null } : {}),
        ...(usernameChanged ? { username: name || null } : {}),
      });
      setQueryData(profileKey(session.user.id), () => updated);
      toast.show({ tone: "success", message: "Profile saved." });
    } catch (error) {
      if (isSilentError(error)) return;
      const message = errorMessage(error, "profile");
      if (usernameChanged && /username/i.test(message)) setUsernameError(message);
      else toast.show({ tone: "error", message });
    } finally {
      setSaving(false);
    }
  };

  const choosePhoto = async (file: File) => {
    setPhotoBusy("upload");
    try {
      const image = await prepareAvatar(file);
      const asset = await backend.assets.put(image, { mimeType: image.type === "image/webp" ? "image/webp" : "image/png" });
      const updated = await backend.account.updateProfile({ avatarAssetId: asset.id });
      setQueryData(profileKey(session.user.id), () => updated);
      invalidate(ACCOUNT_KEY_PREFIX);
      toast.show({ tone: "success", message: "Photo updated." });
    } catch (error) {
      if (error instanceof AvatarError) toast.show({ tone: "error", message: error.message });
      else if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, "upload") });
    } finally {
      setPhotoBusy(null);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy("remove");
    try {
      const updated = await backend.account.updateProfile({ avatarAssetId: null });
      setQueryData(profileKey(session.user.id), () => updated);
    } catch (error) {
      if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, "profile") });
    } finally {
      setPhotoBusy(null);
    }
  };

  const usernameStatus =
    usernameError ?? (usernameChanged && name !== "" ? shapeProblem : null) ?? (availability === "taken" ? "That username is taken. Choose another one." : null);
  const usernameHint =
    availability === "checking" ? (
      "Checking availability…"
    ) : availability === "available" ? (
      <span className="px-settings-ok">
        <Icon icon={Check} size={12} /> Available
      </span>
    ) : profile.username && !usernameChanged ? (
      "You can sign in with it instead of your email."
    ) : (
      "Optional. 3 to 30 letters, numbers, dots, hyphens or underscores."
    );

  return (
    <section id={id} className="px-settings-section" aria-label="Profile">
      <FormGroup title="Profile">
        <FormRow label="Photo" description="Shown in the sidebar on your devices.">
          <Avatar name={accountDisplayName(profile, session.user.email)} src={avatarUrl} size={40} />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void choosePhoto(file);
            }}
          />
          <Button loading={photoBusy === "upload"} loadingLabel="Uploading…" aria-disabled={photoBusy !== null ? true : undefined} onClick={() => fileRef.current?.click()}>
            Choose Photo…
          </Button>
          {profile.avatarAssetId ? (
            <Button variant="plain" loading={photoBusy === "remove"} aria-disabled={photoBusy !== null ? true : undefined} onClick={() => void removePhoto()}>
              Remove
            </Button>
          ) : null}
        </FormRow>
        <FormRow label="Name" htmlFor="px-settings-name">
          <TextField
            id="px-settings-name"
            label="Name"
            hideLabel
            size="regular"
            autoComplete="name"
            placeholder="Your name"
            maxLength={80}
            value={displayName}
            containerClassName="px-settings-field"
            onChange={(event) => setDisplayName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
        </FormRow>
        {config.providers.username ? (
          <FormRow label="Username" htmlFor="px-settings-username">
            <TextField
              id="px-settings-username"
              label="Username"
              hideLabel
              size="regular"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="username"
              maxLength={30}
              value={username}
              containerClassName="px-settings-field"
              hint={usernameHint}
              error={usernameStatus ?? undefined}
              onChange={(event) => {
                setUsername(event.target.value.toLowerCase());
                setUsernameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
          </FormRow>
        ) : null}
        <FormRow label="Email">
          <span className="px-settings-value">{session.user.email ?? "—"}</span>
        </FormRow>
      </FormGroup>
      <div className="px-settings-actions">
        <Button
          aria-disabled={!dirty || saving ? true : undefined}
          onClick={() => {
            setDisplayName(profile.displayName ?? "");
            setUsername(profile.username ?? "");
            setUsernameError(null);
          }}
        >
          Revert
        </Button>
        <Button variant="borderedProminent" loading={saving} loadingLabel="Saving…" aria-disabled={!dirty || blocked ? true : undefined} onClick={() => void save()}>
          Save Changes
        </Button>
      </div>
    </section>
  );
}
