/**
 * daemon/ios/web-manager.ts — IosWebManager: the web-lane owner.
 *
 * Owns device resolution, the target registry (iwt_ handles), single-debugger
 * session leases (iws_ handles), wN DOM refs, the high-level verbs, redaction,
 * and the bounded console/network buffers. It composes the WIR transport and WIP
 * session over a broker-provided byte channel; it never routes through the native
 * IosDeviceChannel and never triggers the runner's ensureRunner. Native-lane work
 * (screenshot, native input, calibration) is delegated to an injected NativeLane.
 *
 * The device-facing attach/discovery I/O is only meaningful with a paired device;
 * the registries, buffers, refs, redaction, capability ledger, action-mode
 * decision, and DOM tree rendering below are pure and unit-tested.
 */

import { randomBytes, randomUUID } from "node:crypto"
import {
  IOS_WEB_SESSION_ACTION_TYPES,
  mintTargetId, mintSessionId, webRef, isWebRef, isNativeRef, webError, blankCapabilities,
  setupVariantCandidates, redactHeaders, redactUrl,
  type IosWebResult, type IosWebTarget, type IosWebApplication, type IosWebCapabilities,
  type WirSetupVariant, type WipEnvelopeMode, type WirTransport,
  type IosWebActionMode, type IosWebActionModeReport,
} from "../../shared/ios-web"
import { iosContextId, iosUdidSlug, isIosContextId } from "../../shared/ios-device"
import {
  IosDeviceServiceBroker, discoverWebLaneDevices, reconcileByUdid, adaptNetSocket,
  type DeviceByteChannel, type WebLaneDevice, type ManagerDescriptorLite,
} from "./device-services"
import { connectServiceSocket } from "./lockdown"
import { resolveUdid } from "./state"
import {
  WebInspectorTransport, type RawWebTarget, type ParsedApplication,
} from "./webinspector-transport"
import { WebInspectorSession, type WipEvent } from "./webinspector-session"

export const WEBINSPECTOR_SHIM_SERVICE = "com.apple.webinspector.shim.remote"
export const WEBINSPECTOR_CLASSIC_SERVICE = "com.apple.webinspector"

// ── native-lane seam (implemented by the daemon over IosManager) ──────────────

export interface NativeLane {
  /** True when the XCUITest runner is connected for this device context. */
  isAvailable(deviceContextId: string): boolean
  screenshot(deviceContextId: string, targetMaxLongEdge?: number): Promise<IosWebResult>
  tap(deviceContextId: string, x: number, y: number): Promise<IosWebResult>
  type(deviceContextId: string, text: string): Promise<IosWebResult>
  keys(deviceContextId: string, text: string): Promise<IosWebResult>
  /** Fresh native element tree (for calibration WebView selection). */
  tree(deviceContextId: string): Promise<IosWebResult>
}

// ── wN ref registry (tied to a document generation) ───────────────────────────

export type WebRefKind = "dom" | "runtime"
export type WebRefRecord = {
  ref: string
  kind: WebRefKind
  generation: number
  /** DOM refs keep the backend/node id; runtime refs keep a resolver + fingerprint. */
  backendNodeId?: number
  nodeId?: number
  selector?: string
  ordinal?: number
  fingerprint?: string
}

export class WebRefRegistry {
  private static readonly MAX_RECORDS = 50_000
  private generation = 0
  private byRef = new Map<string, WebRefRecord>()
  private counter = 0 // monotonic — a ref number is never reused, so a prior-gen ref stays resolvable as STALE

  /** Bump the document generation; all prior wN refs now resolve as stale. */
  newGeneration(): number {
    this.generation++
    return this.generation
  }

  get currentGeneration(): number { return this.generation }

  mint(rec: Omit<WebRefRecord, "ref" | "generation">): string {
    const ref = webRef(++this.counter)
    if (this.byRef.size >= WebRefRegistry.MAX_RECORDS) {
      const oldest = this.byRef.keys().next().value
      if (oldest) this.byRef.delete(oldest)
    }
    this.byRef.set(ref, { ...rec, ref, generation: this.generation })
    return ref
  }

  resolve(ref: string): WebRefRecord | { stale: true } | undefined {
    if (!isWebRef(ref)) return undefined
    const rec = this.byRef.get(ref)
    if (!rec) return undefined
    if (rec.generation !== this.generation) return { stale: true } //
    return rec
  }
}

// ── bounded event buffer (console / network) ──────────────────────────────────

export type BoundedBufferOptions = { maxEvents: number; maxBytes: number }
export const DEFAULT_BUFFER_OPTIONS: BoundedBufferOptions = { maxEvents: 2000, maxBytes: 16 * 1024 * 1024 }

export class BoundedEventBuffer<T = unknown> {
  private events: T[] = []
  private bytes = 0
  private dropped = 0
  private firstRetainedAt: string | undefined
  constructor(private opts: BoundedBufferOptions = DEFAULT_BUFFER_OPTIONS) {}

  push(evt: T): void {
    const size = Buffer.byteLength(JSON.stringify(evt))
    this.events.push(evt)
    this.bytes += size
    if (this.firstRetainedAt === undefined) this.firstRetainedAt = new Date().toISOString()
    while (this.events.length > this.opts.maxEvents || this.bytes > this.opts.maxBytes) {
      const removed = this.events.shift()
      if (removed === undefined) break
      this.bytes -= Buffer.byteLength(JSON.stringify(removed))
      this.dropped++
    }
  }

  drain(): { events: T[]; dropped: number; retainedFrom?: string } {
    const out = { events: this.events.slice(), dropped: this.dropped, retainedFrom: this.firstRetainedAt }
    return out
  }

  clear(): void { this.events = []; this.bytes = 0; this.dropped = 0; this.firstRetainedAt = undefined }
  get droppedCount(): number { return this.dropped }
  get size(): number { return this.events.length }
}

// ── capability ledger ─────────────────────────────────────────────────────────

export class CapabilityLedger {
  constructor(private caps: IosWebCapabilities) {}

  get snapshot(): IosWebCapabilities { return this.caps }

