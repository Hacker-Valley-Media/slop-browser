/**
 * daemon/ios/manager.ts — owns iOS device contexts (`ios:<udid>`) and dispatches
 * the ios_ lifecycle actions + verbs. Daemon-resident.
 *
 * the device channel is now our own on-device **InterceptorRunner**
 * (XCUITest) that dials INTO the daemon WebSocket and registers `{type:"ios"}`,
 * exactly like the browser extension and the in-process native agent. The manager
 * drives it over that socket via `RunnerChannel` — no WebDriverAgent, no usbmux
 * HTTP forward. A legacy `--wda-url` HTTP path (`WdaClient`) remains as a
 * deprecated escape hatch; both satisfy `IosDeviceChannel`, so the verb handlers
 * (tree/click/type/…) and the host-side post-processing (tree formatting, ref
 * registry, sips resize) are identical regardless of channel.
 *
 * Bring-up defaults to the no-Xcode stack: userspace CoreDeviceProxy
 * tunnel + testmanagerd. A legacy Xcode launch path remains as an explicit
 * operator fallback. No signing material is embedded (capability-blind).
 */

import {
  classifyIosWayIn, describeIosDevice, describeIosWayIn, iosContextId, iosUdidSlug, udidFromContextId,
  type IosDeviceDescriptor, type IosDeviceState, type IosTunnelState, type IosDeviceKind,
} from "../../shared/ios-device"
import { WdaClient } from "./wda-client"
import { RunnerChannel, type IosDeviceChannel, type RunnerSocket, type RunnerResult } from "./channel"
import {
  IosRefRegistry, formatWdaTree, findInTree, frameCenter, type WdaSourceNode,
} from "./tree"
import {
  detectToolchain, listDeviceApps, listPhysicalDevices, listSimulators,
  resizePngToBudget, run, runJson, spawnLongLived, killChild,
  prepareXctestrunWithEnv, stageRunner, findXctestrun, installRunnerApp, isRunnerInstalled,
  RUNNER_BUNDLE_ID, findRunnerApp, preferNoXcodeIosPath, buildRunnerWithXcode,
} from "./tools"
import {
  setAlias, aliasForUdid, resolveUdid, markInstalled, knownInstalledUdids,
  getAppleAccount, setAppleAccount, clearAppleAccount, installsExpiringBy,
} from "./state"
// Self-service install (pure-Bun, no Xcode). These modules carry real
// codecs + honest on-device gates; imports are inert until the new verbs run.
import * as keychain from "./keychain"
import * as signer from "./signer"
import * as testmanagerd from "./testmanagerd"
import { helperAvailable, runRemotectl } from "./tunnel"
import type { RunnerEnv } from "./tunnel"
import { resolveRunnerDialBack, runnerDialHint, type DialBack } from "./ws-host"
import net from "node:net"

export type IosResult = { success: boolean; error?: string; data?: unknown }

/** Re-sign this far ahead of expiry so a phone never goes stale. */
const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000 // 1 day
type ManagerDeps = {
  emit: (event: string, data?: Record<string, unknown>) => void
  /** Daemon WS port the on-device runner dials back into. */
  wsPort: number
}

type IosDeviceContext = {
  descriptor: IosDeviceDescriptor
  channel: IosDeviceChannel
  registry: IosRefRegistry
  wdaPort: number
  tunnel: IosTunnelState
  procs: Bun.Subprocess[]
  registeredAt: number
  signingExpiresAt?: number
}

