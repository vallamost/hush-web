# E2E media-delivery (audio/video) via Playwright + LiveKit: design

Linear: HUSHHQ-107 (parent HUSHHQ-106). Screen-share is the deferred sibling
HUSHHQ-110 and is out of scope here.

Status: approved design, local-first scope (no CI this milestone).

## Goal

Prove that two real browser clients, joined to the same voice channel through
the real server and real LiveKit, actually send and receive each other's audio
and video, and that FrameCryptor E2EE decryption succeeds (`decryptFailures ===
0`) with the media key bound to the current MLS epoch.

This is the browser/WebRTC/FrameCryptor layer that the merged HUSHHQ-106 harness
explicitly does NOT cover. HUSHHQ-106 is headless (no browser, no LiveKit) and
proves only protocol-level MLS convergence and bidirectional AES-GCM decrypt.

## Scope (this milestone)

In:

- Audio + video symmetric smoke: A and B both publish fake mic + camera, each
  asserts it receives the other.
- Liveness via `getStats()` and E2EE correctness via a test-only diagnostic
  surface.
- Runnable locally on Linux + Chromium via `npm run e2e:media`.

Out (YAGNI for now):

- CI gating, OS/browser matrix, nightly runs.
- Screen-share (HUSHHQ-110).
- React rendering / message-list / notification assertions.
- Electron/desktop media paths.

## Core invariants

Touches CORE-INVARIANTS **voice** and **MLS**. The implementation PR must name
these sections, list targeted tests/checks run, and state manual smoke gaps.
The diagnostic surface must expose counters/epoch/key-index ONLY: never raw
frame keys, exporter secrets, private keys, or plaintext.

## Reuse vs new

Reused from HUSHHQ-106 (verified present on `main`):

- `/api/test/session` build-tagged endpoint
  (`hush-server/internal/server/test_routes.go`, `-tags e2e_test`). Confirmed
  reachable on the real listening binary: `cmd/hush/main.go` calls
  `server.BuildServer`, which calls `registerTestRoutes` (server.go:199). The
  untagged build compiles the no-op in `test_routes_prod.go`; absence in prod is
  proven by `test_routes_absent_test.go`.
- `server.BuildServer` (the real server, booted natively).
- The ephemeral-identity pattern: client-side Ed25519 key, POST `publicKey`,
  receive JWT (as in `e2e/harness/client.mjs`).
- The existing LiveKit dev service in `hush-server/docker-compose.yml`
  (`livekit/livekit-server:v1.10.1` + `livekit/livekit.yaml`).

New in this milestone:

1. `hush-server`: a build-tagged `/api/test/seed` endpoint (sibling of
   `/api/test/session`, same `-tags e2e_test` file) that creates a server, a
   voice channel, and memberships, returning their IDs. The Go harness seeded
   the DB directly; Playwright has no DB handle, so it seeds over HTTP. Excluded
   from prod by the same no-op mechanism; extend `test_routes_absent_test.go` to
   assert `/api/test/seed` is also 404 in untagged builds.
2. `hush-web`: a test-only diagnostic surface `window.__hushE2eeStats`.
3. `hush-web`: a Playwright project under `e2e/media/` (config, globalSetup,
   webServer, spec, fixtures).

## Architecture: local stack bring-up (hybrid)

Chosen approach B (hybrid). Rejected: A (full docker-compose with the app image
rebuilt under the test tag) for a slow change loop; C (manual prerequisites) for
poor reproducibility.

Layers:

- **Stateful externals via docker-compose**: postgres + livekit only, reusing
  the services already defined in `hush-server/docker-compose.yml`. Brought up
  by Playwright `globalSetup`, torn down by global teardown.
- **Real server natively**: `go run -tags e2e_test ./cmd/hush`, pointed at the
  compose postgres + livekit. This exposes `/api/test/session` and
  `/api/test/seed`. No new server entrypoint and no `BuildServer` change; only
  the seed handler is added.
- **Web app via vite preview**: Playwright `webServer` runs `vite preview`
  against a production build of hush-web with the diagnostic flag enabled.

`globalSetup` ordering: compose up (wait postgres healthy, livekit ready) ->
start tagged server (wait `/healthz`) -> Playwright starts `webServer`. Teardown
always stops the server process and `docker compose down` to avoid orphan
containers, even on failure.

