import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { InstanceProvider, useInstanceContext } from './contexts/InstanceContext';
import { BootProvider, useBootController } from './hooks/useBootController.jsx';
import AppBackground from './components/AppBackground';
import { BlockedTabView } from './components/blocked-tab-view.tsx';
import { DesktopShell } from './components/desktop/DesktopShell.jsx';
import { DesktopUpdateBoundary } from './components/desktop/DesktopUpdateBoundary.jsx';
import { DesktopWindowFloorSync } from './components/desktop/DesktopWindowFloorSync.jsx';
import { useSingleTab } from './hooks/useSingleTab';
import { useDesktopShell } from './hooks/useDesktopShell';
import { buildGuildRouteRef } from './lib/slugify';
import { Toaster } from './components/ui/sonner';
import { UpdateRequiredDialog } from './components/UpdateRequiredDialog';

const UnauthenticatedShell = lazy(() =>
  import('./components/auth/unauthenticated-shell').then((m) => ({
    default: m.UnauthenticatedShell,
  }))
);
const Invite = lazy(() => import('./pages/Invite'));
const LinkDevice = lazy(() => import('./pages/LinkDevice.jsx'));
const RoadmapPage = lazy(() =>
  import('./components/roadmap-page').then((m) => ({ default: m.RoadmapPage }))
);
const AuthenticatedApp = lazy(() =>
  import('./components/authenticated-app').then((m) => ({ default: m.AuthenticatedApp }))
);
const ExplorePage = lazy(() => import('./pages/ExplorePage'));

function RoadmapRoute() {
  const navigate = useNavigate();
  const handleBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };
  return <RoadmapPage onBack={handleBack} />;
}

const fallback = (
  <div style={{
    height: '100%',
    background: 'var(--hush-black)',
  }} />
);

const PENDING_INVITE_KEY = 'hush_pending_invite';

function getQueuedInvitePath() {
  if (typeof window === 'undefined') return null;
  let raw = null;
  try {
    raw = window.sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw, window.location.origin);
  } catch {
    try {
      window.sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch {
      // noop
    }
    return null;
  }

  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const isInvitePath = /^\/(?:invite|join)\//.test(parsed.pathname);
  const isSameOrigin = parsed.origin === window.location.origin;
  try {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // noop
  }

  return isSameOrigin && isInvitePath ? path : null;
}

// ── PostLoginRedirect ─────────────────────────────────────────────────────────

/**
 * Shown at "/" when the user is authenticated. Redirects to the first guild
 * (if any) or to /home (empty state). Handles ?join= invite params.
 *
 * This replaces the routing logic that was previously in Home.jsx's vault-state
 * effect. The BootController guarantees this only renders when auth is ready.
 */
function PostLoginRedirect() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { mergedGuilds, guildsLoaded } = useInstanceContext();
  const joinParam = searchParams.get('join');
  const returnTo = searchParams.get('returnTo');

  useEffect(() => {
    if (
      returnTo
      && returnTo.startsWith('/')
      && !returnTo.startsWith('//')
      && !returnTo.startsWith('/?')
      && returnTo !== '/'
    ) {
      navigate(returnTo, { replace: true });
      return;
    }

    // Handle invite join param - redirect immediately, don't wait for guilds.
    if (joinParam) {
      navigate(`/invite/${encodeURIComponent(joinParam)}`, { replace: true });
      return;
    }

    const queuedInvitePath = getQueuedInvitePath();
    if (queuedInvitePath) {
      navigate(queuedInvitePath, { replace: true });
      return;
    }

    // Wait for instance boot so mergedGuilds is populated.
    if (!guildsLoaded) return;

    // Navigate to first guild or empty state.
    if (mergedGuilds.length > 0) {
      const first = mergedGuilds[0];
      const instanceHost = first.instanceUrl
        ? new URL(first.instanceUrl).host
        : null;
      const guildRouteRef = buildGuildRouteRef(
        first._localName ?? first.name ?? first.id ?? 'guild',
        first.id,
      );
      if (instanceHost) {
        navigate(`/${instanceHost}/${guildRouteRef}`, { replace: true });
        return;
      }
    }

    navigate('/home', { replace: true });
  }, [guildsLoaded, mergedGuilds, navigate, joinParam, returnTo]);

  return fallback;
}

function TransparencyErrorScreen() {
  const { transparencyError } = useAuth();
  const message = transparencyError
    || 'A security check on your account failed. Do not continue on this device.';
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="transparency-error-screen"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6"
    >
      <div className="flex max-w-md flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-lg font-semibold text-destructive">
          Security check failed
        </h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          Your transparency log entries could not be verified. To protect
          your account, the app cannot continue on this device. Recover
          from another trusted device.
        </p>
      </div>
    </div>
  );
}

// ── AppContent ────────────────────────────────────────────────────────────────

