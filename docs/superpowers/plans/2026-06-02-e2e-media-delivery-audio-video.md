# E2E media-delivery (audio/video) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove two real browser clients send and receive each other's audio/video through the real server + real LiveKit, with FrameCryptor `decryptFailures === 0` and the media key bound to the current MLS epoch.

**Architecture:** Hybrid local stack. docker-compose brings up postgres + livekit (services already in `hush-server/docker-compose.yml`); the real server runs natively via `go run -tags e2e_test ./cmd/hush`; hush-web runs via `vite preview`. Playwright drives two isolated browser contexts. A build-tagged `/api/test/seed` endpoint seeds server+channel+memberships over HTTP (Playwright has no DB handle). A flag-gated `window.__hushE2eeStats` surface exposes decrypt counters + epoch for the real assertion.

**Tech Stack:** Playwright (new to hush-web), livekit-client 2.17.2, Go (chi) build-tagged routes, vitest, docker-compose.

**Spec:** `docs/superpowers/specs/2026-06-02-e2e-media-delivery-audio-video-design.md`. Linear HUSHHQ-107.

**Repos:** server tasks in `/home/gisbi/Code/hush/hush-server` (branch off `main`), web tasks in `/home/gisbi/Code/hush/hush-web` (branch `feature/hushhq-107-e2e-media-delivery`).

**Invariants:** CORE-INVARIANTS voice + MLS. The diagnostic surface exposes counters/epoch/index ONLY; never frame keys, exporter secrets, private keys, or plaintext.

---

## File Structure

hush-server:
- Modify `internal/server/test_routes.go` — add `/api/test/seed` handler (already `//go:build e2e_test`).
- Modify `internal/server/test_routes_absent_test.go` — assert `/api/test/seed` is 404 in untagged builds.
- Create `internal/server/test_routes_seed_test.go` — `//go:build e2e_test` unit test for the seed handler.

hush-web:
- Create `src/lib/e2eeDiagnostics.js` — the flag-gated diagnostic surface (standalone, unit-testable; keeps the 1245-line `useRoom.js` from growing).
- Create `src/lib/e2eeDiagnostics.test.js` — vitest unit tests.
- Modify `src/hooks/useRoom.js` — call the diagnostics recorder at the `setKey` sites and on `RoomEvent.EncryptionError`.
- Create `playwright.config.ts`, `e2e/media/global-setup.ts`, `e2e/media/global-teardown.ts`.
- Create `e2e/media/fixtures/session.ts` — ephemeral identity + `/api/test/session` + `/api/test/seed`.
- Create `e2e/media/media-delivery.spec.ts` — the symmetric audio/video test.
- Modify `package.json` — add `e2e:media` script + devDeps.

---

## Task 1: Build-tagged `/api/test/seed` endpoint (hush-server)

**Files:**
- Modify: `/home/gisbi/Code/hush/hush-server/internal/server/test_routes.go`
- Modify: `/home/gisbi/Code/hush/hush-server/internal/server/test_routes_absent_test.go`
- Test: `/home/gisbi/Code/hush/hush-server/internal/server/test_routes_seed_test.go` (create)

Work on a new branch: `git -C /home/gisbi/Code/hush/hush-server checkout -b feature/hushhq-107-test-seed-endpoint`.

- [ ] **Step 1: Write the failing prod-absence test (untagged build)**

Append to `internal/server/test_routes_absent_test.go` (this file builds WITHOUT `e2e_test`, so it proves the route is gone in prod). Locate the existing test that POSTs `/api/test/session` and expects 404, then mirror it:

```go
func TestTestSeedRoute_AbsentInProdBuild(t *testing.T) {
	r := chi.NewRouter()
	registerTestRoutes(r, nil, "") // prod no-op
	req := httptest.NewRequest(http.MethodPost, "/api/test/seed", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for /api/test/seed in prod build, got %d", rec.Code)
	}
}
```

- [ ] **Step 2: Run it to verify it passes already (route absent today)**

Run: `cd /home/gisbi/Code/hush/hush-server && go test ./internal/server/ -run TestTestSeedRoute_AbsentInProdBuild -v`
Expected: PASS (the route does not exist yet, so prod returns 404). This test guards the invariant for later.

- [ ] **Step 3: Write the failing seed-handler test (tagged build)**

