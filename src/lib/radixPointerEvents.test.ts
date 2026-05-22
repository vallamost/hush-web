import { describe, expect, it } from "vitest"

import { restoreStaleBodyPointerEvents } from "./radixPointerEvents"

describe("restoreStaleBodyPointerEvents", () => {
  it("clears a stale body pointer-events lock when no overlay layer is mounted", () => {
    document.body.innerHTML = ""
    document.body.style.pointerEvents = "none"

    restoreStaleBodyPointerEvents(document)

    expect(document.body.style.pointerEvents).toBe("")
  })

  it("keeps the body lock while a modal layer is mounted", () => {
    document.body.innerHTML = '<div data-slot="dialog-content"></div>'
    document.body.style.pointerEvents = "none"

    restoreStaleBodyPointerEvents(document)

    expect(document.body.style.pointerEvents).toBe("none")
  })

  it("does not mutate an already interactive body", () => {
    document.body.innerHTML = ""
    document.body.style.pointerEvents = "auto"

    restoreStaleBodyPointerEvents(document)

    expect(document.body.style.pointerEvents).toBe("auto")
  })
})
