# Auth / Device / Vault Lifecycle

Linear: HUSHHQ-15

This document defines the canonical lifecycle states that govern auth, device
authorization, local vault, revoke, recovery, and wipe in `hush-web`. It pairs
with `hush-web/src/lib/authLifecycle.js`, which exports the typed state set, the
existing pure planners, and the new pure `deriveAuthLifecycle(snapshot)`
derivation.

Cross references:

- `hush/docs/CORE-INVARIANTS.md` — section "Authentication, Vault, and Device Identity".
- `hush/docs/ARCHITECTURE-BOUNDARIES.md` — "Auth/device lifecycle must be modeled as named transitions."
- `hush-web/docs/security/vault-session-key.md` — vault session-key storage policy.

The goal is not a framework. It is to stop scattering lifecycle truth across
`vaultState` / `hasSession` / `needsUnlock` / `authInvalidation` /
`needsPinSetup` / `token` / `user` independently.

## Principles

1. **One pure derivation.** `deriveAuthLifecycle(snapshot)` is the single
   function that turns observable hook state into a canonical lifecycle value.
   No side effects, no storage reads, no network. Existing planners
   (`planNoTokenStartup`, `planInvalidatedSession`, `planVaultUnlockAttempt`,
   `planLocalAuthReset`, `planPinFailure`, `planAuthenticatedVaultBoot`,
   `planAuthenticatedSessionFetchFailure`, `planNoTokenLocalVaultBoot`,
   `planLocalVaultLock`) continue to own transition decisions for storage and
   network actions and are not removed.
2. **Storage actions stay in services / hooks.** IDB, localStorage,
   sessionStorage, vault session-key bridge, and transcript cache mutations
   remain in `useAuth.js` and the storage modules. The lifecycle module never
   touches the browser globals.
3. **Sticky and destructive transitions cannot regress.** A
   `device_revoked` tombstone outranks every later signal until destructive
   cleanup completes. A later `server_session_invalid` cannot downgrade it.
4. **`useBootController` reads lifecycle, never invents it.** Render gating
   for the authenticated tree depends on the canonical lifecycle value.

## Canonical States

Exported from `authLifecycle.js` as `AUTH_LIFECYCLE_STATES`.

| State | Meaning | Authenticated tree? |
|-|-|-|
| `booting` | Auth rehydration / IDB scan in progress. | No |
| `unauthenticated` | No JWT, no recoverable local vault, no invalidation marker. | No |
| `locked` | Local encrypted vault exists; PIN unlock is the next required step. May or may not have a JWT in memory yet. | No |
| `pin_setup_required` | JWT live, no PIN configured yet (post-register or post-recovery). | No (PIN setup gate) |
| `guest_authorized` | JWT for a short-lived guest session; no BIP39 identity. | Yes (guest tree) |
| `authorized` | JWT + user + vault unlocked (or vault never required). | Yes |
| `recovery_required` | Server invalidated the identity and no recoverable local vault remains (or recovery proven required). Retrying the PIN cannot help. | No |
| `revoked` | Sticky tombstone: server revoked this device. Destructive cleanup must run. | No |
| `wiping` | Transient: local vault wipe is in progress (e.g. max-PIN-failure threshold). | No |
| `wiped` | Reserved sticky one-shot after a destructive wipe. Current runtime wiring may collapse directly to `unauthenticated` until a sticky post-wipe marker is introduced. | No |

The minimum mandated by HUSHHQ-15 — `unauthenticated`, `locked`, `authorized`,
`revoked`, `wiping`, `wiped`, `recovery_required` — is fully present. The
extras (`booting`, `pin_setup_required`, `guest_authorized`) reflect existing
useAuth behavior that previously lived in legacy booleans; they remove
ambiguity instead of inventing it.

## Derivation Priority

`deriveAuthLifecycle(snapshot)` evaluates these conditions in order. The first
match wins.

1. `authInvalidation.reason === 'device_revoked'` → `revoked`.
2. `wipeInFlight === true` → `wiping`.
3. `loading === true` → `booting`.
4. Live session (`hasToken && hasUser`):
   - `needsPinSetup` → `pin_setup_required`.
   - `isGuest` → `guest_authorized`.
   - `hasLocalVault && !isVaultUnlocked` → `locked`.
   - otherwise → `authorized`.
5. No live session:
   - `authInvalidation.reason === 'server_session_invalid'`:
     - `hasLocalVault` → `locked` (PIN retry can recover).
     - else → `recovery_required`.
   - `hasLocalVault` → `locked`.
   - `wipedSticky === true` → `wiped`.
   - else → `unauthenticated`.

Inputs are observables; consumers do not pass private material.

## Transition Table

