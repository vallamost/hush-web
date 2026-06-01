/**
 * session.ts
 *
 * Playwright fixtures for the media E2E suite.
 *
 * Provides:
 *   createEphemeralSession() - provisions a server-side test user + session and
 *     returns the token, userId, deviceId, and the raw Ed25519 keypair.
 *   seedVoiceChannel()       - creates a server + one voice channel for a set
 *     of userIds.
 *   injectSession()          - populates browser storage so the app boots in
 *     an authenticated state against the local test server, bypassing the
 *     login/register UI entirely.
 *
 * Authentication injection strategy (discovered from codebase analysis):
 *
 * The app (useAuth.js) determines its authenticated state as follows on boot:
 *   1. Reads the token from sessionStorage under the key `hush_jwt_<host>`,
 *      where `<host>` is derived from the active instance URL (e.g.
 *      `hush_jwt_127.0.0.1:8080` for SERVER_URL = http://127.0.0.1:8080).
 *   2. Calls GET /api/auth/me on the active instance with that token.
 *   3. If the response is 200 OK and no vault evidence exists in localStorage
 *      (`hush_vault_user_<userId>`), the app treats the vault as not set up and
 *      transitions to vaultState='unlocked', hasLocalVault=false.
 *   4. The boot controller resolves to lifecycle=AUTHORIZED, bootState='ready'
 *      or 'booted', and mounts the authenticated route tree.
 *
 * Required storage state (all set before page.goto()):
 *   sessionStorage:
 *     hush_jwt_127.0.0.1:8080         = <JWT token>
 *     hush_auth_instance_active        = "http://127.0.0.1:8080"
 *   localStorage:
 *     hush_auth_instance_selected      = "http://127.0.0.1:8080"
 *     hush_auth_instance_default_origin_migrated_v1 = "1"
 *
 * No IndexedDB or vault material is required because the absence of
 * `hush_vault_user_<userId>` in localStorage causes the app to take the
 * RESTORE_UNLOCKED_SESSION branch, which skips PIN/vault entirely.
 *
 * The private key returned by createEphemeralSession() is available for
 * callers that need to perform MLS or voice operations from the fixture.
 */

import type { BrowserContext } from '@playwright/test';
import { sha512 } from '@noble/hashes/sha2.js';
import * as ed from '@noble/ed25519';
import { SERVER_URL } from '../constants.js';

// Wire the synchronous sha512 implementation required by @noble/ed25519 v3.
// Without this, the sync keygen() API throws "hashes.sha512 not set".
ed.hashes.sha512 = sha512;

// ---------------------------------------------------------------------------
// Storage key derivation (mirrors authInstanceStore.js + useAuth.js)
// ---------------------------------------------------------------------------

const JWT_KEY_PREFIX = 'hush_jwt';
const SELECTED_INSTANCE_KEY = 'hush_auth_instance_selected';
const ACTIVE_INSTANCE_KEY = 'hush_auth_instance_active';
const MIGRATION_KEY = 'hush_auth_instance_default_origin_migrated_v1';

/**
 * Derives the sessionStorage key for a given instance URL.
 * Mirrors jwtKeyForInstance() in useAuth.js.
 *
 * @param instanceUrl - e.g. "http://127.0.0.1:8080"
 * @returns e.g. "hush_jwt_127.0.0.1:8080"
 */
