import { describe, expect, it } from "vitest"

import { deriveLifecycleStateFromAuth } from "./bugReportLifecycle"

describe("deriveLifecycleStateFromAuth", () => {
  it("maps the vault unlocked state to authorized", () => {
    expect(deriveLifecycleStateFromAuth({ vaultState: "unlocked" })).toBe(
      "authorized"
    )
  })

  it("maps the vault locked state to locked", () => {
    expect(deriveLifecycleStateFromAuth({ vaultState: "locked" })).toBe(
      "locked"
    )
  })

  it("maps the vault none state to anonymous", () => {
    expect(deriveLifecycleStateFromAuth({ vaultState: "none" })).toBe(
      "anonymous"
    )
  })

  it("returns unknown for null, undefined, or non-object input", () => {
    expect(deriveLifecycleStateFromAuth(null)).toBe("unknown")
    expect(deriveLifecycleStateFromAuth(undefined)).toBe("unknown")
    expect(deriveLifecycleStateFromAuth("hi" as unknown)).toBe("unknown")
  })

  it("returns unknown when vaultState is missing or not a string", () => {
    expect(deriveLifecycleStateFromAuth({})).toBe("unknown")
    expect(deriveLifecycleStateFromAuth({ vaultState: 42 })).toBe("unknown")
  })
})