| Event | From | To | Destructive? | Owner |
|-|-|-|-|-|
| App boot start | * | `booting` | No | `useAuth` |
| Boot finds no token + no vault + no tombstone | `booting` | `unauthenticated` | No | `planNoTokenStartup` → `useAuth` |
| Boot finds no token + recoverable vault | `booting` | `locked` | No | `planNoTokenLocalVaultBoot` → `useAuth` |
| Boot finds revoked tombstone | `booting`/`unauthenticated`/`locked` | `revoked` → cleanup → `unauthenticated` | Yes | `planNoTokenStartup` + `planLocalAuthReset('device_revoked')` |
| Login / register / recovery succeeds | `unauthenticated`/`locked`/`recovery_required` | `authorized` or `pin_setup_required` | No | `useAuth.performChallengeResponse` / `performRegister` / `performRecovery` |
| Guest auth succeeds | `unauthenticated` | `guest_authorized` | No | `useAuth.performGuestAuth` |
| PIN unlock succeeds | `locked` | `authorized` | No | `useAuth.unlockVault` + `planVaultUnlockAttempt` |
| Wrong PIN below threshold | `locked` | `locked` | No | `planPinFailure` |
| Wrong PIN at threshold | `locked` | `wiping` → `unauthenticated` today; `wiping` → `wiped` → `unauthenticated` once sticky post-wipe UI is wired | Yes | `planPinFailure` + `planLocalAuthReset` |
| Manual lock / inactivity timeout | `authorized` | `locked` | No | `useAuth.lockVault` + `planLocalVaultLock` |
| Server returns `server_session_invalid` (recoverable vault) | `authorized`/`locked` | `locked` | No | `planInvalidatedSession` |
| Server returns `server_session_invalid` (no recoverable vault) | `authorized`/`unauthenticated` | `recovery_required` | No | `planInvalidatedSession` |
| Server returns `device_revoked` | * (except already revoked) | `revoked` → `unauthenticated` | Yes | `planInvalidatedSession` + `planLocalAuthReset('device_revoked')` |
| Cross-tab broadcast logout | `authorized`/`locked` | `unauthenticated` (or `locked` if vault preserved) | Partial | `planLocalAuthReset('broadcast_logout')` |
| Normal logout | `authorized`/`guest_authorized`/`pin_setup_required` | `unauthenticated` | No | `useAuth.performLogout` + `planLocalAuthReset('logout')` |

`*` means "any state". Order of priority for concurrent signals is enforced by
`deriveAuthLifecycle`: a `device_revoked` tombstone always wins, then
`wiping`, then `booting`, before any session/vault evaluation.

## Storage Side Effects Per Transition

Storage actions remain owned by `useAuth.js` and storage services. The lifecycle
module only describes what each transition implies. The action names below
match `AUTH_LIFECYCLE_ACTIONS`.

| Action | Storage effect |
|-|-|
| `DISCOVER_LOCAL_VAULT` | IDB scan for encrypted blob + localStorage marker check. Read-only. |
| `RESTORE_LOCKED_LOCAL_VAULT` | Mark vault locked in memory; no plaintext loaded. |
| `RESTORE_UNLOCKED_SESSION` | Hydrate `/api/auth/me` user; no vault unlock. |
| `KEEP_AUTHENTICATED_SESSION_LOCKED` | Keep JWT, surface locked state until `/api/auth/me` reaches server. |
| `INVALIDATE_SERVER_SESSION` | Persist `authInvalidation` marker (localStorage) so reload preserves the reason. |
| `DESTROY_REVOKED_DEVICE_STATE` | Delete vault IDB blobs, vault session-key (browser + desktop bridge), local device id, transcript cache, JWT, persisted invalidation marker. |
| `UNLOCK_LOCAL_VAULT` | Derive identity key in memory; hydrate transcript cache; arm inactivity timer. |
| `BLOCK_REVOKED_DEVICE_UNLOCK` | Refuse the PIN attempt and run `DESTROY_REVOKED_DEVICE_STATE`. |
| `LOCK_LOCAL_VAULT` | Clear identity from memory; clear session keys; clear transcript cache. Encrypted blob remains. |
| `REJECT_WRONG_PIN` | Increment PIN failure counter; no destructive action. |
| `WIPE_LOCAL_VAULT_AFTER_PIN_FAILURES` | Delete encrypted vault blob + session keys + transcript cache + JWT. Failure counter cleared after wipe. |
| `RESET_LOCAL_AUTH_STATE` | Clear in-memory user/token; per reason, clear or preserve transcript cache (broadcast logout preserves it). |
| `CLEAR_STALE_LOCAL_VAULT_MARKER` | Remove the localStorage marker when no actual vault blob exists. |

