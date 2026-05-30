# Changelog

All notable user-facing changes to the Hush web and desktop client are
recorded here. Format is loosely based on Keep a Changelog. Dates are ISO
8601. Versions track the `hush-web` package version.

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
