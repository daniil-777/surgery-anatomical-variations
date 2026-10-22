// The account shell's route switch (DESIGN.md §10). Three frames:
//   · auth — the centred sign-in card (sign in, create account, code, forgot, reset);
//   · app — sidebar + unified toolbar + content (Home, Projects, Library, Imports, Trash, Settings);
//   · full — the whole window for the project editor and labs (the projects pages draw their own chrome).
// Guards (shell/guards.ts) run before anything renders: account pages never mount for guests, so signed-out screens
// make no data requests. Pages other than Home and the auth screens load on demand.

import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import type { AuthPort } from "../core/types";
import { useToast } from "../ui";
import ForgotPage from "../pages/auth/ForgotPage";
import CodePage from "../pages/auth/CodePage";
import ResetPage from "../pages/auth/ResetPage";
import SignInPage from "../pages/auth/SignInPage";
import SignUpPage from "../pages/auth/SignUpPage";
import HomePage from "../pages/HomePage";
import NotFoundPage from "../pages/NotFoundPage";
import { useAuth, usePlatform, type AuthStatus } from "./context";
import { errorMessage, isSilentError } from "./messages";
import { formatRoute, navigate, useRoute, type Route } from "./router";
import { useAppearanceSync } from "./shell/appearance";
import { PageErrorBoundary } from "./shell/ErrorBoundary";
import { guardKey, guardRoute } from "./shell/guards";
import { BootScreen, FullWindowLoading, PageLoading } from "./shell/Loading";
import { documentTitle, routeFrame } from "./shell/routeMeta";
import { takeAfterSignOut } from "./shell/session";
import { ShellFrame } from "./shell/ShellFrame";

const ProjectsPage = lazy(() => import("../pages/projects/ProjectsPage"));
const ProjectEditorPage = lazy(() => import("../pages/projects/ProjectEditorPage"));
const LabScratchPage = lazy(() => import("../pages/projects/LabScratchPage"));
const LibraryPage = lazy(() => import("../pages/library/LibraryPage"));
const ImportsPage = lazy(() => import("../pages/imports/ImportsPage"));
const SettingsPage = lazy(() => import("../pages/settings/SettingsPage"));
const TrashPage = lazy(() => import("../pages/TrashPage"));

export function AppShell() {
  const route = useRoute();
  const auth = useAuth();
  const routeKey = formatRoute(route);
  const guard = guardRoute(route, { status: auth.status, recovery: auth.recovery });
  const redirect = guard.kind === "redirect" ? guard.to : null;
  const latestRedirect = useRef(redirect);
  latestRedirect.current = redirect;
  const redirectKey = guardKey(guard);

  useEffect(() => {
    const target = latestRedirect.current;
    if (target !== null) navigate(target, { replace: true });
  }, [redirectKey]);

  // after this one so that a chosen destination (sign-in, Home after deleting the account) wins over the guard's
  const previousStatus = useRef<AuthStatus>(auth.status);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = auth.status;
    if (before === "signed-in" && auth.status === "signed-out") {
      const target = takeAfterSignOut();
      if (target) navigate(target, { replace: true });
    }
  }, [auth.status]);

  const latestRoute = useRef(route);
  latestRoute.current = route;
  useEffect(() => {
    // the route object changes identity on every hash change; its formatted form is the stable key
    document.title = documentTitle(latestRoute.current);
  }, [routeKey]);

  useAppearanceSync();
  useCallbackErrorToast(auth.status);

  if (guard.kind !== "render") return <BootScreen />;

  switch (routeFrame(route)) {
    case "auth":
      return <AuthRoute route={route} />;
    case "full":
      return (
        <PageErrorBoundary resetKey={routeKey} variant="stage">
          <Suspense fallback={<FullWindowLoading />}>{fullWindowPage(route)}</Suspense>
        </PageErrorBoundary>
      );
    case "app":
      return (
        <ShellFrame route={route}>
          <PageErrorBoundary resetKey={routeKey}>
            <Suspense fallback={<PageLoading />}>{appPage(route)}</Suspense>
          </PageErrorBoundary>
        </ShellFrame>
      );
  }
}

function AuthRoute({ route }: { route: Route }) {
  switch (route.name) {
    case "signin":
      return <SignInPage next={route.next} />;
    case "signup":
      return <SignUpPage next={route.next} />;
    case "code":
      return <CodePage email={route.email} next={route.next} />;
    case "forgot":
      return <ForgotPage />;
    case "reset":
      return <ResetPage />;
    default:
      return null;
  }
}

function fullWindowPage(route: Route): ReactNode {
  if (route.name === "project") return <ProjectEditorPage key={route.id} projectId={route.id} />;
  if (route.name === "lab") return <LabScratchPage key={route.labId} labId={route.labId} />;
  return null;
}

function appPage(route: Route): ReactNode {
  switch (route.name) {
    case "home":
      return <HomePage />;
    case "projects":
      return <ProjectsPage lab={route.lab} />;
    case "library":
      return <LibraryPage filter={route.filter} itemId={route.itemId} />;
    case "imports":
      return <ImportsPage source={route.source} objectId={route.objectId} />;
    case "trash":
      return <TrashPage />;
    case "settings":
      return <SettingsPage section={route.section} />;
    case "gallery":
      return import.meta.env.DEV ? <GalleryRedirect /> : <NotFoundPage />;
    default:
      return <NotFoundPage />;
  }
}

/** Development only: the UI kit's gallery is its own page (apps/studio/px-gallery.html). */
function GalleryRedirect() {
  useEffect(() => {
    window.location.assign("./px-gallery.html");
  }, []);
  return <PageLoading label="Opening the interface kit" />;
}

/** Both auth adapters can say why an OAuth or email-link callback in the URL did not sign in; AuthPort does not. */
function callbackErrorOf(auth: AuthPort): unknown {
  const port = auth as AuthPort & { callbackError?: () => unknown };
  return typeof port.callbackError === "function" ? port.callbackError() : null;
}

/** A failed provider sign-in (declined consent, an expired link) is told once, after the session is restored. */
function useCallbackErrorToast(status: AuthStatus): void {
  const { backend } = usePlatform();
  const toast = useToast();
  const told = useRef(false);
  useEffect(() => {
    if (status === "loading" || told.current) return;
    told.current = true;
    const error = callbackErrorOf(backend.auth);
    if (error && !isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, "signin") });
  }, [status, backend, toast]);
}
