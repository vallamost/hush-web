/**
 * Tests for the non-blocking stale-server banner and its hook. The banner is
 * driven by the global `hush:server-stale` event, is dismissible, and
 * remembers dismissal per instance + recommended version.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import StaleServerBanner from "./StaleServerBanner";
import {
  STALE_SERVER_EVENT,
  type StaleServerDetail,
} from "@/lib/staleServer";

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function dispatchStale(detail: StaleServerDetail) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent<StaleServerDetail>(STALE_SERVER_EVENT, { detail }),
    );
  });
}

const detail: StaleServerDetail = {
  instanceHost: "chat.example.tld",
  serverVersion: "0.1.0",
  recommended: "0.2.0",
  reason: "below-recommended",
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("StaleServerBanner", () => {
  it("renders nothing until a stale-server event fires", async () => {
    render(<StaleServerBanner />);
    await flushEffects();
    expect(screen.queryByTestId("stale-server-banner")).toBeNull();
  });

  it("shows the instance host and server version when stale", async () => {
    render(<StaleServerBanner />);
    await flushEffects();
    dispatchStale(detail);
    expect(screen.getByTestId("stale-server-banner")).toBeTruthy();
    expect(screen.getByTestId("stale-server-banner").textContent).toContain(
      "chat.example.tld",
    );
    expect(screen.getByTestId("stale-server-banner").textContent).toContain(
      "0.1.0",
    );
  });

  it("dismisses and stays dismissed for the same instance + version", async () => {
    const { unmount } = render(<StaleServerBanner />);
    await flushEffects();
    dispatchStale(detail);
    fireEvent.click(screen.getByTestId("stale-server-dismiss"));
    expect(screen.queryByTestId("stale-server-banner")).toBeNull();

    // Remount (e.g. reconnect) and re-fire: dismissal persisted, stays hidden.
    unmount();
    render(<StaleServerBanner />);
    await flushEffects();
    dispatchStale(detail);
    expect(screen.queryByTestId("stale-server-banner")).toBeNull();
  });

  it("re-notifies when the client recommends a newer server than dismissed", async () => {
    render(<StaleServerBanner />);
    await flushEffects();
    dispatchStale(detail);
    fireEvent.click(screen.getByTestId("stale-server-dismiss"));
    expect(screen.queryByTestId("stale-server-banner")).toBeNull();

    dispatchStale({ ...detail, recommended: "0.3.0" });
    expect(screen.getByTestId("stale-server-banner")).toBeTruthy();
  });
});
