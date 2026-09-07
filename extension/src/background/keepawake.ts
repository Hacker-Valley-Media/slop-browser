import { emitEvent } from "./transport"

// Unattended-run support. chrome.power keeps the machine awake through a long
// overnight batch; chrome.idle emits a `user_returned` event the moment the
// human is back at the keyboard so the agent can yield. Both are pure
// background APIs — no CDP, no page instrumentation.

type KeepAwakeLevel = "system" | "display"
const KEEPAWAKE_STORAGE_KEY = "interceptor_keepawake"
const IDLE_DETECTION_SECONDS = 60

type StoredKeepAwake = { on?: boolean; level?: KeepAwakeLevel }

export async function setKeepAwake(
  on: boolean,
  level: KeepAwakeLevel = "system"
): Promise<{ on: boolean; level?: KeepAwakeLevel }> {
  // chrome.power is Chromium-only. Without this check the Gecko build reports
  // "can't access property requestKeepAwake, chrome.power is undefined" — a raw
  // TypeError that reads like a bug rather than an absent capability.
  const power = (chrome as unknown as { power?: typeof chrome.power }).power
  if (typeof power?.requestKeepAwake !== "function") {
    throw new Error("keepawake is unavailable — this browser has no power API (Chromium-only)")
  }
  if (on) {
    // "system" keeps the CPU awake but lets the display sleep overnight;
    // "display" keeps the screen on too.
    power.requestKeepAwake(level)
    await chrome.storage.local.set({ [KEEPAWAKE_STORAGE_KEY]: { on: true, level } })
    return { on: true, level }
  }
  power.releaseKeepAwake()
  await chrome.storage.local.set({ [KEEPAWAKE_STORAGE_KEY]: { on: false } })
  return { on: false }
}

export function queryIdleState(detectionInterval = IDLE_DETECTION_SECONDS): Promise<string> {
  return new Promise(resolve => {
    chrome.idle.queryState(detectionInterval, state => resolve(state))
  })
}

async function reassertKeepAwakeOnWake(): Promise<void> {
  // The keep-awake request is browser-held, but a torn-down MV3 service worker
  // can drop it; re-assert from persisted intent whenever the SW spins back up.
  try {
    const stored = (await chrome.storage.local.get(KEEPAWAKE_STORAGE_KEY))[
      KEEPAWAKE_STORAGE_KEY
    ] as StoredKeepAwake | undefined
    if (stored?.on) chrome.power.requestKeepAwake(stored.level || "system")
  } catch {}
}

export async function handlePowerIdleActions(
  action: { type: string; [key: string]: unknown }
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  if (action.type === "keepawake") {
    const level: KeepAwakeLevel = action.level === "display" ? "display" : "system"
    const result = await setKeepAwake(action.on === true, level)
    return { success: true, data: result }
  }
  if (action.type === "idle_state") {
    const interval =
      typeof action.detectionInterval === "number" && action.detectionInterval > 0
        ? action.detectionInterval
        : undefined
    const state = await queryIdleState(interval)
    return { success: true, data: { state } }
  }
  return { success: false, error: `unknown power/idle action: ${action.type}` }
}

export function registerPowerIdleListeners(): void {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS)
  chrome.idle.onStateChanged.addListener(state => {
    // onStateChanged wakes the SW, so this fires even after the worker slept.
    if (state === "active") emitEvent("user_returned", { at: Date.now() })
    else emitEvent("user_idle", { state, at: Date.now() })
  })
  reassertKeepAwakeOnWake()
}
