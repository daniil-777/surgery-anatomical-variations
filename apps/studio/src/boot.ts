// Starts the studio or the account shell (DESIGN.md D3). Lab URLs — ?mode, ?embed, ?template, or a page carrying a
// viscera-mode meta tag such as textures.html — always start the studio exactly as before. A bare URL starts the account
// shell only when platform.json enables accounts; otherwise (dev servers, tests, the portfolio copy) the studio.
const params = new URLSearchParams(window.location.search);
const labUrl =
  params.has("mode") ||
  params.has("embed") ||
  params.has("template") ||
  document.querySelector('meta[name="viscera-mode"]') !== null;

async function start(): Promise<void> {
  if (!labUrl) {
    try {
      const { loadPlatformConfig } = await import("./platform/core/config");
      const config = await loadPlatformConfig();
      if (config.enabled) {
        const { startPlatform } = await import("./platform/main");
        startPlatform(config);
        return;
      }
    } catch (error) {
      // the studio still works when the shell cannot load
      console.error("VISCERA account shell failed to start; opening the studio", error);
    }
  }
  await import("./main");
}

void start();