/** A pending `enable` waiting for its InterceptorRunner to dial back in. */
type PendingRunner = {
  token: string
  resolve: (ch: RunnerChannel) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_WDA_PORT = 8100

export class IosManager {
  private contexts = new Map<string, IosDeviceContext>()
  private deps: ManagerDeps
  /** Enables awaiting their runner registration, keyed by udid slug (case-insensitive). */
  private pendingRunners = new Map<string, PendingRunner>()
  /** In-flight ensureRunner promises, keyed by contextId, so concurrent verbs on a
   *  cold device share one launch instead of double-launching + orphaning a runner. */
  private ensuring = new Map<string, Promise<{ ok: boolean; error?: string; contextId?: string }>>()
  /** Live runner sockets → their channel + udid (for response/close routing). */
  private runnerByWs = new Map<RunnerSocket, { udid: string; channel: RunnerChannel }>()

  private refreshTimer?: ReturnType<typeof setInterval>

  constructor(deps: ManagerDeps) {
    this.deps = deps
    this.startRefreshTimer()
  }

  /**
   * background refresh. Every 6h, if an Apple-ID account is signed in
   * and any install is within REFRESH_LEAD_MS of its cert expiry (≤7d free / ~1y
   * paid), re-sign+reinstall+relaunch it. unref'd so it never holds the process.
   */
  private startRefreshTimer(): void {
    const EVERY_MS = 6 * 60 * 60 * 1000
    this.refreshTimer = setInterval(() => {
      if (!getAppleAccount()) return
      if (installsExpiringBy(REFRESH_LEAD_MS).length === 0) return
      void this.refresh({}).catch(() => {})
    }, EVERY_MS)
    if (this.refreshTimer && typeof this.refreshTimer.unref === "function") this.refreshTimer.unref()
  }

  /** Context ids backed by a live device channel (parallels CdpManager.contextIds). */
  contextIds(): string[] {
    return [...this.contexts.keys()]
  }

  hasContext(contextId: string): boolean {
    return this.contexts.has(contextId)
  }

  // ── runner WS plumbing (device dials IN) ───────────────────────────

  /** True if this socket is a registered InterceptorRunner (so the daemon routes its frames here). */
  isRunnerSocket(ws: RunnerSocket): boolean {
    return this.runnerByWs.has(ws)
  }

  /**
   * Handle an InterceptorRunner registration `{type:"ios", udid, token}`. Matches
   * it to a pending `enable`, validates the per-session token, and binds the
   * socket to a RunnerChannel. Returns an ack the daemon sends back.
   */
  registerRunner(ws: RunnerSocket, msg: { udid?: string; token?: string; contextId?: string }): { ok: boolean; error?: string; contextId?: string } {
    const udid = msg.udid || (msg.contextId ? udidFromContextId(msg.contextId) : undefined)
    if (!udid) return { ok: false, error: "ios runner registration missing udid" }
    // Key by slug (case-insensitive): the runner may report the raw devicectl udid
    // (upper-case for physical devices) or a lower-cased contextId slug; both must
    // resolve to the same pending entry that awaitRunner registered.
    const key = iosUdidSlug(udid)
    const pending = this.pendingRunners.get(key)
    if (!pending) return { ok: false, error: `no pending 'ios enable' for udid ${udid}` }
    // A pending runner always carries a per-session token; reject any mismatch
    // outright (a runner dials in over a routable LAN IP, so this is the gate).
    if (msg.token !== pending.token) return { ok: false, error: "ios runner token mismatch" }
    const channel = new RunnerChannel(ws)
    this.runnerByWs.set(ws, { udid, channel })
    clearTimeout(pending.timer)
    this.pendingRunners.delete(key)
    pending.resolve(channel)
    return { ok: true, contextId: iosContextId(udid) }
  }

  /** Route a runner's `{ id, result }` reply to its channel. Returns true if handled. */
  handleRunnerMessage(ws: RunnerSocket, msg: { id?: string; result?: RunnerResult }): boolean {
    const rec = this.runnerByWs.get(ws)
    if (!rec) return false
    if (msg.id && msg.result !== undefined) rec.channel.handleResponse(msg.id, msg.result)
    return true
  }

  /** A runner socket closed: tear down its channel and drop the backing context. */
  handleRunnerClose(ws: RunnerSocket): void {
    const rec = this.runnerByWs.get(ws)
    if (!rec) return
    this.runnerByWs.delete(ws)
    rec.channel.teardown()
    const ctx = this.contexts.get(iosContextId(rec.udid))
    if (ctx && ctx.channel === rec.channel) {
      for (const p of ctx.procs) killChild(p)
      this.contexts.delete(ctx.descriptor.contextId)
      testmanagerd.closeRunner(rec.udid)
      this.deps.emit("ios_disabled", { contextId: ctx.descriptor.contextId, udid: rec.udid, reason: "runner disconnected" })
    }
  }

  private awaitRunner(udid: string, token: string, timeoutMs: number): Promise<RunnerChannel> {
    // Key by slug so registerRunner matches regardless of udid case (see registerRunner).
    const key = iosUdidSlug(udid)
    const prior = this.pendingRunners.get(key)
    if (prior) { clearTimeout(prior.timer); prior.reject(new Error("superseded by a newer enable")) }
    return new Promise<RunnerChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRunners.delete(key)
        reject(new Error(`InterceptorRunner did not register within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pendingRunners.set(key, { token, resolve, reject, timer })
    })
  }

  /**
   * ws://<host>:<port> the on-device runner dials back into. VPN (CGNAT utun)
   * first — iOS silently denies a backgrounded runner's first LAN connection
   * (Local Network privacy) but a VPN address is exempt — then the Mac interface
   * usbmuxd discovered the phone on (InterfaceIndex), then the phone's IPv4
   * subnet, then the default route. See ./ws-host.ts.
   */
  private resolveDialBack(kind: IosDeviceKind, udid: string): Promise<DialBack> {
    return resolveRunnerDialBack(kind, udid, this.deps.wsPort)
  }

  // ── lifecycle dispatch ───────────────────────────────────────────────────────

  async handle(action: { type: string; [k: string]: unknown }): Promise<IosResult> {
    switch (action.type) {
      case "ios_discover": return this.discover()
      case "ios_devices": return this.devices()
      case "ios_install": return this.install(action)
      case "ios_name": return this.name(action)
      case "ios_enable": return this.enable(action)
      case "ios_disable": return this.disable(action)
      case "ios_status": return this.status()
      // self-service (Apple-ID re-sign, no Xcode)
      case "ios_login": return this.login(action)
      case "ios_setup": return this.setup(action)
      case "ios_refresh": return this.refresh(action)
      case "ios_logout": return this.logout()
      case "ios_tunnel": return this.tunnelDiag(action)
      default: return { success: false, error: `unknown ios action: ${action.type}` }
    }
  }

  // ── verb dispatch ──────────────────────────────────────────────────────────

  async executeVerb(contextId: string, action: { type: string; [k: string]: unknown }): Promise<IosResult> {
    // Resolve alias/udid/ios: → canonical ios:<udid> (or the single ready device).
    const canonical = this.canonicalContextId(contextId)
    if (!canonical) return { success: false, error: this.noDeviceHint() }
    let ctx = this.contexts.get(canonical)
    if (!ctx && action.type === "ios_unlock") {
      return { success: false, error: "ios unlock requires a connected resident runner. It cannot launch a runner on a locked phone. Unlock the phone once, run 'interceptor ios tree' to connect, then retry unlock or --probe while the runner remains resident." }
    }
    if (!ctx) {
      // Seamless: auto-connect the agent on demand (no manual enable).
      const udid = udidFromContextId(canonical)!
      const ensured = await this.ensureRunner(udid)
      if (!ensured.ok) return { success: false, error: ensured.error }
      ctx = this.contexts.get(canonical)
    }
    if (!ctx) return { success: false, error: "the device did not connect — is it unlocked and on this Mac's network?" }
    try {
      switch (action.type) {
        case "ios_tree": return await this.verbTree(ctx, action)
        case "ios_find": return await this.verbFind(ctx, action)
        case "ios_inspect": return this.verbInspect(ctx, action)
        case "ios_click": return await this.verbClick(ctx, action)
        case "ios_type": return await this.verbType(ctx, action)
        case "ios_keys": return await this.verbKeys(ctx, action)
        case "ios_scroll": return await this.verbScroll(ctx, action)
        case "ios_drag": return await this.verbDrag(ctx, action)
        case "ios_press": return await this.verbPress(ctx, action)
        case "ios_unlock": return await this.verbUnlock(ctx, action)
        case "ios_screenshot": return await this.verbScreenshot(ctx, action)
        case "ios_apps": return this.verbApps(ctx)
        case "ios_app": return await this.verbApp(ctx, action)
        case "ios_fgdebug":
          return ctx.channel instanceof RunnerChannel
            ? { success: true, data: await ctx.channel.rawOp("fgdebug") }
            : { success: false, error: "fgdebug is runner-only" }
        case "ios_eval": {
          // Lane D: push a JavaScript program onto the device and run it inside the
          // runner's JSContext, where an `Interceptor` global (tree/tap/type/sleep/
          // log/foreground) drives the foreground app. The agent's inner loop runs
          // ON the phone — one round-trip instead of one per action.
          if (!(ctx.channel instanceof RunnerChannel)) return { success: false, error: "eval is runner-only" }
          const script = typeof action.script === "string" ? action.script : ""
          if (!script.trim()) return { success: false, error: "ios eval requires a script (a JS program string)" }
          return { success: true, data: await ctx.channel.rawOp("eval", { script }) }
        }
        default: return { success: false, error: `unknown ios verb: ${action.type}` }
      }
    } catch (err) {
      return { success: false, error: `ios ${action.type}: ${(err as Error).message}` }
    }
  }

  // ── discover ─────────────────────────────────────────────────────────────────

  private discover(): IosResult {
    const tc = detectToolchain()
    const descriptors: IosDeviceDescriptor[] = []

    if (tc.simctl) {
      for (const sim of listSimulators()) {
        if (sim.isAvailable === false) continue
        descriptors.push(describeIosDevice({
          udid: sim.udid, name: `${sim.name} (Simulator)`, kind: "simulator",
          productVersion: sim.runtimeVersion,
        }))
      }
    }
    const phys = tc.devicectl ? listPhysicalDevices() : []
    const transportByUdid = new Map(phys.map((d) => [d.udid, d.transport]))
    for (const dev of phys) {
      descriptors.push(describeIosDevice({
        udid: dev.udid, name: dev.name, kind: "device",
        productVersion: dev.productVersion, paired: dev.paired, developerMode: dev.developerMode,
      }))
    }

    const data = descriptors.map((d) => ({
      contextId: d.contextId,
      udid: d.udid,
      name: d.name,
      kind: d.kind,
      productVersion: d.productVersion,
      developerMode: d.developerMode,
      paired: d.paired,
      transport: d.kind === "device" ? (transportByUdid.get(d.udid) ?? "unknown") : "host",
      wayIn: d.wayIn,
      wayInRung: classifyIosWayIn({ kind: d.kind, paired: d.paired, developerMode: d.developerMode }),
      needsTunnel: d.needsTunnel,
      note: describeIosWayIn(d.wayIn),
    }))

    return {
      success: true,
      data: {
        toolchain: tc,
        devices: data,
        ...(descriptors.length === 0 ? { note: deviceDiscoveryHint(tc) } : {}),
      },
    }
  }

  // ── enable ───────────────────────────────────────────────────────────────────

  // ── install / devices / name (seamless surface) ──────────────────────────────

  /** Push the pre-built, pre-signed agent to a device (no build/sign/env). */
  private async install(action: { [k: string]: unknown }): Promise<IosResult> {
    const ref = typeof action.device === "string" ? action.device : typeof action.udid === "string" ? action.udid : undefined
    const udid = this.pickDeviceUdid(ref)
    if (!udid) return { success: false, error: this.noDeviceHint() }
    const descriptor = this.resolveDescriptor(udid)
    if (!descriptor) return { success: false, error: `device not found — plug the iPhone in, unlock it, and tap "Trust This Computer", then re-run 'interceptor ios install'` }
    if (descriptor.wayIn === "unsupported") return { success: false, error: `'${descriptor.name}' is not ready: ${missingSetup(descriptor)}` }

    const res = await installRunnerApp(udid)
    if (!res.ok) return { success: false, error: res.error }
    markInstalled(udid)

    // Bring it up now so the first verb is instant.
    const ensured = await this.ensureRunner(udid)
    const alias = aliasForUdid(udid)
    return {
      success: true,
      data: {
        installed: descriptor.name, udid, connected: ensured.ok, alias,
        note: ensured.ok
          ? `ready — drive it: interceptor ios tree --on ${alias ?? descriptor.name}`
          : `installed; it'll connect on first use${ensured.error ? ` (${ensured.error})` : ""}`,
      },
    }
  }

  /** Progressive disclosure: only devices with the agent installed (or connected). */
  private devices(): IosResult {
    const phys = listPhysicalDevices()
    const known = new Set(knownInstalledUdids())
    const out = phys
      .filter((d) => known.has(d.udid.toUpperCase()) || isRunnerInstalled(d.udid))
      .map((d) => ({
        name: d.name,
        alias: aliasForUdid(d.udid),
        udid: d.udid,
        // `connected` = a runner session is dialed in RIGHT NOW. It is false
        // whenever the phone is idle; that is the normal ready state, not an
        // error — the runner auto-launches and dials in on the next verb.
        connected: this.contexts.has(iosContextId(d.udid)),
        transport: d.transport ?? "unknown",
        productVersion: d.productVersion,
      }))
    const anyIdle = out.some((d) => !d.connected)
    return {
      success: true,
      data: {
        devices: out,
        ...(out.length === 0
          ? { note: "no devices have the Interceptor agent yet — plug your iPhone in (unlocked) and run: interceptor ios install" }
          : anyIdle
            ? { note: "connected:false is the normal idle state — the on-device runner auto-connects on the next verb (e.g. 'interceptor ios tree --on <name>'). Keep the phone unlocked & awake while driving." }
            : {}),
      },
    }
  }

  private name(action: { [k: string]: unknown }): IosResult {
    const ref = typeof action.device === "string" ? action.device : typeof action.udid === "string" ? action.udid : undefined
    const alias = typeof action.alias === "string" ? action.alias : typeof action.name === "string" ? action.name : undefined
    if (!alias) return { success: false, error: "usage: interceptor ios name <device> <alias>" }
    const udid = this.pickDeviceUdid(ref)
    if (!udid) return { success: false, error: this.noDeviceHint() }
    setAlias(alias, udid)
    return { success: true, data: { alias, udid, note: `named — use it: interceptor ios tree --on ${alias}` } }
  }

  // ── self-service install ───────────────────────────────────────────

  /** Store the Apple-ID session token (Keychain) + account metadata. One-time. */
  private async login(action: { [k: string]: unknown }): Promise<IosResult> {
    const appleId = typeof action.appleId === "string" ? action.appleId : undefined
    const password = typeof action.password === "string" ? action.password : undefined
    const twoFactor = typeof action.code === "string" ? action.code : undefined
    if (!appleId || !password) return { success: false, error: "usage: interceptor ios login (prompts for Apple ID + password + 2FA)" }
    let session: signer.AppleSession
    try { session = await signer.appleLogin(appleId, password, twoFactor) }
    catch (err) { return { success: false, error: (err as Error).message } }
    const stored = await keychain.storeToken(session.token)
    if (!stored.ok) return { success: false, error: `could not store token in Keychain: ${stored.error}` }
    setAppleAccount({ teamId: session.teamId, kind: session.kind })
    return { success: true, data: { teamId: session.teamId, tier: session.kind, note: "signed in — run: interceptor ios setup" } }
  }

  /**
   * Idempotent per-device self-service: install → (Dev-Mode prompt) → register +
   * re-sign with the user's Apple ID → reinstall → (Trust prompt) → launch via our
   * native stack. Surfaces the exact Apple-mandated next step whenever it stops.
   */
  private async setup(action: { [k: string]: unknown }): Promise<IosResult> {
    const ref = typeof action.device === "string" ? action.device : typeof action.udid === "string" ? action.udid : undefined
    const udid = this.pickDeviceUdid(ref)
    if (!udid) {
      return { success: false, error: "no device — plug your iPhone in over USB and tap \"Trust This Computer\" (enter the passcode), then re-run." }
    }
    const xcodeSetup = await this.setupWithXcode(action, udid)
    if (xcodeSetup.success || !getAppleAccount() || !(await keychain.hasToken())) return xcodeSetup

    const account = getAppleAccount()!
    // register UDID under the user's team + create a get-task-allow cert/profile.
    let prov: signer.ProvisionResult
    try {
      const token = (await keychain.loadToken())!
      prov = await signer.provisionForDevice({ token, teamId: account.teamId, kind: account.kind }, udid)
    } catch (err) { return { success: false, error: (err as Error).message } }

    // re-sign the bundled (unsigned) runner with the user's identity.
    const staged = stageRunner()
    if (staged.error || !staged.dir) return { success: false, error: staged.error ?? "the Interceptor agent is not available" }
    const app = findRunnerApp(staged.dir)
    if (!app) return { success: false, error: "bundled agent is missing its .app" }
    try {
      signer.resignRunnerApp(app, {
        signingIdentity: prov.signingIdentity,
        entitlements: { applicationIdentifier: prov.applicationIdentifier, teamId: prov.teamId },
        profilePath: prov.profilePath,
      })
    } catch (err) { return { success: false, error: (err as Error).message } }
    const installed = await installRunnerApp(udid)
    if (!installed.ok) return { success: false, error: installed.error ?? "could not install the signed InterceptorRunner" }

    setAppleAccount({ ...account, teamId: prov.teamId, kind: prov.kind, certSha: prov.signingIdentity, profilePath: prov.profilePath, expiresAt: prov.expiresAt })
    markInstalled(udid, prov.expiresAt)

    // launch via our native (no-Xcode) stack; the runner dials back.
    const ensured = await this.ensureRunner(udid)
    const alias = aliasForUdid(udid)
    return {
      success: ensured.ok,
      error: ensured.ok ? undefined : ensured.error,
      data: ensured.ok ? { udid, tier: prov.kind, expiresAt: prov.expiresAt, note: `ready — drive it: interceptor ios tree --on ${alias ?? udid}` } : undefined,
    }
  }

  private async setupWithXcode(action: { [k: string]: unknown }, udid: string): Promise<IosResult> {
    const teamId = typeof action.team === "string" ? action.team : undefined
    const projectPath = typeof action.project === "string" ? action.project : undefined
    let built: ReturnType<typeof buildRunnerWithXcode>
    try {
      built = buildRunnerWithXcode(udid, { teamId, projectPath })
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }

    const installed = await installRunnerApp(udid)
    if (!installed.ok) return { success: false, error: installed.error ?? "could not install the Xcode-built InterceptorRunner" }

    setAppleAccount({ teamId: built.teamId, kind: built.kind, profilePath: built.profilePath, expiresAt: built.expiresAt })
    markInstalled(udid, built.expiresAt)

    const ensured = await this.ensureRunner(udid)
    const alias = aliasForUdid(udid)
    return {
      success: ensured.ok,
      error: ensured.ok ? undefined : ensured.error,
      data: ensured.ok ? {
        udid,
        teamId: built.teamId,
        tier: built.kind,
        expiresAt: built.expiresAt,
        note: `ready — drive it: interceptor ios tree --on ${alias ?? udid}`,
      } : undefined,
    }
  }

  /** Force a re-sign+reinstall+relaunch now (also runs on the refresh timer). */
  private async refresh(action: { [k: string]: unknown }): Promise<IosResult> {
    const ref = typeof action.device === "string" ? action.device : typeof action.udid === "string" ? action.udid : undefined
    // No device ref → refresh everything that's expiring.
    if (!ref) {
      const due = installsExpiringBy(REFRESH_LEAD_MS)
      if (due.length === 0) return { success: true, data: { note: "nothing to refresh — all installs are current" } }
      const results = [] as Array<{ udid: string; ok: boolean; error?: string }>
      for (const udid of due) { const r = await this.setup({ udid }); results.push({ udid, ok: r.success, error: r.error }) }
      return { success: results.every((r) => r.ok), data: { refreshed: results } }
    }
    return this.setup(action)
  }

  /** Legacy root-helper diagnostic retained only to give operators a clear hint. */
  private async tunnelDiag(action: { [k: string]: unknown }): Promise<IosResult> {
    if (process.env.INTERCEPTOR_ENABLE_LEGACY_IOS_TUNNEL !== "1") {
      return {
        success: false,
        error: "ios tunnel uses the obsolete com.interceptor.ios-tunnel root helper. The no-Xcode path now brings up the userspace CoreDeviceProxy tunnel during `interceptor ios enable`.",
      }
    }
    if (!helperAvailable()) {
      return { success: false, error: "root tunnel helper (com.interceptor.ios-tunnel) not running — check /var/log/interceptor-ios-tunnel.log" }
    }
    // Diagnostic passthrough: run remotectl (root) with arbitrary args via the helper.
    if (typeof action.rc === "string" && action.rc.trim()) {
      const out = await runRemotectl(action.rc.trim().split(/\s+/))
      return { success: out.code === 0, data: out }
    }
    // Bring up the CoreDeviceProxy utun tunnel (root helper) and verify RSD is
    // reachable over it via plain node:net — the M3 end-to-end proof.
    const ref = typeof action.device === "string" ? action.device : typeof action.udid === "string" ? action.udid : undefined
    const udid = this.pickDeviceUdid(ref)
    if (!udid) return { success: false, error: this.noDeviceHint() }
    const { getTunnel } = await import("./tunnel")
    let tunnel
    try { tunnel = await getTunnel(udid) } catch (e) { return { success: false, error: (e as Error).message } }
    const reachable = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: tunnel.deviceIp, port: tunnel.rsdPort, family: 6 }, () => { s.destroy(); resolve(true) })
      s.on("error", () => resolve(false))
      setTimeout(() => { try { s.destroy() } catch {} ; resolve(false) }, 5000)
    })
    return { success: reachable, data: { tunnel, rsdReachable: reachable, note: reachable ? "tunnel up; RSD reachable over utun" : "tunnel up but RSD TCP connect failed" } }
  }

  /** Drop the stored Apple-ID token + account metadata. Always works (no gate). */
  private async logout(): Promise<IosResult> {
    const del = await keychain.deleteToken()
    clearAppleAccount()
    if (!del.ok) return { success: false, error: `token removed from state, but Keychain delete failed: ${del.error}` }
    return { success: true, data: { note: "signed out — Apple-ID token removed from the Keychain" } }
  }

  /**
   * Launch the runner WITHOUT Xcode: our RemoteXPC tunnel (M3) + DDI (M4) +
   * testmanagerd (M5). Same WS env payload; the runner dials back unchanged.
   * Default launch route. Set INTERCEPTOR_IOS_USE_XCODE=1 or
   * INTERCEPTOR_NO_XCODE=0 for the legacy xcodebuild fallback.
   */
  private async launchRunnerNative(
    descriptor: IosDeviceDescriptor,
  ): Promise<{ ok: true; channel: RunnerChannel; tunnel: IosTunnelState } | { ok: false; error: string }> {
    const udid = descriptor.udid
    const token = crypto.randomUUID()
    const dialBack = await this.resolveDialBack(descriptor.kind, udid)
    const env: RunnerEnv = {
      INTERCEPTOR_WS_URL: dialBack.url, INTERCEPTOR_WS_TOKEN: token,
      INTERCEPTOR_UDID: udid, INTERCEPTOR_CONTEXT_ID: descriptor.contextId,
    }
    try {
      if (descriptor.needsTunnel) {
        // The userspace launcher owns CoreDeviceProxy, RSD, DDI lookup, appservice,
        // and the testmanagerd DTX handshake. No root helper is on the product path.
        this.deps.emit("ios_tunnel_userspace", { udid })
      }
      await testmanagerd.launchRunner(udid, { bundleId: RUNNER_BUNDLE_ID, env })
      const channel = await this.awaitRunner(udid, token, 120_000)
      return { ok: true, channel, tunnel: "native" }
    } catch (err) {
      return { ok: false, error: registrationFailure(err as Error, dialBack) }
    }
  }

  // ── enable (back-compat wrapper) ─────────────────────────────────────────────

  private async enable(action: { [k: string]: unknown }): Promise<IosResult> {
    const wdaUrlOverride = typeof action.wdaUrl === "string" && action.wdaUrl ? action.wdaUrl : undefined
    const ref = typeof action.udid === "string" ? action.udid : typeof action.device === "string" ? action.device : undefined
    const udid = this.pickDeviceUdid(ref)
    if (wdaUrlOverride && udid) return this.enableViaWda(udid, wdaUrlOverride, action)
    if (!udid) return { success: false, error: this.noDeviceHint() }
    const ensured = await this.ensureRunner(udid)
    if (!ensured.ok) return { success: false, error: ensured.error }
    const ctx = this.contexts.get(ensured.contextId!)!
    const alias = aliasForUdid(udid)
    return { success: true, data: { contextId: ensured.contextId, name: ctx.descriptor.name, alias, channel: "runner", note: `ready: interceptor ios tree --on ${alias ?? ctx.descriptor.name}` } }
  }

  /** Legacy escape hatch: drive an already-running WebDriverAgent over HTTP. */
  private async enableViaWda(udid: string, baseUrl: string, action: { [k: string]: unknown }): Promise<IosResult> {
    const bundleId = typeof action.bundleId === "string" ? action.bundleId : undefined
    const descriptor = this.resolveDescriptor(udid) ?? describeIosDevice({ udid, name: udid, kind: "device", paired: true, developerMode: true })
    const wda = new WdaClient({ baseUrl })
    if (!(await pollHealthy(wda, 30_000))) return { success: false, error: `WebDriverAgent did not become healthy at ${baseUrl} within 30s (--wda-url is the deprecated legacy path).` }
    try { await wda.createSession(bundleId) } catch (err) { return { success: false, error: `WDA session failed: ${(err as Error).message}` } }
    const ctx: IosDeviceContext = { descriptor, channel: wda, registry: new IosRefRegistry(), wdaPort: DEFAULT_WDA_PORT, tunnel: "none", procs: [], registeredAt: Date.now() }
    this.contexts.set(descriptor.contextId, ctx)
    return { success: true, data: { contextId: descriptor.contextId, channel: "wda-url (legacy)", note: `enabled via --wda-url` } }
  }

  // ── auto-connect (ensureRunner) + launch from the prebuilt agent ──────────────

  /** Ensure the agent is connected for `udid`, launching it on demand if installed.
   *  Concurrent calls for the same device share one in-flight launch (dedup by
   *  contextId) so two near-simultaneous verbs can't double-launch + orphan a runner. */
  private ensureRunner(udid: string): Promise<{ ok: boolean; error?: string; contextId?: string }> {
    const contextId = iosContextId(udid)
    const inflight = this.ensuring.get(contextId)
    if (inflight) return inflight
    const p = this.ensureRunnerInner(udid, contextId).finally(() => this.ensuring.delete(contextId))
    this.ensuring.set(contextId, p)
    return p
  }

  private async ensureRunnerInner(udid: string, contextId: string): Promise<{ ok: boolean; error?: string; contextId?: string }> {
    const existing = this.contexts.get(contextId)
    if (existing) {
      try { await existing.channel.status(); return { ok: true, contextId } }
      catch { await this.teardownContext(existing); this.contexts.delete(contextId) }
    }
    // Tolerate transient devicectl gaps for a device we've already installed onto:
    // synthesize a descriptor and let the launch surface a real error if it's gone.
    let descriptor = this.resolveDescriptor(udid)
    if (!descriptor && knownInstalledUdids().includes(udid.toUpperCase())) {
      // Physical-device UDIDs are canonically upper-case; carry that form so a
      // synthesized descriptor still matches devicectl (`ios apps`, install).
      const canonical = udid.toUpperCase()
      descriptor = describeIosDevice({ udid: canonical, name: aliasForUdid(canonical) ?? canonical, kind: "device", paired: true, developerMode: true })
    }
    if (!descriptor) return { ok: false, error: "device not found — plug it in and unlock it (interceptor ios devices)" }
    if (descriptor.wayIn === "unsupported") return { ok: false, error: `'${descriptor.name}' is not ready: ${missingSetup(descriptor)}` }

    const procs: Bun.Subprocess[] = []
    const brought = await this.launchRunner(descriptor, procs)
    if (!brought.ok) { for (const p of procs) killChild(p); return { ok: false, error: brought.error } }
    const ctx: IosDeviceContext = {
      descriptor, channel: brought.channel, registry: new IosRefRegistry(),
      wdaPort: 0, tunnel: brought.tunnel, procs, registeredAt: Date.now(),
    }
    this.contexts.set(contextId, ctx)
    this.deps.emit("ios_enabled", { contextId, udid, kind: descriptor.kind, transport: "runner" })
    return { ok: true, contextId }
  }

  /**
   * Launch the PRE-BUILT agent via `xcodebuild test-without-building` against the
   * bundled `.xctestrun` (installs + launches; no compile, no signing). Per-session
   * WS env is injected into a staged copy of the descriptor. The runner dials back.
   */
  private async launchRunner(
    descriptor: IosDeviceDescriptor, procs: Bun.Subprocess[],
  ): Promise<{ ok: true; channel: RunnerChannel; tunnel: IosTunnelState } | { ok: false; error: string }> {
    // no-Xcode path (our tunnel + testmanagerd) by default.
    if (preferNoXcodeIosPath()) return this.launchRunnerNative(descriptor)

    const udid = descriptor.udid
    const token = crypto.randomUUID()
    const dialBack = await this.resolveDialBack(descriptor.kind, udid)
    const wsUrl = dialBack.url

    const staged = stageRunner()
    if (staged.error || !staged.dir) return { ok: false, error: staged.error ?? "the Interceptor agent is not available" }
    const xctestrun = findXctestrun(staged.dir)
    if (!xctestrun) return { ok: false, error: "the bundled agent is missing its launch descriptor (.xctestrun) — reinstall Interceptor" }
    const prepared = prepareXctestrunWithEnv(xctestrun, {
      INTERCEPTOR_WS_URL: wsUrl, INTERCEPTOR_WS_TOKEN: token,
      INTERCEPTOR_UDID: udid, INTERCEPTOR_CONTEXT_ID: descriptor.contextId,
    })
    if (!prepared) return { ok: false, error: "could not prepare the agent launch descriptor" }

    if (descriptor.kind === "simulator") run("/usr/bin/xcrun", ["simctl", "boot", udid])
    const destination = descriptor.kind === "simulator" ? `platform=iOS Simulator,id=${udid}` : `id=${udid}`
    procs.push(spawnLongLived("/usr/bin/xcrun", ["xcodebuild", "test-without-building", "-xctestrun", prepared, "-destination", destination]))

    try {
      const channel = await this.awaitRunner(udid, token, 120_000)
      return { ok: true, channel, tunnel: descriptor.needsTunnel ? "xcode" : "none" }
    } catch (err) {
      return { ok: false, error: registrationFailure(err as Error, dialBack) }
    }
  }

  // ── device-ref resolution helpers ────────────────────────────────────────────

  /** Resolve a user ref (alias|udid|ios:) to a udid; if omitted, the single ready device. */
  private pickDeviceUdid(ref?: string): string | undefined {
    if (ref && ref.trim()) {
      const u = resolveUdid(ref)
      if (u) {
        // exact udid/alias hit; verify it's a real device when discoverable
        if (this.resolveDescriptor(u)) return u
        // alias may point at a device that's temporarily offline — still return it
        if (resolveUdid(ref) !== ref.toUpperCase()) return u
        return u
      }
      return undefined
    }
    const phys = listPhysicalDevices()
    if (phys.length === 1) return phys[0].udid
    const known = new Set(knownInstalledUdids())
    const installed = phys.filter((d) => known.has(d.udid.toUpperCase()) || isRunnerInstalled(d.udid))
    return installed.length === 1 ? installed[0].udid : undefined
  }

  private canonicalContextId(ref: string | undefined): string | undefined {
    if (ref && ref.trim() && ref !== "undefined") {
      const u = resolveUdid(ref)
      return u ? iosContextId(u) : undefined
    }
    const u = this.pickDeviceUdid(undefined)
    return u ? iosContextId(u) : undefined
  }

  private noDeviceHint(): string {
    const phys = listPhysicalDevices()
    if (phys.length === 0) return 'no iPhone detected — plug it in, unlock it, and tap "Trust This Computer"'
    return "more than one device — pick one: interceptor ios devices, then add --on <name>"
  }

  // ── disable ──────────────────────────────────────────────────────────────────

  private async disable(action: { [k: string]: unknown }): Promise<IosResult> {
    const ref = typeof action.contextId === "string" ? action.contextId
      : typeof action.udid === "string" ? action.udid
        : typeof action.device === "string" ? action.device : undefined
    const contextId = this.canonicalContextId(ref)
    if (!contextId) return { success: false, error: "ios disable: specify a device (--on <name>) — see interceptor ios devices" }
    const ctx = this.contexts.get(contextId)
    if (!ctx) return { success: false, error: `ios context '${contextId}' not found` }
    await this.teardownContext(ctx)
    this.contexts.delete(contextId)
    this.deps.emit("ios_disabled", { contextId, udid: ctx.descriptor.udid })
    return { success: true, data: { disabled: contextId } }
  }

  private async teardownContext(ctx: IosDeviceContext): Promise<void> {
    try { await ctx.channel.deleteSession() } catch {}
    // Drop any runner socket mapping for this context.
    for (const [ws, rec] of this.runnerByWs) {
      if (rec.channel === ctx.channel) { try { rec.channel.teardown() } catch {} ; this.runnerByWs.delete(ws) }
    }
    for (const p of ctx.procs) killChild(p)
    ctx.procs = []
    testmanagerd.closeRunner(ctx.descriptor.udid)
  }

  // ── status ───────────────────────────────────────────────────────────────────

  private async status(): Promise<IosResult> {
    const data: IosDeviceState[] = []
    for (const ctx of this.contexts.values()) {
      const dial = await this.resolveDialBack(ctx.descriptor.kind, ctx.descriptor.udid)
      data.push({
        contextId: ctx.descriptor.contextId,
        udid: ctx.descriptor.udid,
        name: ctx.descriptor.name,
        kind: ctx.descriptor.kind,
        wayIn: ctx.descriptor.wayIn,
        productVersion: ctx.descriptor.productVersion,
        wdaPort: ctx.wdaPort,
        tunnel: ctx.tunnel,
        connection: "connected",
        signingExpiresAt: ctx.signingExpiresAt,
        registeredAt: ctx.registeredAt,
        dialBack: dial.url,
        dialBackVia: dial.via,
      })
    }
    // The runner drops on idle and re-dials per verb, so live contexts alone make
    // status read empty between calls even though the phone is fully driveable.
    // Also surface every device with our agent installed but no live channel as
    // "disconnected" (installed + ready to auto-connect on the next verb).
    const seen = new Set(data.map((d) => d.contextId))
    for (const udid of knownInstalledUdids()) {
      const contextId = iosContextId(udid)
      if (seen.has(contextId)) continue
      seen.add(contextId)
      const d = this.resolveDescriptor(udid)
        ?? describeIosDevice({ udid, name: aliasForUdid(udid) ?? udid, kind: "device", paired: true, developerMode: true })
      const dial = await this.resolveDialBack(d.kind, d.udid)
      data.push({
        contextId, udid: d.udid, name: d.name, kind: d.kind, wayIn: d.wayIn,
        productVersion: d.productVersion, tunnel: "none", connection: "disconnected", registeredAt: 0,
        dialBack: dial.url, dialBackVia: dial.via,
      })
    }
    return { success: true, data }
  }

  // ── verbs ────────────────────────────────────────────────────────────────────

  /** Refresh the source tree and repopulate the ref registry. Returns the root node. */
  private async refreshTree(ctx: IosDeviceContext): Promise<WdaSourceNode | undefined> {
    const src = await ctx.channel.source()
    return (src ?? undefined) as WdaSourceNode | undefined
  }

  private async verbTree(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const root = await this.refreshTree(ctx)
    ctx.registry.clear()
    const filter = typeof action.filter === "string" ? action.filter : action.all ? "full" : "all"
    const text = formatWdaTree(root, ctx.registry, { filter })
    return { success: true, data: { tree: text, count: ctx.registry.all().length } }
  }

  private async verbFind(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const query = typeof action.query === "string" ? action.query : typeof action.label === "string" ? action.label : undefined
    if (!query) return { success: false, error: "ios find requires a query (or --label)" }
    const root = await this.refreshTree(ctx)
    ctx.registry.clear()
    formatWdaTree(root, ctx.registry, { filter: "full" })
    const role = typeof action.role === "string" ? action.role : undefined
    return { success: true, data: findInTree(ctx.registry, query, role) }
  }

  private verbInspect(ctx: IosDeviceContext, action: { [k: string]: unknown }): IosResult {
    const ref = typeof action.ref === "string" ? action.ref : undefined
    if (!ref) return { success: false, error: "ios inspect requires a ref" }
    const el = ctx.registry.resolve(ref)
    if (!el) return { success: false, error: `ref '${ref}' is stale — re-read with 'interceptor ios tree'` }
    return { success: true, data: el }
  }

  /** Resolve an action's target coordinate from a ref or explicit x,y. */
  private resolvePoint(ctx: IosDeviceContext, action: { [k: string]: unknown }): { x: number; y: number } | { error: string } {
    if (typeof action.x === "number" && typeof action.y === "number") return { x: action.x, y: action.y }
    const ref = typeof action.ref === "string" ? action.ref : undefined
    if (!ref) return { error: "needs a ref (from 'interceptor ios tree') or explicit --x/--y" }
    const el = ctx.registry.resolve(ref)
    if (!el) return { error: `ref '${ref}' is stale — re-read with 'interceptor ios tree'` }
    return frameCenter(el)
  }

  private async verbClick(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const pt = this.resolvePoint(ctx, action)
    if ("error" in pt) return { success: false, error: `ios click ${pt.error}` }
    await ctx.channel.tap(pt.x, pt.y)
    return { success: true, data: { tapped: pt } }
  }

  private async verbType(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const text = typeof action.text === "string" ? action.text : undefined
    if (text === undefined) return { success: false, error: "ios type requires text" }
    if (action.ref !== undefined || (typeof action.x === "number" && typeof action.y === "number")) {
      const pt = this.resolvePoint(ctx, action)
      if ("error" in pt) return { success: false, error: `ios type ${pt.error}` }
      await ctx.channel.tap(pt.x, pt.y)
    }
    await ctx.channel.sendKeys(text, typeof action.bundleId === "string" ? action.bundleId : undefined)
    return { success: true, data: { typed: text.length } }
  }

  private async verbKeys(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const text = typeof action.text === "string" ? action.text : typeof action.keys === "string" ? action.keys : undefined
    if (!text) return { success: false, error: "ios keys requires text" }
    await ctx.channel.sendKeys(text, typeof action.bundleId === "string" ? action.bundleId : undefined)
    return { success: true, data: { sent: text.length } }
  }

  /**
   * issue #244: lock-screen passcode entry. The runner wakes the phone, swipes up,
   * waits for SpringBoard's "Passcode field", types, and waits for lockstate 0.
   * `probe` stops before typing and reports what it found.
   */
  private async verbUnlock(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    if (!(ctx.channel instanceof RunnerChannel)) return { success: false, error: "ios unlock is runner-only" }
    const probe = action.probe === true
    const passcode = typeof action.passcode === "string" ? action.passcode : undefined
    if (!probe && !passcode) return { success: false, error: "ios unlock requires --secret <name> (or --probe)" }
    const data = await ctx.channel.unlock(passcode, probe)
    const d = (data ?? {}) as { unlocked?: boolean; passcodeField?: boolean; locked?: boolean }
    if (!probe && d.unlocked !== true) {
      return { success: false, error: d.passcodeField === false ? "no passcode field appeared on the lock screen (is the phone locked? is the runner resident?)" : "the phone is still locked after typing the passcode", data }
    }
    return { success: true, data }
  }

  private async verbScroll(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const dir = typeof action.dir === "string" ? action.dir.toLowerCase() : "down"
    const pt = this.resolvePoint(ctx, action)
    const center = "error" in pt ? await this.screenCenter(ctx) : pt
    const delta = 250
    let toX = center.x, toY = center.y
    if (dir === "down") toY = center.y - delta
    else if (dir === "up") toY = center.y + delta
    else if (dir === "left") toX = center.x + delta
    else if (dir === "right") toX = center.x - delta
    await ctx.channel.drag(center.x, center.y, toX, toY, 0.4)
    return { success: true, data: { scrolled: dir } }
  }

  private async verbDrag(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const fromRef = typeof action.from === "string" ? action.from : undefined
    const toRef = typeof action.to === "string" ? action.to : undefined
    if (!fromRef || !toRef) return { success: false, error: "ios drag requires <from> and <to> refs" }
    const a = ctx.registry.resolve(fromRef)
    const b = ctx.registry.resolve(toRef)
    if (!a || !b) return { success: false, error: "stale ref in drag — re-read with 'interceptor ios tree'" }
    const pa = frameCenter(a), pb = frameCenter(b)
    await ctx.channel.drag(pa.x, pa.y, pb.x, pb.y, typeof action.duration === "number" ? action.duration : 0.6)
    return { success: true, data: { from: pa, to: pb } }
  }

  private async verbPress(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const raw = typeof action.button === "string" ? action.button : typeof action.name === "string" ? action.name : undefined
    if (!raw) return { success: false, error: "ios press requires home|lock|volume-up|volume-down" }
    const map: Record<string, string> = {
      "home": "home", "lock": "lock",
      "volume-up": "volumeUp", "volumeup": "volumeUp",
      "volume-down": "volumeDown", "volumedown": "volumeDown",
    }
    const name = map[raw.toLowerCase()]
    if (!name) return { success: false, error: `unknown button '${raw}' (home|lock|volume-up|volume-down)` }
    const observed = await ctx.channel.pressButton(name)
    const detail = observed && typeof observed === "object" ? observed as Record<string, unknown> : {}
    const data = { pressed: name, ...detail }
    if (name === "lock" && detail.locked === false) return { success: false, error: "the lock button was delivered but the phone remained unlocked", data }
    return { success: true, data: name === "lock" && detail.locked !== true ? { ...data, verified: false } : data }
  }

  private async verbScreenshot(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const b64 = await ctx.channel.screenshot()
    const maxLongEdge = Number(action.targetMaxLongEdge) > 0 ? Number(action.targetMaxLongEdge) : 1568
    const { dataUrl, format } = resizePngToBudget(b64, maxLongEdge)
    return { success: true, data: { dataUrl, format } }
  }

  private verbApps(ctx: IosDeviceContext): IosResult {
    if (ctx.descriptor.kind === "device") {
      const apps = listDeviceApps(ctx.descriptor.udid)
      if (apps) return { success: true, data: apps }
    } else {
      const apps = runJson<unknown>("/usr/bin/xcrun", ["simctl", "listapps", ctx.descriptor.udid])
      if (apps) return { success: true, data: apps }
    }
    return { success: false, error: "could not list installed apps (xcrun devicectl/simctl unavailable for this device kind)" }
  }

  private async verbApp(ctx: IosDeviceContext, action: { [k: string]: unknown }): Promise<IosResult> {
    const op = typeof action.op === "string" ? action.op : typeof action.sub === "string" ? action.sub : undefined
    const bundleId = typeof action.bundleId === "string" ? action.bundleId : undefined
    if (!op || !bundleId) return { success: false, error: "ios app requires launch|activate|terminate <bundleId>" }
    switch (op) {
      case "launch": await ctx.channel.launchApp(bundleId); break
      case "activate": await ctx.channel.activateApp(bundleId); break
      case "terminate": await ctx.channel.terminateApp(bundleId); break
      default: return { success: false, error: `unknown app op '${op}' (launch|activate|terminate)` }
    }
    return { success: true, data: { op, bundleId } }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async screenCenter(ctx: IosDeviceContext): Promise<{ x: number; y: number }> {
    try {
      const size = await ctx.channel.windowSize()
      return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
    } catch {
      return { x: 200, y: 400 }
    }
  }

  private resolveDescriptor(udid: string): IosDeviceDescriptor | undefined {
    // Match case-insensitively: an auto-connected device is resolved from its
    // lower-cased context slug, but devicectl/simctl report the canonical udid
    // (upper-case hex for physical devices). Returning the descriptor with the
    // TOOL's udid — not the slug — is what lets devicectl ops (e.g. `ios apps`)
    // match the device; devicectl's --device lookup is case-sensitive.
    const norm = udid.toLowerCase()
    for (const sim of listSimulators()) {
      if (sim.udid.toLowerCase() === norm) {
        return describeIosDevice({ udid: sim.udid, name: `${sim.name} (Simulator)`, kind: "simulator", productVersion: sim.runtimeVersion })
      }
    }
    for (const dev of listPhysicalDevices()) {
      if (dev.udid.toLowerCase() === norm) {
        return describeIosDevice({ udid: dev.udid, name: dev.name, kind: "device", productVersion: dev.productVersion, paired: dev.paired, developerMode: dev.developerMode })
      }
    }
    return undefined
  }

  shutdown(): void {
    for (const ctx of this.contexts.values()) {
      try { void ctx.channel.deleteSession() } catch {}
      for (const p of ctx.procs) killChild(p)
    }
    for (const [, rec] of this.runnerByWs) { try { rec.channel.teardown() } catch {} }
    testmanagerd.closeAllRunners()
    this.runnerByWs.clear()
    this.contexts.clear()
  }
}

