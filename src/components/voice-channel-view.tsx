import * as React from "react"

import { RoomContext } from "@livekit/components-react"
import "@livekit/components-styles"
import type { Room } from "livekit-client"

import { isOutputDeviceSelectionSupported } from "@/audio"
import { useAuth } from "@/contexts/AuthContext"
import { getDeviceId } from "@/hooks/useAuth"
import { useIsMobile } from "@/hooks/use-mobile"
import { useRoom } from "@/hooks/useRoom"
import { useVoiceBandwidth } from "@/hooks/useVoiceBandwidth"
import * as mlsStore from "@/lib/mlsStore"
import {
  computeDeviceApplyPlan,
  mergeVoiceDevicePrefs,
  readVoiceDevicePrefs,
  saveVoiceDevicePrefs,
  subscribeVoiceDevicePrefs,
  type VoiceDevicePrefs,
} from "@/lib/voiceDevicePrefs"
import {
  VoiceControlsBar,
} from "@/components/voice/voice-controls-bar"
import { VoiceDevicePickerDialog } from "@/components/voice/voice-device-picker-dialog"
import { VoiceParticipantGrid } from "@/components/voice/voice-participant-grid"
import {
  VoicePrejoinDialog,
  type VoicePrejoinChoice,
} from "@/components/voice/voice-prejoin-dialog"
import { VoiceQualityPickerDialog } from "@/components/voice/voice-quality-picker-dialog"
import { VoiceReconnectOverlay } from "@/components/voice/voice-reconnect-overlay"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MaximizeIcon, MinimizeIcon } from "lucide-react"

type ScreenShareResolutionCap = "1080p" | "720p"

type MicFilterSettingsPatch = Partial<{
  noiseGateEnabled: boolean
  noiseGateThresholdDb: number
}>

type VoiceControlsApi = {
  toggleMic?: () => void
  toggleDeafen?: () => void
  toggleScreenShare?: () => void
  switchScreenSource?: () => void
  toggleWebcam?: () => void
  isScreenSharing?: boolean
  isWebcamOn?: boolean
  applyMicFilterSettings?: (settings: MicFilterSettingsPatch) => void
  setOutputDeviceSink?: (deviceId: string | null) => Promise<void> | void
}

type VoiceState = {
  isMicOn: boolean
  isDeafened: boolean
  isScreenSharing: boolean
  isWebcamOn: boolean
}

interface VoiceChannelViewProps {
  channel: { id: string; name: string; type: "voice" }
  serverId: string
  getToken: () => string | null
  wsClient: unknown
  members?: Array<{ id?: string; userId?: string; displayName?: string | null }>
  myRole?: string
  onLeave: () => void | Promise<void>
  voiceControlsRef?: React.RefObject<VoiceControlsApi | null> | null
  onVoiceStateChange?: (state: VoiceState) => void
  baseUrl?: string
  screenShareResolutionCap?: ScreenShareResolutionCap
}

interface DeviceOption {
  deviceId: string
  label: string
}

interface PlaybackManagerLike {
  bindContainer: (el: HTMLElement) => void
  unbindContainer: () => void
  setRemoteAudioMuted: (muted: boolean) => void
  setSinkId: (sinkId: string) => Promise<void>
}

interface RoomApi {
  isReady: boolean
  error: string | null
  // The runtime hook is `useRoom` (JS); the maps below are intentionally
  // typed as `any` so the orchestrator does not duplicate the source
  // shapes maintained inside `useRoom`. The grid component re-narrows
  // them through its own props interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  localTracks: Map<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  remoteTracks: Map<string, any>
  participants: Array<{ userId: string; displayName: string }>
  isVoiceReconnecting: boolean
  voiceReconnectFailed: boolean
  activeSpeakerIds: string[]
  localSpeaking: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  availableScreens: Map<string, any>
  watchedScreens: Set<string>
  loadingScreens: Set<string>
  connectRoom: (
    roomName: string,
    displayName: string,
    channelId: string
  ) => Promise<void>
  disconnectRoom: () => Promise<void>
  publishScreen: (qualityKey: string) => Promise<MediaStream | null>
  unpublishScreen: () => Promise<void>
  switchScreenSource: (qualityKey: string) => Promise<MediaStream | null>
  changeQuality: (qualityKey: string) => Promise<void>
  publishWebcam: (deviceId: string | null) => Promise<void>
  unpublishWebcam: () => Promise<void>
  publishMic: (deviceId: string | null) => Promise<void>
  unpublishMic: () => Promise<void>
  muteMic: () => Promise<void>
  unmuteMic: () => Promise<void>
  updateMicFilterSettings: (settings: MicFilterSettingsPatch) => void
  watchScreen: (producerId: string) => void
  unwatchScreen: (producerId: string) => void
  playbackManager: PlaybackManagerLike | null
  /** The underlying livekit-client `Room` instance the MLS frame
   *  transformer is attached to. Passed into `RoomContext.Provider`
   *  so `@livekit/components-react` hooks read from the same Room. */
  room: Room | null
}

