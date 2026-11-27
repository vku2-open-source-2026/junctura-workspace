// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { SignInPage, Skeleton } from "@junctura/ui";
import { useEffect, useRef, useState } from "react";
import { configureApi, getBlob, getJson, postBytes, postJson } from "./api";
import { auth, handleCallback, login, refreshSession, signOut, useSession } from "./auth";
import { isDeskApiError } from "./desk/context";
import { loadConfig, type PortalConfig } from "./config";
import { DeskProvider, deskPageFor, isDeskRoute, type DeskApi } from "./desk";
import { PublicHome } from "./pages/PublicHome";
import { useHashRoute } from "./router";
import { fetchStaffProfile, type Staff } from "./session";
import { PackProvider } from "./pack/data";
import { RecordTypeDetailPage, RecordTypesPage, UnitsPage, WorkflowsPage } from "./space";
import { strings } from "./strings";

const RECORD_TYPE_DETAIL = /^\/hop-dong\/([a-z][a-z0-9-]{0,62})$/;
const DESK_HOME = "/lam-viec";
const deskApi: DeskApi = { getJson, postJson, getBlob, postBytes };

/** The public page for a hash route; unknown routes show the home page. */
export function pageFor(route: string) {
  const detail = RECORD_TYPE_DETAIL.exec(route);
  if (detail) return <RecordTypeDetailPage slug={detail[1]} />;
  if (route === "/hop-dong") return <RecordTypesPage />;
  if (route === "/quy-trinh") return <WorkflowsPage />;
  if (route === "/co-so") return <UnitsPage />;
  return <PublicHome />;
}

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-app px-4">
      <Skeleton lines={2} className="w-56" />
    </div>
  );
}

/**
 * The signed-in gate of the desk: the backend resolves the caller's verified
 * Directory membership (`GET /api/me`); there is no client-side account list.
 * A refusal (403) means this account is not staff of the portal; any other
 * failure keeps a visible error with a retry, never a silent loading screen.
 */
function StaffGate({ config, children }: { config: PortalConfig; children: (staff: Staff) => React.ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "refused" | "failed">("loading");
  const [staff, setStaff] = useState<Staff | null>(null);

  useEffect(() => {
    let live = true;
    setState("loading");
    fetchStaffProfile(getJson)
      .then(profile => {
        if (!live) return;
        if (profile) {
          setStaff(profile);
          setState("ok");
        } else {
          setState("refused");
        }
      })
      .catch(error => {
        if (!live) return;
        // A 401 already ended the session (back to sign-in); anything else shows
        // the failure instead of waiting forever. A 403 is the refusal of a
        // non-staff account, distinct from an unusable backend.
        if (!auth.get()) return;
        setState(isDeskApiError(error) && error.status === 403 ? "refused" : "failed");
      });
    return () => { live = false; };
  }, []);

  if (state === "ok" && staff) return <>{children(staff)}</>;
  if (state === "refused") {
    return (
      <SignInPage product={strings.app.name} title={strings.signIn.title} subtitle={strings.signIn.notStaff}
        note={strings.signIn.note} signInLabel={strings.signIn.signOut} onSignIn={() => { void signOut(config); }} onBack={() => { window.location.hash = "#/"; }} />
    );
  }
  if (state === "failed") {
    return (
      <SignInPage product={strings.app.name} title={strings.signIn.title} subtitle={strings.signIn.failed}
        note={strings.signIn.note} signInLabel={strings.signIn.signOut} onSignIn={() => { void signOut(config); }} onBack={() => { window.location.hash = "#/"; }} />
    );
  }
  return <Splash />;
}

/**
 * Root of Cổng Junctura Workspace, the GUI of Layer 2. The pack projection is
 * fetched once from the backend's public route and provided to every page; one
 * built bundle presents whichever pack the backend serves. Public pages explain
 * the workspace and present the installed pack. The signed-in workspace, in the
 * order of the brief, is H (#/lam-viec: today, notices, directory), P (#/ho-so:
 * cross-unit cases) and D (#/dieu-hanh: live figures); it signs staff in with
 * Junctura and works on Layer 1. End users never sign in here: they use the
 * Layer 3 applications.
 */
export function PortalApp() {
  return (
    <PackProvider>
      <PortalContent />
    </PackProvider>
  );
}

function PortalContent() {
  const [route, navigate] = useHashRoute();
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const session = useSession();

  useEffect(() => { window.scrollTo?.(0, 0); }, [route]);

  useEffect(() => {
    void loadConfig().then(loaded => {
      configureApi(loaded.juncturaUrl, () => refreshSession(loaded));
      setConfig(loaded);
    });
  }, []);

  // Finish an OIDC redirect exactly once per page load, then return to where sign-in started.
  const handled = useRef(false);
  useEffect(() => {
    if (!config || handled.current) return;
    handled.current = true;
    if (!new URLSearchParams(window.location.search).has("code")) return;
    handleCallback(config)
      .then(returnTo => navigate(returnTo && isDeskRoute(returnTo) ? returnTo : DESK_HOME))
      .catch(() => { setMessage(strings.signIn.badRedirect); navigate(DESK_HOME); });
  }, [config, navigate]);

  // A 401 during use ends the session with a clear message.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (session) { wasSignedIn.current = true; return; }
    if (!wasSignedIn.current) return;
    wasSignedIn.current = false;
    if (auth.clearedBy() === "unauthorized") setMessage(strings.signIn.sessionEnded);
  }, [session]);

  if (!isDeskRoute(route)) return pageFor(route);
  if (!config) return <Splash />;

  if (!session) {
    const startSignIn = () => {
      setMessage(undefined);
      void login(config).catch(() => setMessage(strings.signIn.failed));
    };
    return (
      <SignInPage product={strings.app.name} title={strings.signIn.title} subtitle={strings.signIn.subtitle}
        note={strings.signIn.note} message={message} onSignIn={startSignIn} onBack={() => navigate("/")} />
    );
  }

  return (
    <StaffGate config={config}>
      {staff => (
        <DeskProvider staff={staff} api={deskApi} signOut={() => { void signOut(config); }}>
          {deskPageFor(route) ?? deskPageFor(DESK_HOME)}
        </DeskProvider>
      )}
    </StaffGate>
  );
}
