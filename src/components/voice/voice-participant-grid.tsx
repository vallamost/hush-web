import * as React from "react"
import { useTracks } from "@livekit/components-react"
import "@livekit/components-styles"
import { Track } from "livekit-client"

import { cn } from "@/lib/utils"
import { VoiceParticipantTile } from "./voice-participant-tile"
import { VoiceLonelyTile } from "./voice-lonely-tile"
import {
  computeRows,
  dedupTracksByIdentitySource,
  orderTracksForStackedLayout,
  pickExpandedSize,
  pickTileSize,
  type TileSize,
} from "./voice-participant-layout"

interface VoiceParticipantGridProps {
  className?: string
  /** Local user's deafen state. LiveKit has no track for "audio out
   *  off" — it's a client-only flag — so the grid receives it from
   *  the parent and forwards it to the local participant tile so a
   *  deafened user gets the headphone-off badge on their own tile. */
  localDeafened?: boolean
  /** Stable identifier of the currently expanded tile. When non-null,
   *  the grid renders only that tile, sized to the full container.
   *  Independent from browser fullscreen — the floating fullscreen
   *  button on the channel surface works whether a tile is expanded
   *  or the full grid is visible. */
  expandedKey?: string | null
  /** Setter the parent owns so this state can survive React re-renders
   *  triggered by track-list churn. */
  onExpandChange?: (key: string | null) => void
}

function tileKey(participantIdentity: string, source: Track.Source): string {
  return `${participantIdentity}:${source}`
}

/**
 * Voice channel participant grid.
 *
 * `useTracks` against the shared `RoomContext` (set by the voice
 * orchestrator over our MLS-aware `useRoom` Room) drives the tile
 * list. Layout is row-major flex with the last row centred — keeps
 * three participants laid out as `[A B] / [   C   ]` instead of the
 * legacy 2×2 grid that left a hole on the right. Each row sizes its
 * tiles to a strict 16:9 box so webcam content doesn't squash.
 *
 * When the user is alone (`tracks.length <= 1`), we sub in a "lonely"
 * tile beneath the user's own so the grid still shows two cells and
 * there is a visible cue that nobody else has joined yet. The lonely
 * tile is intentionally non-expandable (placeholder, no real stream).
 */
export function VoiceParticipantGrid({
  className,
  localDeafened = false,
  expandedKey = null,
  onExpandChange,
}: VoiceParticipantGridProps) {
  const rawTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  )

  // HUSHHQ-78: defensively collapse any duplicates emitted for the
  // same (participant identity, source). Healthy useTracks output has
  // none; this guards against the Linux/webcam-on triple-tile report.
  // No-op under normal conditions.
  const dedupedTracks = React.useMemo(
    () => dedupTracksByIdentitySource(rawTracks),
    [rawTracks]
  )
  const isLonely = dedupedTracks.length <= 1
  // Re-order tracks for the stacked two-tile layouts so the first
  // joiner is at index 0 (visually on top). orderTracksForStackedLayout
  // is a no-op for any other count, so 3+ participant layouts keep
  // their row-major order — shuffling tiles between rows on every
  // join/leave would defeat the existing centred-last-row layout.
  const tracks = React.useMemo(
    () => orderTracksForStackedLayout(dedupedTracks),
    [dedupedTracks]
  )
  const rows = React.useMemo(() => {
    const visibleCount = isLonely ? 2 : tracks.length
    return computeRows(visibleCount)
  }, [isLonely, tracks.length])

  // Compute the largest tile size that fits the container while every
  // tile stays at 16:9. CSS `aspect-ratio` + `max-h-full max-w-full`
  // would only set upper bounds: with no explicit width/height the
  // grid sizes to its intrinsic content (which for a flexible 1fr ×
  // 1fr grid is the children's min-content), far smaller than the
  // container. We therefore measure the parent and set explicit pixel
  // dimensions so the grid always claims the full available real
  // estate.
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const [box, setBox] = React.useState<TileSize>({ width: 0, height: 0 })
  React.useEffect(() => {
    const node = wrapperRef.current
    if (!node || typeof ResizeObserver === "undefined") return
    let raf = 0
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      // Coalesce notifications into a single frame: a naive setBox per
      // entry caused ResizeObserver loops on slow renders, freezing the
      // shell while the browser kept retrying. We also no-op when the
      // dimensions are unchanged so we never schedule a state update
      // that would not affect output.
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        setBox((prev) => {
          const w = Math.round(rect.width)
          const h = Math.round(rect.height)
          if (prev.width === w && prev.height === h) return prev
          return { width: w, height: h }
        })
      })
    })
    observer.observe(node)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  // Lookup expanded track. If the expanded participant disappears
  // (left the call, screen share stopped) we collapse silently so
  // the grid never renders against a stale key.
  const expandedTrack = React.useMemo(() => {
    if (!expandedKey) return null
    return (
      tracks.find(
        (t) => tileKey(t.participant.identity, t.source) === expandedKey
      ) ?? null
    )
  }, [tracks, expandedKey])
  React.useEffect(() => {
    if (expandedKey && !expandedTrack) onExpandChange?.(null)
  }, [expandedKey, expandedTrack, onExpandChange])

  const tileSize = pickTileSize(box, rows)
  const expandedSize = pickExpandedSize(box)

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "flex size-full items-center justify-center overflow-hidden",
        className
      )}
    >
      {expandedTrack && expandedSize.width > 0 ? (
        <div
          style={{
            width: `${expandedSize.width}px`,
            height: `${expandedSize.height}px`,
          }}
        >
          <VoiceParticipantTile
            trackRef={expandedTrack}
            isDeafened={
              expandedTrack.participant.isLocal ? localDeafened : false
            }
            isExpanded
            onCollapse={() => onExpandChange?.(null)}
          />
        </div>
      ) : tileSize.width > 0 ? (
        <div className="flex flex-col items-center justify-center gap-2">
          {rows.map((row, rowIdx) => (
            <div
              key={rowIdx}
              className="flex justify-center gap-2"
              style={{ height: `${tileSize.height}px` }}
            >
              {row.map((idx) => {
                if (idx < tracks.length) {
                  const trackRef = tracks[idx]
                  const key = tileKey(
                    trackRef.participant.identity,
                    trackRef.source
                  )
                  return (
                    <div
                      key={key}
                      style={{
                        width: `${tileSize.width}px`,
                        height: `${tileSize.height}px`,
                      }}
                    >
                      <VoiceParticipantTile
                        trackRef={trackRef}
                        isDeafened={
                          trackRef.participant.isLocal ? localDeafened : false
                        }
                        onExpand={
                          onExpandChange
                            ? () => onExpandChange(key)
                            : undefined
                        }
                      />
                    </div>
                  )
                }
                // Lonely placeholder slot. Not expandable.
                return (
                  <div
                    key="lonely"
                    style={{
                      width: `${tileSize.width}px`,
                      height: `${tileSize.height}px`,
                    }}
                  >
                    <VoiceLonelyTile />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