async function listDevices(
  kind: "audioinput" | "videoinput" | "audiooutput"
): Promise<DeviceOption[]> {
  try {
    if (kind !== "audiooutput") {
      const probe = await navigator.mediaDevices.getUserMedia(
        kind === "audioinput" ? { audio: true } : { video: true }
      )
      probe.getTracks().forEach((t) => t.stop())
    }
    const all = await navigator.mediaDevices.enumerateDevices()
    const fallback =
      kind === "audioinput"
        ? "Microphone"
        : kind === "videoinput"
          ? "Camera"
          : "Speaker"
    return all
      .filter((d) => d.kind === kind && d.deviceId)
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || fallback,
      }))
  } catch {
    return []
  }
}

export function pickVoiceDisplayName(
  user:
    | {
        displayName?: string | null
        display_name?: string | null
        username?: string | null
      }
    | null
    | undefined
): string {
  const candidates = [user?.displayName, user?.display_name, user?.username]
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const trimmed = candidate.trim()
    if (trimmed) return trimmed
  }
  return "Anonymous"
}

/**
 * Voice channel orchestrator. Owns the connection lifecycle to the
 * MLS-backed LiveKit room (`useRoom`), the published track state, and
 * the prejoin / device / quality dialogs that wrap that lifecycle.
 *
 * First-time entries surface `VoicePrejoinDialog` with a camera preview
 * and a "Don't ask again" checkbox; subsequent entries skip the dialog
 * and connect immediately when the user has saved their selection.
 */
