import { afterEach, describe, it, expect } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { ChangeAnnouncementDialog } from "./change-announcement-dialog"
import { getLatestAnnouncement } from "@/lib/changeAnnouncements"

afterEach(() => cleanup())

describe("ChangeAnnouncementDialog", () => {
  it("renders the latest web announcement: single header, founder note, warning, external links, dismiss", () => {
    const entry = getLatestAnnouncement("web")
    expect(entry).toBeTruthy()

    render(<ChangeAnnouncementDialog entry={entry} onDismiss={() => {}} />)

    // "What's new" is the dialog header only; it must not be repeated in the body.
    expect(screen.getAllByText("What's new")).toHaveLength(1)

    // Founder note is retained verbatim (do-not-remove copy).
    expect(screen.getByText(/A note from the founder/)).toBeTruthy()

    // Warning block now covers Windows AND Linux and drops "from the releases page".
    expect(
      screen.getByText(/Windows and Linux desktop app cannot auto-update/),
    ).toBeTruthy()
    expect(screen.queryByText(/from the releases page/)).toBeNull()

    // Two external links (new tab), distinct from the dismiss action.
    const changelog = screen.getByRole("link", { name: /Changelog/ })
    expect(changelog.getAttribute("target")).toBe("_blank")
    const download = screen.getByRole("link", { name: /Download/ })
    expect(download.getAttribute("href")).toBe("https://gethush.live/#downloads")
    expect(download.getAttribute("target")).toBe("_blank")

    // The only real action.
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy()
  })
})