  observeMethod(method: string, ok: boolean): void {
    const dot = method.indexOf(".")
    if (dot <= 0) return
    const domain = method.slice(0, dot)
    const d = (this.caps.domains[domain] ??= { enabled: false, methodsObserved: [], unavailableMethods: [] })
    if (ok) {
      if (!d.methodsObserved.includes(method)) d.methodsObserved.push(method)
      d.unavailableMethods = d.unavailableMethods.filter((m) => m !== method)
      this.applyDerived(domain, method, true)
    } else if (!d.unavailableMethods.includes(method)) {
      d.unavailableMethods.push(method)
      this.applyDerived(domain, method, false)
    }
  }

  markDomainEnabled(domain: string): void {
    const d = (this.caps.domains[domain] ??= { enabled: false, methodsObserved: [], unavailableMethods: [] })
    d.enabled = true
    if (domain === "Console" || domain === "Log") this.caps.consoleEvents = true
    if (domain === "Network") this.caps.networkEvents = true
    if (domain === "Debugger") this.caps.debugger = true
  }

  private applyDerived(domain: string, method: string, ok: boolean): void {
    if (domain === "Runtime" && method === "Runtime.evaluate") this.caps.runtimeEvaluate = ok
    if (domain === "DOM" && (method === "DOM.getDocument" || method === "DOM.querySelector")) this.caps.domRead = ok || this.caps.domRead
    if (method === "DOM.getAccessibilityPropertiesForNode") this.caps.accessibility = ok || this.caps.accessibility
  }
}

// ── action-mode decision (pure) ───────────────────────────────────────────────

export function decideActionMode(
  requested: IosWebActionMode,
  state: { nativeLaneAvailable: boolean; calibrated: boolean },
): { report: IosWebActionModeReport; error?: ReturnType<typeof webError> } {
  const base: IosWebActionModeReport = {
    requestedMode: requested,
    modeUsed: "dom",
    trustedInput: false,
    nativeLaneAvailable: state.nativeLaneAvailable,
  }
  if (requested === "native") {
    if (!state.nativeLaneAvailable) return { report: base, error: webError("native_lane_unavailable") }
    if (!state.calibrated) return { report: base, error: webError("native_mapping_unavailable") }
    return { report: { ...base, modeUsed: "native", trustedInput: true } }
  }
  if (requested === "auto") {
    if (state.nativeLaneAvailable && state.calibrated) {
      return { report: { ...base, modeUsed: "native", trustedInput: true } }
    }
    return {
      report: {
        ...base,
        modeUsed: "dom",
        fallbackReason: !state.nativeLaneAvailable ? "native_runner_not_connected" : "calibration_unavailable",
      },
    }
  }
  return { report: base } // dom
}

// ── DOM read: injected serializer + tree renderer (pure) ──────────────────────

/**
 * A self-contained page serializer run via Runtime.evaluate when DOM.* methods
 * are unavailable. Returns { nodes, truncated }. Refs are minted host-side from
 * each node's stable resolver (selector[+ordinal]) and identity fingerprint; the
 * serializer writes NO marker attributes into the page.
 */
export const WEB_DOM_SERIALIZER_JS = String.raw`(function(maxNodes, maxDepth){
  var out=[], truncated=false;
  function cssPath(el){
    if(!(el instanceof Element)) return "";
    if(el.id) return "#"+CSS.escape(el.id);
    var parts=[], node=el, depth=0;
    while(node && node.nodeType===1 && depth<12){
      var tag=node.tagName.toLowerCase(), sib=node, nth=1;
      while((sib=sib.previousElementSibling)){ if(sib.tagName===node.tagName) nth++; }
      parts.unshift(tag+":nth-of-type("+nth+")");
      if(node.id){ parts.unshift("#"+CSS.escape(node.id)); break; }
      node=node.parentElement; depth++;
    }
    return parts.join(">");
  }
  function visible(el){
    var s=window.getComputedStyle(el);
    if(s.display==="none"||s.visibility==="hidden"||s.opacity==="0") return false;
    var r=el.getBoundingClientRect();
    return r.width>0 && r.height>0;
  }
  function walk(el, depth){
    if(out.length>=maxNodes){ truncated=true; return; }
    if(depth>maxDepth) return;
    var tag=el.tagName ? el.tagName.toLowerCase() : "";
    if(tag==="script"||tag==="style"||tag==="noscript"||tag==="template") return;
    if(el.nodeType===1 && !visible(el)) return;
    var rect=el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    var text=""; for(var i=0;i<el.childNodes.length;i++){ var c=el.childNodes[i]; if(c.nodeType===3) text+=c.nodeValue; }
    out.push({
      tag: tag,
      role: el.getAttribute ? (el.getAttribute("role")||"") : "",
      name: el.getAttribute ? (el.getAttribute("aria-label")||el.getAttribute("alt")||el.getAttribute("title")||"") : "",
      text: (text||"").trim().slice(0,200),
      href: (el.tagName==="A") ? (el.getAttribute("href")||"") : "",
      inputType: (el.tagName==="INPUT") ? (el.getAttribute("type")||"text") : "",
      value: (el.tagName==="INPUT"||el.tagName==="TEXTAREA") ? String(el.value||"").slice(0,120) : "",
      depth: depth,
      selector: cssPath(el),
      box: rect ? {x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)} : null
    });
    for(var j=0;j<el.children.length;j++) walk(el.children[j], depth+1);
  }
  if(document.body) walk(document.body,0);
  return {nodes: out, truncated: truncated, title: document.title, url: location.href};
})`

export type SerializedNode = {
  tag: string
  role?: string
  name?: string
  text?: string
  href?: string
  inputType?: string
  value?: string
  depth: number
  selector?: string
  box?: { x: number; y: number; w: number; h: number } | null
}

