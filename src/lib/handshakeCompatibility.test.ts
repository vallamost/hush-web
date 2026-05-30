import { describe, it, expect, vi, beforeEach } from "vitest";

import { evaluateHandshakeCompatibility } from "./handshakeCompatibility";
import { requestUpdate } from "./updateRequired";
import { CURRENT_MLS_CIPHERSUITE } from "./mlsCiphersuite";

// The function under test dispatches an update-required request as a side
// effect. Mock it so we can assert on calls without touching the DOM event
// bus or the dialog.
vi.mock("./updateRequired", () => ({
  requestUpdate: vi.fn(),
}));

const requestUpdateMock = vi.mocked(requestUpdate);

// CLIENT_VERSION is read from package.json (currently 0.7.0-alpha.x). Use a
// far-future version to force "below minimum" and a far-past version to force
// "compatible", so the assertions do not depend on the exact running version.
const FUTURE = "99.0.0";
const PAST = "0.0.1";

describe("evaluateHandshakeCompatibility", () => {
  beforeEach(() => {
    requestUpdateMock.mockClear();
  });

  it("Test_NullHandshake_ReturnsNull_NoEvent", () => {
    expect(evaluateHandshakeCompatibility(null)).toBeNull();
    expect(evaluateHandshakeCompatibility(undefined)).toBeNull();
    expect(requestUpdateMock).not.toHaveBeenCalled();
  });

  it("Test_BothMinVersionsAbsent_ReturnsNull_NoEvent", () => {
    expect(
      evaluateHandshakeCompatibility({
        current_mls_ciphersuite: CURRENT_MLS_CIPHERSUITE,
      }),
    ).toBeNull();
    expect(requestUpdateMock).not.toHaveBeenCalled();
  });

  it("Test_ClientBelowCanonicalMin_RaisesUpdate", () => {
    const reason = evaluateHandshakeCompatibility({
      min_compatible_client_version: FUTURE,
    });
    expect(reason).toBe("min-client-version");
    expect(requestUpdateMock).toHaveBeenCalledTimes(1);
    expect(requestUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "min-client-version",
        context: expect.objectContaining({ required: FUTURE }),
      }),
    );
  });

  it("Test_CanonicalAbsent_FallsBackToLegacyMinClientVersion", () => {
    const reason = evaluateHandshakeCompatibility({
      min_client_version: FUTURE,
    });
    expect(reason).toBe("min-client-version");
    expect(requestUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ required: FUTURE }),
      }),
    );
  });

  it("Test_CanonicalTakesPrecedenceOverLegacy", () => {
    // Canonical says compatible (past), legacy says incompatible (future).
    // Canonical must win, so no update is raised. This proves the client
    // reads the canonical field first.
    const reason = evaluateHandshakeCompatibility({
      min_compatible_client_version: PAST,
      min_client_version: FUTURE,
    });
    expect(reason).toBeNull();
    expect(requestUpdateMock).not.toHaveBeenCalled();
  });

  it("Test_ClientAtOrAboveCanonicalMin_NoEvent", () => {
    const reason = evaluateHandshakeCompatibility({
      min_compatible_client_version: PAST,
    });
    expect(reason).toBeNull();
    expect(requestUpdateMock).not.toHaveBeenCalled();
  });

  it("Test_CiphersuiteMismatch_RaisesUpdate", () => {
    const reason = evaluateHandshakeCompatibility({
      min_compatible_client_version: PAST,
      current_mls_ciphersuite: CURRENT_MLS_CIPHERSUITE + 1,
    });
    expect(reason).toBe("ciphersuite-mismatch");
    expect(requestUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ciphersuite-mismatch" }),
    );
  });

  it("Test_MinVersionCheckedBeforeCiphersuite", () => {
    // Both fail. min-client-version is evaluated first and short-circuits.
    const reason = evaluateHandshakeCompatibility({
      min_compatible_client_version: FUTURE,
      current_mls_ciphersuite: CURRENT_MLS_CIPHERSUITE + 1,
    });
    expect(reason).toBe("min-client-version");
    expect(requestUpdateMock).toHaveBeenCalledTimes(1);
  });
});