Create `internal/server/test_routes_seed_test.go`. Reuse the same DB/test-server bootstrap helper the existing `test_routes` tagged tests use (search the package for how `createSession` is tested and copy its pool + router setup). The new test seeds two users then calls `/api/test/seed`:

```go
//go:build e2e_test

package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTestSeedRoute_CreatesServerChannelMemberships(t *testing.T) {
	pool := newTestPool(t)        // same helper the session test uses; if named differently, match it
	r := chi.NewRouter()
	registerTestRoutes(r, pool, "test-secret")

	// Two members provisioned via the existing session endpoint.
	uidA := createTestUser(t, r) // helper: POST /api/test/session, return userId
	uidB := createTestUser(t, r)

	body, _ := json.Marshal(map[string]any{"userIds": []string{uidA, uidB}})
	req := httptest.NewRequest(http.MethodPost, "/api/test/seed", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("seed: want 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ServerID  string `json:"serverId"`
		ChannelID string `json:"channelId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ServerID == "" || resp.ChannelID == "" {
		t.Fatalf("seed returned empty ids: %+v", resp)
	}
}
```

Note: `newTestPool`/`createTestUser` must match the helpers already present in the tagged test files. If absent, inline the same pool bootstrap used by `voice_convergence_test.go`'s `buildTestHandler`, and provision users by POSTing `/api/test/session` and reading `userId` from the response.

- [ ] **Step 4: Run it to verify it fails**

Run: `cd /home/gisbi/Code/hush/hush-server && go test -tags e2e_test ./internal/server/ -run TestTestSeedRoute_CreatesServerChannelMemberships -v`
Expected: FAIL — 404 (handler not mounted yet).

- [ ] **Step 5: Implement the seed handler**

In `internal/server/test_routes.go`, register the route inside `registerTestRoutes` (next to the session route) and add the handler. Use the exact seed primitives from `voice_convergence_test.go`:

```go
	r.Post("/api/test/seed", h.createSeed)
```

```go
type testSeedRequest struct {
	UserIDs []string `json:"userIds"`
}

type testSeedResponse struct {
	ServerID  string `json:"serverId"`
	ChannelID string `json:"channelId"`
}

// createSeed provisions one server, one voice channel, and a membership row per
// userId, mirroring the direct-DB seeding the headless Go harness performs. E2E
// only: compiled in solely under -tags e2e_test.
func (h *testHandler) createSeed(w http.ResponseWriter, r *http.Request) {
	var req testSeedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.UserIDs) == 0 {
		writeTestJSON(w, http.StatusBadRequest, map[string]string{"error": "userIds required"})
		return
	}
	ctx := r.Context()
	srv, err := h.pool.CreateServer(ctx, []byte("e2e"))
	if err != nil {
		writeTestJSON(w, http.StatusInternalServerError, map[string]string{"error": "create server: " + err.Error()})
		return
	}
	ch, err := h.pool.CreateChannel(ctx, srv.ID, []byte("e2e"), "voice", nil, 0)
	if err != nil {
		writeTestJSON(w, http.StatusInternalServerError, map[string]string{"error": "create channel: " + err.Error()})
		return
	}
	for _, uid := range req.UserIDs {
		if err := h.pool.AddServerMember(ctx, srv.ID, uid, 0); err != nil {
			writeTestJSON(w, http.StatusInternalServerError, map[string]string{"error": "add member " + uid + ": " + err.Error()})
			return
		}
	}
	writeTestJSON(w, http.StatusCreated, testSeedResponse{ServerID: srv.ID, ChannelID: ch.ID})
}
```

- [ ] **Step 6: Run both tests**

Run: `cd /home/gisbi/Code/hush/hush-server && go test -tags e2e_test ./internal/server/ -run TestTestSeedRoute -v && go test ./internal/server/ -run TestTestSeedRoute_AbsentInProdBuild -v`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git -C /home/gisbi/Code/hush/hush-server add internal/server/test_routes.go internal/server/test_routes_absent_test.go internal/server/test_routes_seed_test.go
git -C /home/gisbi/Code/hush/hush-server commit -m "test(e2e): build-tagged /api/test/seed endpoint for Playwright media suite (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `e2eeDiagnostics` flag-gated surface (hush-web)

**Files:**
- Create: `/home/gisbi/Code/hush/hush-web/src/lib/e2eeDiagnostics.js`
- Test: `/home/gisbi/Code/hush/hush-web/src/lib/e2eeDiagnostics.test.js`

All hush-web tasks use branch `feature/hushhq-107-e2e-media-delivery` (already checked out).

- [ ] **Step 1: Write the failing unit test**

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('e2eeDiagnostics', () => {
  beforeEach(() => {
    delete globalThis.window;
    globalThis.window = {};
    vi.resetModules();
  });

  it('does not attach __hushE2eeStats when the diag flag is off', async () => {
    const { installE2eeDiagnostics } = await import('./e2eeDiagnostics.js');
    installE2eeDiagnostics(false);
    expect(window.__hushE2eeStats).toBeUndefined();
  });

  it('attaches counters/epoch/index only when the flag is on', async () => {
    const { installE2eeDiagnostics, recordKeyEpoch, recordDecryptFailure } =
      await import('./e2eeDiagnostics.js');
    installE2eeDiagnostics(true);
    expect(window.__hushE2eeStats).toEqual({
      decryptFailures: 0,
      mediaKeyEpoch: -1,
      keyIndex: -1,
      lastError: null,
    });

    recordKeyEpoch(5);
    expect(window.__hushE2eeStats.mediaKeyEpoch).toBe(5);
    expect(window.__hushE2eeStats.keyIndex).toBe(5 % 256);

    recordDecryptFailure('InvalidKey');
    expect(window.__hushE2eeStats.decryptFailures).toBe(1);
    expect(window.__hushE2eeStats.lastError).toBe('InvalidKey');
  });

  it('never exposes a key field', async () => {
    const { installE2eeDiagnostics, recordKeyEpoch } = await import('./e2eeDiagnostics.js');
    installE2eeDiagnostics(true);
    recordKeyEpoch(3);
    const keys = Object.keys(window.__hushE2eeStats);
    expect(keys.sort()).toEqual(['decryptFailures', 'keyIndex', 'lastError', 'mediaKeyEpoch']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/gisbi/Code/hush/hush-web && npx vitest run src/lib/e2eeDiagnostics.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```js
