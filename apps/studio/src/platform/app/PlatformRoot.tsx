// Creates the backend for the loaded platform.json and mounts the shell inside the UI kit's provider. The route decides
// the appearance scope: sign-in screens ("auth"), the project editor and labs ("lab", always dark), everything else ("app").
import { useEffect, useState } from "react";
import { createPlatformBackend, type EnabledPlatformConfig } from "../core/config";
import type { PlatformBackend } from "../core/types";
import { PxProvider } from "../ui";
import { AppShell } from "./AppShell";
import { AuthProvider, PlatformProvider } from "./context";
import { isAuthRoute, useRoute, type Route } from "./router";

function pxRoute(route: Route): "auth" | "app" | "lab" {
  if (isAuthRoute(route) || route.name === "reset") return "auth";
  if (route.name === "project" || route.name === "lab") return "lab";
  return "app";
}

export function PlatformRoot({ config }: { config: EnabledPlatformConfig }) {
  const route = useRoute();
  const [backend, setBackend] = useState<PlatformBackend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    createPlatformBackend(config).then(
      (created) => {
        if (alive) setBackend(created);
      },
      (error: unknown) => {
        console.error("VISCERA shell: the account service could not start", error);
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [config]);

  return (
    <PxProvider route={pxRoute(route)}>
      {failed ? (
        <main className="px-boot" role="alert">
          <h1>Accounts are unavailable right now</h1>
          <p>
            You can still use the studio without an account: <a href="./?mode=atlas">open the studio</a>.
          </p>
        </main>
      ) : backend ? (
        <PlatformProvider config={config} backend={backend}>
          <AuthProvider>
            <AppShell />
          </AuthProvider>
        </PlatformProvider>
      ) : (
        <main className="px-boot" aria-busy="true" aria-label="Loading VISCERA" />
      )}
    </PxProvider>
  );
}