/** Render serialized nodes to an Interceptor-style indented tree, minting wN refs. */
export function renderWebTree(nodes: SerializedNode[], registry: WebRefRegistry, opts: { maxNodes?: number } = {}): string {
  const cap = opts.maxNodes ?? 5000
  const lines: string[] = []
  const seen = new Map<string, number>()
  for (const n of nodes.slice(0, cap)) {
    const selector = n.selector ?? ""
    const ordinal = (seen.get(selector) ?? 0) + 1
    seen.set(selector, ordinal)
    const ref = registry.mint({
      kind: "runtime",
      selector,
      ordinal,
      fingerprint: fingerprintNode(n),
    })
    const label = n.role || n.tag
    const bits: string[] = [`[${ref}]`, label]
    if (n.name) bits.push(`"${n.name}"`)
    else if (n.text) bits.push(`"${n.text}"`)
    if (n.href) bits.push(`href=${n.href}`)
    if (n.inputType) bits.push(`type=${n.inputType}`)
    lines.push("  ".repeat(Math.min(n.depth, 20)) + bits.join(" "))
  }
  if (nodes.length > cap) lines.push(`… truncated at ${cap} nodes (${nodes.length} total)`)
  return lines.join("\n")
}

export function fingerprintNode(n: SerializedNode): string {
  return [n.tag, n.role ?? "", n.name ?? "", (n.text ?? "").slice(0, 40), n.box ? `${n.box.w}x${n.box.h}` : ""].join("|")
}

// ── one attached WIP session over a WIR socket ────────────────────────────────

export type WebSessionParams = {
  sessionId: string
  deviceContextId: string
  udid: string
  applicationId: string
  target: IosWebTarget
  /** The raw WIRListingKey key, used to re-resolve a live page id on the attach connection. */
  rawListingKey: string
  connectionId: string
  senderKey: string
  transportKind: WirTransport
  setupVariant: WirSetupVariant
  /** Releases the underlying device-service ownership (shim) or socket (classic). */
  release?: () => void | Promise<void>
}

export class WebSession {
  readonly transport: WebInspectorTransport
  readonly wip: WebInspectorSession
  readonly refs = new WebRefRegistry()
  readonly console = new BoundedEventBuffer<Record<string, unknown>>()
  readonly network = new BoundedEventBuffer<Record<string, unknown>>()
  readonly capabilities: IosWebCapabilities
  readonly ledger: CapabilityLedger
  readonly attachedAt = new Date().toISOString()
  lastEventAt: string | undefined
  private consoleOn = false
  private networkOn = false
  /** Re-resolved on the attach connection's listing; page ids can change per connection. */
  private livePageId: number | null

  constructor(channel: DeviceByteChannel, readonly params: WebSessionParams, envelope: WipEnvelopeMode = "direct") {
    this.livePageId = params.target.devicePageId
    this.capabilities = blankCapabilities(params.target.type, params.setupVariant, envelope)
    this.ledger = new CapabilityLedger(this.capabilities)
    this.transport = new WebInspectorTransport(channel, params.connectionId, {
      onSocketData: (data) => this.wip.feed(data),
      onListing: (p) => this.refreshLivePageId(p.targets),
      onApplicationDidClose: () => this.markTargetClosed(),
      onError: () => this.markTargetClosed(),
    })
    this.wip = new WebInspectorSession({
      sendBytes: (b) => this.transport.forwardSocketData(params.applicationId, this.livePageId, params.senderKey, b),
      onEvent: (e) => this.onWipEvent(e),
      onTargetDestroyed: () => this.markTargetClosed(),
    })
    this.wip.setEnvelopeMode(envelope)
    this.refs.newGeneration()
  }

  private refreshLivePageId(targets: RawWebTarget[]): void {
    const m = targets.find((t) => t.rawListingKey === this.params.rawListingKey)
      ?? targets.find((t) => t.url && t.url === this.params.target.url)
    if (m && m.devicePageId !== null) this.livePageId = m.devicePageId
  }

  /**
   * Attach handshake on this connection: announce, refresh the app listing to get
   * a live page id, then socket-setup. The device answers with Target.targetCreated,
   * which the WIP session auto-promotes to a target-multiplexed inner page.
   */
  async performAttach(): Promise<void> {
    this.transport.reportIdentifier()
    this.transport.getConnectedApplications()
    await new Promise((r) => setTimeout(r, 400))
    this.transport.forwardGetListing(this.params.applicationId)
    await new Promise((r) => setTimeout(r, 500))
    this.transport.forwardSocketSetup(this.params.setupVariant, {
      applicationId: this.params.applicationId,
      pageId: this.livePageId,
      senderKey: this.params.senderKey,
    })
    // Give Target.targetCreated time to arrive and auto-select the inner page.
    await new Promise((r) => setTimeout(r, 700))
    this.capabilities.envelopeMode = this.wip.envelopeMode
  }

  private targetClosed = false
  private markTargetClosed(): void { this.targetClosed = true }
  get isClosed(): boolean { return this.targetClosed || this.wip.isDisposed }

  private onWipEvent(e: WipEvent): void {
    this.lastEventAt = new Date().toISOString()
    if (e.method === "Console.messageAdded" || e.method === "Log.entryAdded") {
      if (this.consoleOn) this.console.push({ at: this.lastEventAt, ...(e.params ?? {}) })
    } else if (e.method.startsWith("Network.")) {
      if (this.networkOn) this.network.push({ at: this.lastEventAt, method: e.method, ...redactNetworkParams(e.params) })
    } else if (e.method === "DOM.documentUpdated" || e.method === "Page.frameNavigated") {
      this.refs.newGeneration()
    }
  }

  // ── high-level verbs ─────────────────────────────────────────────────────────

  async enableDomain(domain: string): Promise<boolean> {
    try {
      await this.wip.request(`${domain}.enable`)
      this.ledger.markDomainEnabled(domain)
      return true
    } catch { return false }
  }

  async evaluate(expression: string, opts: { returnByValue?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    const res = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: opts.returnByValue ?? true,
      includeCommandLineAPI: false,
    }, { timeoutMs: opts.timeoutMs })
    return res
  }

  async call(method: string, params?: Record<string, unknown>, opts: { timeoutMs?: number; mutating?: boolean } = {}): Promise<unknown> {
    try {
      const r = await this.wip.request(method, params, opts)
      this.ledger.observeMethod(method, true)
      return r
    } catch (err) {
      this.ledger.observeMethod(method, false)
      throw err
    }
  }

  setConsole(on: boolean): void { this.consoleOn = on; if (!on) this.console.clear() }
  setNetwork(on: boolean): void { this.networkOn = on; if (!on) this.network.clear() }

  detach(reason = "detached"): void {
    try { this.transport.forwardDidClose(this.params.applicationId, this.livePageId, this.params.senderKey) } catch {}
    this.wip.dispose(reason)
    this.console.clear()
    this.network.clear()
    try { this.transport.close() } catch {}
    try { void this.params.release?.() } catch {}
  }
}

