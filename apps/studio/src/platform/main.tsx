// Entry of the account shell, loaded by src/boot.ts when platform.json enables accounts.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { EnabledPlatformConfig } from "./core/config";
import { PlatformRoot } from "./app/PlatformRoot";
import { applyShellSecurity, isFramedByOtherOrigin } from "./app/security";

export function startPlatform(config: EnabledPlatformConfig): void {
  const container = document.getElementById("root");
  if (!container) throw new Error("VISCERA shell: #root is missing");
  document.documentElement.classList.add("px-shell");
  if (isFramedByOtherOrigin()) {
    container.textContent = "VISCERA cannot be shown inside another site. Open it in its own tab.";
    return;
  }
  applyShellSecurity(config);
  createRoot(container).render(
    <StrictMode>
      <PlatformRoot config={config} />
    </StrictMode>,
  );
}