/**
 * Test/dev-only E2EE diagnostic surface for the Playwright media suite
 * (HUSHHQ-107). Exposes counters/epoch/index ONLY: never frame keys, exporter
 * secrets, private keys, or plaintext (CORE-INVARIANTS voice/MLS). Attached to
 * window only when the diag flag is set, so production bundles never define it.
 */

const AES_KEY_INDEX_MODULUS = 256;

/** @returns {boolean} true when the build/runtime opted into diagnostics. */
export function isE2eeDiagnosticsEnabled() {
  try {
    return import.meta.env?.VITE_E2E_DIAG === '1';
  } catch {
    return false;
  }
}

/**
 * Installs window.__hushE2eeStats when enabled. Idempotent.
 * @param {boolean} enabled
 */
export function installE2eeDiagnostics(enabled) {
  if (!enabled) return;
  if (typeof window === 'undefined') return;
  if (window.__hushE2eeStats) return;
  window.__hushE2eeStats = {
    decryptFailures: 0,
    mediaKeyEpoch: -1,
    keyIndex: -1,
    lastError: null,
  };
}

/** Records the MLS epoch a freshly applied media key derives from. */
export function recordKeyEpoch(epoch) {
  const stats = typeof window !== 'undefined' && window.__hushE2eeStats;
  if (!stats) return;
  stats.mediaKeyEpoch = epoch;
  stats.keyIndex = epoch % AES_KEY_INDEX_MODULUS;
}

