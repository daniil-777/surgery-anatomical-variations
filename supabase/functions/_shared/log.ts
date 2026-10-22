// Structured logs for the platform's Edge Functions. Fields are primitives only, so a request body, a session or a
// user record (passwords, emails, tokens) cannot end up in the logs by passing an object along.

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const silentLogger: Logger = {
  info() {},
  error() {},
};

/** One JSON line per event on the runtime's log stream (Supabase dashboard → Edge Functions → Logs). */
export function consoleLogger(fn: string): Logger {
  const write = (level: "info" | "error", event: string, fields: LogFields = {}): void => {
    const line = JSON.stringify({ ...fields, fn, level, event });
    if (level === "error") console.error(line);
    else console.info(line);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/** The error's class name: safe to log, unlike messages, which can quote request data. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