/** Redact a Network.* event's params (URL + headers) for high-level output. */
export function redactNetworkParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) return {}
  const out: Record<string, unknown> = { ...params }
  const req = out.request as { url?: string; headers?: Record<string, string> } | undefined
  if (req && typeof req === "object") {
    out.request = { ...req, url: redactUrl(req.url), headers: redactHeaders(req.headers) }
  }
  const resp = out.response as { url?: string; headers?: Record<string, string> } | undefined
  if (resp && typeof resp === "object") {
    out.response = { ...resp, url: redactUrl(resp.url), headers: redactHeaders(resp.headers) }
  }
  if (typeof out.documentURL === "string") out.documentURL = redactUrl(out.documentURL)
  // Response/request bodies are never surfaced here unless explicitly requested.
  return out
}

// ── target registry (iwt_ handles ↔ raw listings, per device) ─────────────────

type StoredTarget = { target: IosWebTarget; applicationId: string; rawListingKey: string }

class TargetRegistry {
  private byId = new Map<string, StoredTarget>()

  reset(): void { this.byId.clear() }

  register(applicationId: string, raw: RawWebTarget): IosWebTarget {
    const targetId = mintTargetId(randomBytes(8).toString("hex"))
    const target: IosWebTarget = {
      targetId,
      devicePageId: raw.devicePageId,
      type: raw.type,
      title: raw.title,
      url: raw.url,
      inspectable: raw.inspectable,
    }
    this.byId.set(targetId, { target, applicationId, rawListingKey: raw.rawListingKey })
    return target
  }

  get(targetId: string): StoredTarget | undefined { return this.byId.get(targetId) }
}

// ── the manager ───────────────────────────────────────────────────────────────

type DeviceState = {
  contextId: string
  udid: string
  targets: TargetRegistry
  sessions: Map<string, WebSession>
  defaultSessionId?: string
}

export type IosWebManagerDeps = {
  broker?: IosDeviceServiceBroker
  nativeLane?: NativeLane
  /** Injectable for tests; defaults to pure-usbmux discovery. */
  discover?: () => Promise<WebLaneDevice[]>
  /** Richer descriptors from the native IosManager, for UDID reconciliation. */
  managerDescriptors?: () => ManagerDescriptorLite[]
}

export class IosWebManager {
  private broker: IosDeviceServiceBroker
  private nativeLane?: NativeLane
  private devices = new Map<string, DeviceState>() // deviceContextId → state

  constructor(private deps: IosWebManagerDeps = {}) {
    this.broker = deps.broker ?? new IosDeviceServiceBroker()
    this.nativeLane = deps.nativeLane
  }

  /** Daemon entry point. `outerContextId` is the request's --on/--context value. */
  async handle(action: { type: string; [k: string]: unknown }, outerContextId?: string): Promise<IosWebResult> {
    try {
      // Session-scoped actions resolve their device from the session.
      if (IOS_WEB_SESSION_ACTION_TYPES.has(action.type)) {
        const session = this.resolveSession(action)
        if ("error" in session) return session.error
        return await this.handleSessionAction(action, session.device, session.session)
      }
      // Lifecycle actions resolve a device (no runner, no session required).
      const resolved = await this.resolveDevice(action, outerContextId)
      if ("error" in resolved) return resolved.error
      return await this.handleLifecycleAction(action, resolved.state)
    } catch (err) {
      return { success: false, error: `ios web ${action.type}: ${(err as Error).message}` }
    }
  }

  // ── device resolution ─────────────────────────────────────────────

  private async resolveDevice(
    action: { [k: string]: unknown },
    outerContextId?: string,
  ): Promise<{ state: DeviceState } | { error: IosWebResult }> {
    const explicit = firstString(action.device) ?? (isIosContextId(outerContextId) ? outerContextId : firstString(outerContextId))
    let udid = explicit ? resolveUdid(explicit) : undefined

    if (!udid) {
      // Sole discoverable paired device, else offer choices.
      const listed = await this.listDevices()
      const paired = listed.filter((d) => d.paired)
      if (paired.length === 1) udid = paired[0].udid
      else if (paired.length === 0) return { error: webError("device_not_found", "No paired iOS device found.") }
      else return { error: webError("device_not_found", "Multiple devices — pass --on <udid>.", { candidates: paired.map((d) => ({ udid: d.udid, name: d.name })) }) }
    }
    return { state: this.deviceState(udid) }
  }

  private resolveSession(
    action: { [k: string]: unknown },
  ): { device: DeviceState; session: WebSession } | { error: IosWebResult } {
    const sessionId = firstString(action.sessionId) ?? firstString(action.session)
    // Explicit device narrows the search; otherwise scan all devices.
    for (const state of this.devices.values()) {
      const wanted = sessionId ?? state.defaultSessionId
      if (!wanted) continue
      const session = state.sessions.get(wanted)
      if (session && !session.isClosed) return { device: state, session }
    }
    return { error: webError("session_not_found", sessionId ? `No live web session ${sessionId}.` : "No default web session — run 'ios web attach' first.") }
  }

  private deviceState(udid: string): DeviceState {
    const contextId = iosContextId(udid)
    let s = this.devices.get(contextId)
    if (!s) { s = { contextId, udid, targets: new TargetRegistry(), sessions: new Map() }; this.devices.set(contextId, s) }
    return s
  }

  private async listDevices(): Promise<WebLaneDevice[]> {
    const web = this.deps.discover ? await this.deps.discover() : await discoverWebLaneDevices()
    const mgr = this.deps.managerDescriptors?.() ?? []
    return reconcileByUdid(web, mgr)
  }

