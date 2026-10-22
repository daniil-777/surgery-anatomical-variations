// Settings ▸ Storage & Plan (APPLE_STYLE_SPEC §3.7): what the plan allows, what the account uses, and how long history
// and the Trash are kept (maintenance_run: unnamed versions beyond the newest five of a project are removed after the
// plan's window; named versions and the current one stay; the Trash empties itself after 30 days).

import type { Usage } from "../../core/types";
import { Button, FormGroup, FormRow, StorageMeter, formatBytes } from "../../ui";
import { navigate } from "../../app/router";
import { TRASH_RETENTION_DAYS } from "../../app/shell/time";

const NUMBER = new Intl.NumberFormat("en-US");

export function StorageSection({ id, usage }: { id: string; usage: Usage }) {
  // reserved uploads count against the quota until they finish or expire (DESIGN.md §15.4)
  const used = usage.usedBytes + usage.pendingBytes;
  return (
    <section id={id} className="px-settings-section" aria-label="Storage and Plan">
      <FormGroup
        title="Storage & Plan"
        footer={`Versions you name are kept until you delete them, as is each project’s current version. Other versions are removed after ${NUMBER.format(usage.versionRetentionDays)} days, but the newest five of every project always stay. Items in the Trash are deleted after ${TRASH_RETENTION_DAYS} days.`}
      >
        <div className="px-settings-meter">
          <StorageMeter usedBytes={used} quotaBytes={usage.storageQuotaBytes} />
          {usage.pendingBytes > 0 ? (
            <p className="px-settings-note px-num">Includes {formatBytes(usage.pendingBytes)} of uploads in progress.</p>
          ) : null}
        </div>
        <FormRow label="Plan">
          <span className="px-settings-value">{usage.planTitle}</span>
        </FormRow>
        <FormRow label="Largest File">
          <span className="px-settings-value px-num">{formatBytes(usage.maxFileBytes)}</span>
        </FormRow>
        <FormRow label="Projects">
          <span className="px-settings-value px-num">
            {NUMBER.format(usage.projectCount)} of {NUMBER.format(usage.maxProjects)}
          </span>
        </FormRow>
        <FormRow label="Versions">
          <span className="px-settings-value px-num">{NUMBER.format(usage.versionCount)}</span>
        </FormRow>
        <FormRow label="Library Items">
          <span className="px-settings-value px-num">{NUMBER.format(usage.libraryCount)}</span>
        </FormRow>
        <FormRow label="Imports">
          <span className="px-settings-value px-num">{NUMBER.format(usage.importCount)}</span>
        </FormRow>
        <FormRow label="In the Trash">
          <span className="px-settings-value px-num">{NUMBER.format(usage.trashCount)}</span>
          <Button onClick={() => navigate({ name: "trash" })}>Open Trash</Button>
        </FormRow>
      </FormGroup>
    </section>
  );
}