export function VoiceChannelView({
  channel,
  serverId,
  getToken,
  wsClient,
  onLeave,
  voiceControlsRef,
  onVoiceStateChange,
  baseUrl = "",
  screenShareResolutionCap = "1080p",
}: VoiceChannelViewProps) {
  const { user } = useAuth() as {
    user: {
      id?: string
      displayName?: string
      display_name?: string
      username?: string
    } | null
  }
  const currentUserId = user?.id ?? ""
  const displayName = pickVoiceDisplayName(user)
  const roomName = `channel-${channel.id}`

  const getStore = React.useCallback(
    () => mlsStore.openStore(currentUserId, getDeviceId()),
    [currentUserId]
  )

  const room = useRoom({
    wsClient: wsClient as object,
    getToken,
    currentUserId,
    getStore,
    voiceKeyRotationHours: undefined,
    baseUrl,
  }) as RoomApi

  const bandwidth = useVoiceBandwidth()
  const [prefs, setPrefs] = React.useState<VoiceDevicePrefs | null>(null)
  const [prefsLoaded, setPrefsLoaded] = React.useState(false)
  // Always-fresh mirror of `prefs`. Writers (prejoin confirm + the
  // mid-call mic/cam/output pickers) read from this ref so the
  // merge always sees the latest committed prefs even when the
  // callback was memoised against a stale `prefs` reference. This
  // guards against a class of bugs where a writer would clobber a
  // field (e.g. outputDeviceId) that had been set after the
  // callback was last re-bound.
  const prefsRef = React.useRef<VoiceDevicePrefs | null>(prefs)
  prefsRef.current = prefs
  const [prejoinOpen, setPrejoinOpen] = React.useState(false)
  const [hasJoined, setHasJoined] = React.useState(false)
  const [audioDevices, setAudioDevices] = React.useState<DeviceOption[]>([])
  const [videoDevices, setVideoDevices] = React.useState<DeviceOption[]>([])
  const [showMicPicker, setShowMicPicker] = React.useState(false)
  const [showWebcamPicker, setShowWebcamPicker] = React.useState(false)
  const [showOutputPicker, setShowOutputPicker] = React.useState(false)
  const [outputDevices, setOutputDevices] = React.useState<DeviceOption[]>([])
  const [showQualityPicker, setShowQualityPicker] = React.useState(false)
  const isMobile = useIsMobile()
  const outputDeviceSelectable = React.useMemo(
    () => !isMobile && isOutputDeviceSelectionSupported(),
    [isMobile]
  )
  const [isMicOn, setIsMicOn] = React.useState(false)
  const [isDeafened, setIsDeafened] = React.useState(false)
  const [isWebcamOn, setIsWebcamOn] = React.useState(false)
  const [isScreenSharing, setIsScreenSharing] = React.useState(false)
  const [localScreenWatched, setLocalScreenWatched] = React.useState(false)
  const audioContainerRef = React.useRef<HTMLDivElement>(null)
  const micPublishedRef = React.useRef(false)
  const micBeforeDeafenRef = React.useRef(false)

  React.useEffect(() => {
    if (!currentUserId) return
    let cancelled = false
    readVoiceDevicePrefs(currentUserId, baseUrl)
      .then((stored) => {
        if (cancelled) return
        setPrefs(stored)
        setPrefsLoaded(true)
        if (!stored?.dontAskAgain) setPrejoinOpen(true)
      })
      .catch(() => {
        if (!cancelled) {
          setPrefsLoaded(true)
          setPrejoinOpen(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentUserId, baseUrl])

  // Live-apply prefs changes that originate elsewhere (settings
  // panel, prejoin dialog, in-call device popover). Without this,
  // picking a new mic / camera / output in the panel while the user
  // is in voice would only reach IDB; the active room state would
  // ignore it until the next join.
  React.useEffect(() => {
    if (!currentUserId) return
    return subscribeVoiceDevicePrefs(
      currentUserId,
      (next) => {
        setPrefs(next)
      },
      baseUrl
    )
  }, [currentUserId, baseUrl])

  React.useEffect(() => {
    const pm = room.playbackManager
    const container = audioContainerRef.current
    if (!pm || !container) return
    pm.bindContainer(container)
    return () => {
      pm.unbindContainer()
    }
  }, [room.playbackManager])

  // Apply the saved output sink to the playback manager once prefs are
  // loaded and a manager exists. Browsers that lack setSinkId silently
  // skip; the manager swallows per-element failures inside setSinkId.
  React.useEffect(() => {
    const pm = room.playbackManager
    if (!pm || !outputDeviceSelectable) return
    const id = prefs?.outputDeviceId ?? null
    if (!id) return
    void pm.setSinkId(id).catch(() => {
      // Output device may have been unplugged; fall back to default.
    })
  }, [room.playbackManager, prefs?.outputDeviceId, outputDeviceSelectable])

  const connectRoomRef = React.useRef(room.connectRoom)
  const disconnectRoomRef = React.useRef(room.disconnectRoom)
  const autoJoinArgsRef = React.useRef({
    roomName,
    displayName,
    channelId: channel.id,
  })
  React.useEffect(() => {
    connectRoomRef.current = room.connectRoom
    disconnectRoomRef.current = room.disconnectRoom
  }, [room.connectRoom, room.disconnectRoom])
  React.useEffect(() => {
    autoJoinArgsRef.current = {
      roomName,
      displayName,
      channelId: channel.id,
    }
  }, [roomName, displayName, channel.id])

  const hasWsClient = Boolean(wsClient)
  React.useEffect(() => {
    if (!hasWsClient || !channel.id) return
    if (!prefsLoaded) return
    if (prefs?.dontAskAgain !== true) return
    const args = autoJoinArgsRef.current
    let didStart = true
    void connectRoomRef.current(args.roomName, args.displayName, args.channelId).catch(
      () => {}
    )
    setHasJoined(true)
    return () => {
      if (!didStart) return
      disconnectRoomRef.current().catch(() => {})
      didStart = false
    }
  }, [
    hasWsClient,
    channel.id,
    prefs?.dontAskAgain,
    prefsLoaded,
  ])

  const autoPublishedRef = React.useRef(false)
  // Refs that hold the last device id we actually applied to the
  // active session. Declared above the live re-publish effect so
  // the auto-publish effect can stamp them on first apply (avoids
  // a stale "undefined → null" diff that would skip the first
  // panel-side change when starting from a null baseline).
  const lastAppliedAudioDeviceRef = React.useRef<string | null | undefined>(
    undefined
  )
  const lastAppliedVideoDeviceRef = React.useRef<string | null | undefined>(
    undefined
  )
  const lastAppliedOutputDeviceRef = React.useRef<string | null | undefined>(
    undefined
  )
  React.useEffect(() => {
    if (!room.isReady || autoPublishedRef.current) return
    if (!prefs) return
    autoPublishedRef.current = true
    // Seed the last-applied baselines synchronously so the live
    // re-publish effect never observes the `undefined` state after
    // auto-publish has been initiated. Without this, a prefs change
    // arriving in the small window between autoPublishedRef=true
    // and the async publishMic/publishWebcam settling would silently
    // be dropped (the effect's `!== undefined` guard would skip).
    //
    // Camera is intentionally NOT auto-published on join, even when
    // `prefs.videoEnabled === true`. Camera enablement is session-
    // local: persisted `videoEnabled` survives only as a hint for
    // the prejoin dialog and the in-call picker baselines, never as
    // an auto-publish trigger. Users must explicitly turn the
    // camera on per session. Mic remains opt-in via `audioEnabled`
    // because the existing prejoin flow already gates that choice.
    lastAppliedAudioDeviceRef.current = prefs.audioEnabled
      ? (prefs.audioDeviceId ?? null)
      : null
    lastAppliedVideoDeviceRef.current = null
    lastAppliedOutputDeviceRef.current = prefs.outputDeviceId ?? null
    void (async () => {
      try {
        if (prefs.audioEnabled) {
          // `null` means "system default device" — distinct from
          // "audio disabled". Pass it through to publishMic so the
          // browser picks the OS default mic.
          const audioDeviceId = prefs.audioDeviceId ?? null
          await room.publishMic(audioDeviceId)
          micPublishedRef.current = true
          setIsMicOn(true)
        }
      } catch (err) {
        console.warn("[VoiceChannel] auto-publish failed:", err)
      }
    })()
  }, [room.isReady, prefs, room.publishMic])

  // Live re-publish when device prefs change while we are already
  // capturing. Initial publish is handled by the auto-publish effect
  // above; this hook only fires for *changes* to a currently active
  // input. Skips work when nothing relevant has flipped, so it is
  // safe to depend on the whole prefs object.
  React.useEffect(() => {
    if (!room.isReady || !prefs || !autoPublishedRef.current) return
    void (async () => {
      try {
        const plan = computeDeviceApplyPlan(
          {
            audio: lastAppliedAudioDeviceRef.current ?? null,
            video: lastAppliedVideoDeviceRef.current ?? null,
            output: lastAppliedOutputDeviceRef.current ?? null,
          },
          prefs
        )
        if (plan.audio.changed && micPublishedRef.current) {
          await room.unpublishMic()
          await room.publishMic(plan.audio.nextDeviceId)
          setIsMicOn(true)
        }
        lastAppliedAudioDeviceRef.current = plan.audio.nextDeviceId

        if (plan.video.changed && isWebcamOn) {
          await room.unpublishWebcam()
          await room.publishWebcam(plan.video.nextDeviceId)
          setIsWebcamOn(true)
        }
        lastAppliedVideoDeviceRef.current = plan.video.nextDeviceId

        if (plan.output.changed && outputDeviceSelectable) {
          await room.playbackManager?.setSinkId(
            plan.output.nextDeviceId ?? ""
          )
        }
        lastAppliedOutputDeviceRef.current = plan.output.nextDeviceId
      } catch (err) {
        console.warn("[VoiceChannel] live device re-publish failed:", err)
      }
    })()
  }, [
    room.isReady,
    prefs,
    isWebcamOn,
    outputDeviceSelectable,
    room.unpublishMic,
    room.publishMic,
    room.unpublishWebcam,
    room.publishWebcam,
    room.playbackManager,
  ])

  const handlePrejoinConfirm = React.useCallback(
    async (choice: VoicePrejoinChoice) => {
      setPrejoinOpen(false)
      const next = mergeVoiceDevicePrefs(prefsRef.current, {
        audioDeviceId: choice.audioDeviceId,
        videoDeviceId: choice.videoDeviceId,
        audioEnabled: choice.audioEnabled,
        videoEnabled: choice.videoEnabled,
        dontAskAgain: choice.dontAskAgain,
      })
      setPrefs(next)
      if (currentUserId) {
        void saveVoiceDevicePrefs(currentUserId, next, baseUrl).catch(() => {})
      }
      try {
        await connectRoomRef.current(roomName, displayName, channel.id)
        setHasJoined(true)
      } catch (err) {
        console.error("[VoiceChannel] connect after prejoin failed:", err)
      }
    },
    [currentUserId, roomName, displayName, channel.id, baseUrl]
  )

  const handlePrejoinDevicePrefsChange = React.useCallback(
    (patch: Parameters<typeof mergeVoiceDevicePrefs>[1]) => {
      const next = mergeVoiceDevicePrefs(prefsRef.current, patch)
      setPrefs(next)
      if (currentUserId) {
        void saveVoiceDevicePrefs(currentUserId, next, baseUrl).catch(() => {})
      }
    },
    [currentUserId, baseUrl]
  )

  const handlePrejoinCancel = React.useCallback(() => {
    setPrejoinOpen(false)
    void Promise.resolve(onLeave())
  }, [onLeave])

  const handleToggleMic = React.useCallback(async () => {
    if (isMicOn) {
      await room.muteMic()
      setIsMicOn(false)
      return
    }
    if (!micPublishedRef.current) {
      await room.publishMic(prefs?.audioDeviceId ?? null)
      micPublishedRef.current = true
    } else {
      await room.unmuteMic()
    }
    setIsMicOn(true)
    if (isDeafened) {
      room.playbackManager?.setRemoteAudioMuted(false)
      micBeforeDeafenRef.current = true
      setIsDeafened(false)
    }
  }, [isMicOn, isDeafened, prefs?.audioDeviceId, room])

  const handleToggleDeafen = React.useCallback(() => {
    setIsDeafened((prev) => {
      const next = !prev
      room.playbackManager?.setRemoteAudioMuted(next)
      if (next) {
        micBeforeDeafenRef.current = isMicOn
        if (isMicOn) {
          void room.muteMic().then(() => setIsMicOn(false))
        }
      } else if (micBeforeDeafenRef.current && micPublishedRef.current) {
        void room.unmuteMic().then(() => setIsMicOn(true))
      }
      return next
    })
  }, [isMicOn, room])

  const handleToggleWebcam = React.useCallback(async () => {
    if (isWebcamOn) {
      await room.unpublishWebcam()
      setIsWebcamOn(false)
      return
    }
    await room.publishWebcam(prefs?.videoDeviceId ?? null)
    setIsWebcamOn(true)
  }, [isWebcamOn, prefs?.videoDeviceId, room])

  const handleQualityPick = React.useCallback(
    async (key: Parameters<typeof bandwidth.setQualityKey>[0]) => {
      setShowQualityPicker(false)
      bandwidth.setQualityKey(key)
      if (isScreenSharing) {
        try {
          await room.changeQuality(key)
        } catch (err) {
          console.error("[VoiceChannel] quality change failed:", err)
        }
        return
      }
      try {
        const stream = await room.publishScreen(key)
        if (!stream) return
        setIsScreenSharing(true)
        stream
          .getVideoTracks()[0]
          ?.addEventListener("ended", () => setIsScreenSharing(false))
      } catch (err) {
        console.error("[VoiceChannel] screen share failed:", err)
      }
    },
    [bandwidth, isScreenSharing, room]
  )

  const handleToggleScreen = React.useCallback(async () => {
    if (isScreenSharing) {
      await room.unpublishScreen()
      setIsScreenSharing(false)
      return
    }
    if (screenShareResolutionCap === "720p") {
      await handleQualityPick("lite")
      return
    }
    setShowQualityPicker(true)
  }, [handleQualityPick, isScreenSharing, room, screenShareResolutionCap])

  const handleSwitchScreen = React.useCallback(async () => {
    if (!isScreenSharing) return
    try {
      const stream = await room.switchScreenSource(bandwidth.qualityKey)
      stream
        ?.getVideoTracks()[0]
        ?.addEventListener("ended", () => setIsScreenSharing(false))
    } catch (err) {
      console.error("[VoiceChannel] switch source failed:", err)
    }
  }, [bandwidth.qualityKey, isScreenSharing, room])

  const handleOpenMicPicker = React.useCallback(async () => {
    setAudioDevices(await listDevices("audioinput"))
    setShowMicPicker(true)
  }, [])

  const handleOpenWebcamPicker = React.useCallback(async () => {
    setVideoDevices(await listDevices("videoinput"))
    setShowWebcamPicker(true)
  }, [])

  const handleOpenOutputPicker = React.useCallback(async () => {
    if (!outputDeviceSelectable) return
    setOutputDevices(await listDevices("audiooutput"))
    setShowOutputPicker(true)
  }, [outputDeviceSelectable])

  const handlePickOutput = React.useCallback(
    async (deviceId: string) => {
      setShowOutputPicker(false)
      const next = mergeVoiceDevicePrefs(prefsRef.current, {
        outputDeviceId: deviceId,
      })
      setPrefs(next)
      if (currentUserId) {
        void saveVoiceDevicePrefs(currentUserId, next, baseUrl).catch(() => {})
      }
      try {
        await room.playbackManager?.setSinkId(deviceId)
        // Stamp the last-applied ref so the live re-publish effect
        // (which runs after the prefs subscriber fires) sees the
        // device already on the manager and skips a duplicate
        // setSinkId call.
        lastAppliedOutputDeviceRef.current = deviceId
      } catch (err) {
        console.error("[VoiceChannel] output device switch failed:", err)
      }
    },
    [currentUserId, room.playbackManager, baseUrl]
  )

  const handlePickMic = React.useCallback(
    async (deviceId: string) => {
      setShowMicPicker(false)
      const next = mergeVoiceDevicePrefs(prefsRef.current, {
        audioDeviceId: deviceId,
        audioEnabled: true,
      })
      setPrefs(next)
      if (currentUserId) {
        void saveVoiceDevicePrefs(currentUserId, next, baseUrl).catch(() => {})
      }
      if (micPublishedRef.current) await room.unpublishMic()
      await room.publishMic(deviceId)
      micPublishedRef.current = true
      setIsMicOn(true)
      // Stamp before the prefs subscriber re-fires the live
      // re-publish effect, otherwise we'd unpub+pub again here.
      lastAppliedAudioDeviceRef.current = deviceId
    },
    [currentUserId, room, baseUrl]
  )

  const handlePickWebcam = React.useCallback(
    async (deviceId: string) => {
      setShowWebcamPicker(false)
      const next = mergeVoiceDevicePrefs(prefsRef.current, {
        videoDeviceId: deviceId,
        videoEnabled: true,
      })
      setPrefs(next)
      if (currentUserId) {
        void saveVoiceDevicePrefs(currentUserId, next, baseUrl).catch(() => {})
      }
      if (isWebcamOn) await room.unpublishWebcam()
      await room.publishWebcam(deviceId)
      setIsWebcamOn(true)
      lastAppliedVideoDeviceRef.current = deviceId
    },
    [currentUserId, isWebcamOn, room, baseUrl]
  )

  const handleLeave = React.useCallback(async () => {
    try {
      await room.disconnectRoom()
    } catch {
      // already disconnected
    }
    void Promise.resolve(onLeave())
  }, [room, onLeave])

  const handleRejoin = React.useCallback(async () => {
    try {
      await room.disconnectRoom()
    } catch {
      // ignore
    }
    try {
      await room.connectRoom(roomName, displayName, channel.id)
    } catch (err) {
      console.error("[VoiceChannel] rejoin failed:", err)
    }
  }, [room, roomName, displayName, channel.id])

  // Keep the imperative voice-controls handle in sync with the latest
  // closures. Refs do not participate in render output, so this effect
  // is safe to refire — but it MUST NOT call onVoiceStateChange. Doing
  // so re-enters the parent on every render, and because `handleToggle*`
  // callbacks are rebuilt every render through the (unmemoised) `room`
  // object, that re-entry triggers an infinite update loop.
  React.useEffect(() => {
    if (!voiceControlsRef) return
    voiceControlsRef.current = {
      toggleMic: handleToggleMic,
      toggleDeafen: handleToggleDeafen,
      toggleScreenShare: handleToggleScreen,
      switchScreenSource: handleSwitchScreen,
      toggleWebcam: handleToggleWebcam,
      isScreenSharing,
      isWebcamOn,
      applyMicFilterSettings: room.updateMicFilterSettings,
      setOutputDeviceSink: async (deviceId) => {
        if (!outputDeviceSelectable) return
        await room.playbackManager?.setSinkId(deviceId ?? "")
        // Settings panel calls this BEFORE persisting prefs (so a
        // failed setSinkId does not corrupt the saved choice).
        // Stamping the ref here keeps the live re-publish effect
        // from re-running setSinkId once the prefs save propagates
        // back through the subscriber.
        lastAppliedOutputDeviceRef.current = deviceId ?? null
      },
    }
  })

  // Boolean-only state notification: refires only when one of the four
  // toggles actually flips, not on every render of this component.
  React.useEffect(() => {
    onVoiceStateChange?.({ isMicOn, isDeafened, isScreenSharing, isWebcamOn })
  }, [onVoiceStateChange, isMicOn, isDeafened, isScreenSharing, isWebcamOn])

  // Broadcast our mute/deafen state to peers so their compact
  // roster + active-call tile light up the corresponding badges.
  // Backend `internal/ws/client.go` re-broadcasts the frame to the
  // server room with a membership check; remote clients listen via
  // `useVoiceChannelPresence`. Only emit while joined to the
  // channel — emitting before join would leak presence and
  // emitting after leave would re-light a stale badge.
  React.useEffect(() => {
    if (!hasJoined) return
    if (!wsClient || !currentUserId || !serverId || !channel.id) return
    const ws = wsClient as {
      send: (type: string, payload: Record<string, unknown>) => void
      isConnected?: () => boolean
    }
    if (ws.isConnected && !ws.isConnected()) return
    ws.send("voice.mute_state", {
      server_id: serverId,
      channel_id: channel.id,
      user_id: currentUserId,
      is_muted: !isMicOn,
      is_deafened: isDeafened,
    })
  }, [
    hasJoined,
    wsClient,
    serverId,
    channel.id,
    currentUserId,
    isMicOn,
    isDeafened,
  ])

  React.useEffect(() => {
    if (!isScreenSharing) setLocalScreenWatched(false)
  }, [isScreenSharing])

  // Expand and fullscreen are independent affordances on the voice
  // surface:
  //   - Click a participant tile  → `expandedKey` is set; the grid
  //     collapses to that single tile sized to the channel view.
  //     Click the X on the expanded tile (or press Esc) to collapse.
  //   - Click the floating maximize button (bottom-right of the
  //     channel surface) → request browser fullscreen on the whole
  //     surface. Works whether or not a tile is expanded; the
  //     controls bar and the maximize button itself live inside the
  //     fullscreen subtree so they remain interactive.
  // Browser-level Esc auto-exits fullscreen via `fullscreenchange`;
  // a second Esc collapses any currently expanded tile.
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [cursorIdle, setCursorIdle] = React.useState(false)

  React.useEffect(() => {
    const onChange = () => {
      const el = document.fullscreenElement
      setIsFullscreen(el !== null && el === surfaceRef.current)
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // Idle-hide while fullscreen: any pointer activity or keypress
  // resets the timer; after IDLE_MS of stillness the controls bar
  // and cursor fade out, leaving a clean fullscreen surface.
  React.useEffect(() => {
    if (!isFullscreen) {
      setCursorIdle(false)
      return
    }
    const surface = surfaceRef.current
    if (!surface) return
    const IDLE_MS = 2200
    let timer: number | null = null
    const wake = () => {
      setCursorIdle(false)
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setCursorIdle(true), IDLE_MS)
    }
    wake()
    surface.addEventListener("mousemove", wake)
    surface.addEventListener("pointermove", wake)
    surface.addEventListener("touchstart", wake, { passive: true })
    surface.addEventListener("keydown", wake)
    surface.addEventListener("click", wake)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      surface.removeEventListener("mousemove", wake)
      surface.removeEventListener("pointermove", wake)
      surface.removeEventListener("touchstart", wake)
      surface.removeEventListener("keydown", wake)
      surface.removeEventListener("click", wake)
    }
  }, [isFullscreen])

  // Esc to collapse expanded tile when not in fullscreen. Browser's
  // built-in Esc handler exits fullscreen first; this listener only
  // fires for the second Esc (or any Esc when the tile is expanded
  // outside fullscreen).
  React.useEffect(() => {
    if (!expandedKey || isFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedKey(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [expandedKey, isFullscreen])

  const handleToggleFullscreen = React.useCallback(() => {
    const el = surfaceRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void el.requestFullscreen?.().catch(() => {})
    }
  }, [])

  // Hide the controls bar (and cursor) when fullscreen + idle.
  const hideChrome = isFullscreen && cursorIdle

  if (room.error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-6">
        <p className="text-sm text-destructive">{String(room.error)}</p>
        <Button onClick={() => void onLeave()}>Leave</Button>
      </div>
    )
  }

  return (
    <div
      ref={surfaceRef}
      className={cn(
        "relative flex h-full w-full flex-col bg-background",
        hideChrome && "cursor-none"
      )}
    >
      <div ref={audioContainerRef} className="hidden" />

      <div className="relative flex-1 overflow-hidden">
        <VoiceReconnectOverlay
          isReconnecting={room.isVoiceReconnecting}
          hasFailed={room.voiceReconnectFailed}
          onRejoin={handleRejoin}
        />
        {room.room ? (
          <RoomContext.Provider value={room.room}>
            <VoiceParticipantGrid
              className="p-4"
              localDeafened={isDeafened}
              expandedKey={expandedKey}
              onExpandChange={setExpandedKey}
            />
          </RoomContext.Provider>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Connecting…
          </div>
        )}
        {hasJoined && !isMobile ? (
          // Browser fullscreen on the channel surface is desktop-only.
          // iOS Safari refuses `requestFullscreen()` on arbitrary
          // elements (only `<video>` gets a vendor-prefixed alternative)
          // and Android Chrome's behaviour drifts across versions, so
          // hiding the affordance on mobile is cleaner than rendering
          // a button that silently fails.
          <button
            type="button"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            onClick={handleToggleFullscreen}
            className={cn(
              "absolute bottom-3 right-3 z-20 inline-flex size-10 items-center justify-center rounded-full border bg-background/95 text-foreground backdrop-blur transition-opacity duration-200",
              "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              hideChrome && "pointer-events-none opacity-0"
            )}
          >
            {isFullscreen ? (
              <MinimizeIcon className="size-4" />
            ) : (
              <MaximizeIcon className="size-4" />
            )}
          </button>
        ) : null}
        {hasJoined ? (
          <div
            className={cn(
              "transition-opacity duration-200",
              hideChrome && "pointer-events-none opacity-0"
            )}
          >
            <VoiceControlsBar
              isReady={room.isReady}
              isMicOn={isMicOn}
              isDeafened={isDeafened}
              isWebcamOn={isWebcamOn}
              isScreenSharing={isScreenSharing}
              qualityKey={bandwidth.qualityKey}
              onToggleMic={handleToggleMic}
              onToggleDeafen={handleToggleDeafen}
              onToggleWebcam={handleToggleWebcam}
              onToggleScreen={handleToggleScreen}
              onSwitchScreenSource={handleSwitchScreen}
              outputDeviceSelectable={outputDeviceSelectable}
              onPickMicDevice={handleOpenMicPicker}
              onPickWebcamDevice={handleOpenWebcamPicker}
              onPickOutputDevice={handleOpenOutputPicker}
              onLeave={handleLeave}
            />
          </div>
        ) : null}
      </div>

      <VoicePrejoinDialog
        channelName={channel.name}
        open={prejoinOpen}
        onConfirm={handlePrejoinConfirm}
        onCancel={handlePrejoinCancel}
        onDevicePrefsChange={handlePrejoinDevicePrefsChange}
        initial={
          prefs
            ? {
                audioDeviceId: prefs.audioDeviceId,
                videoDeviceId: prefs.videoDeviceId,
                audioEnabled: prefs.audioEnabled,
                videoEnabled: prefs.videoEnabled,
                dontAskAgain: prefs.dontAskAgain,
              }
            : undefined
        }
      />

      <VoiceQualityPickerDialog
        open={screenShareResolutionCap !== "720p" && showQualityPicker}
        recommendedQualityKey={bandwidth.recommendedQualityKey}
        recommendedUploadMbps={bandwidth.recommendedUploadMbps}
        onSelect={(key) => void handleQualityPick(key)}
        onCancel={() => setShowQualityPicker(false)}
      />

      <VoiceDevicePickerDialog
        open={showMicPicker}
        title="Choose microphone"
        devices={audioDevices}
        selectedDeviceId={prefs?.audioDeviceId ?? null}
        onSelect={(id) => void handlePickMic(id)}
        onCancel={() => setShowMicPicker(false)}
      />

      <VoiceDevicePickerDialog
        open={showWebcamPicker}
        title="Choose camera"
        devices={videoDevices}
        selectedDeviceId={prefs?.videoDeviceId ?? null}
        onSelect={(id) => void handlePickWebcam(id)}
        onCancel={() => setShowWebcamPicker(false)}
      />

      <VoiceDevicePickerDialog
        open={showOutputPicker}
        title="Choose audio output"
        description="Route remote voices to a specific speaker or headset."
        devices={outputDevices}
        selectedDeviceId={prefs?.outputDeviceId ?? null}
        onSelect={(id) => void handlePickOutput(id)}
        onCancel={() => setShowOutputPicker(false)}
      />
    </div>
  )
}