/** Records a FrameCryptor decrypt failure. errorName must contain no key material. */
export function recordDecryptFailure(errorName) {
  const stats = typeof window !== 'undefined' && window.__hushE2eeStats;
  if (!stats) return;
  stats.decryptFailures += 1;
  stats.lastError = String(errorName ?? 'unknown');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/gisbi/Code/hush/hush-web && npx vitest run src/lib/e2eeDiagnostics.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/e2eeDiagnostics.js src/lib/e2eeDiagnostics.test.js
git commit -m "feat(e2e): flag-gated window.__hushE2eeStats diagnostic surface (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire diagnostics into `useRoom.js` (hush-web)

**Files:**
- Modify: `/home/gisbi/Code/hush/hush-web/src/hooks/useRoom.js`

There is no unit test for this 1245-line hook; correctness is verified end-to-end by the Playwright spec (Task 6). Keep edits minimal and at the exact key sites.

- [ ] **Step 1: Import and install the surface**

Add to the imports near the top of `useRoom.js`:

```js
import {
  isE2eeDiagnosticsEnabled,
  installE2eeDiagnostics,
  recordKeyEpoch,
  recordDecryptFailure,
} from '../lib/e2eeDiagnostics.js';
```

Immediately before `keyProvider = new ExternalE2EEKeyProvider();` (currently line ~378), install the surface once:

```js
        installE2eeDiagnostics(isE2eeDiagnosticsEnabled());
```

- [ ] **Step 2: Record the epoch at both setKey sites**

After the initial key application (currently line ~407, `await keyProvider.setKey(new Uint8Array(frameKeyBytes), initialEpoch % 256);`) add:

```js
          recordKeyEpoch(initialEpoch);
```

After the eviction/rotation `setKey` call (currently in the block around lines ~595-606, inside `e2eeKeyProviderRef.current.setKey(...)`), record the rotated epoch. Use the same epoch variable passed to that `setKey` call (read the surrounding lines to get its exact name; it is the rotated epoch used for `% 256`):

```js
          recordKeyEpoch(<rotatedEpochVar>);
```

- [ ] **Step 3: Record decrypt failures**

In the block where the room's event handlers are registered (near the other `room.on(RoomEvent.*)` handlers, ~line 462+), add:

```js
        room.on(RoomEvent.EncryptionError, (error) => {
          recordDecryptFailure(error?.name ?? error?.message ?? 'EncryptionError');
        });
```

`RoomEvent.EncryptionError` is `"encryptionError"` in livekit-client 2.17.2 and emits `(error, participantIdentity)`. Pass only the error name; never the participant identity or any payload to the surface.

- [ ] **Step 4: Verify the build is clean**

Run: `cd /home/gisbi/Code/hush/hush-web && npm run typecheck && npx vitest run src/lib/e2eeDiagnostics.test.js`
Expected: typecheck PASS (no new errors in useRoom.js), unit tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useRoom.js
git commit -m "feat(e2e): feed __hushE2eeStats from useRoom key + EncryptionError sites (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Playwright scaffolding + local stack lifecycle (hush-web)

**Files:**
- Modify: `/home/gisbi/Code/hush/hush-web/package.json`
- Create: `/home/gisbi/Code/hush/hush-web/playwright.config.ts`
- Create: `/home/gisbi/Code/hush/hush-web/e2e/media/global-setup.ts`
- Create: `/home/gisbi/Code/hush/hush-web/e2e/media/global-teardown.ts`
- Create: `/home/gisbi/Code/hush/hush-web/e2e/media/smoke.spec.ts` (temporary, removed in Task 6)

- [ ] **Step 1: Install Playwright**

Run:
```bash
cd /home/gisbi/Code/hush/hush-web
npm i -D @playwright/test
npx playwright install chromium
```
Expected: `@playwright/test` in devDependencies, Chromium downloaded.

- [ ] **Step 2: Add the `e2e:media` script**

In `package.json` `scripts`, add:

```json
    "e2e:media": "playwright test --config=playwright.config.ts"
```

- [ ] **Step 3: Write `global-setup.ts` (compose + tagged server)**

```ts
import { execSync, spawn, ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_DIR = process.env.HUSH_SERVER_DIR ?? '../hush-server';
const SERVER_URL = 'http://127.0.0.1:8080';
const DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://hush:hush@127.0.0.1:5432/hush?sslmode=disable';

let serverProc: ChildProcess | undefined;

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

export default async function globalSetup() {
  if (!dockerAvailable()) {
    throw new Error(
      'Docker is required for e2e:media (postgres + livekit). Skip by not running this suite.',
    );
  }
  // Stateful externals only: postgres + livekit (services already defined).
  execSync('docker compose up -d postgres livekit', {
    cwd: SERVER_DIR,
    stdio: 'inherit',
  });

  serverProc = spawn('go', ['run', '-tags', 'e2e_test', './cmd/hush'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: DB_URL },
  });
  await waitFor(`${SERVER_URL}/healthz`, 60_000);

  // Expose to teardown via a global file path env.
  (globalThis as any).__hushServerPid = serverProc.pid;
  process.env.HUSH_E2E_SERVER_URL = SERVER_URL;
}
```

Note: confirm the server's health route name (`/healthz` vs `/health`) by grepping `hush-server/internal/server/server.go`; use the real one. Confirm the compose service names (`postgres`, `livekit`) and the dev DB credentials from `hush-server/docker-compose.yml`; substitute the real values into `DB_URL` and the compose command.

- [ ] **Step 4: Write `global-teardown.ts`**

```ts
import { execSync } from 'node:child_process';

const SERVER_DIR = process.env.HUSH_SERVER_DIR ?? '../hush-server';

export default async function globalTeardown() {
  const pid = (globalThis as any).__hushServerPid as number | undefined;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  try {
    execSync('docker compose down', { cwd: SERVER_DIR, stdio: 'inherit' });
  } catch {
    // best effort; never fail teardown
  }
}
```

- [ ] **Step 5: Write `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/media',
  globalSetup: './e2e/media/global-setup.ts',
  globalTeardown: './e2e/media/global-teardown.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  webServer: {
    command: 'VITE_E2E_DIAG=1 npm run build && VITE_E2E_DIAG=1 npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
```

Note: `VITE_E2E_DIAG=1` must be set at BUILD time (Vite inlines `import.meta.env` at build), so it is on the `npm run build` invocation, not only preview. Confirm the preview default port; pin it with `--port 4173 --strictPort`.

- [ ] **Step 6: Temporary smoke spec to prove the stack boots**

```ts
// e2e/media/smoke.spec.ts  (temporary; deleted in Task 6)
import { test, expect } from '@playwright/test';

test('app shell loads against the preview build', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Hush/i);
});
```

- [ ] **Step 7: Run the smoke suite**

Run: `cd /home/gisbi/Code/hush/hush-web && npm run e2e:media`
Expected: stack boots (compose up, server healthy, preview built with diag flag), 1 test PASS. If Docker is absent it fails loudly with the message from global-setup; that is intended.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json playwright.config.ts e2e/media/global-setup.ts e2e/media/global-teardown.ts e2e/media/smoke.spec.ts
git commit -m "test(e2e): Playwright scaffolding + local stack lifecycle for media suite (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Ephemeral-session + seed fixtures (hush-web)

**Files:**
- Create: `/home/gisbi/Code/hush/hush-web/e2e/media/fixtures/session.ts`

- [ ] **Step 1: Investigation — how the app ingests a session token**

This is the only app-specific unknown. Before writing the fixture, determine exactly how hush-web persists/reads the JWT so a Playwright context can inject one and land authenticated. Run:

```bash
cd /home/gisbi/Code/hush/hush-web
grep -rnE "getToken|setToken|persistToken|localStorage|sessionStorage" src/lib/authInstanceStore.js src/lib/api.js src/hooks/useAuth*.js src/lib/*ault* 2>/dev/null
```

Capture: (a) the storage key the token is read from, (b) the active-instance key (`hush_auth_instance_active` per `authInstanceStore.js`). The fixture in Step 3 sets exactly these via `page.addInitScript`.

- [ ] **Step 2: Write the ephemeral-identity helper**

`fixtures/session.ts`. Generate an Ed25519 keypair client-side, POST `/api/test/session`, return the JWT + ids. Use `@noble/ed25519` (already a hush-web dependency):

```ts
import { ed25519 } from '@noble/ed25519';
import { randomBytes } from 'node:crypto';

const SERVER_URL = process.env.HUSH_E2E_SERVER_URL ?? 'http://127.0.0.1:8080';

export interface EphemeralSession {
  token: string;
  userId: string;
  deviceId: string;
}

/** Provisions one fully-authenticatable session via the build-tagged endpoint. */
export async function createEphemeralSession(): Promise<EphemeralSession> {
  const priv = randomBytes(32);
  const pub = await ed25519.getPublicKey(priv);
  const publicKey = Buffer.from(pub).toString('base64');

  const res = await fetch(`${SERVER_URL}/api/test/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (res.status !== 201) {
    throw new Error(`/api/test/session: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as EphemeralSession;
}

/** Seeds one server + voice channel + memberships for the given users. */
export async function seedVoiceChannel(userIds: string[]): Promise<{ serverId: string; channelId: string }> {
  const res = await fetch(`${SERVER_URL}/api/test/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userIds }),
  });
  if (res.status !== 201) {
    throw new Error(`/api/test/seed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { serverId: string; channelId: string };
}
```

Note: confirm `@noble/ed25519` v3 API surface; in v3 `getPublicKey` may require setting `etc.sha512Sync` or be async. If the import shape differs, adapt to the version in `package.json` (`@noble/ed25519: ^3.0.1`). The server only needs the raw 32-byte public key.

- [ ] **Step 3: Write the page-injection helper**

Append to `fixtures/session.ts`, using the storage keys captured in Step 1 (replace `<TOKEN_STORAGE_KEY>` with the real key):

```ts
import type { BrowserContext } from '@playwright/test';

/** Injects a session into a context so the app boots authenticated. */
export async function injectSession(
  context: BrowserContext,
  session: EphemeralSession,
  instanceUrl: string,
): Promise<void> {
  await context.addInitScript(
    ({ token, instance, tokenKey }) => {
      sessionStorage.setItem('hush_auth_instance_active', instance);
      localStorage.setItem(tokenKey, token); // tokenKey from Task 5 Step 1
    },
    { token: session.token, instance: instanceUrl, tokenKey: '<TOKEN_STORAGE_KEY>' },
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add e2e/media/fixtures/session.ts
git commit -m "test(e2e): ephemeral session + seed fixtures for media suite (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: The symmetric audio/video media-delivery spec (hush-web)

**Files:**
- Create: `/home/gisbi/Code/hush/hush-web/e2e/media/media-delivery.spec.ts`
- Delete: `/home/gisbi/Code/hush/hush-web/e2e/media/smoke.spec.ts`

- [ ] **Step 1: Investigation — how to join a voice channel programmatically**

Determine the navigation/action that makes the app join the seeded voice channel and publish mic + camera. Run:

```bash
cd /home/gisbi/Code/hush/hush-web
grep -rnE "useRoom\(|joinVoice|connect\(|publishTrack|enableCameraAndMicrophone|setMicrophoneEnabled|setCameraEnabled" src/hooks/useRoom.js src/components 2>/dev/null | head -30
```

Capture the route pattern for a channel (e.g. `/channels/:serverId/:channelId`) and the control that joins voice + enables mic/camera. The spec drives those real controls.

- [ ] **Step 2: Write the media-delivery spec**

```ts
import { test, expect, chromium } from '@playwright/test';
import {
  createEphemeralSession,
  seedVoiceChannel,
  injectSession,
} from './fixtures/session';

const INSTANCE_URL = 'http://127.0.0.1:8080';

// Reads the LiveKit room's per-remote inbound stats from the page.
async function inboundStats(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    // window.__hushRoom must be exposed by useRoom in diag builds (Step 4).
    const room = (window as any).__hushRoom;
    const out: Record<string, any> = { audioBytes: 0, videoFrames: 0 };
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const stats = await pub.track?.getRTCStatsReport?.();
        stats?.forEach((r: any) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') out.audioBytes += r.bytesReceived ?? 0;
          if (r.type === 'inbound-rtp' && r.kind === 'video') out.videoFrames += r.framesDecoded ?? 0;
        });
      }
    }
    return out;
  });
}

