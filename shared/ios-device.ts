/**
 * shared/ios-device.ts — types, constants, and pure helpers for the iOS device
 * control surface. The signed on-device
 * InterceptorRunner (XCUITest) is driven by a daemon-resident IosManager; on
 * iOS 17+ Xcode owns the RemoteXPC tunnel + DDI when it launches the test runner
 * (no third-party tunnel agent).
 *
 * Addressed as `ios:<udid>`. This flips the transport to the `runtime:`
 * dial-in model: the on-device InterceptorRunner (our own XCUITest runner — no
 * WebDriverAgent) dials INTO the daemon WebSocket and registers `{type:"ios"}`,
 * exactly as the browser extension and the in-process native agent do. The
 * daemon's IosManager then sends verb frames down that socket and the runner
 * actuates via public XCUITest APIs. A legacy `--wda-url` HTTP path (WdaClient)
 * remains as a deprecated escape hatch. Either way the verb surface is identical.
 *
 * Dependency-free (no Bun/daemon imports) so it can be unit tested and imported
 * from both cli and daemon. Mirrors shared/cdp-app.ts and shared/native-agent.ts.
 */

export const IOS_CONTEXT_PREFIX = "ios:"

/** WebSocket registration frame type the on-device InterceptorRunner sends to dial INTO the daemon. */
export const IOS_REGISTER_TYPE = "ios"

/**
 * Runner op codes (IosManager → InterceptorRunner over the WS channel). Kept here
 * so the daemon's RunnerChannel and the Swift runner share one vocabulary. Each op
 * is sent as `{ id, op, ...args }` and answered `{ id, result: { success, data?, error? } }`.
 */
export const IOS_RUNNER_OPS = {
  ping: "ping",
  source: "source",
  screenshot: "screenshot",
  windowSize: "windowSize",
  tap: "tap",
  drag: "drag",
  keys: "keys",
  press: "press",
  app: "app",
  eval: "eval",
  // issue #244: lock-screen passcode entry (wake, swipe up, type into SpringBoard).
  unlock: "unlock",
} as const
export type IosRunnerOp = (typeof IOS_RUNNER_OPS)[keyof typeof IOS_RUNNER_OPS]

/** The iOS way-in ladder. Ordered lightest → heaviest. Jailbreak (research) is omitted. */
export type IosWayIn =
  | "simulator"        // rung 0 — host Simulator, no signing
  | "dev-provisioned"  // rung 1 — owned physical device, Developer Mode + operator signing
  | "supervised"       // rung 2 — supervised / MDM device (later phase)
  | "unsupported"      // device unreachable / not owned / cannot sign

export const IOS_WAY_IN_RUNG: Record<IosWayIn, number> = {
  simulator: 0,
  "dev-provisioned": 1,
  supervised: 2,
  unsupported: 9,
}

export type IosDeviceKind = "simulator" | "device"

/** Lifecycle actions dispatched to the IosManager (explicit set, not a prefix). */
export const IOS_ACTION_TYPES = new Set<string>([
  "ios_discover", "ios_enable", "ios_disable", "ios_status",
  // seamless surface: push the prebuilt agent, list ready
  // devices, name them.
  "ios_install", "ios_devices", "ios_name",
  // self-service install: Apple-ID auth + per-user re-sign, no Xcode.
  "ios_login", "ios_setup", "ios_refresh", "ios_logout",
  // tunnel diagnostic: drive the root helper's remotectl relay.
  "ios_tunnel",
])

/** Verb action types the IosManager executes against an `ios:<udid>` context. */
export const IOS_VERB_TYPES = new Set<string>([
  "ios_tree", "ios_find", "ios_inspect", "ios_click", "ios_type", "ios_keys",
  "ios_scroll", "ios_drag", "ios_press", "ios_screenshot", "ios_apps", "ios_app",
  "ios_fgdebug", "ios_eval", "ios_unlock",
])

/**
 * "xcode"  = the iOS 17+ RemoteXPC tunnel is provided by Xcode/CoreDevice during launch.
 * "native" = the tunnel is stood up by OUR pure-Bun stack via the root
 *            tunnel helper — no Xcode on the user's Mac.
 */
export type IosTunnelState = "none" | "xcode" | "native"
export type IosConnectionState = "connected" | "connecting" | "disconnected" | "error"

/** Result of classifying a discovered device into a way-in rung. */
export type IosDeviceDescriptor = {
  /** Stable context id, e.g. "ios:00008110-001A2B...". */
  contextId: string
  udid: string
  name: string
  kind: IosDeviceKind
  /** iOS version string when known (e.g. "17.4"). */
  productVersion?: string
  /** Developer Mode enabled on the device (physical only; sim is always "on"). */
  developerMode: boolean
  /** Device is paired/trusted with this host. */
  paired: boolean
  wayIn: IosWayIn
  /** Major iOS version ≥ 17 ⇒ a RemoteXPC tunnel is required for the test host. */
  needsTunnel: boolean
}

