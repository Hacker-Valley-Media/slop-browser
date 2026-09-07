/**
 * daemon/ios/service-manager.ts — IosDeviceServiceManager.
 *
 * Dispatches the runner-free ios_svc_* actions to the classic-Lockdown service
 * clients, resolves the device, normalizes envelopes + stable errors, and owns
 * the lifecycle of streaming services (syslog / notifications) as bounded
 * buffers with start|read|stop. Sibling of IosWebManager; never touches the
 * runner or IosDeviceChannel.
 */

import {
  IOS_SVC_STREAM_ACTION_TYPES, svcError, classifyServiceError,
  type IosSvcResult, type DiagKind, type FsOp,
} from "../../shared/ios-service"
import { iosContextId, iosUdidSlug, isIosContextId } from "../../shared/ios-device"
import { discoverWebLaneDevices, reconcileByUdid, type WebLaneDevice, type ManagerDescriptorLite } from "./device-services"
import * as svc from "./service-clients"
import { BoundedBuffer } from "./service-plist"
import type { BufferedItem } from "./service-plist"
import { resolveUdid as resolveSavedUdid } from "./state"

export type IosDeviceServiceManagerDeps = {
  discover?: () => Promise<WebLaneDevice[]>
  managerDescriptors?: () => ManagerDescriptorLite[]
}

type ActiveStream = svc.ServiceStream

export class IosDeviceServiceManager {
  /** keyed by `${deviceContextId}:${kind}` (kind = logs | notify) */
  private streams = new Map<string, ActiveStream>()

  constructor(private deps: IosDeviceServiceManagerDeps = {}) {}

  /** Daemon entry. `outerContextId` is the request's --on/--context value. */
  async handle(action: { type: string; [k: string]: unknown }, outerContextId?: string): Promise<IosSvcResult> {
    const resolved = await this.resolveUdid(action, outerContextId)
    if ("error" in resolved) return resolved.error
    const { udid, contextId } = resolved
    try {
      switch (action.type) {
        case "ios_diag": return await this.diag(udid, contextId, action)
        case "ios_logs": return await this.logs(udid, contextId, action)
        case "ios_fs": return await this.fs(udid, contextId, action)
        case "ios_crash": return await this.crash(udid, contextId, action)
        case "ios_profiles": return await this.profiles(udid, contextId)
        case "ios_notify": return await this.notify(udid, contextId, action)
        case "ios_springboard": return await this.springboard(udid, contextId, action)
        default: return { success: false, error: `unhandled service action: ${action.type}` }
      }
    } catch (err) {
      return svcError(classifyServiceError(err), (err as Error).message, { deviceContextId: contextId })
    }
  }

  // ── device resolution ────────────────────────────────────────────────────────

  private async resolveUdid(
    action: { [k: string]: unknown }, outerContextId?: string,
  ): Promise<{ udid: string; contextId: string } | { error: IosSvcResult }> {
    const explicit = firstString(action.device) ?? (isIosContextId(outerContextId) ? outerContextId : firstString(outerContextId))
    let udid = explicit ? resolveSavedUdid(explicit) : undefined
    if (!udid) {
      const listed = await this.listDevices().catch(() => [])
      const paired = listed.filter((d) => d.paired)
      if (paired.length === 1) udid = paired[0].udid
      else if (paired.length === 0) return { error: svcError("device_not_found", "No paired iOS device found.") }
      else return { error: svcError("device_not_found", "Multiple devices — pass --on <udid>.", { candidates: paired.map((d) => ({ udid: d.udid, name: d.name })) }) }
    }
    return { udid, contextId: iosContextId(udid) }
  }

  private async listDevices(): Promise<WebLaneDevice[]> {
    const web = this.deps.discover ? await this.deps.discover() : await discoverWebLaneDevices()
    return reconcileByUdid(web, this.deps.managerDescriptors?.() ?? [])
  }

  // ── verbs ────────────────────────────────────────────────────────────────────

