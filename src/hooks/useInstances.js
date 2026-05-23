/**
 * useInstances - central orchestration hook for multi-instance connections.
 *
 * Manages N simultaneous Hush instance connections in parallel. On mount,
 * it boots all known instances from IDB. Each boot performs:
 *   1. Handshake (public, no auth)
 *   2. Ed25519 challenge-response auth -> JWT
 *   3. Auto-register if the key is unknown to that instance
 *   4. WS connection with reconnect/backoff
 *   5. Guild fetch (stamped with instanceUrl)
 *
 * State is maintained per-instance and derives a merged guild array ordered
 * by the user's persisted preference from IDB.
 *
 * @module useInstances
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from 'react';

import { useAuth } from '../contexts/AuthContext.jsx';
import { createWsClient } from '../lib/ws.js';
import {
  openInstanceRegistry,
  saveInstance,
  getAllInstances,
  removeInstance,
  saveGuildOrder,
  getGuildOrder,
} from '../lib/instanceRegistry.js';
import { getActiveAuthInstanceUrlSync } from '../lib/authInstanceStore.js';
import {
  requestChallenge,
  verifyChallenge,
  getMyGuilds,
  fetchWithAuth,
  resolveAuthAudience,
} from '../lib/api.js';
import { signAuthChallengeV2 } from '../lib/bip39Identity.js';
import { getDeviceId, getLocalToken, getTokenForInstanceUrl } from './useAuth.js';
import {
  assertHandshakeCompatible,
  isHandshakeCompatibilityError,
} from '../lib/handshakeCompatibility';

// ── Constants ─────────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MULTIPLIER = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a Uint8Array to a base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Converts an http(s) URL to a ws(s) URL for WS connection.
 * @param {string} url
 * @returns {string}
 */
function toWsUrl(url) {
  return url.replace(/^http/, 'ws') + '/ws';
}

// ── Main hook ─────────────────────────────────────────────────────────────────

/**
 * Manages N parallel Hush instance connections, merged guild array, and
 * per-instance auth state.
 *
 * @returns {{
 *   instanceStates: Map<string, InstanceState>,
 *   mergedGuilds: Array<object>,
 *   guildsLoaded: boolean,
 *   bootInstance: (instanceUrl: string) => Promise<void>,
 *   disconnectInstance: (instanceUrl: string) => Promise<void>,
 *   getWsClient: (instanceUrl: string) => object|null,
 *   getTokenForInstance: (instanceUrl: string) => string|null,
 *   guildOrder: string[],
 *   setGuildOrder: (ids: string[]) => Promise<void>,
 *   refreshGuilds: (instanceUrl: string) => Promise<void>,
 * }}
 */
