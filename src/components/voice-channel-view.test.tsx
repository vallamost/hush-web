/**
 * Integration tests for the VoiceChannelView active-room device wiring.
 *
 * Targets the auto-publish + live-republish behaviour that pairs the
 * settings panel and the in-call device pickers with the published
 * tracks. Uses heavy mocks for `useRoom`, `useVoiceBandwidth`, the
 * MLS store, and every voice sub-component so the test can drive
 * device prefs through the real `voiceDevicePrefs` emitter without
 * pulling in livekit-client / WASM.
 *
 * Coverage:
 *  - Auto-publish on first mount uses default device when prefs say
 *    so + dontAskAgain skips the prejoin dialog.
 *  - Mic device change made via the panel (writes IDB +
 *    notifyVoiceDevicePrefs) re-publishes the active mic in-room.
 *  - Output device change via the panel pushes setSinkId to the
 *    playback manager.
 *  - In-call mic picker handler (which imperatively re-publishes
 *    BEFORE saving prefs) does not double-publish when the prefs
 *    subscriber re-fires the diff effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, cleanup, waitFor } from "@testing-library/react"

beforeEach(() => {
  if (typeof globalThis.MediaStream === "undefined") {
    // @ts-expect-error jsdom polyfill
    globalThis.MediaStream = class MockMediaStream {
      _tracks = []
    }
  }
})

const roomMock = vi.hoisted(() => {
  const handlers: Record<string, (deviceId: string | null) => unknown> = {}
  const playbackManager = {
    bindContainer: vi.fn(),
    unbindContainer: vi.fn(),
    setRemoteAudioMuted: vi.fn(),
    setSinkId: vi.fn().mockResolvedValue(undefined),
  }
  const api = {
    isReady: false,
    error: null as string | null,
    localTracks: new Map(),
    remoteTracks: new Map(),
    participants: [],
    isVoiceReconnecting: false,
    voiceReconnectFailed: false,
    activeSpeakerIds: [],
    localSpeaking: false,
    availableScreens: new Map(),
    watchedScreens: new Set(),
    loadingScreens: new Set(),
    connectRoom: vi.fn().mockResolvedValue(undefined),
    disconnectRoom: vi.fn().mockResolvedValue(undefined),
    publishScreen: vi.fn().mockResolvedValue(null),
    unpublishScreen: vi.fn().mockResolvedValue(undefined),
    switchScreenSource: vi.fn().mockResolvedValue(null),
    changeQuality: vi.fn().mockResolvedValue(undefined),
    publishWebcam: vi.fn().mockResolvedValue(undefined),
    unpublishWebcam: vi.fn().mockResolvedValue(undefined),
    publishMic: vi.fn().mockResolvedValue(undefined),
    unpublishMic: vi.fn().mockResolvedValue(undefined),
    muteMic: vi.fn().mockResolvedValue(undefined),
    unmuteMic: vi.fn().mockResolvedValue(undefined),
    updateMicFilterSettings: vi.fn(),
    watchScreen: vi.fn(),
    unwatchScreen: vi.fn(),
    playbackManager,
    room: null,
  }
  return { api, handlers, playbackManager }
})

vi.mock("@/hooks/useRoom", () => ({
  useRoom: () => roomMock.api,
}))

vi.mock("@/hooks/useVoiceBandwidth", () => ({
  useVoiceBandwidth: () => ({
    qualityKey: "balanced",
    setQualityKey: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}))

vi.mock("@/audio", () => ({
  isOutputDeviceSelectionSupported: () => true,
}))

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" }, token: "tok" }),
}))

vi.mock("@/hooks/useAuth", () => ({
  getDeviceId: () => "device-1",
  useAuth: () => ({ user: { id: "user-1" }, token: "tok" }),
}))

vi.mock("@/lib/mlsStore", () => ({
  open: vi.fn(),
  loadCredential: vi.fn(),
}))

vi.mock("@livekit/components-react", () => ({
  RoomContext: { Provider: ({ children }: { children: unknown }) => children },
}))

vi.mock("@livekit/components-styles", () => ({}))

// Lightweight stubs for sub-components — most tests only need a
// non-throwing render, while targeted interaction tests capture the
// control callbacks.
const controlsProps: {
  onToggleScreen?: () => void
  onToggleWebcam?: () => void
} = {}

vi.mock("@/components/voice/voice-controls-bar", () => ({
  VoiceControlsBar: (props: typeof controlsProps) => {
    controlsProps.onToggleScreen = props.onToggleScreen
    controlsProps.onToggleWebcam = props.onToggleWebcam
    return null
  },
}))
// Capture each picker's onSelect by title so tests can drive
// in-call mic / webcam / output handlers without rendering real
// dialog DOM.
const pickerHandlers: {
  mic: ((id: string) => void) | null
  camera: ((id: string) => void) | null
  output: ((id: string) => void) | null
} = { mic: null, camera: null, output: null }

vi.mock("@/components/voice/voice-device-picker-dialog", () => ({
  VoiceDevicePickerDialog: (props: {
    title?: string
    onSelect?: (id: string) => void
  }) => {
    if (typeof props.onSelect === "function") {
      if (props.title === "Choose microphone") pickerHandlers.mic = props.onSelect
      else if (props.title === "Choose camera") pickerHandlers.camera = props.onSelect
      else if (props.title === "Choose audio output") pickerHandlers.output = props.onSelect
    }
    return null
  },
}))
vi.mock("@/components/voice/voice-participant-grid", () => ({
  VoiceParticipantGrid: () => null,
}))
const qualityDialogProps: {
  open?: boolean
} = {}

vi.mock("@/components/voice/voice-quality-picker-dialog", () => ({
  VoiceQualityPickerDialog: (props: typeof qualityDialogProps) => {
    qualityDialogProps.open = props.open
    return null
  },
}))
vi.mock("@/components/voice/voice-reconnect-overlay", () => ({
  VoiceReconnectOverlay: () => null,
}))

const prejoinProps: {
  onDevicePrefsChange?: (patch: {
    audioDeviceId?: string | null
    videoDeviceId?: string | null
    audioEnabled?: boolean
    videoEnabled?: boolean
  }) => void
} = {}

vi.mock("@/components/voice/voice-prejoin-dialog", () => ({
  VoicePrejoinDialog: (props: typeof prejoinProps) => {
    prejoinProps.onDevicePrefsChange = props.onDevicePrefsChange
    return null
  },
}))

import {
  clearVoiceDevicePrefs,
  readVoiceDevicePrefs,
  saveVoiceDevicePrefs,
} from "@/lib/voiceDevicePrefs"
import { VoiceChannelView, pickVoiceDisplayName } from "./voice-channel-view"

const CHANNEL = { id: "ch-1", name: "general", type: "voice" as const }
const WS_CLIENT = {
  send: vi.fn(),
  isConnected: () => true,
}
const NEXT_WS_CLIENT = {
  send: vi.fn(),
  isConnected: () => true,
}

describe("pickVoiceDisplayName", () => {
  it("falls back past blank display names before using Anonymous", () => {
    expect(pickVoiceDisplayName({
      displayName: "  ",
      display_name: "",
      username: "alice",
    })).toBe("alice")
    expect(pickVoiceDisplayName({
      displayName: "",
      display_name: "Alice A.",
      username: "alice",
    })).toBe("Alice A.")
    expect(pickVoiceDisplayName(null)).toBe("Anonymous")
  })
})

function setRoomReady(ready: boolean) {
  roomMock.api.isReady = ready
}

function resetRoomMock() {
  roomMock.api.isReady = false
  roomMock.api.connectRoom.mockClear().mockResolvedValue(undefined)
  roomMock.api.disconnectRoom.mockClear().mockResolvedValue(undefined)
  roomMock.api.publishMic.mockClear().mockResolvedValue(undefined)
  roomMock.api.unpublishMic.mockClear().mockResolvedValue(undefined)
  roomMock.api.publishWebcam.mockClear().mockResolvedValue(undefined)
  roomMock.api.unpublishWebcam.mockClear().mockResolvedValue(undefined)
  roomMock.api.publishScreen.mockClear().mockResolvedValue(null)
  roomMock.api.unpublishScreen.mockClear().mockResolvedValue(undefined)
  roomMock.api.switchScreenSource.mockClear().mockResolvedValue(null)
  roomMock.api.changeQuality.mockClear().mockResolvedValue(undefined)
  roomMock.playbackManager.setSinkId.mockClear().mockResolvedValue(undefined)
  WS_CLIENT.send.mockClear()
  NEXT_WS_CLIENT.send.mockClear()
}

beforeEach(async () => {
  resetRoomMock()
  pickerHandlers.mic = null
  pickerHandlers.camera = null
  pickerHandlers.output = null
  controlsProps.onToggleScreen = undefined
  controlsProps.onToggleWebcam = undefined
  qualityDialogProps.open = undefined
  prejoinProps.onDevicePrefsChange = undefined
  await clearVoiceDevicePrefs("user-1").catch(() => {})
})

afterEach(() => {
  cleanup()
})

async function mount(props: {
  screenShareResolutionCap?: "1080p" | "720p"
  baseUrl?: string
} = {}) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <VoiceChannelView
        channel={CHANNEL}
        serverId="srv-1"
        getToken={() => "tok"}
        wsClient={WS_CLIENT}
        onLeave={vi.fn()}
        screenShareResolutionCap={props.screenShareResolutionCap}
        baseUrl={props.baseUrl}
      />
    )
    // Let the prefs-load effect resolve.
    await Promise.resolve()
  })
  await act(async () => {
    setRoomReady(true)
    // Force a re-render so effects depending on room.isReady fire.
    result.rerender(
      <VoiceChannelView
        channel={CHANNEL}
        serverId="srv-1"
        getToken={() => "tok"}
        wsClient={WS_CLIENT}
        onLeave={vi.fn()}
        screenShareResolutionCap={props.screenShareResolutionCap}
        baseUrl={props.baseUrl}
      />
    )
    await Promise.resolve()
  })
  return result
}

describe("VoiceChannelView — auto-join lifecycle", () => {
  it("does not abort an in-flight auto-join when callback or wsClient props refresh", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: false,
      videoEnabled: false,
      dontAskAgain: true,
    })
    roomMock.api.connectRoom.mockImplementationOnce(
      () => new Promise(() => {})
    )

    let result!: ReturnType<typeof render>
    await act(async () => {
      result = render(
        <VoiceChannelView
          channel={CHANNEL}
          serverId="srv-1"
          getToken={() => "tok-a"}
          wsClient={WS_CLIENT}
          onLeave={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(roomMock.api.connectRoom).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      result.rerender(
        <VoiceChannelView
          channel={CHANNEL}
          serverId="srv-1"
          getToken={() => "tok-b"}
          wsClient={NEXT_WS_CLIENT}
          onLeave={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(roomMock.api.disconnectRoom).not.toHaveBeenCalled()
    expect(roomMock.api.connectRoom).toHaveBeenCalledTimes(1)
  })
})

describe("VoiceChannelView — auto-publish with skip prejoin + default device", () => {
  it("publishes the system default mic when audioDeviceId is null", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: true,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalledWith(null)
    })
  })

  // HUSHHQ-14: camera enablement is session-local. Persisted
  // `videoEnabled: true` (including historical records from before
  // this fix) must NOT auto-start the webcam on join. Users have
  // to flip the camera on explicitly each session.
  it("does not auto-publish the webcam even when persisted videoEnabled is true", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: "cam-saved",
      outputDeviceId: null,
      audioEnabled: false,
      videoEnabled: true,
      dontAskAgain: true,
    })

    await mount()

    // Wait long enough for any auto-publish effect to settle.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(roomMock.api.publishWebcam).not.toHaveBeenCalled()
  })

  it("does not auto-publish the webcam when videoEnabled is false", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: false,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(roomMock.api.publishWebcam).not.toHaveBeenCalled()
  })

  it("publishes the webcam when the user explicitly toggles it on after join", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: "cam-saved",
      outputDeviceId: null,
      audioEnabled: false,
      videoEnabled: true,
      dontAskAgain: true,
    })

    await mount()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(roomMock.api.publishWebcam).not.toHaveBeenCalled()

    expect(controlsProps.onToggleWebcam).toBeTypeOf("function")
    await act(async () => {
      await controlsProps.onToggleWebcam?.()
    })

    expect(roomMock.api.publishWebcam).toHaveBeenCalledWith("cam-saved")
  })

  it("publishes a saved mic id when one is persisted", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: "mic-saved",
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: true,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalledWith("mic-saved")
    })
  })
})

describe("VoiceChannelView — prejoin device preference sync", () => {
  it("persists device changes made from the prejoin dialog", async () => {
    await mount()

    expect(prejoinProps.onDevicePrefsChange).toBeTypeOf("function")
    await act(async () => {
      prejoinProps.onDevicePrefsChange?.({
        audioDeviceId: "mic-prejoin",
        videoDeviceId: "cam-prejoin",
        audioEnabled: true,
        videoEnabled: true,
      })
      await Promise.resolve()
    })

    await waitFor(async () => {
      const prefs = await readVoiceDevicePrefs("user-1")
      expect(prefs).toMatchObject({
        audioDeviceId: "mic-prejoin",
        videoDeviceId: "cam-prejoin",
        audioEnabled: true,
        videoEnabled: true,
      })
    })
  })
})

describe("VoiceChannelView — screen-share resolution policy", () => {
  it("starts screen sharing at 720p directly when the instance caps resolution", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: false,
      videoEnabled: false,
      dontAskAgain: true,
    })
    const track = { addEventListener: vi.fn() }
    roomMock.api.publishScreen.mockResolvedValueOnce({
      getVideoTracks: () => [track],
    })

    await mount({ screenShareResolutionCap: "720p" })

    await waitFor(() => {
      expect(controlsProps.onToggleScreen).toBeTypeOf("function")
    })
    await act(async () => {
      await controlsProps.onToggleScreen?.()
    })

    expect(roomMock.api.publishScreen).toHaveBeenCalledWith("lite")
    expect(qualityDialogProps.open).not.toBe(true)
  })

  it("opens the quality picker when the instance allows 1080p", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: false,
      videoEnabled: false,
      dontAskAgain: true,
    })
    await mount({ screenShareResolutionCap: "1080p" })

    await waitFor(() => {
      expect(controlsProps.onToggleScreen).toBeTypeOf("function")
    })
    await act(async () => {
      await controlsProps.onToggleScreen?.()
    })

    expect(roomMock.api.publishScreen).not.toHaveBeenCalled()
    expect(qualityDialogProps.open).toBe(true)
  })
})

describe("VoiceChannelView — live re-publish on prefs change", () => {
  it("re-publishes the mic when audioDeviceId changes via prefs save", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: "mic-a",
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: true,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalledWith("mic-a")
    })

    roomMock.api.publishMic.mockClear()
    roomMock.api.unpublishMic.mockClear()

    // Simulate the settings panel writing a new mic.
    await act(async () => {
      await saveVoiceDevicePrefs("user-1", {
        audioDeviceId: "mic-b",
        videoDeviceId: null,
        outputDeviceId: null,
        audioEnabled: true,
        videoEnabled: false,
        dontAskAgain: true,
      })
    })

    await waitFor(() => {
      expect(roomMock.api.unpublishMic).toHaveBeenCalledTimes(1)
      expect(roomMock.api.publishMic).toHaveBeenCalledWith("mic-b")
    })
  })

  it("pushes setSinkId when outputDeviceId changes via prefs save", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: null,
      videoDeviceId: null,
      outputDeviceId: "out-a",
      audioEnabled: true,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    // The first setSinkId comes from the existing prefs-loaded
    // playback effect; clear it before driving the change.
    await waitFor(() => {
      expect(roomMock.playbackManager.setSinkId).toHaveBeenCalled()
    })
    roomMock.playbackManager.setSinkId.mockClear()

    await act(async () => {
      await saveVoiceDevicePrefs("user-1", {
        audioDeviceId: null,
        videoDeviceId: null,
        outputDeviceId: "out-b",
        audioEnabled: true,
        videoEnabled: false,
        dontAskAgain: true,
      })
    })

    await waitFor(() => {
      expect(roomMock.playbackManager.setSinkId).toHaveBeenCalledWith("out-b")
    })
  })

  it("in-call mic picker handler republishes exactly once (no double-publish)", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: "mic-a",
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: true,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalledWith("mic-a")
      expect(pickerHandlers.mic).toBeTypeOf("function")
    })
    roomMock.api.publishMic.mockClear()
    roomMock.api.unpublishMic.mockClear()

    // Simulate the user picking a different mic from the in-call
    // picker. The handler imperatively re-publishes AND saves prefs;
    // the prefs subscriber re-fires the diff effect, which must
    // see lastApplied === incoming and no-op.
    await act(async () => {
      pickerHandlers.mic!("mic-b")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalledWith("mic-b")
    })
    expect(roomMock.api.unpublishMic).toHaveBeenCalledTimes(1)
    expect(roomMock.api.publishMic).toHaveBeenCalledTimes(1)
  })

  it("does not republish when the panel saves a no-op prefs update", async () => {
    await saveVoiceDevicePrefs("user-1", {
      audioDeviceId: "mic-a",
      videoDeviceId: null,
      outputDeviceId: null,
      audioEnabled: true,
      videoEnabled: false,
      dontAskAgain: true,
    })

    await mount()

    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalledWith("mic-a")
    })
    roomMock.api.publishMic.mockClear()
    roomMock.api.unpublishMic.mockClear()

    // Only the dontAskAgain flag flips — same audio device id.
    await act(async () => {
      await saveVoiceDevicePrefs("user-1", {
        audioDeviceId: "mic-a",
        videoDeviceId: null,
        outputDeviceId: null,
        audioEnabled: true,
        videoEnabled: false,
        dontAskAgain: false,
      })
    })

    // Give the effect a tick to NOT fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(roomMock.api.unpublishMic).not.toHaveBeenCalled()
    expect(roomMock.api.publishMic).not.toHaveBeenCalled()
  })
})

describe("VoiceChannelView — prejoin prefs scoped by instance origin", () => {
  const ORIGIN_HOME = "https://app.gethush.live"
  const ORIGIN_PEER = "https://peer.example.com"

  beforeEach(async () => {
    await clearVoiceDevicePrefs("user-1", ORIGIN_HOME).catch(() => {})
    await clearVoiceDevicePrefs("user-1", ORIGIN_PEER).catch(() => {})
  })

  it("skips prejoin and auto-joins when scoped dontAskAgain is set for the active baseUrl", async () => {
    await saveVoiceDevicePrefs(
      "user-1",
      {
        audioDeviceId: null,
        videoDeviceId: null,
        outputDeviceId: null,
        audioEnabled: true,
        videoEnabled: false,
        dontAskAgain: true,
      },
      ORIGIN_HOME
    )

    await mount({ baseUrl: ORIGIN_HOME })

    await waitFor(() => {
      expect(roomMock.api.connectRoom).toHaveBeenCalled()
    })
    // Auto-publish kicked in because prejoin was skipped.
    await waitFor(() => {
      expect(roomMock.api.publishMic).toHaveBeenCalled()
    })
  })

  it("does not skip prejoin when dontAskAgain is set only for a different baseUrl", async () => {
    // Prefs saved against ORIGIN_PEER must not satisfy a join via
    // ORIGIN_HOME — the prejoin dialog must still surface.
    await saveVoiceDevicePrefs(
      "user-1",
      {
        audioDeviceId: null,
        videoDeviceId: null,
        outputDeviceId: null,
        audioEnabled: true,
        videoEnabled: false,
        dontAskAgain: true,
      },
      ORIGIN_PEER
    )

    await mount({ baseUrl: ORIGIN_HOME })

    // The component opens prejoin when no scoped prefs exist for the
    // active baseUrl. `prejoinProps.onDevicePrefsChange` is wired by
    // the dialog when it mounts.
    await waitFor(() => {
      expect(prejoinProps.onDevicePrefsChange).toBeTypeOf("function")
    })
    // No auto-publish — the user has not confirmed prejoin for this
    // origin yet.
    expect(roomMock.api.publishMic).not.toHaveBeenCalled()
  })
})