/**
 * Top-level rendering switch driven by useBootController.
 *
 * This is the single place that decides what the user sees. No other component
 * independently checks auth/vault/guild state for routing decisions.
 *
 * Boot states:
 *   'loading'             → blank screen (auth rehydrating)
 *   'needs_login'         → Home (login/register UI) for all non-public routes
 *   'needs_pin'           → Home (PIN unlock screen) for all non-public routes
 *   'pin_setup'           → Home (PIN setup after registration) for all non-public routes
 *   'transparency_error'  → full-screen blocking security failure (no route tree)
 *   'ready'               → full route tree (instances still booting)
 *   'booted'              → full route tree (everything loaded)
 */
function AppContent() {
  const { bootState } = useBootController();

  if (bootState === 'loading') return fallback;

  // ── Unauthenticated: show login/PIN for most routes, keep public routes ──

  if (bootState === 'needs_login' || bootState === 'needs_pin' || bootState === 'pin_setup') {
    return (
      <Suspense fallback={fallback}>
        <Routes>
          {/* Public routes - accessible without auth */}
          <Route path="/join/:instance/:code" element={<Invite />} />
          <Route path="/invite/:code" element={<Invite />} />
          <Route path="/link-device" element={<LinkDevice />} />
          <Route path="/room/:roomName" element={<Navigate to="/" replace />} />
          <Route path="/roadmap" element={<RoadmapRoute />} />

          {/* Everything else → login/PIN screen */}
          <Route path="*" element={<UnauthenticatedShell />} />
        </Routes>
      </Suspense>
    );
  }

  if (bootState === 'transparency_error') {
    return <TransparencyErrorScreen />;
  }

  // ── Authenticated (ready or booted): full route tree ─────────────────────

  return (
    <>
      <Suspense fallback={fallback}>
        <Routes>
          {/* Post-login redirect: "/" → first guild or /home */}
          <Route path="/" element={<PostLoginRedirect />} />

          {/* DM landing / no-guild empty state */}
          <Route path="/home" element={<AuthenticatedApp />} />
          <Route path="/home/:channelSlug" element={<AuthenticatedApp />} />

          {/* Guild discovery */}
          <Route path="/explore" element={<ExplorePage />} />

          {/* Cross-instance invite */}
          <Route path="/join/:instance/:code" element={<Invite />} />

          {/* Same-instance invite (legacy path kept) */}
          <Route path="/invite/:code" element={<Invite />} />

          {/* Device-link approval/new-device handoff */}
          <Route path="/link-device" element={<LinkDevice />} />

          {/* Instance-aware guild route: /:instance/:guildSlug/:channelSlug? */}
          <Route path="/:instance/:guildSlug/:channelSlug?" element={<AuthenticatedApp />} />

          {/* Legacy redirects */}
          <Route path="/servers/:serverId/*" element={<Navigate to="/home" replace />} />
          <Route path="/guilds" element={<Navigate to="/home" replace />} />
          <Route path="/channels" element={<Navigate to="/home" replace />} />
          <Route path="/channels/:channelId" element={<Navigate to="/home" replace />} />

          {/* Utility pages */}
          <Route path="/room/:roomName" element={<Navigate to="/" replace />} />
          <Route path="/roadmap" element={<RoadmapRoute />} />
        </Routes>
      </Suspense>
    </>
  );
}

// ── Cosmetic components ──────────────────────────────────────────────────────

/** Syncs favicon and apple-touch-icon with theme (prefers-color-scheme or data-theme). */
function FaviconThemeSync() {
  useEffect(() => {
    const getTheme = () => {
      const dataTheme = document.documentElement.getAttribute('data-theme');
      if (dataTheme) return dataTheme;
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    };
    const apply = () => {
      const theme = getTheme();
      const favicon = document.getElementById('favicon');
      const appleTouch = document.getElementById('apple-touch-icon');
      if (favicon) favicon.href = theme === 'light' ? '/favicon-light.png' : '/favicon.png';
      if (appleTouch) appleTouch.href = theme === 'light' ? '/apple-touch-icon-light.png' : '/apple-touch-icon.png';
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', apply);
    };
  }, []);
  return null;
}

// ── App root ─────────────────────────────────────────────────────────────────

export default function App() {
  useDesktopShell();
  const location = useLocation();
  const { isBlockedTab, takeOver } = useSingleTab();
  const blockedFlow = location.pathname === '/link-device'
    ? 'device-link'
    : location.pathname.startsWith('/invite/') || location.pathname.startsWith('/join/')
    ? 'invite'
    : 'generic';

  if (isBlockedTab) {
    return <BlockedTabView blockedFlow={blockedFlow} takeOver={takeOver} />;
  }

  return (
    <DesktopUpdateBoundary>
      <AuthProvider>
        <InstanceProvider>
          <BootProvider>
            <FaviconThemeSync />
            <DesktopWindowFloorSync />
            <AppBackground />
            <DesktopShell>
              <AppContent />
            </DesktopShell>
            <UpdateRequiredDialog />
            <Toaster position="bottom-right" richColors />
          </BootProvider>
        </InstanceProvider>
      </AuthProvider>
    </DesktopUpdateBoundary>
  );
}