  // ── lifecycle actions ────────────────────────────────────────────────────────

  private async handleLifecycleAction(action: { type: string; [k: string]: unknown }, state: DeviceState): Promise<IosWebResult> {
    switch (action.type) {
      case "ios_web_targets": return this.targets(state)
      case "ios_web_attach": return this.attach(state, firstString(action.targetId) ?? firstString(action.target), action.replace === true)
      case "ios_web_status": return this.status(state, firstString(action.sessionId) ?? firstString(action.session))
      case "ios_web_explain": return this.explain(state)
      case "ios_web_screenshot": return this.screenshot(state, numOrUndef(action.targetMaxLongEdge))
      default: return { success: false, error: `unhandled web lifecycle action: ${action.type}` }
    }
  }

  private async handleSessionAction(action: { type: string; [k: string]: unknown }, device: DeviceState, session: WebSession): Promise<IosWebResult> {
    switch (action.type) {
      case "ios_web_detach": return this.detach(device, session)
      case "ios_web_eval": return this.evalVerb(session, firstString(action.expression) ?? "", numOrUndef(action.timeout))
      case "ios_web_call": return this.callVerb(session, firstString(action.method) ?? "", action.params as Record<string, unknown> | undefined, numOrUndef(action.timeout), action.mutating === true)
      case "ios_web_read": return this.readVerb(session)
      case "ios_web_text": return this.textVerb(session)
      case "ios_web_find": return this.findVerb(session, firstString(action.query) ?? "", firstString(action.role))
      case "ios_web_inspect": return this.inspectVerb(session, firstString(action.ref) ?? "")
      case "ios_web_click": return this.domActionVerb(device, session, "click", action)
      case "ios_web_type": return this.domActionVerb(device, session, "type", action)
      case "ios_web_keys": return this.domActionVerb(device, session, "keys", action)
      case "ios_web_scroll": return this.domActionVerb(device, session, "scroll", action)
      case "ios_web_calibrate": return this.calibrateVerb(device, session)
      case "ios_web_console": return this.consoleVerb(session, firstString(action.operation) ?? "log")
      case "ios_web_network": return this.networkVerb(session, firstString(action.operation) ?? "log")
      default: return { success: false, error: `unhandled web session action: ${action.type}` }
    }
  }

  // ── targets / attach / detach / status / explain ─────────────────────────────

  private async targets(state: DeviceState): Promise<IosWebResult> {
    const disco = await this.openDiscovery(state)
    if ("error" in disco) return disco.error
    try {
      const apps = await disco.discover()
      return { success: true, data: { deviceContextId: state.contextId, transport: disco.transport, applications: apps } }
    } finally {
      disco.close()
    }
  }

  private async attach(state: DeviceState, targetId: string | undefined, replace: boolean): Promise<IosWebResult> {
    if (!targetId) return webError("bad_request", "ios web attach requires a target id (from 'ios web targets').")
    const stored = state.targets.get(targetId)
    if (!stored) return webError("target_not_exposed", `Unknown target ${targetId} — re-run 'ios web targets'.`)

    // Single-debugger lease.
    const live = [...state.sessions.values()].find((s) => !s.isClosed && s.params.target.targetId === targetId)
    if (live && !replace) return webError("target_busy", `Target ${targetId} already has a local session ${live.params.sessionId}.`, { session: live.params.sessionId })
    if (live && replace) { live.detach("replaced"); state.sessions.delete(live.params.sessionId) }

    const opened = await this.openWirChannel(state.udid)
    if ("error" in opened) return opened.error

    const sessionId = mintSessionId(randomBytes(8).toString("hex"))
    const senderKey = randomUUID().toUpperCase()
    const connectionId = randomUUID().toUpperCase()
    const variant = setupVariantCandidates(stored.target.devicePageId)[0]

    const session = new WebSession(opened.channel, {
      sessionId, deviceContextId: state.contextId, udid: state.udid,
      applicationId: stored.applicationId, target: stored.target, rawListingKey: stored.rawListingKey,
      connectionId, senderKey, transportKind: opened.transport, setupVariant: variant,
      release: opened.release,
    })
    session.capabilities.nativeLane = this.nativeLane?.isAvailable(state.contextId) ?? false
    session.capabilities.screenshot = session.capabilities.nativeLane ? "native-runner" : "unavailable"
    state.sessions.set(sessionId, session)
    state.defaultSessionId = sessionId

    // Live attach handshake (announce → refresh listing → socket-setup → Target
    // auto-promote). Populates envelope mode + capabilities.
    try {
      await session.performAttach()
    } catch { /* surfaced by the first verb otherwise */ }

    return {
      success: true,
      data: {
        deviceContextId: state.contextId,
        sessionId,
        target: stored.target,
        capabilities: session.capabilities,
      },
    }
  }

  private detach(device: DeviceState, session: WebSession): IosWebResult {
    session.detach("user detach")
    device.sessions.delete(session.params.sessionId)
    if (device.defaultSessionId === session.params.sessionId) device.defaultSessionId = undefined
    return { success: true, data: { deviceContextId: device.contextId, sessionId: session.params.sessionId, detached: true } }
  }

  private status(state: DeviceState, sessionId?: string): IosWebResult {
    const id = sessionId ?? state.defaultSessionId
    const session = id ? state.sessions.get(id) : undefined
    const nativeLaneAvailable = this.nativeLane?.isAvailable(state.contextId) ?? false
    if (!session) {
      return { success: true, data: { deviceContextId: state.contextId, session: null, nativeLaneAvailable } }
    }
    return {
      success: true,
      data: {
        deviceContextId: state.contextId,
        sessionId: session.params.sessionId,
        target: session.params.target,
        transport: session.params.transportKind,
        setupVariant: session.params.setupVariant,
        envelopeMode: session.wip.envelopeMode,
        capabilities: session.capabilities,
        attachedAt: session.attachedAt,
        lastEventAt: session.lastEventAt ?? null,
        documentGeneration: session.refs.currentGeneration,
        inFlight: session.wip.inFlight,
        nativeLaneAvailable,
        closed: session.isClosed,
      },
    }
  }

