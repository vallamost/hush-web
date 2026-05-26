/**
 * PlaybackManager — TypeScript owner of remote audio playback elements.
 *
 * Owns all HTMLAudioElement instances for remote participant audio.
 * React provides a container via bindContainer(); the manager creates,
 * attaches, and removes audio elements inside it.
 *
 * Lifecycle:
 *   new PlaybackManager({ onPlaybackBlockedChange? })
 *   bindContainer(element)       — mount point ready
 *   addRemoteAudioTrack(...)     — remote track arrives
 *   removeRemoteAudioTrack(sid)  — remote track leaves
 *   setRemoteAudioMuted(true)    — deafen
 *   resumeBlockedPlayback()      — user gesture re-tries blocked tracks
 *   unbindContainer()            — component unmounting
 *   dispose()                    — full cleanup
 *
 * Autoplay policy (HUSHHQ-78):
 *   Browsers (notably Chromium on Linux) reject `audio.play()` when the
 *   user-activation window from the join click has elapsed by the time
 *   a remote track arrives. The manager now models that rejection
 *   explicitly:
 *     - audio elements are appended to the container BEFORE `play()`
 *       runs, giving the browser fewer reasons to reject;
 *     - tracks added before `bindContainer(...)` wait until the
 *       container attaches before `play()` is attempted;
 *     - a rejected `play()` adds the sid to a blocked set and notifies
 *       the host via `onPlaybackBlockedChange(true)` so the UI can
 *       render a visible "Enable audio" affordance instead of silently
 *       polling document clicks;
 *     - `resumeBlockedPlayback()` retries every blocked element and
 *       clears the blocked state per-sid as `play()` resolves.
 *
 * Video elements are NOT managed here — React keeps video ownership.
 */

import { recordClientDiagnostic } from '../../lib/clientDiagnostics';

export interface ManagedAudioTrack {
  sid: string;
  element: HTMLAudioElement;
}

export type PlaybackBlockedListener = (blocked: boolean) => void;

export interface PlaybackManagerOptions {
  onPlaybackBlockedChange?: PlaybackBlockedListener;
}

/**
 * `true` when the current document can route remote audio to a chosen
 * output device. Chromium-based desktop browsers and Electron expose
 * `HTMLMediaElement.setSinkId`; Firefox and all current mobile browsers
 * do not. Callers that surface UI for output selection MUST guard on
 * this predicate.
 */
export function isOutputDeviceSelectionSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof HTMLMediaElement === "undefined") return false;
  const proto = HTMLMediaElement.prototype as unknown as {
    setSinkId?: unknown;
  };
  return typeof proto.setSinkId === "function";
}

export class PlaybackManager {
  private _container: HTMLElement | null = null;
  private _tracks: Map<string, ManagedAudioTrack> = new Map();
  private _muted = false;
  private _disposed = false;
  private _sinkId: string | null = null;
  private _blockedSids: Set<string> = new Set();
  private _onPlaybackBlockedChange: PlaybackBlockedListener | null = null;

  constructor(options?: PlaybackManagerOptions) {
    this._onPlaybackBlockedChange = options?.onPlaybackBlockedChange ?? null;
  }

  get isDisposed(): boolean { return this._disposed; }
  get isMuted(): boolean { return this._muted; }
  get trackCount(): number { return this._tracks.size; }
  get sinkId(): string | null { return this._sinkId; }
  get hasBlockedPlayback(): boolean { return this._blockedSids.size > 0; }

  /**
   * Bind the DOM container where audio elements will be mounted.
   * Call after the React ref is available.
   *
   * If tracks were added before binding, they were intentionally NOT
   * played (the browser would reject a play() on a detached element).
   * Attaching them here is the right moment to drive playback.
   */
  bindContainer(element: HTMLElement): void {
    if (this._disposed) return;
    this._container = element;

    for (const managed of this._tracks.values()) {
      if (!managed.element.parentNode) {
        this._container.appendChild(managed.element);
        this._attemptPlay(managed);
      }
    }
  }

  /**
   * Unbind the container. Audio elements are removed from the DOM
   * but kept in memory so they can be re-attached if a new container
   * is bound (e.g. React re-mount).
   */
  unbindContainer(): void {
    for (const managed of this._tracks.values()) {
      if (managed.element.parentNode) {
        managed.element.parentNode.removeChild(managed.element);
      }
    }
    this._container = null;
  }

  /**
   * Add a remote audio track. Creates an <audio> element. If the
   * container is bound, the element is appended first and then
   * `play()` is attempted; otherwise `play()` is deferred until
   * `bindContainer(...)` runs. A rejected `play()` marks the sid
   * blocked and notifies via `onPlaybackBlockedChange`.
   */
  addRemoteAudioTrack(sid: string, track: MediaStreamTrack): void {
    if (this._disposed) return;
    if (this._tracks.has(sid)) return;

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    audio.muted = this._muted;
    audio.srcObject = new MediaStream([track]);
    if (this._sinkId) {
      const el = audio as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (typeof el.setSinkId === 'function') {
        el.setSinkId(this._sinkId).catch(() => {
          // Output device may have been unplugged between save and use;
          // playback falls back to the system default.
        });
      }
    }

    const managed: ManagedAudioTrack = { sid, element: audio };
    this._tracks.set(sid, managed);

    if (this._container) {
      this._container.appendChild(audio);
      this._attemptPlay(managed);
    }
    // Tracks added before bindContainer() stay in memory with srcObject
    // wired; bindContainer() will append them and drive play().
  }