  private async diag(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosSvcResult> {
    const kind = (firstString(action.kind) as DiagKind) ?? "all"
    const keys = Array.isArray(action.keys) ? (action.keys as unknown[]).filter((k): k is string => typeof k === "string") : undefined
    const result = await svc.diagnostics(udid, kind, keys)
    return { success: true, data: { deviceContextId: contextId, kind, diagnostics: result } }
  }

  private streamKey(contextId: string, kind: "logs" | "notify"): string { return `${contextId}:${kind}` }

  private async logs(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosSvcResult> {
    const op = firstString(action.operation) ?? "read"
    const key = this.streamKey(contextId, "logs")
    if (op === "start") {
      this.streams.get(key)?.close()
      const filter = firstString(action.filter)
      const buffer = new BoundedBuffer<BufferedItem>()
      const stream = await svc.openSyslog(udid, buffer, filter ? safeRegex(filter) : undefined)
      this.streams.set(key, stream)
      return { success: true, data: { deviceContextId: contextId, started: true } }
    }
    if (op === "stop") {
      this.streams.get(key)?.close()
      this.streams.delete(key)
      return { success: true, data: { deviceContextId: contextId, stopped: true } }
    }
    // read (drain)
    const stream = this.streams.get(key)
    if (!stream) return svcError("stream_not_found", "No log stream — run 'ios logs' start first.")
    const drained = stream.buffer.drain(); stream.buffer.clear()
    if (stream.isClosed()) this.streams.delete(key)
    return { success: true, data: { deviceContextId: contextId, ...drained, closed: stream.isClosed(), ...(drained.dropped > 0 ? { code: "buffer_overflow" } : {}) } }
  }

  private async fs(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosSvcResult> {
    const op = firstString(action.op) as FsOp | undefined
    const app = firstString(action.app)
    const path = firstString(action.path) ?? "."
    try {
      if (op === "ls") {
        const entries = await svc.afcList(udid, path, app)
        return { success: true, data: { deviceContextId: contextId, path, app, entries } }
      }
      if (op === "pull") {
        const bytes = await svc.afcPull(udid, path, app)
        return { success: true, data: { deviceContextId: contextId, path, app, bytes: bytes.length, base64: bytes.toString("base64") } }
      }
      if (op === "push") {
        if (!app) return svcError("container_not_owned", "fs push requires --app <bundle> (owned container only).")
        const b64 = firstString(action.base64) ?? ""
        await svc.afcPush(udid, path, Buffer.from(b64, "base64"), app)
        return { success: true, data: { deviceContextId: contextId, path, app, pushed: true } }
      }
      return svcError("bad_request", "ios fs requires op ls|pull|push.")
    } catch (err) {
      if (err instanceof svc.AfcVendError) return svcError("container_not_owned", (err as Error).message)
      throw err
    }
  }

  private async crash(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosSvcResult> {
    const op = firstString(action.op) ?? "list"
    if (op === "list") {
      const entries = await svc.crashList(udid)
      return { success: true, data: { deviceContextId: contextId, entries } }
    }
    const name = firstString(action.name)
    if (!name) return svcError("bad_request", "ios crash pull requires a crash name.")
    const bytes = await svc.crashPull(udid, name)
    return { success: true, data: { deviceContextId: contextId, name, bytes: bytes.length, base64: bytes.toString("base64") } }
  }

  private async profiles(udid: string, contextId: string): Promise<IosSvcResult> {
    const p = await svc.listProfiles(udid)
    return { success: true, data: { deviceContextId: contextId, ...p } }
  }

  private async notify(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosSvcResult> {
    const op = firstString(action.operation) ?? "read"
    const key = this.streamKey(contextId, "notify")
    if (op === "post") {
      const name = firstString(action.name)
      if (!name) return svcError("bad_request", "ios notify post requires a name.")
      await svc.postNotification(udid, name)
      return { success: true, data: { deviceContextId: contextId, posted: name } }
    }
    if (op === "start" || op === "observe") {
      this.streams.get(key)?.close()
      const names = Array.isArray(action.names) ? (action.names as unknown[]).filter((n): n is string => typeof n === "string")
        : firstString(action.name) ? [firstString(action.name)!] : []
      if (names.length === 0) return svcError("bad_request", "ios notify observe requires a name.")
      const stream = await svc.openNotifications(udid, names, () => {})
      this.streams.set(key, stream)
      return { success: true, data: { deviceContextId: contextId, observing: names } }
    }
    if (op === "stop") {
      this.streams.get(key)?.close(); this.streams.delete(key)
      return { success: true, data: { deviceContextId: contextId, stopped: true } }
    }
    const stream = this.streams.get(key)
    if (!stream) return svcError("stream_not_found", "No notification stream — run 'ios notify observe' first.")
    const drained = stream.buffer.drain(); stream.buffer.clear()
    if (stream.isClosed()) this.streams.delete(key)
    return { success: true, data: { deviceContextId: contextId, ...drained, closed: stream.isClosed(), ...(drained.dropped > 0 ? { code: "buffer_overflow" } : {}) } }
  }

  private async springboard(udid: string, contextId: string, action: { [k: string]: unknown }): Promise<IosSvcResult> {
    const sub = firstString(action.sub) ?? "icons"
    if (sub === "wallpaper") {
      const png = await svc.wallpaperPng(udid)
      return { success: true, data: { deviceContextId: contextId, format: "png", bytes: png.length, base64: png.toString("base64") } }
    }
    const icons = await svc.iconState(udid)
    return { success: true, data: { deviceContextId: contextId, icons } }
  }

  /** Close streams for a device (device removal / shutdown). */
  closeDevice(udid: string, _reason: string): void {
    const slug = iosUdidSlug(udid)
    for (const [k, s] of this.streams) {
      if (k.startsWith(`ios:${slug}:`)) { try { s.close() } catch {}; this.streams.delete(k) }
    }
  }
}

function firstString(v: unknown): string | undefined { return typeof v === "string" && v.length ? v : undefined }
function safeRegex(src: string): RegExp | undefined { try { return new RegExp(src, "i") } catch { return undefined } }

// re-export the action-type stream helper for the daemon router
export { IOS_SVC_STREAM_ACTION_TYPES }