function jwtKeyForInstance(instanceUrl: string): string {
  const url = new URL(instanceUrl);
  return `${JWT_KEY_PREFIX}_${url.host}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EphemeralSession {
  token: string;
  userId: string;
  deviceId: string;
  privKey: Uint8Array;
  pubKeyB64: string;
}

export interface SeededChannel {
  serverId: string;
  channelId: string;
}


// ---------------------------------------------------------------------------
// createEphemeralSession
// ---------------------------------------------------------------------------

/**
 * Generates a fresh Ed25519 identity and provisions a server-side test
 * user + session via POST /api/test/session.
 *
 * Returns the token, userId, deviceId, and both halves of the keypair.
 * The private key is needed by callers that perform MLS operations; it is
 * not persisted to any storage by injectSession (the test user has no vault).
 *
 * @throws if the server call fails.
 */
export async function createEphemeralSession(): Promise<EphemeralSession> {
  const { secretKey, publicKey } = ed.keygen();
  const pubKeyB64 = Buffer.from(publicKey).toString('base64');

  const resp = await fetch(`${SERVER_URL}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Empty username lets the server mint a unique `e2e-<uuid>` display name
    // so repeated runs against a persistent test DB never collide.
    body: JSON.stringify({ username: '', publicKey: pubKeyB64 }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '(unreadable body)');
    throw new Error(
      `POST /api/test/session failed (${resp.status}): ${body}`,
    );
  }

  const { token, userId, deviceId } = (await resp.json()) as {
    token: string;
    userId: string;
    deviceId: string;
  };

  return { token, userId, deviceId, privKey: secretKey, pubKeyB64 };
}

// ---------------------------------------------------------------------------
// seedVoiceChannel
// ---------------------------------------------------------------------------

/**
 * Creates a server + one voice channel for the given userIds via
 * POST /api/test/seed. All listed users receive a membership in the channel.
 *
 * @param userIds - array of userId strings to include as members.
 * @throws if the server call fails.
 */
export async function seedVoiceChannel(userIds: string[]): Promise<SeededChannel> {
  const resp = await fetch(`${SERVER_URL}/api/test/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '(unreadable body)');
    throw new Error(
      `POST /api/test/seed failed (${resp.status}): ${body}`,
    );
  }

  const { serverId, channelId } = (await resp.json()) as {
    serverId: string;
    channelId: string;
  };

  return { serverId, channelId };
}

// ---------------------------------------------------------------------------
// injectSession
// ---------------------------------------------------------------------------

/**
 * Populates browser storage so the app, when it loads PREVIEW_URL, boots into
 * an authenticated state without going through the login/register UI.
 *
 * Must be called BEFORE page.goto() so that addInitScript fires on the first
 * navigation. Playwright's addInitScript runs before any page script, including
 * the React app's boot effect.
 *
 * What gets set (all via addInitScript so it runs in the page context):
 *
 *   sessionStorage:
 *     hush_jwt_<host>             = session.token
 *     hush_auth_instance_active   = instanceUrl
 *
 *   localStorage:
 *     hush_auth_instance_selected                       = instanceUrl
 *     hush_auth_instance_default_origin_migrated_v1     = "1"
 *
 * The vault user marker (hush_vault_user_<userId>) is intentionally NOT set.
 * Its absence causes the app to take the RESTORE_UNLOCKED_SESSION branch on
 * authenticated boot, which reaches vaultState='unlocked' without prompting
 * for a PIN. The server-issued JWT is valid so /api/auth/me succeeds.
 *
 * @param context     - Playwright BrowserContext to inject into.
 * @param session     - The EphemeralSession returned by createEphemeralSession().
 */
export async function injectSession(
  context: BrowserContext,
  session: EphemeralSession,
): Promise<void> {
  const instanceUrl = SERVER_URL;
  const jwtKey = jwtKeyForInstance(instanceUrl);

  await context.addInitScript(
    ({ jwtKey: jk, token, instanceUrl: iu, selectedKey, activeKey, migrationKey }) => {
      // sessionStorage: JWT under the per-instance namespaced key.
      sessionStorage.setItem(jk, token);
      // sessionStorage: mark this instance as the active one for this session.
      sessionStorage.setItem(activeKey, iu);
      // localStorage: persist the selected instance so it survives across
      // sessionStorage-clearing events (tab open, etc.).
      localStorage.setItem(selectedKey, iu);
      // localStorage: mark the legacy-origin migration as done so the app
      // does not attempt to rewrite the selected/active keys on boot.
      localStorage.setItem(migrationKey, '1');
    },
    {
      jwtKey,
      token: session.token,
      instanceUrl,
      selectedKey: SELECTED_INSTANCE_KEY,
      activeKey: ACTIVE_INSTANCE_KEY,
      migrationKey: MIGRATION_KEY,
    },
  );
}