export function useInstances() {
  const { identityKeyRef, user: localUser, vaultState, loading: authLoading } = useAuth();

  /**
   * Per-instance runtime state stored in a ref (avoids stale closure issues
   * in WS callbacks). Shape per entry:
   * {
   *   wsClient,       // WS client object from createWsClient
   *   jwt,            // Current JWT string
   *   userId,         // User ID on this instance
   *   handshakeData,  // Last handshake response
   *   guilds,         // Array of guild objects stamped with instanceUrl
   *   connectionState, // 'connecting'|'connected'|'reconnecting'|'offline'
   *   reconnectAttempt, // Backoff counter
   *   reconnectTimer,   // Timer handle for backoff scheduling
   * }
   * @type {React.MutableRefObject<Map<string, object>>}
   */
  const instancesRef = useRef(new Map());

  /**
   * React state mirror of instancesRef used for rendering.
   * We keep a snapshot Map in state so consumers re-render on changes.
   * @type {[Map<string, InstanceState>, Function]}
   */
  const [instanceStates, setInstanceStates] = useState(new Map());

  /**
   * True once the initial boot sequence (IDB read + instance boot) has finished.
   * Consumers should wait for this before treating mergedGuilds as authoritative.
   */
  const [guildsLoaded, setGuildsLoaded] = useState(false);

  /**
   * Persisted guild order from IDB (array of guild IDs).
   * @type {[string[], Function]}
   */
  const [guildOrder, _setGuildOrderState] = useState([]);

  /** IDB handle, opened once on mount. */
  const dbRef = useRef(null);

  /** Monotonic generation used to discard stale async boot completions. */
  const runtimeGenerationRef = useRef(0);

  // ── Metadata extraction helper ──────────────────────────────────────────

  /** Stamp guilds with instanceUrl and extract names from base64 metadata. */
  const stampGuilds = (guilds, instanceUrl) =>
    guilds.map(g => {
      const stamped = { ...g, instanceUrl };
      if (!stamped.name && stamped.encryptedMetadata) {
        try {
          const decoded = new TextDecoder().decode(
            Uint8Array.from(atob(stamped.encryptedMetadata), c => c.charCodeAt(0))
          );
          const parsed = JSON.parse(decoded);
          stamped.name = parsed.n || parsed.name || '';
        } catch { /* encrypted blob - needs MLS key */ }
      }
      return stamped;
    });

  /**
   * Preserve locally-derived presentation fields across guild list refreshes.
   * Server responses can legitimately fall back to generic placeholders like
   * "Server" until MLS metadata is decrypted client-side again.
   *
   * @param {Array<object>} existingGuilds
   * @param {Array<object>} nextGuilds
   * @param {string} instanceUrl
   * @returns {Array<object>}
   */
  const mergeStampedGuilds = (existingGuilds, nextGuilds, instanceUrl) => {
    const existingById = new Map((existingGuilds ?? []).map((guild) => [guild.id, guild]));
    return stampGuilds(nextGuilds, instanceUrl).map((guild) => {
      const existing = existingById.get(guild.id);
      if (!existing?._localName) {
        return guild;
      }
      return {
        ...guild,
        _localName: existing._localName,
      };
    });
  };

  // ── State snapshot helper ────────────────────────────────────────────────

  /**
   * Commits current instancesRef state to React state for re-render.
   * Called after any mutation to per-instance state.
   */
  const flushState = useCallback(() => {
    const snapshot = new Map();
    for (const [url, data] of instancesRef.current) {
      snapshot.set(url, {
        connectionState: data.connectionState,
        jwt: data.jwt,
        userId: data.userId,
        guilds: data.guilds,
        handshakeData: data.handshakeData,
      });
    }
    setInstanceStates(snapshot);
  }, []);

  // ── Guild order management ────────────────────────────────────────────────

  /**
   * Persists a new guild order to IDB and updates local state.
   * @param {string[]} ids - Ordered array of guild IDs.
   */
  const setGuildOrder = useCallback(async (ids) => {
    _setGuildOrderState(ids);
    if (dbRef.current) {
      await saveGuildOrder(dbRef.current, ids).catch(err => {
        console.error('[useInstances] saveGuildOrder failed:', err);
      });
    }
  }, []);

  // ── mergedGuilds derivation ───────────────────────────────────────────────

  /**
   * Connected-instance descriptors for cross-cutting realtime
   * listeners. Each entry exposes the live wsClient + token +
   * handshakeData + the server (non-DM) guild ids hosted on that
   * instance, so root-level shells can mount per-instance and
   * per-server listeners across every connected instance, not
   * only the active-view one.
   *
   * @type {Array<{
   *   instanceUrl: string,
   *   wsClient: object,
   *   token: string,
   *   userId: string,
   *   handshakeData: object|null,
   *   serverIds: string[],
   * }>}
   */
  const connectedInstances = useMemo(() => {
    const out = [];
    for (const [instanceUrl, snapshot] of instanceStates.entries()) {
      const live = instancesRef.current.get(instanceUrl);
      if (!live?.wsClient || !snapshot?.jwt) continue;
      const serverIds = (snapshot.guilds ?? [])
        .filter((g) => !g.isDm && g.id)
        .map((g) => g.id);
      out.push({
        instanceUrl,
        wsClient: live.wsClient,
        token: snapshot.jwt,
        userId: snapshot.userId ?? '',
        handshakeData: snapshot.handshakeData ?? null,
        serverIds,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceStates]);

  /**
   * Memoised DM guild array across all instances.
   * Contains only guilds where isDm === true; separated from the regular sidebar list.
   */
  const dmGuilds = useMemo(() => {
    const all = [];
    for (const data of instancesRef.current.values()) {
      if (data.guilds) {
        all.push(...data.guilds.filter(g => g.isDm));
      }
    }
    return all;
    // NOTE: instanceStates is the trigger - recomputes when any instance state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceStates]);

  /**
   * Memoised merged guild array across all instances (excludes DM guilds).
   * Ordered guilds (from IDB preference) appear first; new guilds append.
   * DM guilds are filtered out so they do not appear in the regular guild icon sidebar.
   */
  const mergedGuilds = useMemo(() => {
    const allGuilds = [];
    for (const data of instancesRef.current.values()) {
      if (data.guilds) {
        allGuilds.push(...data.guilds.filter(g => !g.isDm));
      }
    }

    if (guildOrder.length === 0) return allGuilds;

    const orderIndex = new Map(guildOrder.map((id, i) => [id, i]));
    const ordered = [];
    const unordered = [];

    for (const guild of allGuilds) {
      if (orderIndex.has(guild.id)) {
        ordered.push(guild);
      } else {
        unordered.push(guild);
      }
    }

    ordered.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
    return [...ordered, ...unordered];
    // NOTE: instanceStates is the trigger - mergedGuilds recomputes when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceStates, guildOrder]);

  // ── WS reconnect logic ────────────────────────────────────────────────────

  /**
   * Starts an exponential backoff reconnect for an instance.
   * Increments connectionState to 'reconnecting' and schedules re-boot.
   * @param {string} instanceUrl
   */
  const scheduleReconnect = useCallback((instanceUrl) => {
    const entry = instancesRef.current.get(instanceUrl);
    if (!entry) return;

    // Clear any existing timer.
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }

    const attempt = entry.reconnectAttempt ?? 0;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, attempt),
      RECONNECT_MAX_MS,
    );

    entry.connectionState = 'reconnecting';
    entry.reconnectAttempt = attempt + 1;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      // Re-run bootInstance, ignoring errors (it will retry via close handler).
      bootInstance(instanceUrl).catch(() => undefined);
    }, delay);

    flushState();
  }, [flushState]); // bootInstance added via closure - intentional late binding

  const syncServerSubscriptions = useCallback((entry, nextGuilds = entry?.guilds) => {
    if (!entry?.wsClient?.isConnected?.()) return;

    const nextIds = new Set(
      (nextGuilds ?? [])
        .map((guild) => guild?.id)
        .filter(Boolean)
    );
    const currentIds = entry.subscribedServerIds instanceof Set
      ? entry.subscribedServerIds
      : new Set();

    for (const serverId of currentIds) {
      if (!nextIds.has(serverId)) {
        entry.wsClient.send('unsubscribe.server', { server_id: serverId });
      }
    }
    for (const serverId of nextIds) {
      if (!currentIds.has(serverId)) {
        entry.wsClient.send('subscribe.server', { server_id: serverId });
      }
    }

    entry.subscribedServerIds = nextIds;
  }, []);

  const clearServerSubscriptions = useCallback((entry) => {
    if (!entry) return;
    const currentIds = entry.subscribedServerIds instanceof Set
      ? entry.subscribedServerIds
      : new Set();

    if (entry.wsClient?.isConnected?.()) {
      for (const serverId of currentIds) {
        entry.wsClient.send('unsubscribe.server', { server_id: serverId });
      }
    }

    entry.subscribedServerIds = new Set();
  }, []);

  // ── Per-instance WS event wiring ──────────────────────────────────────────

  /**
   * Attaches WS event handlers for an instance's WS client.
   * Handles guild-mutation events and unexpected disconnects.
   *
   * @param {string} instanceUrl
   * @param {object} wsClient - WS client from createWsClient
   */
  const wireWsHandlers = useCallback((instanceUrl, wsClient) => {
    wsClient.on('close', () => {
      const entry = instancesRef.current.get(instanceUrl);
      // Only reconnect if the instance is still registered and was connected.
      if (!entry) return;
      scheduleReconnect(instanceUrl);
    });

    // Reconcile every guild's hub room on open + reconnect. Without
    // this frame the backend's BroadcastToServer fan-out lands in an
    // empty subscriber set and the client misses voice_state_update,
    // channel_*, and member events for any guild the user isn't
    // actively viewing. Per-adapter `subscribe.server` (in
    // useChannelsForServer) only covers the active server; this
    // hook-level pass covers every server the user is a member of.
    const syncAllServers = () => {
      const entry = instancesRef.current.get(instanceUrl);
      if (entry) {
        entry.subscribedServerIds = new Set();
      }
      syncServerSubscriptions(entry);
    };
    wsClient.on('open', syncAllServers);

    // Handle guild-level WS events that require a guild list refresh.
    // After the refresh, re-subscribe to every guild — a `member_joined`
    // routed via BroadcastToUser means a NEW server appeared in the
    // user's list and we need to start listening for its broadcasts.
    const refreshOnEvent = async () => {
      const entry = instancesRef.current.get(instanceUrl);
      if (!entry?.jwt) return;
      try {
        const guilds = await getMyGuilds(entry.jwt, instanceUrl);
        entry.guilds = mergeStampedGuilds(entry.guilds, guilds, instanceUrl);
        syncServerSubscriptions(entry, entry.guilds);
        flushState();
      } catch (err) {
        console.error(`[useInstances] guild refresh failed for ${instanceUrl}:`, err);
      }
    };

    wsClient.on('server_updated', refreshOnEvent);
    wsClient.on('server_deleted', refreshOnEvent);
    wsClient.on('member_joined', refreshOnEvent);

    // Live-apply admin instance_config changes broadcast by the server
    // so attachment limits, screen-share caps, registration mode, and
    // guild discovery flip without a page refresh. Merge into the
    // cached handshakeData per instance (NOT cross-instance) so each
    // instance's runtime config stays scoped to its origin. Unknown /
    // extra fields are passed through; the schema strips the `type`
    // discriminator before merge so it cannot poison handshakeData.
    const handleInstanceUpdated = (data) => {
      const entry = instancesRef.current.get(instanceUrl);
      if (!entry) return;
      const merged = { ...(entry.handshakeData ?? {}) };
      for (const [key, value] of Object.entries(data ?? {})) {
        if (key === 'type') continue;
        if (value === undefined) continue;
        merged[key] = value;
      }
      entry.handshakeData = merged;
      flushState();
    };
    wsClient.on('instance_updated', handleInstanceUpdated);

    // After member_left, refresh guilds then silently disconnect if the user
    // has no remaining servers on this instance (auto-cleanup, no confirmation).
    const handleMemberLeft = async () => {
      await refreshOnEvent();
      const entry = instancesRef.current.get(instanceUrl);
      if (entry && (!entry.guilds || entry.guilds.length === 0)) {
        disconnectInstance(instanceUrl).catch((err) => {
          console.warn(`[useInstances] auto-disconnect failed for ${instanceUrl}:`, err);
        });
      }
    };
    wsClient.on('member_left', handleMemberLeft);
  }, [scheduleReconnect, syncServerSubscriptions, flushState]); // disconnectInstance added via closure - stable ref

  // ── bootInstance ──────────────────────────────────────────────────────────

  /**
   * Authenticates and connects to an instance via challenge-response then WS.
   *
   * Steps:
   *   1. Set connectionState = 'connecting'
   *   2. getHandshake (public)
   *   3. requestChallenge -> sign -> verifyChallenge -> JWT
   *   4. Auto-register on 404 (unknown key)
   *   5. saveInstance to IDB
   *   6. createWsClient + connect
   *   7. getMyGuilds -> stamp with instanceUrl -> merge
   *   8. Set connectionState = 'connected'
   *
   * @param {string} instanceUrl - Canonical base URL (e.g. https://a.example.com)
   * @returns {Promise<void>}
   */
  const bootInstance = useCallback(async (instanceUrl, expectedGeneration = runtimeGenerationRef.current) => {
    const isActiveGeneration = () => expectedGeneration === runtimeGenerationRef.current;
    if (!isActiveGeneration()) return;

    const identityKey = identityKeyRef?.current;
    if (!identityKey) {
      throw new Error('bootInstance: no identity key available - vault must be unlocked');
    }
    // Guard against partial identity material. Without this, `toBase64(publicKey)`
    // crashes with a cryptic `TypeError: e is not iterable` deep in bootInstance,
    // which blocks WS reconnect, freezes MLS epoch progression, and surfaces to
    // the user as WrongEpoch decrypt failures plus repeating 403 WS handshakes.
    if (!(identityKey.privateKey instanceof Uint8Array) || identityKey.privateKey.length === 0) {
      throw new Error('bootInstance: identity privateKey is missing or empty - relock and unlock the vault');
    }
    if (!(identityKey.publicKey instanceof Uint8Array) || identityKey.publicKey.length === 0) {
      throw new Error('bootInstance: identity publicKey is missing or empty - relock and unlock the vault');
    }

    // Initialise or update entry in instancesRef.
    const existing = instancesRef.current.get(instanceUrl) ?? {};
    instancesRef.current.set(instanceUrl, {
      ...existing,
      connectionState: 'connecting',
      reconnectAttempt: existing.reconnectAttempt ?? 0,
      reconnectTimer: existing.reconnectTimer ?? null,
      guilds: existing.guilds ?? [],
    });
    flushState();

    try {
      // Step 1: Handshake (public, no auth) + compatibility gate.
      //
      // Fail closed: assertHandshakeCompatible raises the global
      // "Update Required" dialog AND throws HandshakeCompatibilityError
      // before any auth/WS/MLS work so incompatible clients cannot
      // mutate durable MLS state.
      const handshakeData = await assertHandshakeCompatible(instanceUrl);
      if (!isActiveGeneration()) return;

      // Step 2: Auth.
      const { privateKey, publicKey } = identityKey;
      const publicKeyBase64 = toBase64(publicKey);
      const deviceId = getDeviceId();
      const username = localUser?.username ?? 'user';
      const displayName = localUser?.displayName ?? username;

      let jwt;
      let authUser;

      try {
        // bootInstance always targets a specific instance URL, so its
        // challenge signature must be bound to that instance's origin.
        // resolveAuthAudience() normalizes the passed instanceUrl
        // (scheme + host + non-default port) so v2 signatures match
        // what the server reconstructs from the request.
        const audience = resolveAuthAudience(instanceUrl);
        if (!audience) {
          throw new Error('Cannot determine instance origin for challenge.');
        }
        const { nonce } = await requestChallenge(publicKeyBase64, instanceUrl);
        const signature = await signAuthChallengeV2(nonce, audience, privateKey);
        const signatureBase64 = toBase64(signature);
        const result = await verifyChallenge(publicKeyBase64, nonce, signatureBase64, deviceId, instanceUrl, audience);
        if (!isActiveGeneration()) return;
        jwt = result.token;
        authUser = result.user;
      } catch (err) {
        // 404 means the key is unknown on this instance - federated sign-in
        // would have been the fallback, but federation is not supported in MVP.
        const isNotFound = err?.status === 404
          || err?.response?.status === 404
          || (typeof err?.message === 'string' && err.message.includes('unknown public key'));
        if (isNotFound) {
          throw new Error('Federated sign-in is not available in this MVP. Add this instance from the sign-in screen or use an account registered on that instance.');
        }
        throw err;
      }

      // Step 3: Persist to IDB.
      const db = dbRef.current;
      if (db) {
        await saveInstance(db, {
          instanceUrl,
          jwt,
          userId: authUser?.id,
          username: authUser?.username,
          connectionState: 'connected',
          lastSeen: Date.now(),
        });
      }
      if (!isActiveGeneration()) return;

      // Step 4: Create and connect WS client. Close any existing WS first.
      const entry = instancesRef.current.get(instanceUrl);
      if (entry?.wsClient) {
        try { entry.wsClient.disconnect(); } catch { /* noop */ }
      }

      const wsClient = createWsClient({
        url: toWsUrl(instanceUrl),
        getToken: () => instancesRef.current.get(instanceUrl)?.jwt ?? null,
      });

      wireWsHandlers(instanceUrl, wsClient);
      wsClient.connect();

      // Step 5: Fetch guilds, extract names from metadata, and stamp with instanceUrl.
      const guilds = await getMyGuilds(jwt, instanceUrl);
      if (!isActiveGeneration()) {
        try { wsClient.disconnect(); } catch { /* noop */ }
        return;
      }
      const stampedGuilds = stampGuilds(guilds, instanceUrl);

      // Step 6: Update entry.
      instancesRef.current.set(instanceUrl, {
        wsClient,
        jwt,
        userId: authUser?.id,
        handshakeData,
        guilds: stampedGuilds,
        connectionState: 'connected',
        reconnectAttempt: 0,
        reconnectTimer: null,
        subscribedServerIds: new Set(),
      });

      syncServerSubscriptions(instancesRef.current.get(instanceUrl), stampedGuilds);
      flushState();
    } catch (err) {
      if (!isActiveGeneration()) return;
      // Mark as offline but keep entry so reconnect can retry.
      const entry = instancesRef.current.get(instanceUrl);
      if (entry) {
        entry.connectionState = 'offline';
        flushState();
      }
      console.error(`[useInstances] bootInstance failed for ${instanceUrl}:`, err);
      throw err;
    }
  }, [identityKeyRef, localUser, flushState, wireWsHandlers, syncServerSubscriptions]);

  // ── disconnectInstance ────────────────────────────────────────────────────

  /**
   * Closes the WS connection, removes the instance from IDB, and clears state.
   *
   * @param {string} instanceUrl
   * @returns {Promise<void>}
   */
  const disconnectInstance = useCallback(async (instanceUrl) => {
    const entry = instancesRef.current.get(instanceUrl);
    if (!entry) return;

    // Cancel any pending reconnect timer.
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }

    // Disconnect WS.
    clearServerSubscriptions(entry);
    try { entry.wsClient?.disconnect(); } catch { /* noop */ }

    // Remove from IDB.
    const db = dbRef.current;
    if (db) {
      await removeInstance(db, instanceUrl).catch(err => {
        console.error('[useInstances] removeInstance failed:', err);
      });
    }

    // Remove from in-memory map and flush.
    instancesRef.current.delete(instanceUrl);
    flushState();
  }, [clearServerSubscriptions, flushState]);

  // ── refreshGuilds ─────────────────────────────────────────────────────────

  /**
   * Re-fetches the guild list for a connected instance.
   * Updates mergedGuilds with the fresh list.
   *
   * @param {string} instanceUrl
   * @returns {Promise<void>}
   */
  const refreshGuilds = useCallback(async (instanceUrl) => {
    const entry = instancesRef.current.get(instanceUrl);
    if (!entry?.jwt) return;

    try {
      const guilds = await getMyGuilds(entry.jwt, instanceUrl);
      entry.guilds = mergeStampedGuilds(entry.guilds, guilds, instanceUrl);
      syncServerSubscriptions(entry, entry.guilds);
      flushState();
    } catch (err) {
      console.error(`[useInstances] refreshGuilds failed for ${instanceUrl}:`, err);
      throw err;
    }
  }, [flushState, syncServerSubscriptions]);

  // ── registerLocalInstance (post-auth shortcut) ──────────────────────────

  /**
   * Registers the current origin as a connected instance using an existing JWT.
   * Skips challenge-response auth - used after registration/recovery when
   * the caller already has a valid session.
   *
   * @param {string} jwt - Existing JWT token
   * @param {{ id: string, username: string }} authUser - Authenticated user
   * @returns {Promise<void>}
   */
  const registerLocalInstance = useCallback(async (jwt, authUser, expectedGeneration = runtimeGenerationRef.current) => {
    const isActiveGeneration = () => expectedGeneration === runtimeGenerationRef.current;
    if (!isActiveGeneration()) {
      return;
    }

    const instanceUrl = getActiveAuthInstanceUrlSync();

    // Compatibility gate. Mirrors bootInstance — the local-JWT shortcut
    // must NEVER open a WS or persist runtime state against an
    // incompatible instance, or MLS state can corrupt durably.
    // Throws HandshakeCompatibilityError on mismatch; the outer boot
    // effect skips the fallback path on that branch.
    const handshakeData = await assertHandshakeCompatible(instanceUrl);
    if (!isActiveGeneration()) return;

    // Save to IDB.
    try {
      const db = dbRef.current ?? await openInstanceRegistry();
      if (!dbRef.current) dbRef.current = db;
      await saveInstance(db, {
        instanceUrl,
        jwt,
        userId: authUser?.id,
        username: authUser?.username,
        connectionState: 'connected',
        lastSeen: Date.now(),
      });
    } catch (err) {
      console.warn('[useInstances] registerLocalInstance IDB save failed:', err);
    }
    if (!isActiveGeneration()) return;

    // Create WS connection.
    const existing = instancesRef.current.get(instanceUrl);
    if (existing?.wsClient) {
      try { existing.wsClient.disconnect(); } catch { /* noop */ }
    }

    const wsClient = createWsClient({
      url: toWsUrl(instanceUrl),
      getToken: () => instancesRef.current.get(instanceUrl)?.jwt ?? null,
    });
    wireWsHandlers(instanceUrl, wsClient);
    wsClient.connect();

    // Fetch guilds.
    let guilds = [];
    try {
      const raw = await getMyGuilds(jwt, instanceUrl);
      if (!isActiveGeneration()) {
        try { wsClient.disconnect(); } catch { /* noop */ }
        return;
      }
      guilds = stampGuilds(raw, instanceUrl);
    } catch { /* no guilds yet - that's fine after fresh registration */ }
    if (!isActiveGeneration()) {
      try { wsClient.disconnect(); } catch { /* noop */ }
      return;
    }

    instancesRef.current.set(instanceUrl, {
      wsClient,
      jwt,
      userId: authUser?.id,
      handshakeData,
      guilds,
      connectionState: 'connected',
      reconnectAttempt: 0,
      reconnectTimer: null,
      subscribedServerIds: new Set(),
    });

    syncServerSubscriptions(instancesRef.current.get(instanceUrl), guilds);
    flushState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushState, wireWsHandlers, syncServerSubscriptions]);

  // Channel unread management.

  /**
   * Updates the unread count for a specific channel within an instance's guild list.
   * Used to clear the local unread badge after sending a read acknowledgement.
   *
   * Only modifies the target channel on the target instance; all other channels
   * and instances are left unchanged.
   *
   * @param {string} targetInstanceUrl
   * @param {string} channelId
   * @param {number} unreadCount
   */
  const setChannelUnreadCount = useCallback((targetInstanceUrl, channelId, unreadCount) => {
    const entry = instancesRef.current.get(targetInstanceUrl);
    if (!entry?.guilds) return;
    let changed = false;
    entry.guilds = entry.guilds.map((guild) => {
      if (!Array.isArray(guild.channels)) return guild;
      const idx = guild.channels.findIndex((ch) => ch.id === channelId);
      if (idx < 0) return guild;
      changed = true;
      return {
        ...guild,
        channels: guild.channels.map((ch, i) =>
          i === idx ? { ...ch, unreadCount } : ch
        ),
      };
    });
    if (changed) flushState();
  }, [flushState]);

  // ── Accessor functions ────────────────────────────────────────────────────

  /**
   * Returns the WS client for an instance, or null if not connected.
   * @param {string} instanceUrl
   * @returns {object|null}
   */
  const getWsClient = useCallback((instanceUrl) => {
    return instancesRef.current.get(instanceUrl)?.wsClient ?? null;
  }, []);

  /**
   * Returns the current JWT for an instance, or null if not connected.
   * @param {string} instanceUrl
   * @returns {string|null}
   */
  const getTokenForInstance = useCallback((instanceUrl) => {
    return instancesRef.current.get(instanceUrl)?.jwt ?? null;
  }, []);

  /**
   * Closes every active WS connection and reconnect timer without mutating
   * React state. Used by effect cleanup during auth-session transitions.
   */
  const disconnectRuntimeEntries = useCallback(() => {
    for (const entry of instancesRef.current.values()) {
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      clearServerSubscriptions(entry);
      try { entry.wsClient?.disconnect(); } catch { /* noop */ }
    }
  }, [clearServerSubscriptions]);

  /**
   * Clears all runtime instance state for the current session.
   */
  const resetRuntimeState = useCallback(() => {
    disconnectRuntimeEntries();
    instancesRef.current = new Map();
    flushState();
    setGuildsLoaded(false);
  }, [disconnectRuntimeEntries, flushState]);

  // ── Boot: load instances and connect when auth is ready ──────────────────
  //
  // This effect is keyed to the authenticated session, not to component
  // lifetime. When auth is rehydrating, locked, logged out, or switched to a
  // different user, all runtime connections are torn down. When the vault is
  // unlocked for the current user, stored instances are booted and the current
  // origin is ensured as a connected instance when a local JWT exists.

  useEffect(() => {
    let cancelled = false;
    runtimeGenerationRef.current += 1;
    const generation = runtimeGenerationRef.current;

    if (authLoading) {
      resetRuntimeState();
      return () => {};
    }

    if (vaultState !== 'unlocked' || !localUser?.id) {
      resetRuntimeState();
      return () => {};
    }

    resetRuntimeState();

    (async () => {
      try {
        const db = dbRef.current ?? await openInstanceRegistry();
        if (cancelled) return;

        dbRef.current = db;

        const [storedInstances, storedOrder] = await Promise.all([
          getAllInstances(db),
          getGuildOrder(db),
        ]);

        if (cancelled) return;

        _setGuildOrderState(storedOrder);

        const localUrl = getActiveAuthInstanceUrlSync();
        let localJwt = localUrl ? getTokenForInstanceUrl(localUrl) : null;
        if (!localJwt && localUrl) {
          // One-time legacy migration for the resolved active auth
          // instance. Explicit instance lookups above never fall back
          // to `hush_jwt`; `getLocalToken` is the only place allowed
          // to consume and clear the legacy slot.
          localJwt = getLocalToken();
        }
        const storedUrls = new Set(storedInstances.map(({ instanceUrl }) => instanceUrl));
        const bootTargets = storedInstances.map(({ instanceUrl }) => ({ type: 'stored', instanceUrl }));

        if (localJwt && !storedUrls.has(localUrl)) {
          bootTargets.push({ type: 'local', instanceUrl: localUrl });
        }

        if (bootTargets.length === 0) {
          flushState();
          return;
        }

        const bootResults = await Promise.allSettled(
          bootTargets.map((target) => {
            if (target.type === 'local') {
              return registerLocalInstance(localJwt, {
                id: localUser.id,
                username: localUser.username,
              }, generation);
            }
            return bootInstance(target.instanceUrl, generation);
          }),
        );

        // If any boot target for the local instance failed because the
        // server is incompatible, the fallback below MUST stay closed.
        // Re-issuing /api/auth/me + registerLocalInstance would create a
        // WS against an incompatible server and risk MLS state corruption.
        const localBootHitCompatError = bootResults.some((res, idx) => {
          if (res.status !== 'rejected') return false;
          const target = bootTargets[idx];
          if (target.instanceUrl !== localUrl) return false;
          return isHandshakeCompatibilityError(res.reason);
        });

        // Fallback: if bootInstance failed but a local JWT still exists in
        // sessionStorage, use it directly for the local instance.
        if (localJwt && !cancelled && !localBootHitCompatError) {
          const localEntry = instancesRef.current.get(localUrl);
          if (!localEntry || localEntry.connectionState === 'offline') {
            try {
              const res = await fetchWithAuth(localJwt, '/api/auth/me');
              if (res.ok) {
                const u = await res.json();
                if (!cancelled) {
                  await registerLocalInstance(localJwt, { id: u.id, username: u.username }, generation);
                }
              }
            } catch (err) {
              if (isHandshakeCompatibilityError(err)) {
                // Compat dialog already dispatched; do not retry.
                return;
              }
              // JWT invalid or network error - will show empty state.
            }
          }
        }
      } catch (err) {
        console.error('[useInstances] boot failed:', err);
      } finally {
        if (!cancelled) setGuildsLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
      runtimeGenerationRef.current += 1;
      disconnectRuntimeEntries();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultState, authLoading, localUser?.id, localUser?.username, bootInstance, registerLocalInstance, resetRuntimeState, disconnectRuntimeEntries]);

  return {
    instanceStates,
    mergedGuilds,
    guildsLoaded,
    dmGuilds,
    connectedInstances,
    bootInstance,
    registerLocalInstance,
    disconnectInstance,
    getWsClient,
    getTokenForInstance,
    guildOrder,
    setGuildOrder,
    refreshGuilds,
    setChannelUnreadCount,
  };
}
