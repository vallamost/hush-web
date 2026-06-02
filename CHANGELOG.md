# Changelog

All notable user-facing changes to the Hush web and desktop client are
recorded here. Format is loosely based on Keep a Changelog. Dates are ISO
8601. Versions track the `hush-web` package version.

## [0.7.0-alpha.28] - 2026-06-02

### Fixed
- Desktop: channel hover and the active-channel highlight are now clearly
  visible whether the translucency (glass) effect is on or off, and no longer
  wash out depending on the desktop wallpaper behind the window. The bottom
  user menu and voice controls got the same treatment, and the message composer
  now lines up with the user menu. (HUSHHQ-123)
- The audio output picker no longer shows a stray description line, matching the
  microphone and camera pickers. (HUSHHQ-127)

## [0.7.0-alpha.27] - 2026-06-02

### Added
- Voice channels now play a short sound when someone joins or leaves a channel,
  and when a screen-share starts or ends. You hear your own actions too, and
  switching channels plays the leave then the join. (HUSHHQ-119)

### Fixed
- Screen sharing on the macOS desktop app: picking a window or screen now
  actually starts the share instead of silently doing nothing. (HUSHHQ-108)
- Device linking no longer gets stuck on "a previous device-link transfer is
  still occupying the server slot" (HTTP 409) after an interrupted transfer; the
  orphaned transfer slot is now released and the next attempt recovers in the
  same session. (HUSHHQ-101)

### Internal
- Added headless and real-browser (Playwright + LiveKit) end-to-end test suites
  covering two-client voice/video media delivery and chat, plus the voice/MLS
  convergence regressions below. No user-facing change. (HUSHHQ-106, HUSHHQ-107)

## [0.7.0-alpha.21 to 0.7.0-alpha.26] - 2026-05-31 to 2026-06-01

### Fixed
- Voice and video reliability: participants in a voice channel could fail to
  hear or see each other, with repeated decryption failures in the logs. Fixed
  the voice MLS group failing to converge on external join (clients now
  subscribe to the voice channel topic so encryption-key commits are delivered),
  on rejoin after the room emptied, and around member add/removal key handling.
  (HUSHHQ-104, HUSHHQ-105, HUSHHQ-97, HUSHHQ-99)

## [0.7.0-alpha.20] - 2026-05-30

### Added
- Desktop: native window chrome with the in-app title bar, plus update-flow and
  "What's new" UX refinements. (HUSHHQ-92)

### Fixed
- Desktop: drag-and-drop interactions (including the channel sidebar drag
  preview) no longer misbehave under the custom title bar. (HUSHHQ-92)

## [0.7.0-alpha.19] - 2026-05-29

### Added
- Outdated-server notice: the client now reads the server version from the
  handshake and warns, without blocking, when the connected instance runs a
  server older than this client recommends. An old but working instance stays
  usable; the notice advises asking the instance admin to update.
- Invite landing page: opening an invite link in a browser on a backend-only
  instance now shows the invite code and clear join instructions instead of
  the raw backend message.
- "What's new" note surfaced after updates, including a founder message.

### Known issues
- The Windows desktop build is not yet code-signed, so the in-app auto-update
  cannot complete: the app may restart but stay on the old version. Until
  Windows signing lands, update Windows manually by downloading the latest
  installer from the releases page. macOS (signed and notarized) and Linux
  AppImage auto-update normally; Linux deb updates via your package manager.
