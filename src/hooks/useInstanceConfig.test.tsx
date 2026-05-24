import * as React from "react"
import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import {
  instanceConfigQueryKey,
  seedInstanceConfigQuery,
  mergeInstanceConfigUpdate,
} from "@/lib/instanceConfigQuery"
import { useInstanceConfig } from "./useInstanceConfig"
import {
  readMaxAttachmentBytes,
  readScreenShareResolutionCap,
} from "@/lib/instanceRuntimeConfig"

const INSTANCE_A = "https://a.example.com"
const INSTANCE_B = "https://b.example.com"

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  }
}

describe("useInstanceConfig", () => {
  let qc: QueryClient

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  it("returns normalized query data when the cache is populated", () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, {
      max_attachment_bytes: 1234,
      screen_share_resolution_cap: "720p",
    })

    const { result } = renderHook(() => useInstanceConfig(INSTANCE_A), {
      wrapper: makeWrapper(qc),
    })

    // Both casings are mirrored by the normalizer.
    expect(result.current).toMatchObject({
      max_attachment_bytes: 1234,
      maxAttachmentBytes: 1234,
      screen_share_resolution_cap: "720p",
      screenShareResolutionCap: "720p",
    })
  })

  it("falls back to the legacy mirror when the query cache is empty", () => {
    const fallback = {
      max_attachment_bytes: 99,
    }
    const { result } = renderHook(
      () => useInstanceConfig(INSTANCE_A, fallback),
      { wrapper: makeWrapper(qc) }
    )

    expect(result.current).toMatchObject({
      max_attachment_bytes: 99,
      maxAttachmentBytes: 99,
    })
  })

  it("query data wins over the legacy fallback", () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, {
      max_attachment_bytes: 7777,
    })

    const fallback = { max_attachment_bytes: 1 }
    const { result } = renderHook(
      () => useInstanceConfig(INSTANCE_A, fallback),
      { wrapper: makeWrapper(qc) }
    )

    expect(result.current?.max_attachment_bytes).toBe(7777)
  })

  it("returns null when no instanceUrl and no fallback", () => {
    const { result } = renderHook(() => useInstanceConfig(null), {
      wrapper: makeWrapper(qc),
    })
    expect(result.current).toBeNull()
  })

  it("re-renders when an instance_updated payload merges into the cache", () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, {
      max_attachment_bytes: 10,
    })

    const { result } = renderHook(() => useInstanceConfig(INSTANCE_A), {
      wrapper: makeWrapper(qc),
    })

    expect(result.current?.max_attachment_bytes).toBe(10)

    act(() => {
      mergeInstanceConfigUpdate(qc, INSTANCE_A, {
        type: "instance_updated",
        max_attachment_bytes: 5555,
      })
    })

    expect(result.current?.max_attachment_bytes).toBe(5555)
    expect(result.current?.maxAttachmentBytes).toBe(5555)
  })

  it("only reflects updates for the subscribed instance", () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, { max_attachment_bytes: 1 })
    seedInstanceConfigQuery(qc, INSTANCE_B, { max_attachment_bytes: 2 })

    const { result } = renderHook(() => useInstanceConfig(INSTANCE_A), {
      wrapper: makeWrapper(qc),
    })

    expect(result.current?.max_attachment_bytes).toBe(1)

    act(() => {
      mergeInstanceConfigUpdate(qc, INSTANCE_B, {
        type: "instance_updated",
        max_attachment_bytes: 999,
      })
    })

    // INSTANCE_A view is unchanged; only INSTANCE_B mutated.
    expect(result.current?.max_attachment_bytes).toBe(1)
  })

  // Small integration test: prove the hook output flows into the
  // derived consumer values without a `connectedInstances` change.
  it("derived consumer values follow cache updates without a fallback change", () => {
    const fallback = {
      max_attachment_bytes: 10,
      screen_share_resolution_cap: "1080p",
    }

    const { result } = renderHook(
      () => useInstanceConfig(INSTANCE_A, fallback),
      { wrapper: makeWrapper(qc) }
    )

    expect(readMaxAttachmentBytes(result.current)).toBe(10)
    expect(readScreenShareResolutionCap(result.current)).toBe("1080p")

    act(() => {
      mergeInstanceConfigUpdate(qc, INSTANCE_A, {
        type: "instance_updated",
        max_attachment_bytes: 8888,
        screen_share_resolution_cap: "720p",
      })
    })

    expect(readMaxAttachmentBytes(result.current)).toBe(8888)
    expect(readScreenShareResolutionCap(result.current)).toBe("720p")
  })
})