/** Daemon-side per-context state for `ios status`. */
export type IosDeviceState = {
  contextId: string
  udid: string
  name: string
  kind: IosDeviceKind
  wayIn: IosWayIn
  productVersion?: string
  wdaPort?: number
  tunnel: IosTunnelState
  connection: IosConnectionState
  /** Runner signing expiry epoch ms, when known (1-yr paid / 7-day free). */
  signingExpiresAt?: number
  registeredAt: number
  /** ws://host:port the runner is handed to dial back, and which ladder rung chose it. */
  dialBack?: string
  dialBackVia?: IosDialBackVia
}

/**
 * Which rung of the dial-back ladder picked the runner's WebSocket host:
 * `override` (INTERCEPTOR_WS_URL), `loopback` (simulator), `vpn` (CGNAT utun —
 * exempt from iOS Local Network privacy), `interface` (the Mac interface usbmuxd
 * discovered the phone on, matched by InterfaceIndex; works whatever address
 * family usbmuxd reports), `subnet` (Mac interface on the phone's own IPv4
 * subnet), `default-route`, `first` (first non-internal IPv4).
 */
export type IosDialBackVia = "override" | "loopback" | "vpn" | "interface" | "subnet" | "default-route" | "first"

// ── Pure helpers (unit tested) ────────────────────────────────────────────────

export function isIosContextId(contextId: string | undefined): contextId is string {
  return typeof contextId === "string" && contextId.startsWith(IOS_CONTEXT_PREFIX)
}

/** Normalize a udid into a context-safe form (udids are already safe; lower-case + trim). */
export function iosUdidSlug(udid: string): string {
  return udid.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "")
}

export function iosContextId(udid: string): string {
  return IOS_CONTEXT_PREFIX + iosUdidSlug(udid)
}

/** Extract the udid back out of an `ios:<udid>` context id. */
export function udidFromContextId(contextId: string): string | undefined {
  if (!isIosContextId(contextId)) return undefined
  const udid = contextId.slice(IOS_CONTEXT_PREFIX.length)
  return udid || undefined
}

/** Parse a major iOS version from a product-version string ("17.4.1" -> 17). */
export function iosMajorVersion(productVersion: string | undefined): number | undefined {
  if (!productVersion) return undefined
  const m = /^(\d+)/.exec(productVersion.trim())
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : undefined
}

/** iOS 17+ moved the developer services behind a RemoteXPC tunnel. */
export function deviceNeedsTunnel(productVersion: string | undefined): boolean {
  const major = iosMajorVersion(productVersion)
  return typeof major === "number" && major >= 17
}

/**
 * Deterministic way-in classifier. Pure so the toolchain-discovery output and
 * the TS tests share one source of truth.
 *
 * - A Simulator is always rung 0 (no signing, Developer Mode is a no-op there).
 * - A physical device is rung 1 only when it is paired AND in Developer Mode.
 * - A supervised flag bumps a paired device to rung 2.
 * - Anything not paired / not in Developer Mode is "unsupported" until the
 *   operator completes the one-time setup (the manager reports what is missing).
 */
export function classifyIosWayIn(input: {
  kind: IosDeviceKind
  paired?: boolean
  developerMode?: boolean
  supervised?: boolean
}): IosWayIn {
  if (input.kind === "simulator") return "simulator"
  if (!input.paired) return "unsupported"
  if (!input.developerMode) return "unsupported"
  if (input.supervised) return "supervised"
  return "dev-provisioned"
}

/** Human-readable one-liner for `ios discover` plain-text output. */
export function describeIosWayIn(w: IosWayIn): string {
  switch (w) {
    case "simulator": return "Simulator — no signing, no Developer Mode"
    case "dev-provisioned": return "owned device — Developer Mode + operator-signed InterceptorRunner"
    case "supervised": return "supervised / MDM device — managed deployment"
    case "unsupported": return "unsupported — pair the device and enable Developer Mode first"
  }
}

/**
 * Build a descriptor from raw discovery facts. Pure — the manager feeds it the
 * results of `xcrun devicectl list devices` / `xcrun simctl list` queries.
 */
export function describeIosDevice(input: {
  udid: string
  name: string
  kind: IosDeviceKind
  productVersion?: string
  paired?: boolean
  developerMode?: boolean
  supervised?: boolean
}): IosDeviceDescriptor {
  const developerMode = input.kind === "simulator" ? true : input.developerMode === true
  const paired = input.kind === "simulator" ? true : input.paired === true
  return {
    contextId: iosContextId(input.udid),
    udid: input.udid,
    name: input.name,
    kind: input.kind,
    productVersion: input.productVersion,
    developerMode,
    paired,
    wayIn: classifyIosWayIn({ kind: input.kind, paired, developerMode, supervised: input.supervised }),
    needsTunnel: input.kind === "device" && deviceNeedsTunnel(input.productVersion),
  }
}