  private async explain(state: DeviceState): Promise<IosWebResult> {
    // Read-only checks, in order.
    const checks: Array<{ step: string; ok: boolean; detail?: string }> = []
    const listed = await this.listDevices().catch(() => [])
    const dev = listed.find((d) => iosUdidSlug(d.udid) === iosUdidSlug(state.udid))
    checks.push({ step: "device_discovery", ok: !!dev, detail: dev ? `${dev.name ?? dev.udid}` : "not visible to usbmux" })
    checks.push({ step: "pair_record", ok: !!dev?.paired, detail: dev?.paired ? "paired" : "no pair record — accept Trust This Computer" })
    // The device exposes no reliably-queryable Web Inspector flag, so an empty
    // target list must NOT be diagnosed as the setting being off.
    checks.push({ step: "web_inspector_setting", ok: true, detail: "not directly queryable; an empty target list is not proof the setting is off" })
    const nativeLaneAvailable = this.nativeLane?.isAvailable(state.contextId) ?? false
    checks.push({ step: "native_runner", ok: nativeLaneAvailable, detail: nativeLaneAvailable ? "connected" : "not connected — web lane still eligible" })
    return {
      success: true,
      data: {
        deviceContextId: state.contextId,
        checks,
        distinctions: {
          developerMode: "off ⇒ web lane still attempted; native lane unavailable",
          webInspector: "off ⇒ web lane unavailable; native lane independently eligible",
          appOptIn: "a single app absent while Safari targets present is app opt-in, not device-wide failure",
          noActiveTarget: "an empty list may just mean no page/worker is currently alive",
        },
      },
    }
  }

  // ── semantic verbs ────────────────────────────────────────────────────────────

  private async evalVerb(session: WebSession, expression: string, timeout?: number): Promise<IosWebResult> {
    if (!expression) return webError("bad_request", "ios web eval requires an expression.")
    try {
      const result = await session.evaluate(expression, { timeoutMs: timeout })
      return { success: true, data: { sessionId: session.params.sessionId, result } }
    } catch (err) { return this.wipErr(err) }
  }

  private async callVerb(session: WebSession, method: string, params: Record<string, unknown> | undefined, timeout?: number, mutating?: boolean): Promise<IosWebResult> {
    if (!method || method.indexOf(".") <= 0) return webError("bad_request", "ios web call requires a Domain.method.")
    try {
      const start = Date.now()
      const result = await session.call(method, params, { timeoutMs: timeout, mutating })
      return { success: true, data: { sessionId: session.params.sessionId, method, durationMs: Date.now() - start, mutating: !!mutating, result } }
    } catch (err) { return this.wipErr(err) }
  }

  private async readVerb(session: WebSession): Promise<IosWebResult> {
    try {
      await session.enableDomain("Runtime")
      const evalRes = await session.evaluate(`${WEB_DOM_SERIALIZER_JS}(5000, 64)`, { returnByValue: true })
      const payload = extractRuntimeValue(evalRes)
      if (!payload || !Array.isArray((payload as { nodes?: unknown }).nodes)) return webError("dom_unavailable")
      const p = payload as { nodes: SerializedNode[]; truncated: boolean; title?: string; url?: string }
      const tree = renderWebTree(p.nodes, session.refs)
      return { success: true, data: { sessionId: session.params.sessionId, title: p.title, url: redactUrl(p.url), truncated: p.truncated, generation: session.refs.currentGeneration, tree } }
    } catch (err) { return this.wipErr(err) }
  }

  private async textVerb(session: WebSession): Promise<IosWebResult> {
    try {
      const res = await session.evaluate(`(document.body ? document.body.innerText : "")`, { returnByValue: true })
      return { success: true, data: { sessionId: session.params.sessionId, text: String(extractRuntimeValue(res) ?? "") } }
    } catch (err) { return this.wipErr(err) }
  }

  private async findVerb(session: WebSession, query: string, role?: string): Promise<IosWebResult> {
    if (!query) return webError("bad_request", "ios web find requires a query.")
    try {
      const js = `${WEB_DOM_SERIALIZER_JS}(5000, 64)`
      const res = await session.evaluate(js, { returnByValue: true })
      const payload = extractRuntimeValue(res) as { nodes?: SerializedNode[] } | undefined
      const nodes = (payload?.nodes ?? []).filter((n) => {
        const hay = `${n.role ?? ""} ${n.name ?? ""} ${n.text ?? ""}`.toLowerCase()
        return hay.includes(query.toLowerCase()) && (!role || (n.role ?? n.tag) === role)
      })
      const matches = nodes.slice(0, 50).map((n) => ({
        ref: session.refs.mint({ kind: "runtime", selector: n.selector, fingerprint: fingerprintNode(n) }),
        role: n.role || n.tag, name: n.name, text: n.text, box: n.box,
      }))
      return { success: true, data: { sessionId: session.params.sessionId, generation: session.refs.currentGeneration, matches } }
    } catch (err) { return this.wipErr(err) }
  }

  private async inspectVerb(session: WebSession, ref: string): Promise<IosWebResult> {
    if (isNativeRef(ref)) return webError("invalid_web_ref", "That is a native 'eN' ref; use 'ios inspect' for native.")
    const rec = session.refs.resolve(ref)
    if (!rec) return webError("invalid_web_ref", `Unknown web ref ${ref}.`)
    if ("stale" in rec) return webError("stale_web_ref")
    try {
      const selector = JSON.stringify(rec.selector ?? "")
      const js = `(function(){var el=document.querySelector(${selector});if(!el)return null;var r=el.getBoundingClientRect();var s=window.getComputedStyle(el);return {tag:el.tagName.toLowerCase(),attributes:Array.from(el.attributes).reduce(function(a,x){a[x.name]=x.value;return a},{}),box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},styles:{display:s.display,color:s.color,fontSize:s.fontSize},text:(el.innerText||"").slice(0,200)}})()`
      const res = await session.evaluate(js, { returnByValue: true })
      const node = extractRuntimeValue(res)
      if (!node) return webError("stale_web_ref", "The referenced element is no longer in the document.")
      return { success: true, data: { sessionId: session.params.sessionId, ref, node } }
    } catch (err) { return this.wipErr(err) }
  }

