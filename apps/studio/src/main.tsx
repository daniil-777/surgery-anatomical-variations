import { VideoRecorderProvider } from "./VideoRecorderPanel";
import { DisplayProvider } from "./DisplaySettings";
import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
const App = lazy(() => import("./App"));   // the original procedural studio: loaded only with ?mode=legacy
const FatLab = lazy(() => import("./fat/FatLab"));
const TissueLab = lazy(() => import("./tissues/TissueLab"));
const ImportedModelStudio = lazy(() => import("./imports/ImportedModelStudio"));
const BloodLab = lazy(() => import("./blood/BloodLab"));
import AtlasStudio from "./AtlasStudio";
import { loadRuntimeApiConfig } from "./api";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./styles.css";
import "./apiNotice.css";
// ?mode= chooses the workspace; the texture lab's own page (textures.html, written by the Vite build) names its mode
// in a <meta name="viscera-mode"> so that it needs no query string.
// the public copy may name a hosted API (api.json beside index.html): decided before anything asks the API
await loadRuntimeApiConfig();
const mode = new URLSearchParams(window.location.search).get("mode")
  ?? document.querySelector<HTMLMetaElement>('meta[name="viscera-mode"]')?.content ?? "";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DisplayProvider><VideoRecorderProvider><Suspense fallback={<div className="atlas-loading" role="status">Loading VISCERA…</div>}>
      {mode === "blood" ? <BloodLab /> : mode === "imports" ? <ImportedModelStudio /> : mode === "tissues" ? <TissueLab /> : mode === "fat" ? <FatLab /> : mode === "legacy" ? <App /> : <AtlasStudio textureLab={mode.startsWith("textures")} />}
    </Suspense></VideoRecorderProvider></DisplayProvider>
  </React.StrictMode>,
);
