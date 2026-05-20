import type { BugReportLifecycleState } from "./bugReport"

/**
 * Maps the auth context's `vaultState` field onto the bug-report
 * lifecycle enum. Lives here so every entry point that opens the
 * `BugReportDialog` (settings panel, global chrome button, future
 * surfaces) agrees on the mapping without copy-pasting the logic.
 *
 * The input is intentionally typed as `unknown` so callers can hand
 * over whatever `useAuth()` returns — including the stubbed shapes
 * tests inject — and the helper never throws.
 */
export function deriveLifecycleStateFromAuth(
  auth: unknown
): BugReportLifecycleState {
  if (!auth || typeof auth !== "object") return "unknown"

  const record = auth as { vaultState?: unknown; token?: unknown }
  const vaultState =
    typeof record.vaultState === "string" ? record.vaultState : null

  if (vaultState === "unlocked") return "authorized"
  if (vaultState === "locked") return "locked"
  if (vaultState === "none") return "anonymous"
  return "unknown"
}
