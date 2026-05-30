import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STALE_SERVER_EVENT,
  type StaleServerDetail,
} from "./staleServer";
import {
  __resetStaleServerDesktopStore,
  collapseStaleServerDesktop,
  getStaleServerDesktopState,
  reopenStaleServerDesktop,
  startStaleServerDesktopStore,
  subscribeStaleServerDesktop,
} from "./staleServerDesktopStore";

const detail: StaleServerDetail = {
  instanceHost: "chat.example.tld",
  serverVersion: "0.1.0",
  recommended: "0.2.0",
  reason: "below-recommended",
};

function fire(d: StaleServerDetail) {
  window.dispatchEvent(new CustomEvent(STALE_SERVER_EVENT, { detail: d }));
}

beforeEach(() => {
  __resetStaleServerDesktopStore();
  startStaleServerDesktopStore();
});
afterEach(() => __resetStaleServerDesktopStore());

describe("staleServerDesktopStore", () => {
  it("captures a stale-server event as an open (not collapsed) notice", () => {
    fire(detail);
    expect(getStaleServerDesktopState()).toEqual({ detail, collapsed: false });
  });

  it("collapses to the icon then re-opens", () => {
    fire(detail);
    collapseStaleServerDesktop();
    expect(getStaleServerDesktopState().collapsed).toBe(true);
    reopenStaleServerDesktop();
    expect(getStaleServerDesktopState().collapsed).toBe(false);
  });

  it("a fresh event re-opens a collapsed notice", () => {
    fire(detail);
    collapseStaleServerDesktop();
    fire(detail);
    expect(getStaleServerDesktopState().collapsed).toBe(false);
  });

  it("notifies subscribers on change", () => {
    let hits = 0;
    const unsub = subscribeStaleServerDesktop(() => (hits += 1));
    fire(detail);
    collapseStaleServerDesktop();
    unsub();
    collapseStaleServerDesktop(); // no-op after collapse + unsubscribed
    expect(hits).toBe(2);
  });

  it("collapse/reopen are no-ops without a detail", () => {
    expect(() => collapseStaleServerDesktop()).not.toThrow();
    expect(() => reopenStaleServerDesktop()).not.toThrow();
    expect(getStaleServerDesktopState().detail).toBeNull();
  });
});