// ── module helpers ─────────────────────────────────────────────────────────────

function deviceDiscoveryHint(tc: ReturnType<typeof detectToolchain>): string {
  const parts: string[] = []
  if (!tc.simctl) parts.push("Xcode/simctl not found (no Simulators)")
  if (!tc.devicectl) parts.push("xcrun devicectl not found — install Xcode to see physical devices")
  return parts.length ? parts.join("; ") : "no iOS devices or simulators found"
}

function missingSetup(d: IosDeviceDescriptor): string {
  const missing: string[] = []
  if (!d.paired) missing.push("pair + trust this computer")
  if (!d.developerMode) missing.push("enable Developer Mode (Settings → Privacy & Security → Developer Mode)")
  return missing.length ? missing.join("; then ") : "device not in a supported state"
}

async function pollHealthy(channel: IosDeviceChannel, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await channel.status(); return true } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * The runner never registered: say which address it was handed and what that
 * implies. Only a registration timeout gets the dial-back explanation; a failure
 * before the launch (usbmuxd cannot see the phone, tunnel down, DTX handshake)
 * passes through unchanged because no runner was ever told to dial anything.
 */
export function registrationFailure(err: Error, dialBack: DialBack): string {
  if (!/did not register/.test(err.message)) return err.message
  return `${err.message} — the runner was told to dial ${dialBack.url} (${dialBack.via}). ${runnerDialHint(dialBack)}`
}
