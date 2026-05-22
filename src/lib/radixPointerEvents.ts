const OPEN_LAYER_SELECTOR = [
  '[data-slot="alert-dialog-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[data-slot="sheet-content"]',
].join(",")

const RESTORE_DELAYS_MS = [0, 50, 150, 300] as const

export function restoreStaleBodyPointerEvents(doc: Document = document): void {
  if (doc.querySelector(OPEN_LAYER_SELECTOR)) {
    return
  }

  if (doc.body.style.pointerEvents === "none") {
    doc.body.style.pointerEvents = ""
  }
}

export function scheduleBodyPointerEventsRestore(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return
  }

  for (const delayMs of RESTORE_DELAYS_MS) {
    window.setTimeout(() => restoreStaleBodyPointerEvents(document), delayMs)
  }
}
