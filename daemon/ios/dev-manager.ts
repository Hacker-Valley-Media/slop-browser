/**
 * daemon/ios/dev-manager.ts — IosDevServiceManager.
 *
 * Dispatches the runner-free ios_dev_* actions (Instruments/DTX,
 * screenshotr, backup, screen, AX-audit), resolves the device, normalizes
 * envelopes + stable errors, and owns streaming lifecycle (top/gpu/screen)
 * as bounded buffers with start|read|stop. Sibling of IosDeviceServiceManager /
 * IosWebManager; never touches the XCUITest runner.
 */

import {
  devError, classifyDevError, type IosDevResult,
} from "../../shared/ios-dev"
import { iosContextId, iosUdidSlug, isIosContextId } from "../../shared/ios-device"
import { discoverWebLaneDevices, reconcileByUdid, type WebLaneDevice, type ManagerDescriptorLite } from "./device-services"
import { BoundedBuffer } from "./service-plist"
import type { BufferedItem } from "./service-plist"
import { InstrumentsClient } from "./instruments"
import { captureScreenshot } from "./screenshotr"
import { backupInfo } from "./backup"
import { axAuditProbe } from "./axaudit"
import { resizePngToBudget } from "./tools"
import { resolveUdid as resolveSavedUdid } from "./state"

/** Re-encode/shrink a screenshot PNG so it fits the daemon↔CLI socket (a raw
 *  9 MB PNG stalls it; the native screenshot verb budgets the same way). */
function budgetImage(png: Buffer, maxLongEdge: number): { format: string; bytes: number; base64: string } {
  const { dataUrl, format } = resizePngToBudget(png.toString("base64"), maxLongEdge)
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
  return { format, bytes: Buffer.from(b64, "base64").length, base64: b64 }
}

export type IosDevServiceManagerDeps = {
  discover?: () => Promise<WebLaneDevice[]>
  managerDescriptors?: () => ManagerDescriptorLite[]
  /** Drive the on-device XCUITest runner (screenshot fallback + live screen). */
  runnerVerb?: (contextId: string, action: { type: string; [k: string]: unknown }) => Promise<{ success: boolean; data?: unknown; error?: string }>
}

type ActiveStream = { buffer: BoundedBuffer<BufferedItem>; close: () => void; isClosed: () => boolean }

export class IosDevServiceManager {
  /** keyed by `${deviceContextId}:${kind}` (kind = top | gpu | screen) */
  private streams = new Map<string, ActiveStream>()

  constructor(private deps: IosDevServiceManagerDeps = {}) {}

  async handle(action: { type: string; [k: string]: unknown }, outerContextId?: string): Promise<IosDevResult> {
    const resolved = await this.resolveUdid(action, outerContextId)
    if ("error" in resolved) return resolved.error
    const { udid, contextId } = resolved
    try {
      switch (action.type) {
        case "ios_proc": return await this.proc(udid, contextId)
        case "ios_spawn": return await this.spawn(udid, contextId, action)
        case "ios_kill": return await this.killProc(udid, contextId, action)
        case "ios_location": return await this.location(udid, contextId, action)
        case "ios_top": return await this.instrStream(udid, contextId, "top", action)
        case "ios_gpu": return await this.instrStream(udid, contextId, "gpu", action)
        case "ios_shot": return await this.shot(udid, contextId)
        case "ios_backup": return await this.backup(udid, contextId)
        case "ios_screen": return await this.screen(udid, contextId, action)
        case "ios_axtree": return await this.axtree(udid, contextId)
        default: return { success: false, error: `unhandled dev action: ${action.type}` }
      }
    } catch (err) {
      return devError(classifyDevError(err), (err as Error).message, { deviceContextId: contextId })
    }
  }

  // ── device resolution (mirrors service-manager) ───────────────────────────────

  private async resolveUdid(
    action: { [k: string]: unknown }, outerContextId?: string,
  ): Promise<{ udid: string; contextId: string } | { error: IosDevResult }> {
    const explicit = firstString(action.device) ?? (isIosContextId(outerContextId) ? outerContextId : firstString(outerContextId))
    let udid = explicit ? resolveSavedUdid(explicit) : undefined
    if (!udid) {
      const listed = await this.listDevices().catch(() => [])
      const paired = listed.filter((d) => d.paired)
      if (paired.length === 1) udid = paired[0].udid
      else if (paired.length === 0) return { error: devError("device_not_found", "No paired iOS device found.") }
      else return { error: devError("device_not_found", "Multiple devices — pass --on <udid>.", { candidates: paired.map((d) => ({ udid: d.udid, name: d.name })) }) }
    }
    return { udid, contextId: iosContextId(udid) }
  }

