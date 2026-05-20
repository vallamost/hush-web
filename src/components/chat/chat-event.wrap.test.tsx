/**
 * Regression: long unbroken text inside a chat message must wrap within
 * the channel column and must not turn the channel view into a
 * horizontal scroller. The structural guarantee we rely on is:
 *   - `ChatEventBody` is a flex child with `min-w-0`.
 *   - `ChatEventContent` carries `min-w-0`, `break-words`, and
 *     `overflow-wrap: anywhere` so a single long token wraps.
 *
 * We assert these on the rendered DOM so a regression that drops the
 * class fails the test before reaching production.
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import {
  ChatEvent,
  ChatEventBody,
  ChatEventContent,
} from "./chat-event"

const LONG_TOKEN = "a".repeat(400)

describe("chat-event wrapping", () => {
  afterEach(() => cleanup())

  it("ChatEventBody is a flex child that allows horizontal shrink", () => {
    render(
      <ChatEvent data-testid="event">
        <ChatEventBody data-testid="body">
          <ChatEventContent data-testid="content">{LONG_TOKEN}</ChatEventContent>
        </ChatEventBody>
      </ChatEvent>
    )

    const body = screen.getByTestId("body")
    expect(body.className).toContain("min-w-0")
    expect(body.className).toContain("flex-1")
  })

  it("ChatEventContent wraps long unbroken text", () => {
    render(
      <ChatEvent>
        <ChatEventBody>
          <ChatEventContent data-testid="content">{LONG_TOKEN}</ChatEventContent>
        </ChatEventBody>
      </ChatEvent>
    )

    const content = screen.getByTestId("content")
    expect(content.className).toContain("break-words")
    expect(content.className).toContain("[overflow-wrap:anywhere]")
    expect(content.className).toContain("whitespace-pre-wrap")
    expect(content.className).toContain("min-w-0")
  })
})
