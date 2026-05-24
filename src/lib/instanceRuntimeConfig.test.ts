import { describe, expect, it } from "vitest"

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_SCREEN_SHARE_RESOLUTION_CAP,
  pickInstanceConfig,
  readMaxAttachmentBytes,
  readScreenShareResolutionCap,
} from "./instanceRuntimeConfig"

describe("readScreenShareResolutionCap", () => {
  it("reads the snake_case key", () => {
    expect(
      readScreenShareResolutionCap({ screen_share_resolution_cap: "720p" })
    ).toBe("720p")
  })

  it("reads the camelCase key", () => {
    expect(
      readScreenShareResolutionCap({ screenShareResolutionCap: "720p" })
    ).toBe("720p")
  })

  it("treats unknown values as the safe 1080p default", () => {
    // Server payload corruption must never broaden the cap beyond what
    // the client knows how to enforce.
    expect(
      readScreenShareResolutionCap({ screen_share_resolution_cap: "4k" })
    ).toBe("1080p")
    expect(
      readScreenShareResolutionCap({ screenShareResolutionCap: "" })
    ).toBe("1080p")
  })

  it("returns the default when no config is provided", () => {
    expect(readScreenShareResolutionCap(null)).toBe(
      DEFAULT_SCREEN_SHARE_RESOLUTION_CAP
    )
    expect(readScreenShareResolutionCap(undefined)).toBe(
      DEFAULT_SCREEN_SHARE_RESOLUTION_CAP
    )
    expect(readScreenShareResolutionCap({})).toBe(
      DEFAULT_SCREEN_SHARE_RESOLUTION_CAP
    )
  })
})

describe("readMaxAttachmentBytes", () => {
  it("reads the snake_case key", () => {
    expect(readMaxAttachmentBytes({ max_attachment_bytes: 1234 })).toBe(1234)
  })

  it("reads the camelCase key", () => {
    expect(readMaxAttachmentBytes({ maxAttachmentBytes: 1234 })).toBe(1234)
  })

  it("falls back to the default for non-positive, NaN, or non-numeric values", () => {
    // A 0 / negative / Infinity-like / non-number payload must never
    // disable the limit.
    expect(readMaxAttachmentBytes({ max_attachment_bytes: 0 })).toBe(
      DEFAULT_MAX_ATTACHMENT_BYTES
    )
    expect(readMaxAttachmentBytes({ maxAttachmentBytes: -1 })).toBe(
      DEFAULT_MAX_ATTACHMENT_BYTES
    )
    expect(readMaxAttachmentBytes({ max_attachment_bytes: NaN })).toBe(
      DEFAULT_MAX_ATTACHMENT_BYTES
    )
    expect(
      readMaxAttachmentBytes({
        // @ts-expect-error intentional bad type
        max_attachment_bytes: "1000",
      })
    ).toBe(DEFAULT_MAX_ATTACHMENT_BYTES)
  })

  it("returns the default when no config is provided", () => {
    expect(readMaxAttachmentBytes(null)).toBe(DEFAULT_MAX_ATTACHMENT_BYTES)
    expect(readMaxAttachmentBytes(undefined)).toBe(DEFAULT_MAX_ATTACHMENT_BYTES)
    expect(readMaxAttachmentBytes({})).toBe(DEFAULT_MAX_ATTACHMENT_BYTES)
  })
})

describe("pickInstanceConfig", () => {
  it("prefers the query result over the fallback", () => {
    const query = { max_attachment_bytes: 1 }
    const fallback = { max_attachment_bytes: 2 }
    expect(pickInstanceConfig(query, fallback)).toBe(query)
  })

  it("falls back to the legacy mirror when the query is empty", () => {
    const fallback = { max_attachment_bytes: 2 }
    expect(pickInstanceConfig(null, fallback)).toBe(fallback)
    expect(pickInstanceConfig(undefined, fallback)).toBe(fallback)
  })

  it("returns null when both sources are empty", () => {
    expect(pickInstanceConfig(null, null)).toBeNull()
    expect(pickInstanceConfig(undefined, undefined)).toBeNull()
  })
})
