/**
 * session.ts
 *
 * Playwright fixtures for the media E2E suite.
 *
 * hush-web is an E2EE client: a server-minted JWT is not enough to reach the
 * authenticated, MLS-capable app (the boot controller gates on a real local
 * vault). So each browser client establishes a GENUINE identity by driving the
 * real register flow through the build-gated bridge (window.__hushTestAuth,
 * VITE_E2E_DIAG only), which calls the app's real performRegister + setPIN.
 *
 * Provides:
 *   openRegistration()        - flips the instance to open registration so the
 *     real register call is not rejected (fresh DB defaults to invite_only).
 *   injectInstanceSelection() - points the app at the local test server so it
 *     boots against 127.0.0.1:8090 (no JWT is planted).
 *   registerViaApp()          - runs the real register + PIN flow in-page and
 *     returns the new userId.
 *   seedVoiceChannel()        - creates a server + one voice channel and makes
 *     the given userIds members.
 */

import type { BrowserContext, Page } from '@playwright/test';
import { SERVER_URL } from '../constants.js';

interface TestAuthBridge {
  registerAndUnlock: (args: {
    username: string;
    displayName: string;
    pin: string;
    instanceUrl: string;
  }) => Promise<{ userId: string }>;
  unlock: (pin: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage keys (mirror authInstanceStore.js)
// ---------------------------------------------------------------------------

const SELECTED_INSTANCE_KEY = 'hush_auth_instance_selected';
const ACTIVE_INSTANCE_KEY = 'hush_auth_instance_active';
const MIGRATION_KEY = 'hush_auth_instance_default_origin_migrated_v1';

// Default PIN for the test vault. Six digits; never a real secret.
const TEST_PIN = '424242';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisteredUser {
  userId: string;
  username: string;
}

export interface SeededChannel {
  serverId: string;
  channelId: string;
}

// ---------------------------------------------------------------------------
// Instance preparation
// ---------------------------------------------------------------------------

/**
 * Flips the instance registration_mode to "open" via the build-tagged endpoint
 * so the real register flow is accepted. A fresh DB defaults to "invite_only".
 *
 * @throws if the server call fails.
 */
export async function openRegistration(): Promise<void> {
  const resp = await fetch(`${SERVER_URL}/api/test/open-registration`, {
    method: 'POST',
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '(unreadable body)');
    throw new Error(`POST /api/test/open-registration failed (${resp.status}): ${body}`);
  }
}

/**
 * Points the app at the local test server so it boots authenticated-capable
 * against SERVER_URL. Must be called BEFORE page.goto() so addInitScript runs
 * before the app's boot effect. No JWT is planted: the client registers a real
 * identity in-page (see registerViaApp).
 */
export async function injectInstanceSelection(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ instanceUrl, selectedKey, activeKey, migrationKey }) => {
      sessionStorage.setItem(activeKey, instanceUrl);
      localStorage.setItem(selectedKey, instanceUrl);
      // Mark the legacy-origin migration done so the app does not rewrite the
      // selected/active keys on boot.
      localStorage.setItem(migrationKey, '1');
    },
    {
      instanceUrl: SERVER_URL,
      selectedKey: SELECTED_INSTANCE_KEY,
      activeKey: ACTIVE_INSTANCE_KEY,
      migrationKey: MIGRATION_KEY,
    },
  );
}

// ---------------------------------------------------------------------------
// Registration (real flow via the build-gated bridge)
// ---------------------------------------------------------------------------

/**
 * Drives the REAL register + PIN flow in the page and returns the new userId.
 * The page must already be on the app (so E2eTestAuthBridge has mounted).
 *
 * @param page     - a page navigated to the app shell.
 * @param username - unique username for the new account.
 * @throws if the bridge never appears or registration fails.
 */
export async function registerViaApp(page: Page, username: string): Promise<RegisteredUser> {
  await waitForBridge(page);
  const result = await page.evaluate(
    async ({ username: u, instanceUrl, pin }) => {
      const bridge = (window as unknown as { __hushTestAuth: TestAuthBridge }).__hushTestAuth;
      return bridge.registerAndUnlock({ username: u, displayName: u, pin, instanceUrl });
    },
    { username, instanceUrl: SERVER_URL, pin: TEST_PIN },
  );
  return { userId: result.userId, username };
}

/**
 * Unlocks the local vault after a page reload (a reload drops the in-memory
 * identity, returning the app to needs_pin). Call after navigating to the
 * channel deep-link, before joining voice.
 */
export async function unlockViaApp(page: Page): Promise<void> {
  await waitForBridge(page);
  await page.evaluate(async (pin) => {
    const bridge = (window as unknown as { __hushTestAuth: TestAuthBridge }).__hushTestAuth;
    await bridge.unlock(pin);
  }, TEST_PIN);
}

/** Builds the voice-channel deep-link path (relative to the preview baseURL). */
export function voiceChannelPath(serverId: string, channelId: string): string {
  const host = new URL(SERVER_URL).host;
  return `/${host}/e2e--${serverId}/${channelId}`;
}

async function waitForBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as { __hushTestAuth?: unknown }).__hushTestAuth !== 'undefined',
    undefined,
    { timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Channel seeding
// ---------------------------------------------------------------------------

/**
 * Creates a server + one voice channel for the given userIds via
 * POST /api/test/seed. All listed users receive a membership in the channel.
 *
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
    throw new Error(`POST /api/test/seed failed (${resp.status}): ${body}`);
  }
  return (await resp.json()) as SeededChannel;
}
