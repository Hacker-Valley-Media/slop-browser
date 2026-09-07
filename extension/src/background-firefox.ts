// Firefox (Gecko) WebExtension background — MV3 event page.
//
// Firefox implements MV3 with an event page (`background.scripts`), not a
// service worker, and exposes the `chrome.*` namespace as a promise-and-callback
// alias over `browser.*`, so every module under background/ runs unmodified. The
// transport is the same one Chromium builds use: native messaging first
// (com.interceptor.host, registered under ~/.mozilla/native-messaging-hosts),
// with the loopback WebSocket as the fallback — Gecko puts no Safari-style
// sandbox between an extension and ws://localhost.
//
// What Gecko does NOT have decides the rest of this file:
//   chrome.debugger   -> the CDP lane (background/cdp.ts) cannot register
//   chrome.tabGroups  -> tab-group + brand-tab-group degrade to ungrouped
//   chrome.power      -> keepawake has no backend
//   chrome.offscreen  -> tesseract OCR has nowhere to run
//   chrome.tabCapture / pageCapture -> compositor capture lanes are absent
//
// Every optional step is therefore wrapped: a Gecko version that lacks one API
// must lose that one capability, never the whole browser context. Losing the
// context would make the browser invisible to `interceptor contexts` and take
// the working verbs down with the missing one.
//
// The context id is fixed at "firefox" (Chromium builds use a random UUID) so a
// Firefox instance coexists with Chrome/Brave in the daemon's context map and is
// addressable as `--context firefox`.

import {
  configureTransport,
  connectToHost,
  connectWsChannel,
  registerAlarmListener,
  registerSwKeepaliveListener,
  registerStorageContextListener,
} from "./background/transport"
import { registerTabGroupListeners, ensureInterceptorGroup } from "./background/tab-group"
import { registerBrandTabGroup } from "./background/brand-tab-group"
import { registerTabLifecycle } from "./background/tab-lifecycle"
import { registerDelegationListeners } from "./background/delegation"
import { initializeActionRouter } from "./background/router"

function runOptionalStartupStep(name: string, step: () => void): void {
  try {
    step()
  } catch (err) {
    console.warn(`[interceptor] Firefox startup step '${name}' unavailable:`, err)
  }
}

function addOptionalRuntimeListener(
  name: string,
  event: { addListener?: (listener: () => void) => void } | undefined,
): void {
  if (typeof event?.addListener !== "function") return
  runOptionalStartupStep(name, () => event.addListener?.(connect))
}

function connect(): void {
  connectToHost()
  connectWsChannel()
  runOptionalStartupStep("interceptor tab group", ensureInterceptorGroup)
}

// Module state, not a global: static imports run before this module's body, so a
// global assigned here could not govern an imported module's startup.
configureTransport({ contextId: "firefox", osInputAvailable: false })

// Control plane first — a capability that fails to register must not be able to
// prevent the daemon from ever seeing this browser.
runOptionalStartupStep("action router", initializeActionRouter)
runOptionalStartupStep("alarm keepalive", registerAlarmListener)
runOptionalStartupStep("event-page keepalive", registerSwKeepaliveListener)
runOptionalStartupStep("context storage", registerStorageContextListener)
runOptionalStartupStep("tab groups", registerTabGroupListeners)
runOptionalStartupStep("brand tab group", registerBrandTabGroup)
runOptionalStartupStep("tab lifecycle", registerTabLifecycle)
runOptionalStartupStep("delegation", registerDelegationListeners)

// chrome.debugger (background/cdp.ts) and chrome.power (background/keepawake.ts)
// have no Gecko implementation at all; they are omitted rather than guarded so
// the absence is visible here instead of surfacing as a swallowed warning.

const runtime = (chrome as unknown as { runtime?: typeof chrome.runtime }).runtime
addOptionalRuntimeListener("runtime.onInstalled", runtime?.onInstalled)
addOptionalRuntimeListener("runtime.onStartup", runtime?.onStartup)

connect()