  private async domActionVerb(device: DeviceState, session: WebSession, kind: "click" | "type" | "keys" | "scroll", action: { [k: string]: unknown }): Promise<IosWebResult> {
    const requested = (firstString(action.mode) as IosWebActionMode) ?? "dom"
    const nativeLaneAvailable = this.nativeLane?.isAvailable(device.contextId) ?? false
    const decision = decideActionMode(requested === "auto" || requested === "native" ? requested : "dom", {
      nativeLaneAvailable,
      calibrated: session.capabilities.nativeMappingCalibrated,
    })
    if (decision.error) return { ...decision.error, data: { ...(decision.error.data as object), mode: decision.report } }

    if (decision.report.modeUsed === "native") {
      const native = await this.runNativeAction(device, session, kind, action)
      return { ...native, data: mergeMode(native.data, decision.report) }
    }

    // DOM mode — synthetic, trustedInput:false.
    const ref = firstString(action.ref)
    try {
      let result: unknown = null
      if (kind === "click") {
        const rec = this.requireRef(session, ref)
        if ("error" in rec) return rec.error
        result = await session.evaluate(`(function(){var el=document.querySelector(${JSON.stringify(rec.selector)});if(!el)return "no_element";el.click();return "clicked"})()`, { returnByValue: true })
      } else if (kind === "type") {
        const rec = this.requireRef(session, ref)
        if ("error" in rec) return rec.error
        const text = firstString(action.text) ?? ""
        result = await session.evaluate(`(function(){var el=document.querySelector(${JSON.stringify(rec.selector)});if(!el)return "no_element";el.focus();var set=Object.getOwnPropertyDescriptor(el.__proto__,"value");if(set&&set.set)set.set.call(el,${JSON.stringify(text)});else el.value=${JSON.stringify(text)};el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return "typed"})()`, { returnByValue: true })
      } else if (kind === "keys") {
        const text = firstString(action.text) ?? firstString(action.keys) ?? ""
        result = await session.evaluate(`(function(){var el=document.activeElement||document.body;var t=${JSON.stringify(text)};for(var i=0;i<t.length;i++){var k=t[i];["keydown","keypress","input","keyup"].forEach(function(type){el.dispatchEvent(new KeyboardEvent(type,{key:k,bubbles:true}))})}return "keys"})()`, { returnByValue: true })
      } else {
        const dx = numOrUndef(action.dx) ?? 0, dy = numOrUndef(action.dy) ?? 0
        result = await session.evaluate(`(function(){window.scrollBy(${dx},${dy});return "scrolled"})()`, { returnByValue: true })
      }
      return { success: true, data: { sessionId: session.params.sessionId, mode: decision.report, result: extractRuntimeValue(result) } }
    } catch (err) { return this.wipErr(err) }
  }

  private requireRef(session: WebSession, ref: string | undefined): { selector: string } | { error: IosWebResult } {
    if (!ref) return { error: webError("bad_request", "this action requires a web ref (from 'ios web read'/'find').") }
    if (isNativeRef(ref)) return { error: webError("invalid_web_ref", "native 'eN' refs cannot address web nodes.") }
    const rec = session.refs.resolve(ref)
    if (!rec) return { error: webError("invalid_web_ref", `unknown web ref ${ref}.`) }
    if ("stale" in rec) return { error: webError("stale_web_ref") }
    return { selector: rec.selector ?? "" }
  }

  private async runNativeAction(device: DeviceState, _session: WebSession, kind: string, action: { [k: string]: unknown }): Promise<IosWebResult> {
    if (!this.nativeLane) return webError("native_lane_unavailable")
    // Native mapping (DOM box → device point) requires a passing calibration.
    // Guarded by decideActionMode(calibrated) already; a full mapping impl is
    // Phase 4 device-gated. Delegate simple native input where a point is given.
    const x = numOrUndef(action.x), y = numOrUndef(action.y)
    if (kind === "click" && x !== undefined && y !== undefined) return this.nativeLane.tap(device.contextId, x, y)
    if (kind === "type") return this.nativeLane.type(device.contextId, firstString(action.text) ?? "")
    if (kind === "keys") return this.nativeLane.keys(device.contextId, firstString(action.text) ?? firstString(action.keys) ?? "")
    return webError("native_mapping_unavailable", "native mapping from a DOM ref needs calibration (Gate G4).")
  }

  private async calibrateVerb(device: DeviceState, _session: WebSession): Promise<IosWebResult> {
    if (!this.nativeLane?.isAvailable(device.contextId)) return webError("native_lane_unavailable")
    // Full multi-point calibration is device-gated (Gate G4). Report status.
    return webError("native_mapping_unavailable", "calibration requires a live device + fixture page (Gate G4).", { gate: "G4" })
  }

  private consoleVerb(session: WebSession, operation: string): IosWebResult | Promise<IosWebResult> {
    if (operation === "start") { session.setConsole(true); return this.enableAnd(session, ["Console", "Log"], { started: true }) }
    if (operation === "stop") { session.setConsole(false); return { success: true, data: { sessionId: session.params.sessionId, stopped: true } } }
    const drained = session.console.drain()
    return { success: true, data: { sessionId: session.params.sessionId, events: drained.events, dropped: drained.dropped, retainedFrom: drained.retainedFrom, ...(drained.dropped > 0 ? { code: "buffer_overflow" } : {}) } }
  }

  private networkVerb(session: WebSession, operation: string): IosWebResult | Promise<IosWebResult> {
    if (operation === "start") { session.setNetwork(true); return this.enableAnd(session, ["Network"], { started: true }) }
    if (operation === "stop") { session.setNetwork(false); return { success: true, data: { sessionId: session.params.sessionId, stopped: true } } }
    const drained = session.network.drain()
    return { success: true, data: { sessionId: session.params.sessionId, events: drained.events, dropped: drained.dropped, retainedFrom: drained.retainedFrom, redacted: true, ...(drained.dropped > 0 ? { code: "buffer_overflow" } : {}) } }
  }

