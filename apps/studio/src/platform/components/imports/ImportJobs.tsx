// The rows of imports in progress, above the grid (APPLE_STYLE_SPEC §3.5 "Import job rows"): the file name, a 2 px bar
// across analysis, upload and saving, the current stage, and Cancel. A refusal stays as a row with the importer's own
// reason (danger text) and advice until it is dismissed; connection problems offer Try Again.

import { useId } from "react";
import { CircleAlert, Clock, FileBox, X } from "lucide-react";
import { Button, Icon, IconButton, ProgressBar } from "../../ui";
import { jobFraction, jobStatusText } from "./model";
import type { ImportJob } from "./queue";

export interface ImportJobsProps {
  jobs: readonly ImportJob[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
}

function heading(jobs: readonly ImportJob[]): string {
  const active = jobs.filter((job) => job.state.status !== "failed").length;
  if (active > 0) return active === 1 ? "Importing 1 Model" : `Importing ${active} Models`;
  return jobs.length === 1 ? "1 Import Didn’t Finish" : `${jobs.length} Imports Didn’t Finish`;
}

export function ImportJobs({ jobs, onCancel, onDismiss, onRetry }: ImportJobsProps) {
  const titleId = useId();
  if (jobs.length === 0) return null;
  return (
    <section className="px-imports-jobs" aria-labelledby={titleId}>
      <h2 id={titleId} className="px-imports-jobs__title">
        {heading(jobs)}
      </h2>
      <ul role="list" className="px-imports-jobs__list">
        {jobs.map((job) => (
          <ImportJobRow key={job.id} job={job} onCancel={onCancel} onDismiss={onDismiss} onRetry={onRetry} />
        ))}
      </ul>
    </section>
  );
}

function ImportJobRow({ job, onCancel, onDismiss, onRetry }: { job: ImportJob } & Omit<ImportJobsProps, "jobs">) {
  const { state } = job;
  if (state.status === "failed") {
    return (
      <li className="px-imports-job" data-status="failed">
        <span className="px-imports-job__icon">
          <Icon icon={CircleAlert} size={16} />
        </span>
        <div className="px-imports-job__body">
          <span className="px-imports-job__name" title={job.label}>
            {job.label}
          </span>
          <p className="px-imports-job__reason">{state.reason}</p>
          {state.advice ? <p className="px-imports-job__advice">{state.advice}</p> : null}
        </div>
        <div className="px-imports-job__actions">
          {state.retryable ? (
            <Button size="small" variant="bordered" onClick={() => onRetry(job.id)}>
              Try Again
            </Button>
          ) : null}
          <IconButton icon={X} size="small" label={`Dismiss ${job.label}`} onClick={() => onDismiss(job.id)} />
        </div>
      </li>
    );
  }
  return (
    <li className="px-imports-job" data-status={state.status}>
      <span className="px-imports-job__icon">
        <Icon icon={state.status === "waiting" ? Clock : FileBox} size={16} />
      </span>
      <div className="px-imports-job__body">
        <span className="px-imports-job__name" title={job.label}>
          {job.label}
        </span>
        <ProgressBar size="inline" value={jobFraction(state)} aria-label={`Importing ${job.label}`} />
        <p className="px-imports-job__status px-num">{jobStatusText(state)}</p>
      </div>
      <div className="px-imports-job__actions">
        <IconButton icon={X} size="small" label={`Cancel Importing ${job.label}`} onClick={() => onCancel(job.id)} />
      </div>
    </li>
  );
}
