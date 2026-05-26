/**
 * Tests for the pure layout helpers used by
 * `voice-participant-grid.tsx`. The grid itself depends on
 * @livekit/components-react which we do not exercise here; we only
 * pin the row-layout contract and the stacked-layout join-order
 * contract.
 */
import { describe, it, expect } from "vitest"
import {
  computeRows,
  dedupTracksByIdentitySource,
  orderTracksForStackedLayout,
} from "./voice-participant-layout"

describe("computeRows", () => {
  it("returns a single cell for the lonely (zero/one tile) case", () => {
    expect(computeRows(0)).toEqual([[0]])
    expect(computeRows(1)).toEqual([[0]])
  })

  it("stacks two tiles vertically (top/bottom), not side by side", () => {
    // Product contract: two-participant voice and lonely-with-
    // placeholder must read top-to-bottom so the first joiner sits
    // on top. A side-by-side layout (the prior `[[0, 1]]`) leaves
    // both tiles at the same vertical position with no visual
    // hierarchy.
    expect(computeRows(2)).toEqual([[0], [1]])
  })

  it("keeps the legacy centred-last-row shape for 3 and 4 participants", () => {
    expect(computeRows(3)).toEqual([[0, 1], [2]])
    expect(computeRows(4)).toEqual([[0, 1], [2, 3]])
  })

  it("uses the legacy 3-column / 4-column shapes for 5+ participants", () => {
    expect(computeRows(5)).toEqual([[0, 1, 2], [3, 4]])
    expect(computeRows(8)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]])
    expect(computeRows(10)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
  })
})

describe("orderTracksForStackedLayout", () => {
  const makeTrack = (joinedAtMs: number | null, label: string) => ({
    participant: {
      joinedAt: joinedAtMs === null ? null : new Date(joinedAtMs),
    },
    label,
  })

  it("is a no-op for any count other than 2", () => {
    const one = [makeTrack(10, "a")]
    expect(orderTracksForStackedLayout(one)).toEqual(one)

    const three = [makeTrack(30, "c"), makeTrack(10, "a"), makeTrack(20, "b")]
    // Same order, just a shallow copy.
    expect(orderTracksForStackedLayout(three).map((t) => t.label)).toEqual([
      "c",
      "a",
      "b",
    ])
  })

  it("puts the earlier joiner first in a two-tile layout", () => {
    const later = makeTrack(2_000, "later")
    const earlier = makeTrack(1_000, "earlier")
    const ordered = orderTracksForStackedLayout([later, earlier])
    expect(ordered.map((t) => t.label)).toEqual(["earlier", "later"])
  })

  it("treats missing joinedAt as 'unknown / latest' so a known joiner takes the top slot", () => {
    const known = makeTrack(1_000, "known")
    const unknown = makeTrack(null, "unknown")
    const ordered = orderTracksForStackedLayout([unknown, known])
    expect(ordered.map((t) => t.label)).toEqual(["known", "unknown"])
  })

  it("preserves input order when both joinedAt values tie (stable sort)", () => {
    const a = makeTrack(1_000, "a")
    const b = makeTrack(1_000, "b")
    const ordered = orderTracksForStackedLayout([a, b])
    expect(ordered.map((t) => t.label)).toEqual(["a", "b"])
  })

  it("returns a new array, never mutates the input", () => {
    const input = [makeTrack(2_000, "later"), makeTrack(1_000, "earlier")]
    const beforeLabels = input.map((t) => t.label)
    orderTracksForStackedLayout(input)
    expect(input.map((t) => t.label)).toEqual(beforeLabels)
  })
})

describe("dedupTracksByIdentitySource", () => {
  const track = (
    identity: string,
    source: string,
    publication?: { sid: string } | null,
    tag?: string,
  ) => ({
    participant: { identity },
    source,
    publication: publication ?? undefined,
    tag,
  })

  it("returns the input unchanged when every (identity, source) pair is unique", () => {
    const tracks = [
      track("alice", "camera", { sid: "a-cam" }, "1"),
      track("alice", "screen_share", { sid: "a-ss" }, "2"),
      track("bob", "camera", { sid: "b-cam" }, "3"),
    ]
    const result = dedupTracksByIdentitySource(tracks)
    expect(result.map((t) => t.tag)).toEqual(["1", "2", "3"])
  })

  it("collapses repeats of the same (identity, source) pair", () => {
    const tracks = [
      track("alice", "camera", { sid: "a-cam-old" }, "stale"),
      track("alice", "camera", { sid: "a-cam-new" }, "fresh"),
      track("alice", "camera", { sid: "a-cam-old2" }, "ghost"),
    ]
    const result = dedupTracksByIdentitySource(tracks)
    expect(result).toHaveLength(1)
  })

  it("prefers a real publication over a placeholder entry", () => {
    const placeholder = track("alice", "camera", null, "placeholder")
    const real = track("alice", "camera", { sid: "a-cam" }, "real")
    expect(
      dedupTracksByIdentitySource([placeholder, real]).map((t) => t.tag),
    ).toEqual(["real"])
    expect(
      dedupTracksByIdentitySource([real, placeholder]).map((t) => t.tag),
    ).toEqual(["real"])
  })

  it("preserves first-seen order for kept entries", () => {
    const tracks = [
      track("alice", "screen_share", { sid: "a-ss" }, "a-ss"),
      track("bob", "camera", { sid: "b-cam" }, "b-cam"),
      track("alice", "screen_share", { sid: "a-ss-dup" }, "dup"),
      track("alice", "camera", { sid: "a-cam" }, "a-cam"),
    ]
    expect(
      dedupTracksByIdentitySource(tracks).map((t) => t.tag),
    ).toEqual(["a-ss", "b-cam", "a-cam"])
  })

  it("treats missing identity as a single empty bucket", () => {
    const tracks = [
      track("", "camera", { sid: "1" }, "first"),
      track("", "camera", { sid: "2" }, "second"),
    ]
    expect(
      dedupTracksByIdentitySource(tracks).map((t) => t.tag),
    ).toEqual(["first"])
  })
})