  private async enableAnd(session: WebSession, domains: string[], extra: Record<string, unknown>): Promise<IosWebResult> {
    let anyOk = false
    for (const d of domains) anyOk = (await session.enableDomain(d)) || anyOk
    return { success: true, data: { sessionId: session.params.sessionId, enabled: anyOk, ...extra } }
  }

  // ── native-lane screenshot ────────────────────────────────────────────────────

  private async screenshot(state: DeviceState, targetMaxLongEdge?: number): Promise<IosWebResult> {
    if (!this.nativeLane?.isAvailable(state.contextId)) return webError("native_lane_unavailable", "ios web screenshot uses the XCUITest runner; it is not connected.")
    return this.nativeLane.screenshot(state.contextId, targetMaxLongEdge)
  }

  // ── device-service + WIR plumbing (device-gated) ──────────────────────────────

  /**
   * Open a WIR byte channel to the device's Web Inspector service.
   *
   * Transport selection is EVIDENCE-BASED, not an OS-major hard-code. The classic
   * lockdown `com.apple.webinspector` service (usbmux + TLS) is tried FIRST because
   * live G0 on iOS 27 proved it works and returns full listings, while the RemoteXPC
   * `…shim.remote` path regressed (the device drops the per-service connection). The
   * shim remains a fallback for devices/OS builds where classic is unavailable.
   */
  private async openWirChannel(udid: string): Promise<{ channel: DeviceByteChannel; transport: WirTransport; release: () => Promise<void> } | { error: IosWebResult }> {
    try {
      const { sock } = await connectServiceSocket(udid, WEBINSPECTOR_CLASSIC_SERVICE)
      return { channel: adaptNetSocket(sock), transport: "classic-lockdown", release: async () => { try { sock.destroy() } catch {} } }
    } catch (classicErr) {
      const msg = (classicErr as Error).message
      if (/not paired|Trust This Computer/i.test(msg)) return { error: webError("device_unpaired") }
      // RemoteXPC shim fallback.
      try {
        const session = await this.broker.sessionFor(udid)
        session.retain("web")
        if (!session.services.has(WEBINSPECTOR_SHIM_SERVICE)) {
          await session.release("web")
          return { error: webError("webinspector_service_unavailable", "classic webinspector failed and no shim service present", { classic: msg }) }
        }
        const channel = await session.open(WEBINSPECTOR_SHIM_SERVICE)
        return { channel, transport: "rsd-shim", release: async () => { await session.release("web") } }
      } catch (shimErr) {
        if ((shimErr as { code?: string }).code === "device_unpaired") return { error: webError("device_unpaired") }
        return { error: webError("webinspector_service_unavailable", `classic: ${msg}; shim: ${(shimErr as Error).message}`) }
      }
    }
  }

  /** Open a short-lived discovery connection: reportIdentifier → gather listings. */
  private async openDiscovery(state: DeviceState): Promise<
    { discover: () => Promise<IosWebApplication[]>; transport: WirTransport; close: () => void } | { error: IosWebResult }
  > {
    const opened = await this.openWirChannel(state.udid)
    if ("error" in opened) return opened

    state.targets.reset()
    const apps = new Map<string, ParsedApplication>()
    const listings = new Map<string, RawWebTarget[]>()
    const transport = new WebInspectorTransport(opened.channel, randomUUID().toUpperCase(), {
      onApplicationList: (list) => { for (const a of list) if (a.applicationId) apps.set(a.applicationId, a) },
      onApplicationConnected: (a) => { if (a.applicationId) apps.set(a.applicationId, a) },
      onListing: (p) => { if (p.applicationId) listings.set(p.applicationId, p.targets) },
    })

    const discover = async (): Promise<IosWebApplication[]> => {
      transport.reportIdentifier()
      transport.getConnectedApplications()
      await delay(400)
      for (const appId of apps.keys()) transport.forwardGetListing(appId)
      await delay(500)
      const out: IosWebApplication[] = []
      for (const [appId, app] of apps) {
        const raw = listings.get(appId) ?? []
        const targets: IosWebTarget[] = raw.map((r) => state.targets.register(appId, r))
        out.push({ applicationId: appId, bundleId: app.bundleId, name: app.name, active: app.active, proxy: app.proxy, targets })
      }
      return out
    }

    return {
      discover,
      transport: opened.transport,
      close: () => { try { transport.close() } catch {}; void opened.release() },
    }
  }

  // ── error mapping ─────────────────────────────────────────────────────────────

  private wipErr(err: unknown): IosWebResult {
    const code = (err as { code?: string }).code
    if (code === "wip_timeout") return webError("wip_timeout", (err as Error).message)
    if (code === "wip_method_unavailable") return webError("wip_method_unavailable", (err as Error).message)
    if (code === "wip_detached") return webError("target_closed", (err as Error).message)
    return webError("bad_request", (err as Error).message)
  }

  /** Release device-service sessions + close web sessions on device removal. */
  async closeDevice(udid: string, reason: string): Promise<void> {
    const state = this.devices.get(iosContextId(udid))
    if (state) {
      for (const s of state.sessions.values()) s.detach(reason)
      state.sessions.clear()
      this.devices.delete(state.contextId)
    }
    await this.broker.closeDevice(udid, reason)
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function firstString(v: unknown): string | undefined { return typeof v === "string" && v.length ? v : undefined }
function numOrUndef(v: unknown): number | undefined { const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN; return Number.isFinite(n) ? n : undefined }
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
function mergeMode(data: unknown, report: IosWebActionModeReport): unknown {
  return typeof data === "object" && data !== null ? { ...(data as object), mode: report } : { mode: report, result: data }
}

/** Pull a returnByValue result out of a WIP Runtime.evaluate response. */
export function extractRuntimeValue(res: unknown): unknown {
  if (res && typeof res === "object" && "result" in (res as Record<string, unknown>)) {
    const inner = (res as { result?: { value?: unknown; type?: string } }).result
    if (inner && typeof inner === "object" && "value" in inner) return (inner as { value?: unknown }).value
    return inner
  }
  return res
}
