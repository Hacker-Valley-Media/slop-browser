/**
 * daemon/ios/channel.ts — the device transport the IosManager drives, plus the
 * native `RunnerChannel` over the dial-in WebSocket.
 *
 * `IosDeviceChannel` is the small contract the manager's verb handlers call
 * (tap/type/source/screenshot/…). Two implementations satisfy it:
 *   - `RunnerChannel` (default) — talks to our own on-device InterceptorRunner
 *     (XCUITest), which dialed INTO the daemon WS. No WebDriverAgent, no usbmux
 *     HTTP forward; the runner actuates via public XCUITest APIs.
 *   - `WdaClient` (legacy `--wda-url`) — HTTP to a running WebDriverAgent. Kept
 *     as a deprecated escape hatch; it already implements this interface.
 *
 * Host-side post-processing (tree formatting, ref registry, sips screenshot
 * resize) lives in the manager and is identical for both channels — the channel
 * only moves raw bytes to/from the device.
 */

import { IOS_RUNNER_OPS } from "../../shared/ios-device"

export type IosWindowSize = { x: number; y: number; width: number; height: number }

/** The device transport contract the manager's verb handlers depend on. */
export interface IosDeviceChannel {
  /** Liveness probe. Resolves when the device channel is reachable. */
  status(): Promise<unknown>
  /** Establish a logical session (optionally launching `bundleId`). Returns an id. */
  createSession(bundleId?: string): Promise<string>
  getSession(): string | undefined
  deleteSession(): Promise<void>
  /** Foreground app element tree (XCUIElement snapshot serialization). */
  source(): Promise<unknown>
  windowSize(): Promise<IosWindowSize>
  /** Full-resolution screenshot as base64 PNG. */
  screenshot(): Promise<string>
  tap(x: number, y: number): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number, durationSec?: number): Promise<void>
  /** Type into the foreground app, or into `bundleId` (e.g. SpringBoard for a passcode sheet). */
  sendKeys(text: string, bundleId?: string): Promise<void>
  pressButton(name: string): Promise<unknown>
  launchApp(bundleId: string): Promise<void>
  activateApp(bundleId: string): Promise<void>
  terminateApp(bundleId: string): Promise<void>
}

/** Minimal Bun ServerWebSocket shape we need (send + best-effort close). */
export type RunnerSocket = { send: (data: string) => unknown; close?: () => void }

/** Result frame the runner replies with for every op. */
export type RunnerResult = { success: boolean; data?: unknown; error?: string }

/**
 * Drives the on-device InterceptorRunner over its dial-in WebSocket. Every verb
 * is a `{ id, op, ...args }` frame; the runner answers `{ id, result }`. The
 * channel correlates by id and times out so a wedged device never hangs a verb.
 */
export class RunnerChannel implements IosDeviceChannel {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly sessionId = "runner"
  private nextId = 1

  constructor(private ws: RunnerSocket, private timeoutMs = 60_000) {}

  /** Send an op and await the runner's `{ id, result }` reply (data on success). */
  private send<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = `r${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ios runner op '${op}' timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, op, ...args }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Called by the manager when the runner replies `{ id, result }`. */
  handleResponse(id: string, result: RunnerResult | undefined): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    if (result?.success) p.resolve(result.data)
    else p.reject(new Error(result?.error || "ios runner op failed"))
  }

  /** Reject all in-flight ops (runner disconnected / context torn down). */
  teardown(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error("ios runner disconnected"))
    }
    this.pending.clear()
    try { this.ws.close?.() } catch {}
  }

  // ── IosDeviceChannel ─────────────────────────────────────────────────────────
  async status(): Promise<unknown> { return this.send(IOS_RUNNER_OPS.ping) }

  async createSession(bundleId?: string): Promise<string> {
    if (bundleId) await this.send(IOS_RUNNER_OPS.app, { action: "launch", bundleId })
    return this.sessionId
  }
  getSession(): string | undefined { return this.sessionId }
  async deleteSession(): Promise<void> { /* the runner has no server-side session to delete */ }

  async source(): Promise<unknown> { return this.send(IOS_RUNNER_OPS.source) }

  async windowSize(): Promise<IosWindowSize> {
    const v = await this.send<{ width?: number; height?: number }>(IOS_RUNNER_OPS.windowSize)
    return { x: 0, y: 0, width: Number(v?.width) || 0, height: Number(v?.height) || 0 }
  }

  async screenshot(): Promise<string> {
    const b64 = await this.send<string>(IOS_RUNNER_OPS.screenshot)
    if (typeof b64 !== "string" || !b64) throw new Error("ios runner returned no screenshot data")
    return b64
  }

  async tap(x: number, y: number): Promise<void> { await this.send(IOS_RUNNER_OPS.tap, { x, y }) }

  async drag(fromX: number, fromY: number, toX: number, toY: number, durationSec = 0.5): Promise<void> {
    await this.send(IOS_RUNNER_OPS.drag, { fromX, fromY, toX, toY, duration: durationSec })
  }

  async sendKeys(text: string, bundleId?: string): Promise<void> { await this.send(IOS_RUNNER_OPS.keys, bundleId ? { text, bundleId } : { text }) }
  /** issue #244: lock-screen passcode entry (see the runner's `unlock` op). */
  async unlock(passcode?: string, probe = false): Promise<unknown> { return this.send(IOS_RUNNER_OPS.unlock, { passcode: passcode ?? "", probe }) }

  async pressButton(name: string): Promise<unknown> { return this.send(IOS_RUNNER_OPS.press, { name }) }

  /** Diagnostic passthrough for an arbitrary runner op (e.g. "fgdebug"). */
  async rawOp(op: string, args: Record<string, unknown> = {}): Promise<unknown> { return this.send(op, args) }

  async launchApp(bundleId: string): Promise<void> { await this.send(IOS_RUNNER_OPS.app, { action: "launch", bundleId }) }
  async activateApp(bundleId: string): Promise<void> { await this.send(IOS_RUNNER_OPS.app, { action: "activate", bundleId }) }
  async terminateApp(bundleId: string): Promise<void> { await this.send(IOS_RUNNER_OPS.app, { action: "terminate", bundleId }) }
}