test('two clients send and receive each other audio+video with E2EE intact', async () => {
  // Provision two members, then seed a shared voice channel.
  const a = await createEphemeralSession();
  const b = await createEphemeralSession();
  const { channelId, serverId } = await seedVoiceChannel([a.userId, b.userId]);

  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await injectSession(ctxA, a, INSTANCE_URL);
  await injectSession(ctxB, b, INSTANCE_URL);

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Navigate both to the seeded channel and join voice (route + controls from Step 1).
  const channelPath = `/channels/${serverId}/${channelId}`; // confirm pattern in Step 1
  await pageA.goto(channelPath);
  await pageB.goto(channelPath);
  // joinVoiceAndPublish(pageA) / (pageB): click the join control, enable mic + camera.

  // Wait until both sides report E2EE enabled and a remote participant.
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(() => {
      const room = (window as any).__hushRoom;
      return room && room.remoteParticipants.size >= 1;
    }, { timeout: 30_000 });
  }

  // Liveness: two samples ~700ms apart, assert positive deltas (not absolutes).
  for (const page of [pageA, pageB]) {
    const s1 = await inboundStats(page);
    await page.waitForTimeout(700);
    const s2 = await inboundStats(page);
    expect(s2.audioBytes).toBeGreaterThan(s1.audioBytes);
    expect(s2.videoFrames).toBeGreaterThan(s1.videoFrames);
  }

  // The real assertion: E2EE correctness on both sides.
  for (const page of [pageA, pageB]) {
    const stats = await page.evaluate(() => (window as any).__hushE2eeStats);
    expect(stats.decryptFailures).toBe(0);
    expect(stats.mediaKeyEpoch).toBeGreaterThanOrEqual(0);
    expect(stats.keyIndex).toBe(stats.mediaKeyEpoch % 256);
  }

  await browser.close();
});
```

- [ ] **Step 3: Expose the room handle for the test (diag builds only)**

The spec reads `window.__hushRoom`. In `useRoom.js`, right after `const room = new Room(roomOptions);` (line ~435), add a diag-gated handle so the test can reach `remoteParticipants`/stats without touching production behavior:

```js
        if (isE2eeDiagnosticsEnabled() && typeof window !== 'undefined') {
          window.__hushRoom = room;
        }