Graceful skip: when Docker is unavailable, `npm run e2e:media` skips with a
clear message rather than failing, mirroring the Go harness skip behavior. This
suite is a dedicated script, never part of the default `npm test`.

## Component: `window.__hushE2eeStats` diagnostic surface

Shape (counters/epoch/index ONLY):

```ts
interface HushE2eeStats {
  decryptFailures: number;   // cumulative FrameCryptor decrypt failures
  mediaKeyEpoch: number;     // MLS epoch the active media key derives from
  keyIndex: number;          // active key index == epoch % 256
  lastError: string | null;  // last FrameCryptor error name, no key material
}
```

- Lives in `hush-web`, attached to `window` only when a build/env flag is set
  (e.g. `import.meta.env.VITE_E2E_DIAG === '1'`), so production bundles never
  define it. Verified by a unit test asserting it is undefined without the flag.
- Populated in `src/hooks/useRoom.js` (LiveKit Room + E2EE wiring) from
  FrameCryptor error/key events, and the MLS epoch read from `src/hooks/useMLS.js`.
- Exposes derived counters only. It must never read or surface the frame key,
  exporter secret, or any plaintext.

## Component: Playwright project (`e2e/media/`)

- `playwright.config.ts`: single Chromium project, Linux headless (`--headless=new`
  not required for camera/mic but kept consistent), `launchOptions.args` include
  `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`.
  Optional `.y4m`/`.wav` fixtures for deterministic frames/tone (optional this
  milestone). `webServer` runs `vite preview`. `globalSetup`/`globalTeardown`
  own the compose + server lifecycle.
- `fixtures/session.ts`: generates an ephemeral Ed25519 identity client-side,
  POSTs `/api/test/session`, returns the JWT/userId/deviceId, and injects the
  session into the app the same way the real client does.
- `media-delivery.spec.ts`: the symmetric two-context test below.

## Data flow: the test

1. `globalSetup` brings up the stack and calls `/api/test/seed` once to create
   the server, one voice channel, and two memberships; it returns the channel id
   and the two member identities.
2. Two isolated browser contexts A and B (no shared storage). Each gets an
   ephemeral session via `/api/test/session` mapped to one seeded membership.
3. Each context loads the app, joins the seeded voice channel, and publishes the
   fake mic + camera.
4. Per remote, assert liveness via `getStats()` (necessary, not sufficient):
   inbound audio `bytesReceived`/`packetsReceived` and (when available)
   `totalAudioEnergy` rising; inbound video `bytesReceived` and `framesDecoded`
   rising. Sampled twice ~500ms apart; assert positive deltas, never absolute
   values.
5. Per remote, assert E2EE correctness via `window.__hushE2eeStats`:
   `decryptFailures === 0`, no sustained errors, `mediaKeyEpoch` equals the
   current MLS epoch, `keyIndex === mediaKeyEpoch % 256`.
6. `framesDecoded`/`bytesReceived` alone are NOT treated as proof of E2EE
   correctness; the `__hushE2eeStats` assertion is the real gate.

## Failure handling

- DB connection / compose / livekit / server unhealthy in `globalSetup`: fail
  loud with the captured stderr; do not start the test run.
- Teardown is idempotent and always runs: stop the server process, `docker
  compose down`. No orphan containers on failure.
- Re-run / runs-twice: each run uses fresh ephemeral identities and a fresh seed
  call; no run depends on prior state. Postgres volume can be ephemeral.
- Media flakiness: poll `getStats()` with a bounded timeout and delta-based
  assertions, not single-sample absolutes.

## Verification (this milestone)

- `npm run e2e:media` green locally on Linux + Chromium.
- Unit test: `window.__hushE2eeStats` is undefined when the diag flag is unset.
- `go test ./internal/server/...` (untagged) still proves `/api/test/seed` is
  404 in production builds (extended absent-route test).
- No CI gate added this milestone (deferred, tracked under HUSHHQ-107 follow-up
  alongside HUSHHQ-110).

## Dependencies / sequencing

- This (HUSHHQ-107 local-first) lands first. HUSHHQ-110 (screen-share) reuses
  this project's harness, fixtures, and `__hushE2eeStats` surface, adding only a
  screen-share track and asymmetric topology.
