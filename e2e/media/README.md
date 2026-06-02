# Media-delivery E2E (HUSHHQ-107)

Proves two **real** browser clients send and receive each other's audio + video
through the real server and real LiveKit, with the FrameCryptor reporting
`decryptFailures === 0` and the media key bound to the current MLS epoch. This is
the media-delivery counterpart to the protocol-level voice/chat suites in
`hush-server/internal/e2e` (HUSHHQ-106): those prove MLS convergence over the
real server; this proves audio/video actually arrive and decrypt.

## What it proves

- Two genuinely independent clients (own browser context, own storage, own real
  BIP39 identity + MLS keypackages + PIN-protected vault) join the same voice
  channel through the real server and real LiveKit.
- Inbound RTP rises on each remote (audio `bytesReceived`, video `framesDecoded`).
- FrameCryptor `decryptFailures === 0`, media key epoch is bound, and the active
  key index equals `epoch % 256`.

## What it does NOT prove

- Screen-share send/receive (HUSHHQ-110).
- Real-device capture (Chromium fake media devices are used).
- OS/browser matrix (Chromium-on-host only).
- CI gating (deferred; runs locally).

## Why real registration, not a JWT shortcut

hush-web is an E2EE client. A server-minted JWT is **not** enough to reach the
authenticated, MLS-capable app: the boot controller gates on a real local vault
(PIN-protected BIP39 identity), so an injected token lands on the PIN-unlock
screen, a dead end. Each client therefore establishes a genuine identity by
driving the app's **real** `performRegister` + `setPIN` through a build-gated
bridge (`window.__hushTestAuth`). It fakes nothing: real identity derivation,
real keypackage upload, real encrypted vault. Only the onboarding UI clicks are
bypassed.

## Architecture

- **Postgres**: a dedicated **throwaway** container (`hush-e2e-postgres`,
  ephemeral, no volume, db `hush_e2e`). It is **never** the dev `hush-postgres`
  container or its volume. Teardown removes it, so every registered account is
  destroyed with the database. There is no `docker compose down` against the dev
  stack anywhere.
- **LiveKit**: the already-running dev LiveKit on `:7880` is reused (stateless,
  no persistent data; already configured for local 127.0.0.1 media). The server
  hands the browser `LIVEKIT_PUBLIC_URL=ws://127.0.0.1:7880` so it connects
  directly (the e2e stack has no reverse proxy fronting `/livekit`).
- **Server**: built with `-tags e2e_test` and run natively on `:8090` (the dev
  `hush-api` owns `:8080`). It auto-migrates the throwaway db on boot.
- **Web**: `vite preview` of a `VITE_E2E_DIAG=1` build, which enables the
  build-gated bridge and the `__hushE2eeStats` / `__hushRoom` diagnostic surface.

## Build-tagged / build-gated test surfaces

These exist only in test builds and are asserted absent from production:

- Server `/api/test/{session,seed,open-registration}` — compiled in only under
  `-tags e2e_test`; `BuildServer` prod-absence tests assert 404 in shipped builds.
- Web `window.__hushTestAuth` (register/unlock bridge) and `window.__hushE2eeStats`
  / `window.__hushRoom` — installed only when `VITE_E2E_DIAG` is set; the unit
  tests assert they are undefined otherwise. No key material crosses any of them.

## Run it

Requires Docker (the dev LiveKit on `:7880`) and Go.

```bash
# from hush-web/
HUSH_SERVER_DIR=../hush-server npm run e2e:media
```

`globalSetup` starts the throwaway postgres, verifies the dev LiveKit, builds and
spawns the e2e server, and stands up the preview build. `globalTeardown` kills the
server and removes the throwaway postgres (the dev stack is untouched).

## Manual smoke gaps

Real-device mic/camera, screen-share, and an OS/browser matrix are not exercised
here. A short two-real-browser voice smoke (talk/listen, video on/off,
leave/rejoin) remains worth doing once as belt-and-suspenders.
