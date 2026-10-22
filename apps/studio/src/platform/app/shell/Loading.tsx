// Loading states of the shell: nothing for the first 150 ms (fast loads never flash), then the macOS spinner, kept at
// least 300 ms once shown (APPLE_STYLE_SPEC §2.14, §4.4).

import { Spinner, useDeferredLoading } from "../../ui";
import "./styles/shell.css";

export function DelayedSpinner({ label = "Loading", size = 20 }: { label?: string | undefined; size?: number | undefined }) {
  const visible = useDeferredLoading(true);
  return visible ? <Spinner size={size} label={label} /> : null;
}

/** While the stored session is restored or a redirect is under way. */
export function BootScreen() {
  return (
    <main className="px-shell-boot" aria-busy="true" aria-label="Loading VISCERA">
      <DelayedSpinner />
    </main>
  );
}

/** Inside the content column while a page's code loads. */
export function PageLoading({ label = "Loading" }: { label?: string | undefined }) {
  return (
    <div className="px-shell-loading" aria-busy="true">
      <DelayedSpinner label={label} />
    </div>
  );
}

/** The whole window (project editor, labs) while its code loads: dark, like the labs. */
export function FullWindowLoading() {
  return (
    <main className="px-shell-boot px-shell-boot--stage" aria-busy="true" aria-label="Opening the lab">
      <DelayedSpinner label="Opening" />
    </main>
  );
}