The destructive-vs-recoverable boundary lives in two places: the
`shouldDestroyLocalDeviceState` / `shouldWipeLocalVault` flags returned by the
existing planners, and the `revoked` / `wiping` / `wiped` lifecycle states
returned by `deriveAuthLifecycle`. The two are designed to be consistent: any
planner that returns `shouldDestroyLocalDeviceState: true` produces inputs that
make `deriveAuthLifecycle` return `revoked`.

Current implementation status: `revoked` is wired through `useAuth` and
`useBootController`. `wiping` and `wiped` are present in the canonical pure
derivation and tests, but the production hook does not yet expose sticky
`wipeInFlight` / `wipedSticky` runtime flags. Today, max-PIN destructive wipe
executes the storage deletion and then lands on `unauthenticated`.

## Mapping To Legacy Fields Exported By `useAuth`

`useAuth.js` continues to expose the same fields it always has. The new
`lifecycle` field is the canonical view; legacy fields are kept as
compatibility shims so existing components do not need to change at the same
time.

| Legacy field | Derivable from canonical lifecycle? | Notes |
|-|-|-|
| `loading` | `lifecycle === 'booting'` | Drives boot-controller `'loading'`. |
| `vaultState` ('none' / 'locked' / 'unlocked') | `authorized`/`guest_authorized` → 'unlocked'; `locked`/`recovery_required` (when local vault is present) → 'locked'; everything else → 'none'. | Kept verbatim for compat. |
| `hasSession` | `authorized` / `guest_authorized` / `pin_setup_required`. | A `locked` state may still have a token if PIN unlock is pending mid-session. |
| `isAuthenticated` | Equivalent to `hasSession`. | |
| `needsUnlock` | `lifecycle === 'locked'`. | |
| `needsPinSetup` | `lifecycle === 'pin_setup_required'`. | |
| `isGuest` | `lifecycle === 'guest_authorized'`. | |
| `authInvalidation.reason` | `revoked` (when reason === 'device_revoked'); `recovery_required` (when reason === 'server_session_invalid' and no recoverable vault). | Persisted invalidation marker stays the source of truth for the reason. |

Consumers should prefer `lifecycle` going forward. Legacy boolean fields are
guaranteed to remain consistent with `lifecycle` (the canonical value is
derived from the same inputs that drive them).

## Rendering Expectations For `useBootController`

`useBootController` continues to return the existing boot states. After this
change, it ALSO honors the canonical lifecycle so the authenticated route tree
cannot render for destructive or recovery-required states:

| Lifecycle | Boot state surfaced |
|-|-|
| `wiping` | `loading` (a destructive in-flight transition must not render the auth tree or the PIN screen; it must look like a blocked boot). |
| `revoked` | `needs_login` (after destructive cleanup, the user must re-authenticate from scratch). |
| `wiped` | `needs_login` (reserved post-wipe surface once sticky wipe UI is wired). |
| `recovery_required` | `needs_login` (PIN cannot help; route to mnemonic recovery / re-register from the login surface). |
| every other lifecycle | unchanged: `loading` / `needs_pin` / `needs_login` / `pin_setup` / `transparency_error` / `ready` / `booted`. |

Tests in `useBootController.test.jsx` cover the gating for `revoked`,
`wiping`, `wiped`, and `recovery_required`.

## Retry / Reload Behavior

| Surface | Behavior |
|-|-|
| `device_revoked` | One-shot destructive. Refresh / re-open desktop app lands on `unauthenticated`. No PIN screen is shown — the tombstone was cleared together with the encrypted blob. |
| Normal logout | Refresh → `unauthenticated`. Transcript cache cleared. |
| Broadcast logout | Refresh → `locked` if the vault blob is still on disk; transcript cache is preserved. |
| Expired / invalid server session (recoverable vault) | Refresh → `locked`. User re-enters PIN; identity key + JWT are re-derived. |
| Expired / invalid server session (no recoverable vault) | Refresh → `recovery_required`. User must run mnemonic recovery or re-register. |
| Wrong PIN below threshold | Refresh → `locked` with the persisted failure counter intact. |
| Wrong PIN at threshold (wipe) | Refresh → `unauthenticated`. Current runtime does not yet preserve a sticky one-render wipe message. |

## Non-Goals

- No XState / no Zustand for this slice. The whole module is plain JS,
  consistent with `hush/docs/ARCHITECTURE-BOUNDARIES.md`.
- No refactor of `useAuth.js` beyond the smallest change required to expose
  `lifecycle`.
- No UI-component rewrites. Boot controller integration is the only mandatory
  consumer change in this pass.
- No movement of storage / crypto side effects into UI components.
- No server changes. The server contract (RequireAuth + WS hub
  device-revoke close + 401 classification by `sessionInvalidationDetector`)
  is already sufficient for this lifecycle.