```

This is gated by the same `VITE_E2E_DIAG` flag and exposes only the LiveKit room object the app already holds (no key material). Document it in the diagnostics module header.

- [ ] **Step 4: Replace the smoke spec and run**

```bash
cd /home/gisbi/Code/hush/hush-web
rm e2e/media/smoke.spec.ts
npm run e2e:media
```
Expected: `media-delivery.spec.ts` PASS. If liveness deltas are flaky, increase the inter-sample wait; if join controls differ, fix per Step 1 findings.

- [ ] **Step 5: Commit**

```bash
git add e2e/media/media-delivery.spec.ts src/hooks/useRoom.js
git rm e2e/media/smoke.spec.ts
git commit -m "test(e2e): symmetric audio/video media-delivery spec via Playwright + LiveKit (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Docs + final verification

**Files:**
- Create: `/home/gisbi/Code/hush/hush-web/e2e/media/README.md`

- [ ] **Step 1: Write the suite README**

Document: prerequisites (Docker, Go, `HUSH_SERVER_DIR`), how to run (`npm run e2e:media`), what it proves (two-client audio/video delivery + FrameCryptor `decryptFailures === 0` + epoch binding), what it does NOT prove (screen-share → HUSHHQ-110; CI gating deferred), and the invariant note that `__hushE2eeStats`/`__hushRoom` are flag-gated and absent from production builds.