  private async listDevices(): Promise<WebLaneDevice[]> {
    const web = this.deps.discover ? await this.deps.discover() : await discoverWebLaneDevices()
    return reconcileByUdid(web, this.deps.managerDescriptors?.() ?? [])
  }

  // ── Instruments one-shots ─────────────────────────────────────────────────────

  private async proc(udid: string, contextId: string): Promise<IosDevResult> {
    const inst = await InstrumentsClient.open(udid)
    try {
      const processes = await inst.runningProcesses()
      return { success: true, data: { deviceContextId: contextId, count: processes.length, processes } }
    } finally { inst.close() }
  }

  private async spawn(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosDevResult> {
    const bundleId = firstString(action.bundle) ?? firstString(action.bundleId)
    if (!bundleId) return devError("bad_request", "ios spawn requires a bundle id.")
    const env = isStringRecord(action.env) ? action.env : undefined
    const args = Array.isArray(action.args) ? (action.args as unknown[]).filter((a): a is string => typeof a === "string") : undefined
    const inst = await InstrumentsClient.open(udid)
    try {
      const pid = await inst.launch(bundleId, { env, args, suspended: action.suspended === true })
      return { success: true, data: { deviceContextId: contextId, bundleId, pid } }
    } finally { inst.close() }
  }

  private async killProc(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosDevResult> {
    const pid = typeof action.pid === "number" ? action.pid : Number(firstString(action.pid))
    if (!pid || Number.isNaN(pid)) return devError("bad_request", "ios kill requires a numeric pid.")
    const inst = await InstrumentsClient.open(udid)
    try { await inst.kill(pid); return { success: true, data: { deviceContextId: contextId, killed: pid } } }
    finally { inst.close() }
  }

  private async location(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosDevResult> {
    const op = firstString(action.op) ?? "set"
    const inst = await InstrumentsClient.open(udid)
    try {
      if (op === "clear") { await inst.clearLocation(); return { success: true, data: { deviceContextId: contextId, cleared: true } } }
      const lat = typeof action.lat === "number" ? action.lat : Number(firstString(action.lat))
      const lon = typeof action.lon === "number" ? action.lon : Number(firstString(action.lon))
      if (Number.isNaN(lat) || Number.isNaN(lon)) return devError("bad_request", "ios location set requires --lat and --lon.")
      await inst.setLocation(lat, lon)
      return { success: true, data: { deviceContextId: contextId, lat, lon, set: true } }
    } finally { inst.close() }
  }

  // ── Instruments streams (top / gpu) ───────────────────────────────────────────

  private async instrStream(udid: string, contextId: string, kind: "top" | "gpu", action: { [k: string]: unknown }): Promise<IosDevResult> {
    const op = firstString(action.operation) ?? "read"
    const key = `${contextId}:${kind}`
    if (op === "start") {
      this.streams.get(key)?.close()
      const buffer = new BoundedBuffer<BufferedItem>()
      const inst = await InstrumentsClient.open(udid)
      const onSample = (s: unknown) => buffer.push({ at: new Date().toISOString(), sample: s })
      let stop: () => void
      try {
        stop = kind === "top" ? await inst.startSysmontap(onSample) : await inst.startGraphics(onSample)
      } catch (e) { inst.close(); throw e }
      this.streams.set(key, { buffer, close: () => { try { stop() } catch {}; inst.close() }, isClosed: () => false })
      return { success: true, data: { deviceContextId: contextId, started: true, kind } }
    }
    if (op === "stop") { this.streams.get(key)?.close(); this.streams.delete(key); return { success: true, data: { deviceContextId: contextId, stopped: true } } }
    const stream = this.streams.get(key)
    if (!stream) return devError("stream_not_found", `No ${kind} stream — run start first.`)
    const drained = stream.buffer.drain(); stream.buffer.clear()
    return { success: true, data: { deviceContextId: contextId, ...drainEnv(drained),...(drained.dropped > 0 ? { code: "buffer_overflow" } : {}) } }
  }


  // ── one-shots: shot / backup / screen / axtree ────────────────────────────────

  private async shot(udid: string, contextId: string): Promise<IosDevResult> {
    // Primary: the Instruments dtservicehub screenshot service — runner-free and
    // reliable (~700ms), same proven transport as `proc`/`top`. Fall back to the
    // on-device runner, then screenshotr, only if Instruments is unavailable.
    try {
      const inst = await InstrumentsClient.open(udid)
      try {
        const png = await inst.screenshot()
        return { success: true, data: { deviceContextId: contextId, ...budgetImage(png, 2200), source: "instruments" } }
      } finally { inst.close() }
    } catch {
      const frame = await this.runnerShot(contextId).catch(() => null)
      if (frame) return { success: true, data: { deviceContextId: contextId, ...frame, source: "runner" } }
      const png = await captureScreenshot(udid)
      return { success: true, data: { deviceContextId: contextId, format: "png", bytes: png.length, base64: png.toString("base64"), source: "screenshotr" } }
    }
  }

  /** Capture one frame via the on-device runner (XCUIScreen). Returns null if no runner dep. */
  private async runnerShot(contextId: string): Promise<{ format: string; bytes: number; base64: string } | null> {
    if (!this.deps.runnerVerb) return null
    const r = await this.deps.runnerVerb(contextId, { type: "ios_screenshot" })
    const dataUrl = (r?.data as { dataUrl?: string } | undefined)?.dataUrl
    const m = typeof dataUrl === "string" ? dataUrl.match(/^data:(image\/\w+);base64,(.*)$/s) : null
    if (!m) return null
    const buf = Buffer.from(m[2], "base64")
    return { format: m[1].split("/")[1], bytes: buf.length, base64: buf.toString("base64") }
  }

  private async backup(udid: string, contextId: string): Promise<IosDevResult> {
    const info = await backupInfo(udid)
    return { success: true, data: { deviceContextId: contextId, ...info } }
  }

  /** Live screen as a poll-based frame stream via the Instruments screenshot
   *  service (runner-free, ~700ms/frame). No USB / CoreMediaIO. start|read|stop. */
  private async screen(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosDevResult> {
    const op = firstString(action.operation) ?? "read"
    const key = `${contextId}:screen`
    if (op === "start") {
      this.streams.get(key)?.close()
      const fps = Math.min(3, Math.max(1, Number(action.fps) || 1))
      const buffer = new BoundedBuffer<BufferedItem>(Math.min(60, Number(action.max) || 15), 256 * 1024 * 1024)
      let inst: InstrumentsClient
      try { inst = await InstrumentsClient.open(udid) }
      catch (e) { return devError(classifyDevError(e), `live screen needs the Instruments screenshot service: ${(e as Error).message}`, { deviceContextId: contextId }) }
      let running = true, capturing = false
      const tick = async () => {
        if (!running || capturing) return
        capturing = true
        try { const png = await inst.screenshot(); if (running) buffer.push({ at: new Date().toISOString(), ...budgetImage(png, 1200) }) }
        catch { /* drop a bad frame */ }
        finally { capturing = false }
      }
      const timer = setInterval(() => { void tick() }, Math.round(1000 / fps))
      void tick()
      this.streams.set(key, { buffer, close: () => { running = false; clearInterval(timer); inst.close() }, isClosed: () => !running })
      return { success: true, data: { deviceContextId: contextId, started: true, fps, source: "instruments" } }
    }
    if (op === "stop") { this.streams.get(key)?.close(); this.streams.delete(key); return { success: true, data: { deviceContextId: contextId, stopped: true } } }
    const stream = this.streams.get(key)
    if (!stream) return devError("stream_not_found", "No screen stream — run start first.")
    const drained = stream.buffer.drain(); stream.buffer.clear()
    return { success: true, data: { deviceContextId: contextId, ...drainEnv(drained),...(drained.dropped > 0 ? { code: "buffer_overflow" } : {}) } }
  }

  private async axtree(udid: string, contextId: string): Promise<IosDevResult> {
    const probe = await axAuditProbe(udid)
    return { success: probe.reachable, data: { deviceContextId: contextId, ...probe } }
  }

  /** Close streams for a device (device removal / shutdown). */
  closeDevice(udid: string): void {
    const slug = iosUdidSlug(udid)
    for (const [k, s] of this.streams) {
      if (k.startsWith(`ios:${slug}:`)) { try { s.close() } catch {}; this.streams.delete(k) }
    }
  }
}

/** Map a bounded-buffer drain to the CLI's `{events,dropped}` envelope. */
function drainEnv(d: { items: unknown[]; dropped: number; retainedFrom?: string }): { events: unknown[]; dropped: number; retainedFrom?: string } {
  return { events: d.items, dropped: d.dropped, ...(d.retainedFrom ? { retainedFrom: d.retainedFrom } : {}) }
}

function firstString(v: unknown): string | undefined { return typeof v === "string" && v.length ? v : undefined }
function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")
}
