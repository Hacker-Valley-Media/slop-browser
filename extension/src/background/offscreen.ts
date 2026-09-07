export const OFFSCREEN_IDLE_MS = 30_000
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Offscreen documents are a Chromium API. The Gecko build has no equivalent, so
 * every caller here (image crop/stitch/diff and the tesseract OCR worker) has no
 * backend on Firefox. Detect that up front: without this, `runtime.getContexts`
 * below rejects with a raw Gecko enum error ("Invalid enumeration value
 * OFFSCREEN_DOCUMENT") that says nothing about what the user should do.
 */
export function offscreenAvailable(): boolean {
  const api = (chrome as unknown as { offscreen?: { createDocument?: unknown } }).offscreen
  return typeof api?.createDocument === "function"
}

export const OFFSCREEN_UNSUPPORTED_ERROR =
  "this browser has no offscreen-document API (Chromium-only), so image compositing and tesseract OCR are unavailable here — use a Chromium-based browser for `ocr`"

export async function ensureOffscreen(): Promise<void> {
  if (!offscreenAvailable()) throw new Error(OFFSCREEN_UNSUPPORTED_ERROR)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
  })
  if (contexts.length > 0) {
    resetOffscreenTimer()
    return
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS" as chrome.offscreen.Reason],
    justification: "Image crop, stitch, and diff operations"
  })
  resetOffscreenTimer()
}

export function resetOffscreenTimer(): void {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer)
  offscreenIdleTimer = setTimeout(async () => {
    try { await chrome.offscreen.closeDocument() } catch {}
    offscreenIdleTimer = null
  }, OFFSCREEN_IDLE_MS)
}

export async function sendToOffscreen(msg: Record<string, unknown>): Promise<unknown> {
  // Return the shared {success,error} shape rather than throwing: every caller
  // already forwards that straight to the CLI, so an unsupported browser reads
  // as a clear capability gap instead of an unhandled rejection.
  if (!offscreenAvailable()) {
    return { success: false, error: OFFSCREEN_UNSUPPORTED_ERROR }
  }
  await ensureOffscreen()
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, resolve)
  })
}