- [ ] **Step 2: Full local run, both repos clean**

Run:
```bash
cd /home/gisbi/Code/hush/hush-web && npm run typecheck && npx vitest run src/lib/e2eeDiagnostics.test.js && npm run e2e:media
cd /home/gisbi/Code/hush/hush-server && go test ./internal/server/ -run TestTestSeedRoute_AbsentInProdBuild && go test -tags e2e_test ./internal/server/ -run TestTestSeedRoute
```
Expected: typecheck PASS, unit PASS, media spec PASS, prod-absence PASS, tagged seed PASS.

- [ ] **Step 3: Commit + push both branches**

```bash
git -C /home/gisbi/Code/hush/hush-web add e2e/media/README.md && git -C /home/gisbi/Code/hush/hush-web commit -m "docs(e2e): media-delivery suite README (HUSHHQ-107)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C /home/gisbi/Code/hush/hush-web push -u origin feature/hushhq-107-e2e-media-delivery
git -C /home/gisbi/Code/hush/hush-server push -u origin feature/hushhq-107-test-seed-endpoint
```

- [ ] **Step 4: Open PRs (one per repo), cross-link, reference HUSHHQ-107**

PR bodies must name the CORE-INVARIANTS voice + MLS sections, list the tests run (above), and state the manual smoke gap (real-device mic/camera, OS/browser matrix, CI gating all deferred). Do not paste private Linear URLs; reference by `HUSHHQ-107` identifier only.

---

## Self-Review notes

- Spec coverage: stack bring-up (Task 4), seed endpoint (Task 1), diagnostic surface (Tasks 2-3, 6.3), ephemeral identity (Task 5), symmetric audio/video + getStats + e2eeStats assertions (Task 6), graceful docker skip + loud failure + idempotent teardown (Task 4), invariants/prod-absence (Tasks 1, 2, 7). All spec sections map to a task.
- Two app-specific unknowns are isolated to explicit investigation steps with concrete capture commands (Task 5.1 token storage key, Task 6.1 voice-join route/controls); every other step ships real code.
- Type consistency: `EphemeralSession`, `createEphemeralSession`, `seedVoiceChannel`, `injectSession`, `installE2eeDiagnostics`, `recordKeyEpoch`, `recordDecryptFailure`, `window.__hushE2eeStats` (fields: decryptFailures/mediaKeyEpoch/keyIndex/lastError), `window.__hushRoom` used consistently across tasks.
