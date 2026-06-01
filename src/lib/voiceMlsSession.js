/**
 * Framework-agnostic voice MLS WS dispatch (HUSHHQ-104 / HUSHHQ-106).
 *
 * Owns the integration seam that broke in HUSHHQ-104: subscribing to the voice
 * channel's WS topic and routing incoming `mls.commit` frames into the MLS group
 * so every participant converges on the same epoch and frame key. Extracted
 * verbatim from useRoom.js so the exact same code runs in production and in the
 * headless E2E harness (no React, no LiveKit) - the seam itself becomes the unit
 * under test instead of a mock that only looks wired.
 *
 * Side effects that belong to the LiveKit/React layer (applying the derived
 * frame key, updating component state) are delegated to the `onFrameKey`
 * callback; this module never touches LiveKit or React.
 */

/**
 * Converts a base64 string to a Uint8Array. Local copy kept framework-agnostic
 * so this module has no dependency on the React hook it was extracted from.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function fromBase64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * @typedef {object} VoiceMlsSessionDeps
 * @property {{ on: Function, off: Function, subscribeChannel: Function, unsubscribeChannel: Function }} wsClient
 * @property {string} channelId - the voice channel id for this session
 * @property {() => string} getActiveChannelId - returns the currently active channel id (the original useRoom check filtered against channelIdRef.current; passing an accessor keeps that exact semantic)
 * @property {string} currentUserId
 * @property {() => string} getDeviceId
 * @property {() => Promise<IDBDatabase>} getStore
 * @property {() => string|null} getToken
 * @property {typeof import('./mlsStore')} mlsStore
 * @property {typeof import('./hushCrypto')} hushCrypto
 * @property {typeof import('./mlsGroup')} mlsGroup
 * @property {import('./mlsGroup').MlsInstanceApi} voiceApi
 * @property {(frameKeyBytes: Uint8Array, epoch: number) => void | Promise<void>} onFrameKey - apply the re-derived frame key (LiveKit setKey + state) and record the epoch
 * @property {(err: unknown) => void} [onCommitError]
 * @property {(err: unknown) => void} [onDestroyError]
 */

/**
 * Subscribes to the voice channel WS topic and wires the `mls.commit` /
 * `voice_group_destroyed` handlers. Returns a session handle whose `dispose()`
 * removes the listeners and unsubscribes (idempotent, safe on every leave path).
 *
 * @param {VoiceMlsSessionDeps} deps
 * @returns {{ dispose: () => void }}
 */
export function createVoiceMlsSession(deps) {
  const {
    wsClient,
    channelId,
    getActiveChannelId,
    currentUserId,
    getDeviceId,
    getStore,
    getToken,
    mlsStore,
    hushCrypto,
    mlsGroup,
    voiceApi,
    onFrameKey,
    onCommitError,
    onDestroyError,
  } = deps;

  let active = true;

  const buildDeps = async () => {
    const db = await getStore();
    const credential = await mlsStore.getCredential(db);
    return { db, token: getToken(), credential, mlsStore, hushCrypto, api: voiceApi };
  };

  // Re-derive the frame key when a voice commit advances the epoch.
  const handleVoiceCommit = async (data) => {
    if (data.group_type !== 'voice' || data.channel_id !== getActiveChannelId()) return;
    // Own commits are already applied locally when we sent them.
    if (data.sender_id === currentUserId && data.sender_device_id === getDeviceId()) return;
    try {
      const mlsDeps = await buildDeps();
      const commitBytes = fromBase64(data.commit_bytes);
      await mlsGroup.processVoiceCommit(mlsDeps, data.channel_id, commitBytes);
      const { frameKeyBytes, epoch } = await mlsGroup.exportVoiceFrameKey(mlsDeps, data.channel_id);
      if (active) await onFrameKey(frameKeyBytes, epoch);
    } catch (err) {
      if (onCommitError) onCommitError(err);
    }
  };

  // Clean up local state when the server signals the voice group is gone
  // (last participant left and the webhook fired DeleteMLSGroupInfo).
  const handleVoiceGroupDestroyed = async (data) => {
    if (data.channel_id !== getActiveChannelId()) return;
    try {
      const mlsDeps = await buildDeps();
      await mlsGroup.destroyVoiceGroup(mlsDeps, data.channel_id);
    } catch (err) {
      if (onDestroyError) onDestroyError(err);
    }
  };

  wsClient.on('mls.commit', handleVoiceCommit);
  wsClient.on('voice_group_destroyed', handleVoiceGroupDestroyed);
  // Subscribe to the voice channel's WS topic. The server fans mls.commit
  // (external-join, key rotation, eviction) only to clients subscribed to the
  // channel; without this the handler above never fires and peers never converge
  // on an epoch (HUSHHQ-104). Refcounted + replayed on reconnect by ws.js.
  wsClient.subscribeChannel(channelId);

  return {
    dispose() {
      active = false;
      wsClient.off('mls.commit', handleVoiceCommit);
      wsClient.off('voice_group_destroyed', handleVoiceGroupDestroyed);
      wsClient.unsubscribeChannel(channelId);
    },
  };
}
