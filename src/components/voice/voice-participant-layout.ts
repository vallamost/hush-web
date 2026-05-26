const TILE_GAP_PX = 8
const TILE_ASPECT = 16 / 9

export interface TileSize {
  width: number
  height: number
}

type OrderableTrackRef = {
  participant: { joinedAt?: Date | null }
}

type DedupableTrackRef = {
  participant: { identity?: string | null }
  source: unknown
  publication?: unknown
}

/**
 * Collapse duplicate track references emitted by `useTracks` for the
 * same (participant identity, source) pair.
 *
 * Under healthy conditions the LiveKit hook never repeats a pair, but
 * we have one reproducible report (Linux Chromium, peer with webcam
 * on) where a single participant rendered three tiles. The most
 * plausible cause is the placeholder track and the real publication
 * coexisting for a moment after camera enablement, with a stale
 * publication added on top. Rather than chase the LiveKit internals,
 * this helper enforces the invariant directly: at most one tile per
 * (identity, source). When a duplicate is observed, the entry with a
 * real `publication` wins over a placeholder so the user sees actual
 * media.
 *
 * Pure function so it can be unit-tested without livekit-client.
 */
export function dedupTracksByIdentitySource<T extends DedupableTrackRef>(
  tracks: readonly T[]
): T[] {
  const winners = new Map<string, T>()
  const order: string[] = []
  for (const track of tracks) {
    const identity = track.participant?.identity ?? ""
    const key = `${identity}::${String(track.source)}`
    const existing = winners.get(key)
    if (!existing) {
      winners.set(key, track)
      order.push(key)
      continue
    }
    const existingHasPub = Boolean(existing.publication)
    const candidateHasPub = Boolean(track.publication)
    if (candidateHasPub && !existingHasPub) {
      winners.set(key, track)
    }
  }
  return order.map((key) => winners.get(key) as T)
}

/**
 * Returns row buckets for `count` voice tiles. The last incomplete row is
 * centered by the grid renderer.
 */
export function computeRows(count: number): number[][] {
  if (count <= 1) return [[0]]
  if (count === 2) return [[0], [1]]
  if (count === 3) return [[0, 1], [2]]
  if (count === 4) return [[0, 1], [2, 3]]
  if (count === 5) return [[0, 1, 2], [3, 4]]
  if (count === 6) return [[0, 1, 2], [3, 4, 5]]
  if (count === 7) return [[0, 1, 2], [3, 4, 5], [6]]
  if (count === 8) return [[0, 1, 2, 3], [4, 5, 6, 7]]
  if (count === 9) return [[0, 1, 2], [3, 4, 5], [6, 7, 8]]

  const rows: number[][] = []
  for (let i = 0; i < count; i += 4) {
    rows.push(
      Array.from({ length: Math.min(4, count - i) }, (_, j) => i + j)
    )
  }
  return rows
}

/**
 * For the two-tile stacked layout, place the earliest joiner first. For every
 * other count, keep the existing row-major track order.
 */
export function orderTracksForStackedLayout<T extends OrderableTrackRef>(
  tracks: readonly T[]
): T[] {
  if (tracks.length !== 2) return tracks.slice()

  return tracks.slice().sort((a, b) => {
    const joinedA = getJoinedAtTime(a.participant?.joinedAt)
    const joinedB = getJoinedAtTime(b.participant?.joinedAt)
    if (joinedA === joinedB) return 0
    return joinedA < joinedB ? -1 : 1
  })
}

export function pickTileSize(box: TileSize, rows: number[][]): TileSize {
  if (box.width <= 0 || box.height <= 0) return { width: 0, height: 0 }
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 1)
  const rowCount = rows.length
  const widthBoundW =
    (box.width - (maxCols - 1) * TILE_GAP_PX) / maxCols
  const heightBoundH =
    (box.height - (rowCount - 1) * TILE_GAP_PX) / rowCount
  const heightBoundW = heightBoundH * TILE_ASPECT
  const tileW = Math.max(0, Math.min(widthBoundW, heightBoundW))
  return { width: tileW, height: tileW / TILE_ASPECT }
}

export function pickExpandedSize(box: TileSize): TileSize {
  if (box.width <= 0 || box.height <= 0) return { width: 0, height: 0 }
  const widthBoundW = box.width
  const heightBoundW = box.height * TILE_ASPECT
  const width = Math.max(0, Math.min(widthBoundW, heightBoundW))
  return { width, height: width / TILE_ASPECT }
}

function getJoinedAtTime(joinedAt: Date | null | undefined): number {
  return joinedAt instanceof Date
    ? joinedAt.getTime()
    : Number.POSITIVE_INFINITY
}