  /**
   * Remove a remote audio track. Pauses, clears srcObject, removes
   * element from DOM.
   */
  removeRemoteAudioTrack(sid: string): void {
    const managed = this._tracks.get(sid);
    if (!managed) return;

    this._teardownElement(managed);
    this._tracks.delete(sid);
    this._clearBlocked(sid);
  }

  /**
   * Mute or unmute all managed remote audio elements.
   * This is the playback-level mute — VoiceChannel's deafen handler
   * calls this instead of querySelectorAll.
   *
   * Does not touch blocked-playback state: a deafened user can still
   * have blocked-but-pending audio that should resume on un-deafen.
   */
  setRemoteAudioMuted(muted: boolean): void {
    this._muted = muted;
    for (const managed of this._tracks.values()) {
      managed.element.muted = muted;
    }
  }

  /**
   * Retry playback for every currently blocked audio element. Designed
   * to be invoked from a real user gesture (the "Enable audio" button)
   * so the browser grants playback. Blocked state clears per-sid as
   * each retry resolves; sids that fail again stay blocked.
   */
  async resumeBlockedPlayback(): Promise<void> {
    if (this._disposed) return;
    const blocked = Array.from(this._blockedSids);
    for (const sid of blocked) {
      const managed = this._tracks.get(sid);
      if (!managed) {
        this._clearBlocked(sid);
        continue;
      }
      try {
        const result = managed.element.play();
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result;
        }
        recordClientDiagnostic({
          category: 'voice',
          event: 'audio-playback-resumed',
          severity: 'info',
          details: { sid },
        });
        this._clearBlocked(sid);
      } catch {
        // Stay blocked; the affordance will keep the prompt visible
        // so the user can retry, or the next remove will clear it.
      }
    }
  }

  /**
   * Route remote audio playback to a specific output device. Uses the
   * Audio Output Devices API (`HTMLMediaElement.setSinkId`) which is
   * supported on Chromium-based desktop browsers and Electron — but not
   * on Firefox or any mobile browser. Callers MUST gate the UI on
   * `isOutputDeviceSelectionSupported()` before exposing this control.
   *
   * The chosen `sinkId` is remembered so audio elements created
   * afterwards (a peer joins mid-call) inherit the routing without an
   * extra round-trip through `voiceDevicePrefs`.
   */
  async setSinkId(sinkId: string): Promise<void> {
    this._sinkId = sinkId;
    const failures: unknown[] = [];
    for (const managed of this._tracks.values()) {
      const el = managed.element as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (typeof el.setSinkId !== 'function') continue;
      try {
        await el.setSinkId(sinkId);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /**
   * Full cleanup. Removes all elements, clears state.
   * Idempotent.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    for (const managed of this._tracks.values()) {
      this._teardownElement(managed);
    }
    this._tracks.clear();
    const wasBlocked = this._blockedSids.size > 0;
    this._blockedSids.clear();
    this._container = null;
    if (wasBlocked) {
      this._emitBlockedChange(false);
    }
    this._onPlaybackBlockedChange = null;
  }

  private _attemptPlay(managed: ManagedAudioTrack): void {
    let playPromise: Promise<void> | undefined;
    try {
      const result = managed.element.play();
      playPromise = result && typeof (result as Promise<void>).then === 'function'
        ? (result as Promise<void>)
        : undefined;
    } catch {
      this._markBlocked(managed.sid);
      return;
    }
    if (!playPromise) return;
    playPromise
      .then(() => {
        this._clearBlocked(managed.sid);
      })
      .catch(() => {
        this._markBlocked(managed.sid);
      });
  }

  private _markBlocked(sid: string): void {
    if (this._disposed) return;
    if (!this._tracks.has(sid)) return;
    if (this._blockedSids.has(sid)) return;
    const wasEmpty = this._blockedSids.size === 0;
    this._blockedSids.add(sid);
    recordClientDiagnostic({
      category: 'voice',
      event: 'audio-playback-blocked',
      severity: 'warn',
      details: { sid },
    });
    if (wasEmpty) this._emitBlockedChange(true);
  }

  private _clearBlocked(sid: string): void {
    if (!this._blockedSids.delete(sid)) return;
    if (this._blockedSids.size === 0) this._emitBlockedChange(false);
  }

  private _emitBlockedChange(blocked: boolean): void {
    const listener = this._onPlaybackBlockedChange;
    if (!listener) return;
    try {
      listener(blocked);
    } catch {
      // Listener errors must not crash playback management.
    }
  }

  private _teardownElement(managed: ManagedAudioTrack): void {
    managed.element.pause();
    managed.element.srcObject = null;
    if (managed.element.parentNode) {
      managed.element.parentNode.removeChild(managed.element);
    }
  }
}
