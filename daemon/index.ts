import {
  unlinkSync, existsSync, appendFileSync, statSync, readFileSync, writeFileSync,
  mkdirSync, openSync, writeSync, closeSync, renameSync,
} from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { validateBinarySinkPath, binarySinkIntegrityError } from "./binary-sink"
import { osClick, osKey, osType, osMove, generateBezierPath, translateCoords } from "./os-input-loader"
import { IS_WIN, SOCKET_PATH, IPC_PORT, PID_PATH, LOCK_PATH, LOG_PATH, EVENTS_PATH, WS_PORT, EVENTS_MAX_SIZE, MAX_UPLOAD_FRAME_BYTES, transportLabel } from "../shared/platform"
import {
  MONITOR_EVENT_NAMES,
  appendSessionEvent,
  appendSessionNetArtifact,
  type MonitorAttachmentMeta,
  type MonitorEvent,
  type MonitorSessionMeta,
  updateSessionMeta,
} from "../shared/monitor-artifacts"
import { chooseOutboundTransport, isRelayPing, relaySlotAfterClose, validateContextRouting } from "./outbound-routing"
import { claimContextId, describeContexts, type ContextSocket } from "./context-registration"
import { failPendingBridgeRequests, formatBridgeUnavailableError, getBridgeRecoveryActions, getBridgeRecoveryLayout } from "./bridge-recovery"
import { socketWriteAll, drainSocketQueue, releaseSocketQueue } from "./socket-write"
import { captureSpinSample, spinWatchdogStep, SPIN_EXIT_TICKS, type SpinWatchdogState } from "./spin-watchdog"
import { cleanupOwnedRuntimeFiles, clearDaemonRuntimeFiles, constantTimeTokenEquals, decideDaemonStartupRole, decideSingletonGate, defaultLifecycleDeps, generateShutdownToken, parseDaemonPidFile, readLockFile, readPidState, spawnDetachedStandaloneDaemon, writeLockFile } from "./lifecycle"
import { DAEMON_HEALTH_SERVICE, LEGACY_HEALTH_BODY, probeDaemonHealth } from "../shared/daemon-health"
import { assertNoInstallMaintenance } from "../shared/install-maintenance"
import { VERSION } from "../cli/version"
import { actionLogSummary, inboundLogSummary, outboundLogSummary } from "./redact"
import * as secrets from "./secrets"
import * as chromeCreds from "./chrome-creds"
import { CdpManager, CDP_ACTION_TYPES } from "./cdp/manager"
import { CDP_CONTEXT_PREFIX } from "../shared/cdp-app"
import { IosManager } from "./ios/manager"
import { IosWebManager } from "./ios/web-manager"
import { IosDeviceServiceManager } from "./ios/service-manager"
import { IosDevServiceManager } from "./ios/dev-manager"
import { IOS_ACTION_TYPES, IOS_CONTEXT_PREFIX, IOS_REGISTER_TYPE, IOS_VERB_TYPES } from "../shared/ios-device"
import { IOS_WEB_ACTION_TYPES } from "../shared/ios-web"
import { IOS_SVC_ACTION_TYPES } from "../shared/ios-service"
import { IOS_DEV_ACTION_TYPES } from "../shared/ios-dev"
import {
  NATIVE_REGISTER_TYPE, NATIVE_DELEGATE_TYPE, NATIVE_CONTEXT_PREFIX,
  type NativeAgentState, type CodeSlice, type NativeWayIn,
} from "../shared/native-agent"

// Legacy experiment: older packages could run this binary as the
// com.interceptor.ios-tunnel root helper. Current packages remove that helper;
// keep the branch only so old installs fail predictably instead of falling into
// normal daemon startup.
if (process.argv.includes("--ios-tunnel-helper")) {
  const { runTunnelHelper } = await import("./ios/tunnel-helper/helper")
  await runTunnelHelper()
}

// ── Native Bridge (interceptor-bridge) connection ────────────────────────────────
const BRIDGE_SOCKET_PATH = "/tmp/interceptor-bridge.sock"
const BRIDGE_PID_PATH = "/tmp/interceptor-bridge.pid"
const BRIDGE_RECONNECT_MS = 2000
const BRIDGE_CONNECT_TIMEOUT_MS = 5000
const BRIDGE_RECOVERY_ACTION_TIMEOUT_MS = 1500

let bridgeSocket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T | null : never = null as any
let bridgeBuffer = Buffer.alloc(0)
let bridgeConnecting = false
let bridgeSpawnAttempted = false
const bridgePending = new Map<string, {
  resolve: (response: string) => void
  timer: ReturnType<typeof setTimeout>
  cliSocket: { write: (data: Buffer | string) => number }
  startTime: number
  actionType: string
}>()

function isBridgeAlive(): boolean {
  try {
    const pid = parseInt(readFileSync(BRIDGE_PID_PATH, "utf-8").trim())
    if (isNaN(pid)) return false
    process.kill(pid, 0)
    return true
  } catch { return false }
}

function readBridgeRecoveryLayout() {
  return getBridgeRecoveryLayout({
    exists: existsSync,
    home: process.env.HOME ?? "",
    importMetaUrl: import.meta.url,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  })
}

// Probe whether the bridge LaunchAgent is actually bootstrapped into the
// user's GUI domain. A plist file existing on disk doesn't mean it's loaded —
// pkg postinstalls can (and do) fail the bootstrap call silently, leaving the
// agent unregistered. Distinguishes "user should kickstart" from "user must
// bootstrap first". Returns false on non-darwin or when the probe fails.
function isLaunchAgentBootstrapped(): boolean {
  if (process.platform !== "darwin") return false
  if (typeof process.getuid !== "function") return false
  try {
    const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/com.interceptor.bridge`], {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
    })
    return result.status === 0
  } catch {
    return false
  }
}

async function waitForBridgeSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(BRIDGE_SOCKET_PATH)) return true
    await Bun.sleep(100)
  }
  return existsSync(BRIDGE_SOCKET_PATH)
}

async function spawnBridge(): Promise<boolean> {
  if (bridgeSpawnAttempted) return false
  bridgeSpawnAttempted = true
  try {
    const layout = readBridgeRecoveryLayout()
    const actions = getBridgeRecoveryActions(layout, existsSync, { launchAgentLoaded: isLaunchAgentBootstrapped() })
    if (actions.length === 0) {
      log("bridge binary not found — cannot auto-spawn")
      return false
    }

    for (const action of actions) {
      try {
        log(`bridge recovery attempt: ${action.kind}`)
        const child = spawn(action.command, action.args, { detached: true, stdio: "ignore" })
        child.unref()
      } catch (err) {
        log(`bridge recovery launch failed (${action.kind}): ${(err as Error).message}`)
        continue
      }

      if (await waitForBridgeSocket(BRIDGE_RECOVERY_ACTION_TIMEOUT_MS)) return true
    }

    return existsSync(BRIDGE_SOCKET_PATH)
  } finally {
    setTimeout(() => { bridgeSpawnAttempted = false }, 10000)
  }
}

async function connectBridge(): Promise<boolean> {
  if (bridgeConnecting) return false
  if (!existsSync(BRIDGE_SOCKET_PATH)) {
    if (!isBridgeAlive()) {
      const recovered = await spawnBridge()
      if (!recovered || !existsSync(BRIDGE_SOCKET_PATH)) return false
    } else {
      return false
    }
  }
  bridgeConnecting = true
  try {
    const sock = await Bun.connect({
      unix: BRIDGE_SOCKET_PATH,
      socket: {
        open(socket) {
          log("bridge connected")
          bridgeSocket = socket as any
          bridgeBuffer = Buffer.alloc(0)
          bridgeConnecting = false
        },
        data(_socket, raw) {
          bridgeBuffer = Buffer.concat([bridgeBuffer, Buffer.from(raw)])
          processBridgeBuffer()
        },
        drain(socket) {
          // Issue #229: flush frame tails the 8 KiB unix send buffer rejected.
          drainSocketQueue(socket as any)
        },
        close(socket) {
          // Issue #222: fail in-flight requests now, not at the CLI's timeout.
          const failed = failPendingBridgeRequests(bridgePending)
          log(`bridge disconnected${failed ? ` (failed ${failed} in-flight request(s))` : ""}`)
          releaseSocketQueue(socket as any)
          bridgeSocket = null as any
          bridgeConnecting = false
          // Schedule reconnect
          setTimeout(() => connectBridge(), BRIDGE_RECONNECT_MS)
        },
        error(_socket, err) {
          log(`bridge socket error: ${err.message}`)
          bridgeConnecting = false
        }
      }
    })
    bridgeSocket = sock as any
    return true
  } catch (err) {
    log(`bridge connect failed: ${(err as Error).message}`)
    bridgeConnecting = false
    if (!isBridgeAlive()) {
      const recovered = await spawnBridge()
      if (recovered && existsSync(BRIDGE_SOCKET_PATH)) return connectBridge()
    }
    return false
  }
}

function processBridgeBuffer(): void {
  while (bridgeBuffer.length >= 4) {
    const msgLen = bridgeBuffer.readUInt32LE(0)
    if (msgLen === 0 || msgLen > 10 * 1024 * 1024) {
      log(`bridge: invalid message length: ${msgLen}`)
      bridgeBuffer = Buffer.alloc(0)
      return
    }
    if (bridgeBuffer.length < 4 + msgLen) return
    const jsonBuf = bridgeBuffer.subarray(4, 4 + msgLen)
    bridgeBuffer = bridgeBuffer.subarray(4 + msgLen)
    try {
      const msg = JSON.parse(jsonBuf.toString("utf-8")) as { id?: string; result?: unknown }
      if (msg.id) {
        const pending = bridgePending.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          const duration = Date.now() - pending.startTime
          const result = msg.result as { success?: boolean } | undefined
          log(`bridge resp [${msg.id.slice(0, 8)}] ${result?.success ? "ok" : "err"} ${pending.actionType} ${duration}ms`)
          emitEvent("request_complete", { requestId: msg.id, action: pending.actionType, duration, success: result?.success ?? false })
          pending.resolve(JSON.stringify(msg))
          bridgePending.delete(msg.id)
        }
      }
    } catch (err) {
      log(`bridge: json parse error: ${(err as Error).message}`)
    }
  }
}

function sendToBridge(id: string, action: Record<string, unknown>, cliSocket: { write: (data: Buffer | string) => number }, actionType: string): void {
  const payload = JSON.stringify({ id, action })
  const encoded = Buffer.from(payload, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encoded.byteLength, 0)
  const frame = Buffer.concat([header, encoded])
  try {
    // Issue #229: a bare write() truncated any frame > 8 KiB and desynced the
    // bridge's framing; queue the tail and let the drain handler finish it.
    socketWriteAll(bridgeSocket as any, frame)
  } catch (err) {
    log(`bridge write error: ${(err as Error).message}`)
    socketWriteFramed(cliSocket, JSON.stringify({ id, result: { success: false, error: "bridge connection lost" } }))
    return
  }
  const timer = setTimeout(() => {
    bridgePending.delete(id)
    log(`bridge request timeout: ${id}`)
    socketWriteFramed(cliSocket, JSON.stringify({ id, result: { success: false, error: "bridge timeout" } }))
  }, REQUEST_TIMEOUT_MS)
  bridgePending.set(id, {
    resolve: (response: string) => {
      clearTimeout(timer)
      socketWriteFramed(cliSocket, response)
    },
    timer,
    cliSocket: cliSocket,
    startTime: Date.now(),
    actionType
  })
}

// Runtime Agent surface: forward a `delegate` frame from an in-process
// agent to the Swift bridge (a macos_* action), then send the bridge's
// {id,result} back to the agent's WebSocket. This is how the injected agent
// piggybacks on the bridge's already-granted TCC (Accessibility / Screen
// Recording / Apple Events) instead of the re-signed target's reset grants.
function forwardDelegateToBridge(
  id: string,
  action: Record<string, unknown>,
  agentWs: { send: (data: string) => void },
  contextId: string,
): void {
  const actionType = (action?.type as string) || "unknown"
  emitEvent("native_delegate", { contextId, action: actionType, requestId: id })
  const fail = (error: string) => {
    try { agentWs.send(JSON.stringify({ id, result: { success: false, error } })) } catch {}
  }
  const dispatch = () => {
    const payload = JSON.stringify({ id, action })
    const encoded = Buffer.from(payload, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    try {
      socketWriteAll(bridgeSocket as any, Buffer.concat([header, encoded]))
    } catch {
      fail("bridge connection lost")
      return
    }
    const timer = setTimeout(() => {
      bridgePending.delete(id)
      fail("bridge timeout")
    }, REQUEST_TIMEOUT_MS)
    bridgePending.set(id, {
      resolve: (response: string) => { clearTimeout(timer); try { agentWs.send(response) } catch {} },
      timer,
      cliSocket: { write: () => 0 } as any,
      startTime: Date.now(),
      actionType,
    })
  }
  if (bridgeSocket) dispatch()
  else connectBridge().then((ok) => { (ok && bridgeSocket) ? dispatch() : fail("bridge unavailable for delegation") })
}

// Route a macos_ action to the bridge, connecting first when needed.
function routeToBridge(id: string, action: Record<string, unknown>, socket: { write: (data: Buffer | string) => number }, actionType: string): void {
  if (bridgeSocket) {
    sendToBridge(id, action, socket, actionType)
    return
  }
  connectBridge().then((connected) => {
    if (connected && bridgeSocket) {
      sendToBridge(id, action, socket, actionType)
    } else {
      socketWriteFramed(socket, JSON.stringify({
        id,
        result: { success: false, error: formatBridgeUnavailableError(readBridgeRecoveryLayout(), { launchAgentLoaded: isLaunchAgentBootstrapped() }) },
      }))
    }
  })
}

// ── issue #244: secret vault plumbing ───────────────────────────────────────────
//
// The daemon is the only process that ever holds a resolved secret. Every
// entry point below logs the action first (name only, see daemon/redact.ts),
// then resolves, then hands the value to exactly one delivery leg.

type DaemonResult = { success: boolean; error?: string; data?: unknown; [k: string]: unknown }
type CliRequest = { id?: string; action?: unknown; tabId?: number; contextId?: string }

/** Ask the bridge and await its result as a promise (same framing as sendToBridge). */
function bridgeCall(action: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DaemonResult> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const actionType = String(action.type ?? "unknown")
    const fail = (error: string) => resolve({ success: false, error })
    const dispatch = () => {
      const encoded = Buffer.from(JSON.stringify({ id, action }), "utf-8")
      const header = Buffer.alloc(4)
      header.writeUInt32LE(encoded.byteLength, 0)
      try { socketWriteAll(bridgeSocket as any, Buffer.concat([header, encoded])) } catch { fail("bridge connection lost"); return }
      const timer = setTimeout(() => { bridgePending.delete(id); fail("bridge timeout") }, timeoutMs)
      bridgePending.set(id, {
        resolve: (response: string) => {
          clearTimeout(timer)
          try {
            const parsed = JSON.parse(response) as { result?: DaemonResult }
            resolve(parsed.result ?? { success: false, error: "empty bridge result" })
          } catch { fail("bridge response parse error") }
        },
        timer,
        cliSocket: { write: () => 0 } as any,
        startTime: Date.now(),
        actionType,
      })
    }
    if (bridgeSocket) dispatch()
    else connectBridge().then((ok) => {
      if (ok && bridgeSocket) dispatch()
      else fail(formatBridgeUnavailableError(readBridgeRecoveryLayout(), { launchAgentLoaded: isLaunchAgentBootstrapped() }))
    })
  })
}

/** Ask the extension (one tab) and await its result as a promise. */
function extensionCall(action: Record<string, unknown>, contextId?: string, tabId?: number, timeoutMs = 15_000): Promise<DaemonResult> {
  return new Promise((resolve) => {
    const validation = validateContextRouting({
      contextId,
      connectedContexts: [...extensionWsMap.keys()],
      nativeRelayAvailable: !!nativeRelaySocket,
      cdpContexts: cdpManager.contextIds(),
      iosContexts: iosManager.contextIds(),
    })
    if (!validation.ok) { resolve({ success: false, error: validation.error }); return }
    const id = crypto.randomUUID()
    const timer = setTimeout(() => { pendingRequests.delete(id); resolve({ success: false, error: "timeout" }) }, timeoutMs)
    pendingRequests.set(id, {
      resolve: (response: string) => {
        clearTimeout(timer)
        try {
          const parsed = JSON.parse(response) as { result?: DaemonResult }
          resolve(parsed.result ?? { success: false, error: "empty result" })
        } catch { resolve({ success: false, error: "response parse error" }) }
      },
      timer,
      socket: { write: () => 0, remoteAddress: "daemon" } as any,
      startTime: Date.now(),
      actionType: String(action.type ?? "unknown"),
    })
    sendNativeMessage({ id, action, tabId }, contextId)
  })
}

/** The extension dispatch tail: context validation, timeout, pending entry, send. */
function dispatchToExtension(id: string, request: CliRequest, socket: Bun.Socket<undefined>, actionType: string, sensitiveText?: string): void {
  const contextValidation = validateContextRouting({
    contextId: request.contextId,
    connectedContexts: [...extensionWsMap.keys()],
    nativeRelayAvailable: !!nativeRelaySocket,
    cdpContexts: cdpManager.contextIds(),
    iosContexts: iosManager.contextIds(),
  })
  if (!contextValidation.ok) {
    socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: contextValidation.error } }))
    return
  }

  const timer = setTimeout(() => {
    pendingRequests.delete(id)
    timedOutRequests.add(id)
    setTimeout(() => timedOutRequests.delete(id), 60_000)
    log(`request timeout: ${id}`)
    emitEvent("request_timeout", { requestId: id, action: actionType })
    socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "timeout" } }))
  }, requestTimeoutForAction(actionType))
  pendingRequests.set(id, {
    resolve: (response: string) => {
      clearTimeout(timer)
      socketWriteFramed(socket, response)
    },
    timer,
    socket,
    startTime: Date.now(),
    actionType,
    sensitiveText,
  })

  sendNativeMessage({ id, action: request.action, tabId: request.tabId }, request.contextId)
}

const SECRET_DELIVERY_TYPES = new Set(["macos_type", "macos_authdialog", "input_text", "find_and_type", "os_type", "ios_type", "ios_keys", "ios_unlock", "macos_sudo"])
// issue #248: Chrome saved-login fills go to browser input legs only.
const CHROME_LOGIN_TYPES = new Set(["input_text", "find_and_type", "os_type"])

const bunVault = new secrets.BunSecretsVault()

/** Items in the data protection keychain owned by the signed bridge. */
class BridgeVault implements secrets.Vault {
  readonly backend = "data-protection-keychain"
  async set(name: string, value: string): Promise<void> {
    const r = await bridgeCall({ type: "macos_secrets", sub: "set", name, value }, 20_000)
    if (!r.success) throw new Error(r.error || "bridge keychain write failed")
  }
  async get(name: string): Promise<string | null> {
    const r = await bridgeCall({ type: "macos_secrets", sub: "get", name }, 20_000)
    if (!r.success) {
      if (/not found/i.test(r.error || "")) return null
      throw new Error(r.error || "bridge keychain read failed")
    }
    const d = r.data as { value?: unknown } | undefined
    return typeof d?.value === "string" ? d.value : null
  }
  async delete(name: string): Promise<boolean> {
    const r = await bridgeCall({ type: "macos_secrets", sub: "delete", name }, 20_000)
    return r.success
  }
}

/** Writes go to the bridge; reads fall back to the login keychain (v1 items); deletes clear both. */
class LayeredVault implements secrets.Vault {
  readonly backend = "data-protection-keychain"
  constructor(private primary: BridgeVault, private fallback: secrets.BunSecretsVault) {}
  async set(name: string, value: string): Promise<void> {
    await this.primary.set(name, value)
    await this.fallback.delete(name)
  }
  async get(name: string): Promise<string | null> {
    const v = await this.primary.get(name)
    if (v !== null) return v
    return this.fallback.get(name)
  }
  async delete(name: string): Promise<boolean> {
    const a = await this.primary.delete(name)
    const b = await this.fallback.delete(name)
    return a || b
  }
}

let vaultProbe: { dataProtection: boolean; checkedAt: number } | null = null

async function bridgeDataProtection(force = false): Promise<boolean> {
  if (!force && vaultProbe && Date.now() - vaultProbe.checkedAt < 60_000) return vaultProbe.dataProtection
  const r = await bridgeCall({ type: "macos_secrets", sub: "status" }, 10_000)
  const dp = r.success && (r.data as { dataProtection?: unknown } | undefined)?.dataProtection === true
  vaultProbe = { dataProtection: dp, checkedAt: Date.now() }
  return dp
}

async function activeVault(): Promise<secrets.Vault> {
  return (await bridgeDataProtection()) ? new LayeredVault(new BridgeVault(), bunVault) : bunVault
}

const gateViaBridge: secrets.GateFn = async ({ reason, policy, reuseSeconds }) => {
  const r = await bridgeCall({ type: "macos_auth", sub: "confirm", reason, policy: policy === "biometry" ? "biometry" : "any", reuse_seconds: reuseSeconds }, 180_000)
  if (!r.success) return { ok: false, error: r.error || "authentication prompt failed" }
  const d = r.data as { ok?: boolean; error?: string } | undefined
  return d?.ok === true ? { ok: true } : { ok: false, error: d?.error || "not approved" }
}

function sessionLabel(action: Record<string, unknown>): string | undefined {
  return typeof action.group === "string" && action.group.length > 0 ? action.group : undefined
}

async function handleSecretAction(action: Record<string, unknown>, request: CliRequest): Promise<DaemonResult> {
  const sub = String(action.sub ?? "")
  const session = sessionLabel(action)
  try {
    switch (sub) {
      case "status": {
        const bridgeStatus = await bridgeCall({ type: "macos_secrets", sub: "status" }, 10_000)
        const auth = await bridgeCall({ type: "macos_auth", sub: "status" }, 10_000)
        const dp = await bridgeDataProtection(true)
        return {
          success: true,
          data: {
            backend: dp ? "data-protection-keychain" : "login-keychain",
            dataProtection: dp,
            bridge: bridgeStatus.success ? bridgeStatus.data : { error: bridgeStatus.error },
            auth: auth.success ? auth.data : { error: auth.error },
            secrets: secrets.listSecrets().length,
            unlocked: secrets.openUnlocks().map((u) => ({ name: u.name, until: new Date(u.until).toISOString() })),
            metadata: secrets.metadataPath(),
          },
        }
      }
      case "list":
        return { success: true, data: { backend: (await activeVault()).backend, secrets: secrets.listSecrets() } }
      case "register": {
        const name = secrets.assertName(action.name)
        const gate = secrets.parseGate(action.gate)
        const targets = secrets.parseTargets(action.targets)
        const r = await bridgeCall({
          type: "macos_secrets", sub: "register", name, gate, targets,
          reuse_seconds: typeof action.reuseSeconds === "number" ? action.reuseSeconds : 0,
          session: session ?? "",
        }, 600_000)
        if (!r.success) return { success: false, error: r.error }
        const d = r.data as { cancelled?: boolean; value?: unknown; gate?: unknown; targets?: unknown } | undefined
        if (!d || d.cancelled === true || typeof d.value !== "string") return { success: false, error: "registration cancelled" }
        const vault = await activeVault()
        const meta = await secrets.storeSecret(vault, name, d.value, { gate: d.gate ?? gate, targets: d.targets ?? targets, reuseSeconds: action.reuseSeconds })
        emitEvent("secret_stored", { name, gate: meta.gate, targets: meta.targets, via: "register", backend: vault.backend })
        return { success: true, data: { stored: true, name, gate: meta.gate, targets: meta.targets, backend: vault.backend } }
      }
      case "set": {
        const name = secrets.assertName(action.name)
        if (typeof action.value !== "string" || action.value.length === 0) return { success: false, error: "secret set needs a value on stdin (or the hidden prompt); never on argv" }
        const vault = await activeVault()
        const meta = await secrets.storeSecret(vault, name, action.value, { gate: action.gate, targets: action.targets, reuseSeconds: action.reuseSeconds })
        emitEvent("secret_stored", { name, gate: meta.gate, targets: meta.targets, via: "set", backend: vault.backend })
        return { success: true, data: { stored: true, name, gate: meta.gate, targets: meta.targets, backend: vault.backend } }
      }
      case "rm": {
        const name = secrets.assertName(action.name)
        const removed = await secrets.removeSecret(await activeVault(), name)
        emitEvent("secret_removed", { name, removed })
        return removed ? { success: true, data: { removed: true, name } } : { success: false, error: `no secret named '${name}'` }
      }
      case "unlock": {
        const name = secrets.assertName(action.name)
        const seconds = secrets.parseDuration(action.forSeconds ?? action.for)
        const meta = secrets.loadMeta().secrets[name]
        if (!meta) return { success: false, error: `no secret named '${name}'` }
        const minutes = Math.max(1, Math.round(seconds / 60))
        const res = await gateViaBridge({
          reason: `Interceptor: unlock "${name}" for ${minutes} min${session ? ` (session ${session})` : ""}`,
          policy: meta.gate === "biometry" ? "biometry" : "any",
          reuseSeconds: 0,
        })
        if (!res.ok) return { success: false, error: res.error }
        const until = secrets.openUnlock(name, seconds)
        emitEvent("secret_unlock", { name, seconds })
        return { success: true, data: { unlocked: true, name, until: new Date(until).toISOString(), seconds } }
      }
      case "lock": {
        const names = secrets.lock(typeof action.name === "string" ? action.name : undefined)
        emitEvent("secret_lock", { names })
        return { success: true, data: { locked: names } }
      }
      case "reveal": {
        const name = secrets.assertName(action.name)
        const vault = await activeVault()
        const res = await secrets.resolveSecret(vault, name, { kind: "reveal" }, { gate: gateViaBridge, session, alwaysGate: true })
        emitEvent("secret_release", { name, target: "reveal", action: "macos_secret", outcome: "released", gated: true })
        return { success: true, data: { name, value: res.value } }
      }
      default:
        return { success: false, error: `unknown secret verb '${sub}' (register|set|list|rm|status|unlock|lock|reveal)` }
    }
  } catch (err) {
    const e = err as secrets.SecretError
    return { success: false, error: e.message, code: e.code }
  }
}

/**
 * issue #248: read-only Chrome saved-login enumeration. Exposes host +
 * username + which profile only — never the decrypted password. Refused for
 * model callers (INTERCEPTOR_MCP): a model must not enumerate the user's
 * saved accounts. The fill path (`type --chrome-login`) is unaffected because
 * it never returns the value.
 */
async function handleChromeCredsAction(action: Record<string, unknown>): Promise<DaemonResult> {
  if (process.env.INTERCEPTOR_MCP === "1") {
    return { success: false, error: "chrome creds enumeration is refused over MCP (a model must not list saved accounts); use `type --chrome-login <host>` to fill" }
  }
  const sub = typeof action.sub === "string" ? action.sub : "list"
  try {
    if (sub === "status") {
      const profiles = chromeCreds.listProfiles()
      return { success: true, data: { profiles, count: profiles.length } }
    }
    if (sub === "list") {
      const host = typeof action.host === "string" && action.host ? action.host : undefined
      const rows = chromeCreds.listLogins(host)
      const data = rows.map((r) => ({ profile: r.profile, host: r.host, username: r.username, hasPassword: r.hasPassword }))
      return { success: true, data }
    }
    return { success: false, error: `unknown chrome creds verb '${sub}' (list|status)` }
  } catch (err) {
    const e = err as chromeCreds.ChromeCredsError
    return { success: false, error: e.message, code: e.code }
  }
}

function parseAppsList(data: unknown): Array<{ pid: number; name: string; bundleId: string }> {
  if (typeof data !== "string") return []
  const out: Array<{ pid: number; name: string; bundleId: string }> = []
  for (const line of data.split("\n")) {
    const m = /^\[(\d+)\]\s+(.*?)(?: \*)?(?: \(hidden\))?\s+—\s+(\S*)$/.exec(line.trim())
    if (m) out.push({ pid: parseInt(m[1], 10), name: m[2], bundleId: m[3] })
  }
  return out
}

/** Where a delivery lands, for the per-secret allowlist. */
async function targetForAction(action: Record<string, unknown>, actionType: string, request: CliRequest): Promise<secrets.SecretTarget> {
  switch (actionType) {
    case "macos_sudo": return { kind: "sudo" }
    case "macos_authdialog": return { kind: "macos", id: "com.apple.SecurityAgent" }
    case "macos_type": {
      const app = typeof action.app === "string" ? action.app : undefined
      const pid = typeof action.pid === "number" ? action.pid : undefined
      if (app !== undefined || pid !== undefined) {
        const r = await bridgeCall({ type: "macos_apps" }, 10_000)
        const match = parseAppsList(r.data).find((a) => (pid !== undefined && a.pid === pid) || (app !== undefined && (a.name.toLowerCase() === app.toLowerCase() || a.bundleId.toLowerCase() === app.toLowerCase())))
        if (!match || !match.bundleId) throw new Error(`could not resolve the bundle id of ${app ?? `pid ${pid}`} for the target check`)
        return { kind: "macos", id: match.bundleId }
      }
      const fm = await bridgeCall({ type: "macos_frontmost" }, 10_000)
      const bid = (fm.data as { bundleId?: unknown } | undefined)?.bundleId
      if (!fm.success || typeof bid !== "string" || !bid) throw new Error(`could not read the frontmost app for the target check: ${fm.error ?? "no bundle id"}`)
      return { kind: "macos", id: bid }
    }
    case "input_text":
    case "find_and_type":
    case "os_type": {
      // Same tab as the delivery: the group scope rides inside the action, so
      // the page_info probe carries it too (else the extension answers for the
      // active tab, which may sit outside the caller's group).
      const probe: Record<string, unknown> = { type: "page_info" }
      for (const k of ["group", "groupSoft", "groupColor"]) if (action[k] !== undefined) probe[k] = action[k]
      const info = await extensionCall(probe, request.contextId, request.tabId)
      const url = (info.data as { url?: unknown } | undefined)?.url
      if (!info.success || typeof url !== "string") throw new Error(`could not read the page URL for the target check: ${info.error ?? "no url"}`)
      let host = ""
      try { host = new URL(url).hostname } catch {}
      return { kind: "browser", id: host || url }
    }
    default:
      return { kind: "ios" }
  }
}

/** Resolve `secret` on an action and hand the value to its delivery leg. */
async function deliverWithSecret(id: string, action: Record<string, unknown>, request: CliRequest, socket: Bun.Socket<undefined>, actionType: string): Promise<void> {
  const reply = (result: DaemonResult) => socketWriteFramed(socket, JSON.stringify({ id, result }))
  if (!SECRET_DELIVERY_TYPES.has(actionType)) { reply({ success: false, error: `--secret is not supported for '${actionType}'` }); return }
  const name = action.secret
  if (typeof name !== "string") { reply({ success: false, error: "macos sudo requires --secret <name>" }); return }
  const literal = typeof action.text === "string" ? action.text : typeof action.inputText === "string" ? action.inputText : ""
  if (literal.length > 0) { reply({ success: false, error: "--secret and literal text are mutually exclusive" }); return }
  const session = sessionLabel(action)

  let target: secrets.SecretTarget
  try { target = await targetForAction(action, actionType, request) }
  catch (err) { reply({ success: false, error: (err as Error).message }); return }

  let value: string
  try {
    const res = await secrets.resolveSecret(await activeVault(), name, target, { gate: gateViaBridge, session })
    value = res.value
    emitEvent("secret_release", { requestId: id, name, target: secrets.describeTarget(target), action: actionType, outcome: "released", gated: res.gated })
  } catch (err) {
    const e = err as secrets.SecretError
    emitEvent("secret_release", { requestId: id, name, target: secrets.describeTarget(target), action: actionType, outcome: "denied", code: e.code })
    reply({ success: false, error: e.message, code: e.code })
    return
  }

  await deliverResolvedValue(id, action, request, socket, actionType, value, ["secret"])
}

/**
 * Hand a resolved credential value to the delivery leg for `actionType`. The
 * delivered action carries `sensitive:true` (redaction) and never the source
 * field, so the value only ever appears in-process. `stripFields` names the
 * source markers to remove from the outgoing action (e.g. "secret",
 * "chromeLogin").
 */
async function deliverResolvedValue(id: string, action: Record<string, unknown>, request: CliRequest, socket: Bun.Socket<undefined>, actionType: string, value: string, stripFields: string[]): Promise<void> {
  const reply = (result: DaemonResult) => socketWriteFramed(socket, JSON.stringify({ id, result }))
  const delivered: Record<string, unknown> = { ...action, sensitive: true }
  for (const f of stripFields) delete delivered[f]
  switch (actionType) {
    case "macos_type":
    case "macos_authdialog":
      delivered.text = value
      routeToBridge(id, delivered, socket, actionType)
      return
    case "input_text":
      delivered.text = value
      dispatchToExtension(id, { ...request, action: delivered }, socket, actionType)
      return
    case "find_and_type":
      delivered.inputText = value
      dispatchToExtension(id, { ...request, action: delivered }, socket, actionType)
      return
    case "os_type":
      // The extension only focuses the target; the text is posted by the
      // daemon from the pending entry, so the value never leaves this process.
      dispatchToExtension(id, { ...request, action: delivered }, socket, actionType, value)
      return
    case "ios_type":
    case "ios_keys":
      delivered.text = value
      iosManager.executeVerb(request.contextId ?? "", delivered as { type: string; [k: string]: unknown })
        .then(reply)
        .catch((err) => reply({ success: false, error: `ios verb failed: ${(err as Error).message}` }))
      return
    case "ios_unlock":
      delivered.passcode = value
      iosManager.executeVerb(request.contextId ?? "", delivered as { type: string; [k: string]: unknown })
        .then(reply)
        .catch((err) => reply({ success: false, error: `ios verb failed: ${(err as Error).message}` }))
      return
    case "macos_sudo":
      reply(await secrets.runSudo(value, action.cmd as string[], { keep: action.keep === true }))
      return
  }
}

/**
 * issue #248: resolve a Chrome saved login and hand it to a browser delivery
 * leg. The credential can only be filled into the page it belongs to: the
 * requested host must match the live page host, and the resolved credential's
 * own origin host must match too. This is the whole allowlist — an agent on
 * one site can never pull another site's saved password.
 */
async function deliverWithChromeLogin(id: string, action: Record<string, unknown>, request: CliRequest, socket: Bun.Socket<undefined>, actionType: string): Promise<void> {
  const reply = (result: DaemonResult) => socketWriteFramed(socket, JSON.stringify({ id, result }))
  if (!CHROME_LOGIN_TYPES.has(actionType)) { reply({ success: false, error: `--chrome-login is not supported for '${actionType}'` }); return }
  const spec = action.chromeLogin as { host?: unknown; field?: unknown } | undefined
  const host = spec && typeof spec.host === "string" ? spec.host : ""
  const field: chromeCreds.ChromeLoginField = spec && spec.field === "user" ? "user" : "pass"
  if (!host) { reply({ success: false, error: "--chrome-login requires a host" }); return }

  // Bind the fill to the live page. The delivery target derivation already
  // resolves the tab's host for the browser surface.
  let pageHost = ""
  try {
    const target = await targetForAction(action, actionType, request)
    if (target.kind !== "browser") { reply({ success: false, error: "--chrome-login only fills browser fields" }); return }
    pageHost = (target.id ?? "").toLowerCase()
  } catch (err) { reply({ success: false, error: (err as Error).message }); return }

  if (!chromeCreds.hostMatches(pageHost, host)) {
    emitEvent("chrome_login", { requestId: id, host, pageHost, field, action: actionType, outcome: "denied", code: "host_mismatch" })
    reply({ success: false, error: `--chrome-login host '${host}' does not match the current page host '${pageHost}'`, code: "host_mismatch" })
    return
  }

  let value: string
  let resolvedOrigin: string
  try {
    const res = chromeCreds.resolveLogin(host, field)
    value = res.value
    resolvedOrigin = res.originUrl
  } catch (err) {
    const e = err as chromeCreds.ChromeCredsError
    emitEvent("chrome_login", { requestId: id, host, field, action: actionType, outcome: "denied", code: e.code ?? "error" })
    reply({ success: false, error: e.message, code: e.code })
    return
  }

  // Defense in depth: the credential's own origin must also match the page.
  let originHost = ""
  try { originHost = new URL(resolvedOrigin).hostname.toLowerCase() } catch {}
  if (originHost && !chromeCreds.hostMatches(pageHost, originHost) && !chromeCreds.hostMatches(originHost, pageHost)) {
    emitEvent("chrome_login", { requestId: id, host, pageHost, field, action: actionType, outcome: "denied", code: "origin_mismatch" })
    reply({ success: false, error: `resolved credential origin '${originHost}' does not match the page host '${pageHost}'`, code: "origin_mismatch" })
    return
  }
  if (field === "pass" && value.length === 0) {
    reply({ success: false, error: `saved Chrome login for '${host}' has an empty password`, code: "not_found" })
    return
  }

  emitEvent("chrome_login", { requestId: id, host, pageHost, field, action: actionType, outcome: "released" })
  await deliverResolvedValue(id, action, request, socket, actionType, value, ["chromeLogin"])
}

// Start bridge connection on daemon startup
setTimeout(() => connectBridge(), 500)

function log(msg: string) {
  const mode = process.argv.includes("--standalone") ? "standalone" : "native-messaging"
  const line = `[${new Date().toISOString()} pid:${process.pid} mode:${mode}] ${msg}\n`
  try { appendFileSync(LOG_PATH, line) } catch {}
}

function emitEvent(event: string, data: Record<string, unknown> = {}) {
  const eventObj = { timestamp: new Date().toISOString(), event, ...data }
  const entry = JSON.stringify(eventObj)
  try {
    appendFileSync(EVENTS_PATH, entry + "\n")
    const stat = statSync(EVENTS_PATH)
    if (stat.size > EVENTS_MAX_SIZE) {
      const content = readFileSync(EVENTS_PATH, "utf-8")
      const lines = content.split("\n")
      const half = lines.slice(Math.floor(lines.length / 2)).join("\n")
      writeFileSync(EVENTS_PATH, half)
    }
  } catch {}

  const sid = typeof data.sid === "string" ? data.sid : undefined
  if (sid && MONITOR_EVENT_NAMES.has(event)) {
    try {
      appendSessionEvent(sid, eventObj as MonitorEvent)
      syncSessionMetaFromEvent(eventObj as MonitorEvent)
    } catch {}
  }
}

function attachmentFromEvent(ev: MonitorEvent): MonitorAttachmentMeta | null {
  const tabId = typeof ev.tid === "number" ? ev.tid : undefined
  if (tabId === undefined) return null
  const doc = typeof ev.doc === "string" ? ev.doc : undefined
  return {
    key: `${tabId}:${doc || "unknown"}`,
    tabId,
    documentId: doc,
    frameId: typeof ev.fid === "number" ? ev.fid : 0,
    url: typeof ev.u === "string" ? ev.u : undefined,
    openerTabId: typeof ev.openerTid === "number" ? ev.openerTid : undefined,
    attachedAt: typeof ev.t === "number" ? ev.t : Date.now(),
    detachedAt: undefined,
    lifecycle: typeof ev.lif === "string" ? ev.lif : undefined,
    reason: typeof ev.reason === "string" ? ev.reason : undefined
  }
}

function syncSessionMetaFromEvent(ev: MonitorEvent): void {
  if (!ev.sid) return

  updateSessionMeta(ev.sid, (current): MonitorSessionMeta => {
    const base: MonitorSessionMeta = current || {
      artifactVersion: 2,
      surface: "browser",
      sessionId: ev.sid!,
      taskId: typeof ev.taskId === "string" ? ev.taskId : undefined,
      startedAt: typeof ev.t === "number" ? ev.t : Date.now(),
      status: ev.event === "mon_stop" ? "stopped" : "active",
      paused: false,
      rootTabId: typeof ev.tid === "number" ? ev.tid : undefined,
      instruction: typeof ev.ins === "string" ? ev.ins : undefined,
      url: typeof ev.url === "string" ? ev.url : (typeof ev.u === "string" ? ev.u : undefined),
      activeAttachmentKey: undefined,
      counts: undefined,
      stopReason: undefined,
      attachments: []
    }

    if (ev.event === "mon_start") {
      base.surface = "browser"
      base.taskId = typeof ev.taskId === "string" ? ev.taskId : base.taskId
      base.startedAt = typeof ev.t === "number" ? ev.t : base.startedAt
      base.status = "active"
      base.paused = false
      base.rootTabId = typeof ev.tid === "number" ? ev.tid : base.rootTabId
      base.instruction = typeof ev.ins === "string" ? ev.ins : base.instruction
      base.url = typeof ev.url === "string" ? ev.url : base.url
    } else if (ev.event === "mon_pause") {
      base.paused = true
    } else if (ev.event === "mon_resume") {
      base.paused = false
    } else if (ev.event === "mon_stop") {
      base.status = "stopped"
      base.paused = false
      base.endedAt = typeof ev.t === "number" ? ev.t : base.endedAt
      base.stopReason = typeof ev.reason === "string" ? ev.reason : base.stopReason
      base.counts = {
        evt: typeof ev.evt === "number" ? ev.evt : base.counts?.evt || 0,
        mut: typeof ev.mut === "number" ? ev.mut : base.counts?.mut || 0,
        net: typeof ev.net === "number" ? ev.net : base.counts?.net || 0,
        nav: typeof ev.nav === "number" ? ev.nav : base.counts?.nav || 0,
      }
    } else if (ev.event === "mon_attach") {
      const attachment = attachmentFromEvent(ev)
      if (attachment) {
        const idx = base.attachments.findIndex((item) => item.key === attachment.key)
        if (idx === -1) base.attachments.push(attachment)
        else base.attachments[idx] = { ...base.attachments[idx], ...attachment }
        base.activeAttachmentKey = attachment.key
      }
    } else if (ev.event === "mon_detach") {
      const attachment = attachmentFromEvent(ev)
      if (attachment) {
        const idx = base.attachments.findIndex((item) => item.key === attachment.key)
        if (idx === -1) {
          base.attachments.push({ ...attachment, detachedAt: typeof ev.t === "number" ? ev.t : Date.now() })
        } else {
          base.attachments[idx] = {
            ...base.attachments[idx],
            detachedAt: typeof ev.t === "number" ? ev.t : Date.now(),
            reason: attachment.reason || base.attachments[idx].reason,
            lifecycle: attachment.lifecycle || base.attachments[idx].lifecycle,
            url: attachment.url || base.attachments[idx].url,
          }
        }
        if (base.activeAttachmentKey === attachment.key) base.activeAttachmentKey = undefined
      }
    }

    return base
  })
}

function persistNetArtifactFromEvent(ev: Record<string, unknown>): void {
  if (typeof ev.sid !== "string") return
  const event = typeof ev.event === "string" ? ev.event : ""
  let kind: "fetch" | "xhr" | "sse" | "ws" | "beacon" | "broadcast" | undefined
  if (event === "fetch" || event === "xhr" || event === "sse") kind = event
  else if (event.startsWith("ws_")) kind = "ws"
  else if (event === "beacon" || event === "beacon_error") kind = "beacon"
  else if (event.startsWith("broadcast_")) kind = "broadcast"
  if (!kind) return
  if ((kind === "fetch" || kind === "xhr" || kind === "sse") && (typeof ev.bp !== "string" || !ev.bp)) return

  appendSessionNetArtifact(ev.sid, {
    sid: ev.sid,
    seq: typeof ev.s === "number" ? ev.s : undefined,
    tid: typeof ev.tid === "number" ? ev.tid : undefined,
    doc: typeof ev.doc === "string" ? ev.doc : undefined,
    cause: typeof ev.cause === "number" ? ev.cause : undefined,
    kind,
    url: typeof ev.u === "string" ? ev.u : "",
    method: typeof ev.m === "string" ? ev.m : undefined,
    status: typeof ev.st === "number" ? ev.st : undefined,
    contentType: typeof ev.ct === "string" ? ev.ct : undefined,
    truncated: ev.trn === true,
    bodyBytes: typeof ev.bt === "number" ? ev.bt : undefined,
    bodyPreview: typeof ev.bp === "string" ? ev.bp : "",
    direction: typeof ev.dir === "string" ? ev.dir : undefined,
    payloadKind: typeof ev.pk === "string" ? ev.pk : undefined,
    payloadEncoding: typeof ev.enc === "string" ? ev.enc : undefined,
    socketId: typeof ev.skt === "string" ? ev.skt : undefined,
    channelId: typeof ev.ch === "string" ? ev.ch : undefined,
    channelName: typeof ev.cn === "string" ? ev.cn : undefined,
    returnValue: typeof ev.rv === "boolean" ? ev.rv : undefined
  })
}

const STANDALONE = process.argv.includes("--standalone")
const NATIVE_STANDALONE_BOOT_TIMEOUT_MS = 5_000

log(`daemon starting (mode: ${STANDALONE ? "standalone" : "native-messaging"})`)

try {
  assertNoInstallMaintenance()
} catch (error) {
  log((error as Error).message)
  process.exit(20)
}

// ── Native Relay ─────────────────────────────────────────────────────────────
// When Chrome spawns a new daemon (native-messaging mode) and a singleton is
// already running, the new process becomes a transparent stdio↔IPC bridge
// instead of exiting. This prevents the "native host disconnected" error cycle
// that occurs every ~30s due to MV3 service worker reconnects.
async function startNativeRelay(existingPid: number | null): Promise<never> {
  log(`relay mode: bridging native messaging to singleton (pid ${existingPid ?? "unknown, port held"})`)

  let singletonSocket: Bun.Socket<undefined> | null = null

  try {
    const relaySocketHandlers: Bun.SocketHandler<undefined> = {
      open(socket: Bun.Socket<undefined>) {
        // Register as native relay — singleton routes traffic to handleNativeMessage
        const reg = JSON.stringify({ type: "native-relay" })
        const encoded = Buffer.from(reg, "utf-8")
        const header = Buffer.alloc(4)
        header.writeUInt32LE(encoded.byteLength, 0)
        socketWriteAll(socket, Buffer.concat([header, encoded]))
        log("relay: registered with singleton")
      },
      data(_socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
        // Singleton → stdout (Chrome)
        process.stdout.write(Buffer.from(raw))
      },
      drain(socket: Bun.Socket<undefined>) {
        // Issue #229: Chrome→singleton chunks can exceed the 8 KiB unix send
        // buffer; flush the queued tail or the singleton's framing desyncs.
        drainSocketQueue(socket)
      },
      close() {
        log("relay: singleton disconnected — exiting")
        process.exit(0)
      },
      error(_socket: Bun.Socket<undefined>, err: Error) {
        log(`relay: socket error — ${err.message}`)
        process.exit(1)
      }
    }

    singletonSocket = IS_WIN
      ? await Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port: IPC_PORT,
        socket: relaySocketHandlers
      })
      : await Bun.connect<undefined>({
        unix: SOCKET_PATH,
        socket: relaySocketHandlers
      })
  } catch (err) {
    log(`relay: failed to connect to singleton — exiting: ${(err as Error).message}`)
    process.exit(1)
  }

  // Chrome stdin → singleton IPC socket
  process.stdin.on("data", (chunk: Buffer) => {
    if (singletonSocket) socketWriteAll(singletonSocket, chunk)
  })
  process.stdin.on("end", () => {
    log("relay: stdin ended (Chrome disconnected) — exiting")
    process.exit(0)
  })
  process.stdin.resume()

  // Keep alive — Bun exits when event loop is empty
  while (true) await Bun.sleep(30_000)
}

function lifecycleDeps() {
  return {
    ...defaultLifecycleDeps({ pidPath: PID_PATH, lockPath: LOCK_PATH, socketPath: SOCKET_PATH, isWin: IS_WIN }),
    log,
  }
}

async function bootstrapDaemonRole(): Promise<void> {
  const deps = lifecycleDeps()
  const state = readPidState(deps)
  // The port, not the pid file, says whether a singleton is serving. Probing
  // it also makes a live owner restore any runtime files that went missing,
  // so a relay decided below finds the socket it needs.
  const probe = await probeDaemonHealth(WS_PORT)
  if (probe.state === "interceptor" && probe.healed.length) log(`singleton pid ${probe.pid} restored runtime files on probe: ${probe.healed.join(", ")}`)
  if (probe.state !== "free") log(`singleton port ${WS_PORT} is held (${probe.state}); pid file state: ${state.status}`)
  const decision = decideDaemonStartupRole(STANDALONE, state, probe.state !== "free")

  if (decision.action === "exit") {
    log(`another daemon already running (pid ${decision.pid ?? "unknown, port held"}) — exiting`)
    process.exit(0)
  }

  if (decision.action === "relay") {
    await startNativeRelay(decision.pid)
  }

  if (decision.action === "clear-and-continue" || decision.action === "clear-and-spawn") {
    clearDaemonRuntimeFiles(deps, decision.reason)
  }

  if (decision.action === "spawn" || decision.action === "clear-and-spawn") {
    const standalonePid = await spawnDetachedStandaloneDaemon(deps, NATIVE_STANDALONE_BOOT_TIMEOUT_MS)
    if (standalonePid) {
      await startNativeRelay(standalonePid)
    }
    log("native bootstrap failed to start detached singleton — falling back to in-process singleton")
  }
}

await bootstrapDaemonRole()

// Singleton election (atomic): the WebSocket port is the one OS-exclusive token that both
// the CLI socket and the extension channel must agree on. Bind it BEFORE claiming the CLI
// socket, so two daemons can never split-brain (one owning the socket, another the WS port).
// Losing this race is fatal: exit instead of becoming a second, extension-less singleton.
let wsServer: ReturnType<typeof Bun.serve> | null = null
let wsBindError: Error | null = null
// True only after this process wins the singleton gate below: the runtime
// files (socket, pid, lock) describe the gate winner, so only the winner may
// write, restore, or remove them.
let ownsRuntimeFiles = false
let shuttingDown = false
try {
  assertNoInstallMaintenance()
} catch (error) {
  log((error as Error).message)
  process.exit(20)
}
try {
  wsServer = startWsServer()
} catch (err) {
  wsBindError = err as Error
}
const singletonGate = decideSingletonGate({ wsPortAcquired: wsServer !== null, standalone: STANDALONE })
if (singletonGate.action === "exit") {
  log(`ws port ${WS_PORT} already held by another daemon — ${singletonGate.reason}${wsBindError ? ` (${wsBindError.message})` : ""}`)
  process.exit(singletonGate.exitCode)
}
log(`ws server listening on port ${WS_PORT}`)
ownsRuntimeFiles = true

// Write lock file — metadata record of this instance, read by `interceptor
// diagnose` for binary-mismatch detection. Written only after winning the
// singleton gate so a losing duplicate can never clobber the winner's record.
// Duplicate *prevention* is the WS-port gate above, not this file.
// A non-standalone process only reaches here via the spawn-failure fallback,
// where it serves as the daemon in-process — hence "native-singleton".
const daemonIdentity = {
  pid: process.pid,
  version: VERSION,
  execPath: process.execPath,
  startedAt: new Date().toISOString(),
  socketPath: SOCKET_PATH,
  wsPort: WS_PORT,
  mode: (STANDALONE ? "standalone" : "native-singleton") as "standalone" | "native-singleton",
  shutdownProtocolVersion: 1 as const,
  shutdownToken: generateShutdownToken(),
}
try {
  writeLockFile(LOCK_PATH, daemonIdentity)
} catch (error) {
  log(`daemon lock-file setup failed: ${error instanceof Error ? error.message : String(error)}`)
  throw error
}
// Lock cleanup rides the existing shutdown paths (gracefulShutdown + the
// process "exit" listener below) — a separate signal handler here would
// register first and its process.exit(0) would stop gracefulShutdown from
// ever running, skipping the CDP/iOS manager teardown.

const pendingRequests = new Map<string, {
  resolve: (v: string) => void
  timer: ReturnType<typeof setTimeout>
  // issue #244: a resolved secret for os_type stays here, never in the extension
  // round trip, and is dropped with the entry.
  sensitiveText?: string
  socket: { write: (data: Buffer | string) => number; readonly remoteAddress: string }
  startTime: number
  actionType: string
}>()

const socketBuffers = new Map<object, Buffer>()

const LARGE_PAYLOAD_THRESHOLD = 16 * 1024
const MAX_RESPONSE_CHARS = 50000
const NATIVE_HOST_TO_CHROME_MAX_BYTES = 1024 * 1024

function socketWriteFramed(socket: { write: (data: Buffer | string) => number }, json: string): boolean {
  try {
    let payload = json
    if (payload.length > MAX_RESPONSE_CHARS) {
      try {
        const parsed = JSON.parse(payload)
        if (parsed.result?.data && typeof parsed.result.data === "string" && parsed.result.data.length > MAX_RESPONSE_CHARS) {
          parsed.result.data = parsed.result.data.slice(0, MAX_RESPONSE_CHARS) + "\n... (truncated)"
          payload = JSON.stringify(parsed)
        }
      } catch {}
    }

    const encoded = Buffer.from(payload, "utf-8")

    if (encoded.byteLength > LARGE_PAYLOAD_THRESHOLD) {
      const sink = new Bun.ArrayBufferSink()
      sink.start({ asUint8Array: true, highWaterMark: 65536 })
      const header = new Uint8Array(4)
      new DataView(header.buffer).setUint32(0, encoded.byteLength, true)
      sink.write(header)
      sink.write(encoded)
      const frame = sink.end() as Uint8Array
      socketWriteAll(socket, Buffer.from(frame))
    } else {
      const header = Buffer.alloc(4)
      header.writeUInt32LE(encoded.byteLength, 0)
      socketWriteAll(socket, Buffer.concat([header, encoded]))
    }
    return true
  } catch (err) {
    log(`socket write error: ${(err as Error).message}`)
    return false
  }
}

const timedOutRequests = new Set<string>()

let stdinBuffer = Buffer.alloc(0)

function processStdinBuffer() {
  while (stdinBuffer.length >= 4) {
    const msgLen = stdinBuffer.readUInt32LE(0)
    if (msgLen === 0 || msgLen > 10 * 1024 * 1024) {
      log(`invalid message length: ${msgLen}, discarding buffer`)
      stdinBuffer = Buffer.alloc(0)
      return
    }
    if (stdinBuffer.length < 4 + msgLen) return
    const jsonBuf = stdinBuffer.subarray(4, 4 + msgLen)
    stdinBuffer = stdinBuffer.subarray(4 + msgLen)
    try {
      const msg = JSON.parse(jsonBuf.toString("utf-8"))
      log(`received: ${inboundLogSummary(msg)}`)
      handleNativeMessage(msg)
    } catch (err) {
      log(`json parse error: ${(err as Error).message}`)
    }
  }
}

function handleNativeMessage(msg: { id?: string; type?: string; [key: string]: unknown }) {
  if (msg.type === "ping") {
    log("received ping, sending pong")
    sendNativeMessage({ type: "pong" })
    emitEvent("keepalive_ping")
    return
  }

  if (msg.type === "event") {
    const eventName = msg.event as string || "extension_event"
    const eventPayload = { ...msg } as Record<string, unknown>
    if (typeof eventPayload.sid === "string") {
      try { persistNetArtifactFromEvent({ event: eventName, ...eventPayload }) } catch {}
      delete eventPayload.bp
      delete eventPayload.bt
      delete eventPayload.trn
      delete eventPayload.ct
    }
    emitEvent(eventName, eventPayload)
    return
  }

  if (msg.id) {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      const requestId = msg.id
      clearTimeout(pending.timer)
      const duration = Date.now() - pending.startTime
      const result = (msg as { result?: { success?: boolean; data?: Record<string, unknown> } }).result
      const success = result?.success ?? true

      if (success && pending.actionType.startsWith("os_") && result?.data) {
        const data = result.data as Record<string, unknown>
        if (data.method === "os_event") {
          const enrichedAction: Record<string, unknown> = { type: pending.actionType }
          if (data.windowBounds) {
            Object.assign(enrichedAction, data.screenTarget as Record<string, unknown> || {})
            enrichedAction.windowBounds = data.windowBounds
            enrichedAction.chromeUiHeight = data.chromeUiHeight
          }
          if (pending.actionType === "os_click") {
            enrichedAction.button = data.button || "left"
            enrichedAction.clickCount = data.clickCount || 1
          }
          if (pending.actionType === "os_key") {
            enrichedAction.key = data.key
            enrichedAction.modifiers = data.modifiers
          }
          if (pending.actionType === "os_type") {
            enrichedAction.text = pending.sensitiveText ?? data.text
            if (pending.sensitiveText !== undefined) enrichedAction.sensitive = true
          }
          if (pending.actionType === "os_move") {
            enrichedAction.path = data.path
            enrichedAction.duration = data.duration
          }
          log(`[${requestId.slice(0, 8)}] posting OS event for ${pending.actionType}`)
          handleOsAction(requestId, enrichedAction).then((osResult) => {
            const finalResult = osResult || { success: false, error: "os action failed" }
            emitEvent("request_complete", { requestId, action: pending.actionType, duration: Date.now() - pending.startTime, success: finalResult.success })
            pending.resolve(JSON.stringify({ id: requestId, result: finalResult }))
            pendingRequests.delete(requestId)
          })
          return
        }
      }

      log(`[${msg.id.slice(0, 8)}] resp ${success ? "ok" : "err"} ${pending.actionType} ${duration}ms`)
      emitEvent("request_complete", { requestId: msg.id, action: pending.actionType, duration, success })
      pending.resolve(JSON.stringify(msg))
      pendingRequests.delete(msg.id)
    } else if (timedOutRequests.has(msg.id)) {
      log(`late response for timed-out request: ${msg.id}`)
      timedOutRequests.delete(msg.id)
    }
  }
}

const extensionWsMap = new Map<string, ContextSocket>()
// Runtime Agent surface: per-agent metadata for `macos runtime status`.
// The agent's ws is stored in extensionWsMap under its runtime:<app> contextId so the
// normal verb-routing / contexts / disambiguation paths work unchanged; this map
// only adds the descriptive metadata those paths don't carry.
const nativeAgentMeta = new Map<string, NativeAgentState>()
let nativeRelaySocket: Bun.Socket<undefined> | null = null
const wsOutboundQueues = new Map<string, string[]>()
const WS_QUEUE_CAP = 50

function resolveExtensionWs(contextId?: string): { send: (data: string) => void } | null {
  if (contextId) return extensionWsMap.get(contextId) ?? null
  if (extensionWsMap.size === 1) return [...extensionWsMap.values()][0]
  return null
}

// Resolve where the MV2 sibling extension (loaded into Electron apps) lives.
function resolveMv2ExtDir(): string {
  const env = process.env.INTERCEPTOR_MV2_EXT_DIR
  if (env) return env
  const candidates = [
    `${import.meta.dir}/../extension/dist-mv2`,
    `${process.env.HOME ?? ""}/.interceptor/extension-mv2`,
    "/Library/Application Support/Interceptor/extension-mv2",
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch {}
  }
  return candidates[0]
}

// CDP-app surface: direct CDP (cdp:) contexts live here; inspector
// bootstrap loads the MV2 extension which registers as an app: extension context.
const cdpManager = new CdpManager({
  emit: (event, data) => emitEvent(event, data || {}),
  hasExtensionContext: (ctxId: string) => extensionWsMap.has(ctxId),
  mv2ExtensionDir: resolveMv2ExtDir,
})

// iOS device surface: our own on-device InterceptorRunner (XCUITest)
// dials INTO this daemon WS and registers {type:"ios"}, exactly like the browser
// extension and the in-process native agent. The manager drives it over that
// socket (RunnerChannel) — no WebDriverAgent. Keyed by ios:<udid>, parallel to
// cdpManager. A legacy --wda-url HTTP path remains as a deprecated escape hatch.
const iosManager = new IosManager({
  emit: (event, data) => emitEvent(event, data || {}),
  wsPort: WS_PORT,
})

// web lane. Reuses iosManager's runner for native-lane work (screenshot,
// native input) but the web lane itself needs no runner / Developer Mode.
const iosWebManager = new IosWebManager({
  nativeLane: {
    isAvailable: (ctx) => iosManager.contextIds().includes(ctx),
    screenshot: (ctx, max) => iosManager.executeVerb(ctx, { type: "ios_screenshot", targetMaxLongEdge: max }),
    tap: (ctx, x, y) => iosManager.executeVerb(ctx, { type: "ios_click", x, y }),
    type: (ctx, text) => iosManager.executeVerb(ctx, { type: "ios_type", text }),
    keys: (ctx, text) => iosManager.executeVerb(ctx, { type: "ios_keys", text }),
    tree: (ctx) => iosManager.executeVerb(ctx, { type: "ios_tree" }),
  },
  managerDescriptors: () => iosManager.contextIds()
    .filter((c) => c.startsWith(IOS_CONTEXT_PREFIX))
    .map((c) => ({ udid: c.slice(IOS_CONTEXT_PREFIX.length), contextId: c })),
})

// device-service introspection lane. Runner-free classic Lockdown
// (diagnostics/logs/filesystem/crashes/profiles/notifications/springboard).
const iosServiceManager = new IosDeviceServiceManager({
  managerDescriptors: () => iosManager.contextIds()
    .filter((c) => c.startsWith(IOS_CONTEXT_PREFIX))
    .map((c) => ({ udid: c.slice(IOS_CONTEXT_PREFIX.length), contextId: c })),
})

// Instruments/DTX + telemetry + developer-service lanes. Runner-free by
// default; `shot`/`screen` fall back to the on-device XCUITest runner via runnerVerb.
const iosDevManager = new IosDevServiceManager({
  managerDescriptors: () => iosManager.contextIds()
    .filter((c) => c.startsWith(IOS_CONTEXT_PREFIX))
    .map((c) => ({ udid: c.slice(IOS_CONTEXT_PREFIX.length), contextId: c })),
  runnerVerb: (contextId, action) => iosManager.executeVerb(contextId, action),
})

function drainWsOutboundQueue(ctxId: string): void {
  const ws = extensionWsMap.get(ctxId)
  if (!ws) return
  for (const key of [ctxId, "default"]) {
    const queue = wsOutboundQueues.get(key)
    if (!queue) continue
    while (queue.length > 0) {
      const msg = queue.shift()!
      log(`draining queued ws message [${key}]: ${(() => { try { return outboundLogSummary(JSON.parse(msg)).slice(0, 100) } catch { return msg.slice(0, 100) } })()}`)
      try { ws.send(msg) } catch (err) { log(`ws drain error: ${(err as Error).message}`) }
    }
    wsOutboundQueues.delete(key)
  }
}

function sendNativeMessage(msg: unknown, contextId?: string): void {
  const json = JSON.stringify(msg)
  const resolvedWs = resolveExtensionWs(contextId)
  const preferred = chooseOutboundTransport(msg, {
    nativeRelayAvailable: !!nativeRelaySocket,
    extensionWsAvailable: !!resolvedWs,
    stdinAlive,
    standalone: STANDALONE
  })
  const byteLength = Buffer.byteLength(json, "utf-8")

  function failOversizedNativeMessage(transport: string): boolean {
    if (byteLength <= NATIVE_HOST_TO_CHROME_MAX_BYTES) return false
    const id = (msg as { id?: unknown } | null)?.id
    const error = `native message too large for ${transport}: ${byteLength} bytes exceeds ${NATIVE_HOST_TO_CHROME_MAX_BYTES}`
    log(error)
    if (typeof id === "string") {
      handleNativeMessage({ id, result: { success: false, error } })
    }
    return true
  }

  if (preferred === "ws" && resolvedWs) {
    log(`forwarding via ws: ${outboundLogSummary(msg)}`)
    try {
      resolvedWs.send(json)
      return
    } catch (err) {
      log(`ws send error: ${(err as Error).message}`)
    }
  }

  if (preferred === "relay" && nativeRelaySocket) {
    if (failOversizedNativeMessage("native relay")) return
    log(`forwarding via relay: ${outboundLogSummary(msg)}`)
    const relayAtSend = nativeRelaySocket
    try {
      socketWriteFramed(relayAtSend, json)
      return
    } catch (err) {
      log(`relay send error: ${(err as Error).message}`)
      // Identity-checked release. This block is synchronous (no yield between
      // capture and check), so unlike the close handler this guard is
      // belt-and-suspenders, not a race fix — kept so the invariant
      // "only the owner releases the slot" holds at every release site.
      if (nativeRelaySocket === relayAtSend) nativeRelaySocket = null
    }
  }

  if (preferred === "native" && !STANDALONE && stdinAlive) {
    if (failOversizedNativeMessage("native stdio")) return
    log(`forwarding via runtime agent: ${outboundLogSummary(msg)}`)
    const encoded = Buffer.from(json, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    const combined = Buffer.concat([header, encoded])
    process.stdout.write(combined)
    return
  }

  if (resolvedWs) {
    log(`fallback via ws: ${outboundLogSummary(msg)}`)
    try {
      resolvedWs.send(json)
      return
    } catch (err) {
      log(`fallback ws send error: ${(err as Error).message}`)
    }
  }

  if (nativeRelaySocket) {
    if (failOversizedNativeMessage("fallback native relay")) return
    log(`fallback via relay: ${outboundLogSummary(msg)}`)
    const relayAtSend = nativeRelaySocket
    try {
      socketWriteFramed(relayAtSend, json)
      return
    } catch (err) {
      log(`fallback relay send error: ${(err as Error).message}`)
      if (nativeRelaySocket === relayAtSend) nativeRelaySocket = null
    }
  }

  if (!STANDALONE && stdinAlive) {
    if (failOversizedNativeMessage("fallback native stdio")) return
    log(`fallback via runtime agent: ${outboundLogSummary(msg)}`)
    const encoded = Buffer.from(json, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    const combined = Buffer.concat([header, encoded])
    process.stdout.write(combined)
    return
  }

  const queueKey = contextId ?? "default"
  if (!wsOutboundQueues.has(queueKey)) wsOutboundQueues.set(queueKey, [])
  const queue = wsOutboundQueues.get(queueKey)!
  if (queue.length >= WS_QUEUE_CAP) queue.shift()
  queue.push(json)
  log(`queued for ws [${queueKey}] (${queue.length} pending): ${outboundLogSummary(msg).slice(0, 100)}`)
}

let stdinAlive = !STANDALONE

if (!STANDALONE) {
  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk])
    processStdinBuffer()
  })

  process.stdin.on("end", () => {
    stdinAlive = false
    log("stdin ended (native port disconnected) — daemon continues in standalone mode")
  })

  process.stdin.on("error", (err) => {
    log(`stdin error: ${err.message}`)
  })

  process.stdin.resume()
} else {
  log("standalone mode — no native messaging stdin")
}

const REQUEST_TIMEOUT_MS = 180_000
const LONG_REQUEST_TIMEOUT_MS = 600_000
const BINARY_SINK_MAGIC = Buffer.from("IBS1")
const BINARY_SINK_MAX_HEADER_BYTES = 64 * 1024

type BinarySinkState = {
  fd: number
  finalPath: string
  tempPath: string
  expectedBytes?: number
  mime?: string
  sourceUrl?: string
  bytes: number
  chunks: number
  lastSeq: number
  hash: ReturnType<typeof createHash>
  startedAt: number
}

const binarySinks = new Map<string, BinarySinkState>()

function requestTimeoutForAction(actionType: string): number {
  if (actionType === "binary_sink_save") return LONG_REQUEST_TIMEOUT_MS
  // iOS XCUITest AX ops (element-tree snapshot, app activate/launch) are slow —
  // the FIRST snapshot initializes the on-device accessibility bridge and waits
  // for app quiescence, which routinely exceeds the generic 15s budget.
  if (actionType.startsWith("ios_")) return 60_000
  return REQUEST_TIMEOUT_MS
}

function sendWsResult(ws: { send: (data: string) => unknown }, id: unknown, result: Record<string, unknown>) {
  if (typeof id !== "string" || id.length === 0) return
  try { ws.send(JSON.stringify({ id, result })) } catch {}
}

// validateBinarySinkPath + binarySinkIntegrityError live in ./binary-sink so the
// path policy and the close-time integrity rule are unit-testable.

function handleBinarySinkOpen(
  ws: { send: (data: string) => unknown },
  request: { id?: string; sinkId?: unknown; path?: unknown; expectedBytes?: unknown; mime?: unknown; sourceUrl?: unknown }
): boolean {
  const id = request.id
  const sinkId = typeof request.sinkId === "string" && request.sinkId.length > 0
    ? request.sinkId
    : crypto.randomUUID()
  const validated = validateBinarySinkPath(request.path)
  if (!validated.path) {
    sendWsResult(ws, id, { success: false, error: validated.error || "invalid path" })
    return true
  }

  if (binarySinks.has(sinkId)) {
    sendWsResult(ws, id, { success: false, error: `binary_sink_open: duplicate sinkId ${sinkId}` })
    return true
  }

  const tempPath = `${validated.path}.interceptor-${sinkId}.tmp`
  try {
    mkdirSync(dirname(validated.path), { recursive: true, mode: 0o700 })
    const fd = openSync(tempPath, "w", 0o600)
    binarySinks.set(sinkId, {
      fd,
      finalPath: validated.path,
      tempPath,
      expectedBytes: typeof request.expectedBytes === "number" ? request.expectedBytes : undefined,
      mime: typeof request.mime === "string" ? request.mime : undefined,
      sourceUrl: typeof request.sourceUrl === "string" ? request.sourceUrl : undefined,
      bytes: 0,
      chunks: 0,
      lastSeq: -1,
      hash: createHash("sha256"),
      startedAt: Date.now(),
    })
    sendWsResult(ws, id, { success: true, data: { sinkId, path: validated.path, tempPath } })
  } catch (err) {
    sendWsResult(ws, id, { success: false, error: `binary_sink_open failed: ${(err as Error).message}` })
  }
  return true
}

function closeBinarySink(sinkId: string): { success: boolean; error?: string; data?: Record<string, unknown> } {
  const sink = binarySinks.get(sinkId)
  if (!sink) return { success: false, error: `binary sink not found: ${sinkId}` }
  binarySinks.delete(sinkId)

  try {
    closeSync(sink.fd)
    // Integrity gate: never promote a short / truncated temp file to the final
    // path. When the source size is known (expectedBytes), require an exact byte
    // match before the atomic rename; otherwise discard the partial file and
    // fail. This closes the silent-truncation hole where a mid-stream write
    // error — whose error frame the streamer cannot ack — would still rename a
    // partial file as a successful save.
    const integrityError = binarySinkIntegrityError(sink.expectedBytes, sink.bytes)
    if (integrityError) {
      try { if (existsSync(sink.tempPath)) unlinkSync(sink.tempPath) } catch {}
      return { success: false, error: integrityError }
    }
    renameSync(sink.tempPath, sink.finalPath)
    const sha256 = sink.hash.digest("hex")
    return {
      success: true,
      data: {
        sinkId,
        path: sink.finalPath,
        bytes: sink.bytes,
        chunks: sink.chunks,
        sha256,
        mime: sink.mime,
        expectedBytes: sink.expectedBytes,
        durationMs: Date.now() - sink.startedAt,
      }
    }
  } catch (err) {
    try { closeSync(sink.fd) } catch {}
    try { if (existsSync(sink.tempPath)) unlinkSync(sink.tempPath) } catch {}
    return { success: false, error: `binary_sink_close failed: ${(err as Error).message}` }
  }
}

function abortBinarySink(sinkId: string): { success: boolean; error?: string } {
  const sink = binarySinks.get(sinkId)
  if (!sink) return { success: true }
  binarySinks.delete(sinkId)
  try { closeSync(sink.fd) } catch {}
  try { if (existsSync(sink.tempPath)) unlinkSync(sink.tempPath) } catch {}
  return { success: true }
}

function handleBinarySinkControl(
  ws: { send: (data: string) => unknown },
  request: { id?: string; type?: string; sinkId?: unknown; [key: string]: unknown }
): boolean {
  if (request.type === "binary_sink_open") {
    return handleBinarySinkOpen(ws, request)
  }
  if (request.type === "binary_sink_close") {
    const sinkId = typeof request.sinkId === "string" ? request.sinkId : ""
    sendWsResult(ws, request.id, closeBinarySink(sinkId))
    return true
  }
  if (request.type === "binary_sink_abort") {
    const sinkId = typeof request.sinkId === "string" ? request.sinkId : ""
    sendWsResult(ws, request.id, abortBinarySink(sinkId))
    return true
  }
  return false
}

function handleBinarySinkFrame(ws: { send: (data: string) => unknown }, raw: Buffer): boolean {
  if (raw.byteLength < 8) return false
  if (!raw.subarray(0, 4).equals(BINARY_SINK_MAGIC)) return false

  const headerLen = raw.readUInt32LE(4)
  if (headerLen <= 0 || headerLen > BINARY_SINK_MAX_HEADER_BYTES || raw.byteLength < 8 + headerLen) {
    try { ws.send(JSON.stringify({ result: { success: false, error: "invalid binary sink frame header" } })) } catch {}
    return true
  }

  let header: { sinkId?: unknown; seq?: unknown; id?: unknown }
  try {
    header = JSON.parse(raw.subarray(8, 8 + headerLen).toString("utf-8"))
  } catch {
    try { ws.send(JSON.stringify({ result: { success: false, error: "invalid binary sink frame JSON" } })) } catch {}
    return true
  }

  const sinkId = typeof header.sinkId === "string" ? header.sinkId : ""
  const sink = binarySinks.get(sinkId)
  if (!sink) {
    sendWsResult(ws, header.id, { success: false, error: `binary sink not found: ${sinkId}` })
    return true
  }

  const seq = typeof header.seq === "number" ? header.seq : sink.lastSeq + 1
  if (seq !== sink.lastSeq + 1) {
    sendWsResult(ws, header.id, { success: false, error: `binary sink sequence mismatch: expected ${sink.lastSeq + 1}, got ${seq}` })
    return true
  }

  const payload = raw.subarray(8 + headerLen)
  try {
    writeSync(sink.fd, payload)
    sink.hash.update(payload)
    sink.bytes += payload.byteLength
    sink.chunks += 1
    sink.lastSeq = seq
  } catch (err) {
    // A write failure aborts the whole sink: close the fd, discard the temp
    // file, and drop it from the registry so a later close() cannot promote a
    // truncated file (and so the fd / temp file are not leaked). The subsequent
    // close() will report "binary sink not found", surfacing the failure.
    binarySinks.delete(sinkId)
    try { closeSync(sink.fd) } catch {}
    try { if (existsSync(sink.tempPath)) unlinkSync(sink.tempPath) } catch {}
    sendWsResult(ws, header.id, { success: false, error: `binary sink write failed: ${(err as Error).message}` })
  }
  return true
}

async function handleOsAction(
  id: string,
  action: { type?: string; [key: string]: unknown } | undefined
): Promise<{ success: boolean; error?: string; data?: unknown } | null> {
  if (!action) return null
  const startTime = Date.now()

  switch (action.type) {
    case "os_click": {
      const windowBounds = action.windowBounds as { left: number; top: number; width: number; height: number } | undefined
      const pageX = action.pageX as number | undefined
      const pageY = action.pageY as number | undefined
      if (!windowBounds || pageX === undefined || pageY === undefined) {
        return { success: false, error: "os_click requires windowBounds, pageX, pageY" }
      }
      const chromeUiHeight = (action.chromeUiHeight as number) || 88
      const { screenX, screenY } = translateCoords(pageX, pageY, windowBounds, chromeUiHeight)
      const button = (action.button as "left" | "right") || "left"
      const clickCount = (action.clickCount as number) || 1
      log(`[${id.slice(0, 8)}] os_click screen(${screenX},${screenY}) button=${button} clicks=${clickCount}`)
      const result = await osClick(screenX, screenY, button, clickCount)
      emitEvent("os_action", { requestId: id, action: "os_click", duration: Date.now() - startTime, success: result.success })
      return result
    }

    case "os_key": {
      const key = action.key as string
      const modifiers = (action.modifiers as string[]) || []
      if (!key) return { success: false, error: "os_key requires key" }
      log(`[${id.slice(0, 8)}] os_key ${modifiers.join("+")}${modifiers.length ? "+" : ""}${key}`)
      const result = await osKey(key, modifiers)
      emitEvent("os_action", { requestId: id, action: "os_key", duration: Date.now() - startTime, success: result.success })
      return result
    }

    case "os_type": {
      const text = action.text as string
      if (!text) return { success: false, error: "os_type requires text" }
      if (action.sensitive === true) log(`[${id.slice(0, 8)}] os_type (sensitive, ${text.length} chars)`)
      else log(`[${id.slice(0, 8)}] os_type "${text.slice(0, 50)}"`)
      const result = await osType(text)
      emitEvent("os_action", { requestId: id, action: "os_type", duration: Date.now() - startTime, success: result.success })
      return result
    }

    case "os_move": {
      const path = action.path as Array<{ x: number; y: number }> | undefined
      const windowBounds = action.windowBounds as { left: number; top: number; width: number; height: number } | undefined
      if (!path || !windowBounds) return { success: false, error: "os_move requires path and windowBounds" }
      const chromeUiHeight = (action.chromeUiHeight as number) || 88
      const screenPath = path.map(p => translateCoords(p.x, p.y, windowBounds, chromeUiHeight))
        .map(p => ({ x: p.screenX, y: p.screenY }))
      const duration = (action.duration as number) || 100
      log(`[${id.slice(0, 8)}] os_move ${screenPath.length} points`)
      const result = await osMove(screenPath, duration)
      emitEvent("os_action", { requestId: id, action: "os_move", duration: Date.now() - startTime, success: result.success })
      return result
    }

    default:
      return null
  }
}

let socketServer: Bun.TCPSocketListener<undefined> | Bun.UnixSocketListener<undefined> | null = null

const socketHandlers: Bun.SocketHandler<undefined> = {
      open(socket: Bun.Socket<undefined>) {
        socketBuffers.set(socket, Buffer.alloc(0))
        log("cli connected via socket")
      },
      data(socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
        let buf = Buffer.concat([socketBuffers.get(socket) || Buffer.alloc(0), Buffer.from(raw)])

        while (buf.length >= 4) {
          const msgLen = buf.readUInt32LE(0)
          if (msgLen === 0 || msgLen > MAX_UPLOAD_FRAME_BYTES) {
            // Oversized/corrupt frame. Recover the request id from the buffered
            // prefix — it sits at the front of the JSON ({"id":"…","action":…}) —
            // so the CLI gets an honest error instead of a silent 15s timeout,
            // then drop the buffer.
            let recoveredId: string | undefined
            try {
              const prefix = buf.subarray(4, Math.min(buf.length, 4 + 256)).toString("utf-8")
              const m = prefix.match(/"id"\s*:\s*"([^"]+)"/)
              if (m) recoveredId = m[1]
            } catch {}
            log(`oversized socket frame: ${msgLen} bytes exceeds ${MAX_UPLOAD_FRAME_BYTES}, discarding${recoveredId ? ` (id ${recoveredId})` : ""}`)
            if (recoveredId) {
              socketWriteFramed(socket, JSON.stringify({ id: recoveredId, result: { success: false, error: `payload too large: ${msgLen} bytes exceeds transport limit ${MAX_UPLOAD_FRAME_BYTES} — split the upload or use a smaller file` } }))
            }
            buf = Buffer.alloc(0)
            break
          }
          if (buf.length < 4 + msgLen) break

          const jsonBuf = buf.subarray(4, 4 + msgLen)
          buf = buf.subarray(4 + msgLen)

          let request: { id?: string; action?: unknown; tabId?: number; contextId?: string; type?: string }
          try {
            request = JSON.parse(jsonBuf.toString("utf-8"))
          } catch {
            socketWriteFramed(socket, JSON.stringify({ error: "invalid JSON" }))
            continue
          }

          // Native relay registration — relay process identifies itself
          if (request.type === "native-relay") {
            ;(socket as any).__nativeRelay = true
            if (nativeRelaySocket && nativeRelaySocket !== socket) {
              log("native relay superseded — previous registration replaced (reconnect or second browser)")
            }
            nativeRelaySocket = socket
            log("native relay registered via IPC socket")
            continue
          }

          // Native relay message forwarding — route to extension protocol handler
          if ((socket as any).__nativeRelay) {
            // Keepalive pings are answered directly on the originating socket:
            // the extension's pong timer must measure THIS link, not the
            // relay-slot routing state (a superseded slot starved pongs and
            // forced endless 15s-timeout reconnects).
            if (isRelayPing(request)) {
              log("received ping (relay), sending pong to origin")
              socketWriteFramed(socket, JSON.stringify({ type: "pong" }))
              emitEvent("keepalive_ping")
              continue
            }
            handleNativeMessage(request as any)
            continue
          }

          const id = request.id ?? crypto.randomUUID()
          const action = request.action as { type?: string; [key: string]: unknown } | undefined
          const actionType = action?.type || "unknown"
          log(`cli request: ${id} ${actionLogSummary(request.action)}`)
          emitEvent("request_received", { requestId: id, action: actionType })

          if (action?.type === "daemon_shutdown") {
            const valid = action.protocolVersion === 1 && constantTimeTokenEquals(action.token, daemonIdentity.shutdownToken)
            if (!valid) {
              socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "authenticated daemon shutdown rejected" } }))
              emitEvent("daemon_shutdown_rejected", { requestId: id })
              continue
            }
            socketWriteFramed(socket, JSON.stringify({
              id,
              result: {
                success: true,
                data: {
                  accepted: true,
                  protocolVersion: 1,
                  pid: daemonIdentity.pid,
                  execPath: daemonIdentity.execPath,
                  startedAt: daemonIdentity.startedAt,
                },
              },
            }))
            emitEvent("daemon_shutdown_accepted", { requestId: id, reason: typeof action.reason === "string" ? action.reason.slice(0, 64) : "unspecified" })
            setTimeout(() => gracefulShutdown("authenticated shutdown"), 50)
            continue
          }

          if (action?.type === "contexts") {
            const ids = [...extensionWsMap.keys(), ...cdpManager.contextIds(), ...iosManager.contextIds()]
            const list = action.verbose === true
              ? describeContexts(ids, (c) => extensionWsMap.get(c), { runtime: NATIVE_CONTEXT_PREFIX, cdp: CDP_CONTEXT_PREFIX, ios: IOS_CONTEXT_PREFIX })
              : ids
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: true, data: list } }))
            continue
          }

          // Runtime Agent surface: list connected in-process agents.
          if (action?.type === "native_status") {
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: true, data: [...nativeAgentMeta.values()] } }))
            continue
          }

          // issue #244: vault verbs and secret-bearing deliveries resolve here,
          // before any surface dispatch. The log line above carried the name
          // only (daemon/redact.ts).
          if (action?.type === "macos_secret") {
            handleSecretAction(action, request).then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
            continue
          }
          if (action && (action.type === "macos_sudo" || typeof action.secret === "string")) {
            deliverWithSecret(id, action, request, socket, actionType).catch((err) => {
              socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `secret delivery failed: ${(err as Error).message}` } }))
            })
            continue
          }
          // issue #248: read-only Chrome credential enumeration, and the
          // `type --chrome-login` fill that resolves a saved password here.
          if (action?.type === "chrome_creds") {
            handleChromeCredsAction(action).then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
            continue
          }
          if (action && action.chromeLogin && typeof action.chromeLogin === "object") {
            deliverWithChromeLogin(id, action, request, socket, actionType).catch((err) => {
              socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `chrome-login delivery failed: ${(err as Error).message}` } }))
            })
            continue
          }

          // CDP-app surface: lifecycle actions → manager; verbs for
          // cdp: contexts → manager (app: contexts are extensions, handled below).
          if (action?.type && CDP_ACTION_TYPES.has(action.type)) {
            cdpManager.handle(action as { type: string; [k: string]: unknown })
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `cdp dispatch failed: ${(err as Error).message}` } })))
            continue
          }
          if (request.contextId && request.contextId.startsWith(CDP_CONTEXT_PREFIX)) {
            cdpManager.executeVerb(request.contextId, (action as { type: string; [k: string]: unknown }) ?? { type: "unknown" })
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `cdp verb failed: ${(err as Error).message}` } })))
            continue
          }

          // iOS device surface: lifecycle actions → manager; verbs for ios: contexts → manager.
          if (action?.type && IOS_ACTION_TYPES.has(action.type)) {
            iosManager.handle(action as { type: string; [k: string]: unknown })
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `ios dispatch failed: ${(err as Error).message}` } })))
            continue
          }
          // iOS WEB lane: MUST be tested before the broad `ios:` fallback
          // below so a web action never reaches ensureRunner just for carrying a
          // device context. The web lane needs no runner / Developer Mode.
          if (action?.type && IOS_WEB_ACTION_TYPES.has(action.type)) {
            iosWebManager.handle(action as { type: string; [k: string]: unknown }, request.contextId)
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `ios web dispatch failed: ${(err as Error).message}` } })))
            continue
          }
          // iOS device-service introspection lane: tested before the
          // broad `ios:` fallback so service actions never reach ensureRunner.
          if (action?.type && IOS_SVC_ACTION_TYPES.has(action.type)) {
            iosServiceManager.handle(action as { type: string; [k: string]: unknown }, request.contextId)
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `ios svc dispatch failed: ${(err as Error).message}` } })))
            continue
          }
          // iOS Instruments/DTX + telemetry + developer-service lanes:
          // tested before the broad `ios:` fallback so they never reach ensureRunner.
          if (action?.type && IOS_DEV_ACTION_TYPES.has(action.type)) {
            iosDevManager.handle(action as { type: string; [k: string]: unknown }, request.contextId)
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `ios dev dispatch failed: ${(err as Error).message}` } })))
            continue
          }
          if ((action?.type && IOS_VERB_TYPES.has(action.type)) || (request.contextId && request.contextId.startsWith(IOS_CONTEXT_PREFIX))) {
            iosManager.executeVerb(request.contextId ?? "", (action as { type: string; [k: string]: unknown }) ?? { type: "unknown" })
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `ios verb failed: ${(err as Error).message}` } })))
            continue
          }

          if (action?.type?.startsWith("os_") && action.windowBounds && action.pageX !== undefined) {
            handleOsAction(id, action).then((osResult) => {
              if (osResult) {
                socketWriteFramed(socket, JSON.stringify({ id, result: osResult }))
              } else {
                socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "unhandled os action" } }))
              }
            })
            continue
          }

          // Route macos_ actions to the native bridge
          if (action?.type?.startsWith("macos_")) {
            routeToBridge(id, action, socket, actionType)
            continue
          }

          dispatchToExtension(id, request, socket, actionType)
        }

        socketBuffers.set(socket, buf)
      },
      drain(socket: Bun.Socket<undefined>) {
        drainSocketQueue(socket)
      },
      close(socket: Bun.Socket<undefined>) {
        if ((socket as any).__nativeRelay) {
          const { slot, released } = relaySlotAfterClose(nativeRelaySocket, socket)
          nativeRelaySocket = slot
          if (released) {
            log("native relay disconnected")
          } else {
            log("stale native relay closed — current relay registration kept")
          }
        }
        socketBuffers.delete(socket)
        releaseSocketQueue(socket)
        log("cli disconnected")
      },
      error(_socket: Bun.Socket<undefined>, err: Error) {
        log(`socket error: ${err.message}`)
      }
    }

function listenCliSocket(): Bun.TCPSocketListener<undefined> | Bun.UnixSocketListener<undefined> {
  if (IS_WIN) return Bun.listen({ hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers })
  // We hold the WS port (the singleton token), so any leftover socket file is ours to clear.
  try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH) } catch {}
  return Bun.listen({ unix: SOCKET_PATH, socket: socketHandlers })
}

function writePidFile(): void {
  writeFileSync(PID_PATH, `${process.pid}\n${transportLabel()}\n`)
}

try {
  socketServer = listenCliSocket()
  log(`socket listening on ${transportLabel()}`)
} catch (err) {
  log(`socket listen failed: ${(err as Error).message}`)
  if (wsServer) wsServer.stop(true)
  process.exit(1)
}

// Synchronous so no reader ever sees a truncated pid file (the "invalid" branch).
writePidFile()
log(`pid file written: ${process.pid}`)

// Restore whichever runtime files no longer describe this process. Anything
// can remove files under /tmp (a stale-pid guess by an older build, a pkg
// postinstall, a tmp cleaner, a user); the daemon is still the port owner, so
// it rebuilds them instead of stranding every CLI verb on "daemon failed to
// start". Runs on every GET /health (the CLI and a starting native host probe
// that before deciding anything) and on the keepalive tick.
function healRuntimeFiles(reason: string): string[] {
  if (!ownsRuntimeFiles || shuttingDown || !socketServer) return []
  const healed: string[] = []
  // Each step is contained: a transient write/rename/listen failure must not
  // turn /health into a 500 (the probe would then classify the live owner as
  // foreign and the CLI would fail closed) or reject the keepalive loop.
  const attempt = (name: string, fn: () => void) => {
    try {
      fn()
      healed.push(name)
    } catch (err) {
      log(`could not restore ${name} (${reason}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // The lock is derived from daemonIdentity; any drifted field (pid, port,
  // shutdown protocol, or token) makes the CLI's authenticated readiness and
  // `daemon stop` fail, so compare the whole identity, not only the pid.
  let lockMatches = false
  try {
    const lock = readLockFile(LOCK_PATH)
    lockMatches = !!lock
      && lock.pid === daemonIdentity.pid
      && lock.wsPort === daemonIdentity.wsPort
      && lock.shutdownProtocolVersion === daemonIdentity.shutdownProtocolVersion
      && lock.shutdownToken === daemonIdentity.shutdownToken
  } catch {}
  if (!lockMatches) attempt("lock", () => writeLockFile(LOCK_PATH, daemonIdentity))
  let pidOnDisk: number | null = null
  try { pidOnDisk = parseDaemonPidFile(readFileSync(PID_PATH, "utf-8")) } catch {}
  if (pidOnDisk !== process.pid) attempt("pid", writePidFile)
  if (!IS_WIN && !existsSync(SOCKET_PATH)) {
    // Stop the orphaned listener first (without closing its in-flight
    // connections), then listen anew. Newer Bun releases unlink the listener's
    // socket path on stop(), which would delete a freshly created file if the
    // new listener came first; the path is already gone here, so stopping
    // first is safe on every Bun.
    attempt("socket", () => {
      try { socketServer!.stop() } catch {}
      socketServer = listenCliSocket()
    })
  }
  if (healed.length) log(`restored runtime files (${reason}): ${healed.join(", ")}`)
  return healed
}

function startWsServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve<undefined>({
    port: WS_PORT,
    fetch(req, server) {
      if (server.upgrade(req, {})) return
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ service: DAEMON_HEALTH_SERVICE, pid: process.pid, version: VERSION, wsPort: WS_PORT, healed: healRuntimeFiles("health probe") })
      }
      return new Response(LEGACY_HEALTH_BODY, { status: 200 })
    },
    websocket: {
      // Bun's default maxPayloadLength is 16 MiB and the server responds to a
      // larger message by CLOSING the connection — killing every in-flight
      // request on that socket (verified live: 15 MiB accepted, 17 MiB →
      // close 1006). This is the transport screenshots/save are auto-routed
      // to precisely because it carries large payloads, so align its ceiling
      // with the unix-socket transport's frame cap.
      maxPayloadLength: MAX_UPLOAD_FRAME_BYTES,
      open(ws) {
        log(`ws client connected`)
      },
      message(ws, raw) {
        if (typeof raw !== "string" && handleBinarySinkFrame(ws, Buffer.from(raw))) {
          return
        }
        const rawStr = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8")
        log(`ws recv: ${rawStr.slice(0, 300)}`)
        let request: { id?: string; action?: unknown; tabId?: number; contextId?: string; type?: string; result?: unknown }
        try {
          request = JSON.parse(rawStr)
        } catch {
          ws.send(JSON.stringify({ error: "invalid JSON" }))
          return
        }

        if (handleBinarySinkControl(ws, request as any)) {
          return
        }

        // iOS InterceptorRunner: once a socket has registered as a
        // runner, all its frames are {id,result} verb replies — route them to the
        // manager's RunnerChannel before any generic {id,result} handling.
        if (iosManager.isRunnerSocket(ws as any)) {
          iosManager.handleRunnerMessage(ws as any, request as { id?: string; result?: { success: boolean; data?: unknown; error?: string } })
          return
        }

        if (request.type === "extension") {
          const ctxId = request.contextId ?? "default"
          const claim = claimContextId(extensionWsMap, ws as ContextSocket, ctxId)
          ws.send(JSON.stringify(claim.message))
          if (claim.status === "conflict") {
            return
          }
          const extVersion = (request as { version?: unknown }).version
          ;(ws as ContextSocket).__version = typeof extVersion === "string" ? extVersion : undefined
          log(`ws extension registered [context: ${ctxId}]${typeof extVersion === "string" ? ` extension ${extVersion}` : ""}`)
          drainWsOutboundQueue(ctxId)
          return
        }

        // Runtime Agent surface: an in-process agent dylib registers
        // here. We store it in extensionWsMap under its runtime:<app> contextId
        // so verb routing / contexts / disambiguation all work unchanged, plus
        // nativeAgentMeta for `macos runtime status`.
        if (request.type === NATIVE_REGISTER_TYPE) {
          const r = request as { contextId?: string; pid?: number; slice?: string; appName?: string; frameworks?: string[]; wayIn?: string }
          const ctxId = r.contextId && r.contextId.startsWith(NATIVE_CONTEXT_PREFIX) ? r.contextId : NATIVE_CONTEXT_PREFIX + (r.contextId ?? "app")
          const claim = claimContextId(extensionWsMap, ws as ContextSocket, ctxId)
          ws.send(JSON.stringify(claim.message))
          if (claim.status === "conflict") {
            return
          }
          if (claim.previousContextId) {
            nativeAgentMeta.delete(claim.previousContextId)
          }
          ;(ws as any).__native = true
          nativeAgentMeta.set(ctxId, {
            contextId: ctxId,
            appName: r.appName ?? ctxId.slice(NATIVE_CONTEXT_PREFIX.length),
            pid: typeof r.pid === "number" ? r.pid : undefined,
            slice: (r.slice as CodeSlice) ?? "unknown",
            wayIn: r.wayIn as NativeWayIn | undefined,
            frameworks: Array.isArray(r.frameworks) ? r.frameworks : undefined,
            registeredAt: Date.now(),
            connection: "connected",
          })
          log(`ws native agent registered [context: ${ctxId} pid: ${r.pid ?? "?"} slice: ${r.slice ?? "?"}]`)
          emitEvent("native_agent_registered", { contextId: ctxId, pid: r.pid, slice: r.slice, appName: r.appName })
          drainWsOutboundQueue(ctxId)
          return
        }

        // Runtime Agent surface: the agent delegates a TCC-gated /
        // OS-level op to the bridge. Routes the macos_* action to the bridge and
        // returns {id,result} back to the agent's ws.
        if (request.type === NATIVE_DELEGATE_TYPE) {
          const id = request.id ?? crypto.randomUUID()
          const action = (request.action as Record<string, unknown> | undefined) ?? { type: "unknown" }
          const ctxId = (ws as any).__contextId ?? "runtime:?"
          forwardDelegateToBridge(id, action, ws, ctxId)
          return
        }

        // iOS device surface: the on-device InterceptorRunner dials in
        // and registers {type:"ios", udid, token}. The manager validates the
        // per-session token, binds the socket to a RunnerChannel, and the daemon
        // tags it so subsequent frames route to handleRunnerMessage (above).
        if (request.type === IOS_REGISTER_TYPE) {
          const r = request as { udid?: string; token?: string; contextId?: string }
          const ack = iosManager.registerRunner(ws as any, r)
          try { ws.send(JSON.stringify({ type: IOS_REGISTER_TYPE, ...ack })) } catch {}
          if (ack.ok) log(`ws ios runner registered [context: ${ack.contextId}]`)
          else log(`ws ios runner registration rejected: ${ack.error}`)
          return
        }

        if (request.type === "keepalive") {
          log("ws keepalive")
          // Ack so the extension can detect a half-open socket. After MV3 SW
          // hibernation the OS socket can wedge OPEN-but-dead: the extension's
          // outbound keepalives keep flowing while its ws.onmessage is silently
          // severed. The ack is the inbound frame the extension watches for; N
          // consecutive unacked keepalives means the read side is gone and it
          // must force a reconnect. Older extensions ignore this frame.
          //
          // This app-level ack is NOT redundant with Bun's protocol-level pings
          // (sendPings, on by default): those are RFC 6455 control frames the
          // browser's ws stack answers internally — extension JS never sees
          // them, so they can't drive half-open detection on the client side.
          //
          // Bun's ServerWebSocket.send() reports failure via return value, not
          // exceptions: -1 = enqueued with backpressure, 0 = dropped due to a
          // connection issue, 1+ = bytes sent.
          const ackSent = ws.send(JSON.stringify({ type: "keepalive_ack", timestamp: Date.now() }))
          if (ackSent === 0) log("ws keepalive_ack dropped (connection issue) — extension will detect via miss limit")
          return
        }

        if (request.type === "event") {
          // Extension-originated event stream (monitor, keepalive_ping, etc.)
          handleNativeMessage(request as any)
          return
        }

        if ((request as any).id && (request as any).result !== undefined) {
          handleNativeMessage(request as any)
          return
        }

        const id = request.id ?? crypto.randomUUID()
        log(`ws request: ${id} ${actionLogSummary(request.action)}`)

        const actionType = (request.action as { type?: string })?.type || "unknown"

        if (actionType === "daemon_shutdown") {
          ws.send(JSON.stringify({ id, result: { success: false, error: "daemon shutdown is accepted only on the local IPC transport" } }))
          return
        }

        // CDP-app surface over the WebSocket transport (screenshot etc.).
        if (CDP_ACTION_TYPES.has(actionType)) {
          cdpManager.handle(request.action as { type: string; [k: string]: unknown })
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `cdp dispatch failed: ${(err as Error).message}` } })) } catch {} })
          return
        }
        if (request.contextId && request.contextId.startsWith(CDP_CONTEXT_PREFIX)) {
          cdpManager.executeVerb(request.contextId, (request.action as { type: string; [k: string]: unknown }) ?? { type: "unknown" })
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `cdp verb failed: ${(err as Error).message}` } })) } catch {} })
          return
        }

        // iOS device surface over the WebSocket transport (screenshot etc.).
        if (IOS_ACTION_TYPES.has(actionType)) {
          iosManager.handle(request.action as { type: string; [k: string]: unknown })
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `ios dispatch failed: ${(err as Error).message}` } })) } catch {} })
          return
        }
        // iOS WEB lane: tested before the broad `ios:` fallback below.
        if (IOS_WEB_ACTION_TYPES.has(actionType)) {
          iosWebManager.handle(request.action as { type: string; [k: string]: unknown }, request.contextId)
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `ios web dispatch failed: ${(err as Error).message}` } })) } catch {} })
          return
        }
        // iOS device-service introspection lane: before the broad `ios:` fallback.
        if (IOS_SVC_ACTION_TYPES.has(actionType)) {
          iosServiceManager.handle(request.action as { type: string; [k: string]: unknown }, request.contextId)
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `ios svc dispatch failed: ${(err as Error).message}` } })) } catch {} })
          return
        }
        // iOS Instruments/DTX + telemetry + developer-service lanes: before the broad `ios:` fallback.
        if (IOS_DEV_ACTION_TYPES.has(actionType)) {
          iosDevManager.handle(request.action as { type: string; [k: string]: unknown }, request.contextId)
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `ios dev dispatch failed: ${(err as Error).message}` } })) } catch {} })
          return
        }
        if ((IOS_VERB_TYPES.has(actionType)) || (request.contextId && request.contextId.startsWith(IOS_CONTEXT_PREFIX))) {
          iosManager.executeVerb(request.contextId ?? "", (request.action as { type: string; [k: string]: unknown }) ?? { type: "unknown" })
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `ios verb failed: ${(err as Error).message}` } })) } catch {} })
          return
        }

        const contextValidation = validateContextRouting({
          contextId: request.contextId,
          connectedContexts: [...extensionWsMap.keys()],
          nativeRelayAvailable: !!nativeRelaySocket,
          cdpContexts: cdpManager.contextIds(),
          iosContexts: iosManager.contextIds(),
        })
        if (!contextValidation.ok) {
          ws.send(JSON.stringify({ id, result: { success: false, error: contextValidation.error } }))
          return
        }

        const timer = setTimeout(() => {
          pendingRequests.delete(id)
          timedOutRequests.add(id)
          setTimeout(() => timedOutRequests.delete(id), 60_000)
          log(`ws request timeout: ${id}`)
          ws.send(JSON.stringify({ id, result: { success: false, error: "timeout" } }))
        }, requestTimeoutForAction(actionType))

        pendingRequests.set(id, {
          resolve: (response: string) => {
            clearTimeout(timer)
            ws.send(response)
          },
          timer,
          socket: { write: () => 0, remoteAddress: "ws" } as any,
          startTime: Date.now(),
          actionType
        })

        sendNativeMessage({ id, action: request.action, tabId: request.tabId }, request.contextId)
      },
      close(ws, code, reason) {
        // A 1009 here means a client message exceeded maxPayloadLength and
        // Bun killed the connection — log it so the failure is diagnosable
        // from the daemon log instead of surfacing only as a CLI timeout.
        if (code !== 1000 && code !== 1001) {
          log(`ws client closed: code ${code}${reason ? ` reason ${reason}` : ""}`)
        }
        // iOS InterceptorRunner socket closed → drop its channel + context.
        if (iosManager.isRunnerSocket(ws as any)) {
          iosManager.handleRunnerClose(ws as any)
        }
        const ctxId = (ws as any).__contextId
        if (ctxId && extensionWsMap.get(ctxId) === ws) {
          extensionWsMap.delete(ctxId)
        }
        if (ctxId && nativeAgentMeta.has(ctxId)) {
          nativeAgentMeta.delete(ctxId)
          emitEvent("native_agent_disconnected", { contextId: ctxId })
        }
        log(`ws client disconnected [context: ${ctxId ?? "unknown"}]`)
      }
    }
  })
}

function gracefulShutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} received, draining ${pendingRequests.size} pending requests`)
  for (const [id, req] of pendingRequests) {
    clearTimeout(req.timer)
    socketWriteFramed(req.socket, JSON.stringify({ id, result: { success: false, error: "daemon shutting down" } }))
  }
  pendingRequests.clear()
  try { cdpManager.shutdown() } catch {} // close outbound CDP sockets + disable Fetch/Network on targets
  try { iosManager.shutdown() } catch {} // close WDA sessions + kill tunnel/forward/runner processes
  if (socketServer) {
    socketServer.stop(true)
    socketServer = null
  }
  if (wsServer) wsServer.stop(true)
  cleanupOwnedRuntimeFiles(lifecycleDeps(), ownsRuntimeFiles)
  log("shutdown complete")
  process.exit(0)
}

process.on("exit", (code) => {
  log(`exiting with code ${code}`)
  cleanupOwnedRuntimeFiles(lifecycleDeps(), ownsRuntimeFiles)
})
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"))
process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${err.message}\n${err.stack}`)
})
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason}`)
})

// Issue #216 — idle-spin watchdog (see daemon/spin-watchdog.ts for the
// rationale and the limit: it cannot see a blocked main thread). "Idle" means
// nothing is connected and nothing is in flight; the bridge is our own outbound
// link, not a client, so it does not count.
function daemonIsIdle(): boolean {
  return socketBuffers.size === 0
    && extensionWsMap.size === 0
    && !nativeRelaySocket
    && pendingRequests.size === 0
    && bridgePending.size === 0
    && cdpManager.contextIds().length === 0
    && iosManager.contextIds().length === 0
}
let spinState: SpinWatchdogState = { busyIdleTicks: 0 }
let spinCpu = process.cpuUsage()
let spinWall = Date.now()
let spinSampleAttempted = false
function spinWatchdogTick(): void {
  if (process.env.INTERCEPTOR_SPIN_WATCHDOG === "off") return
  const now = Date.now()
  const wallMs = now - spinWall
  const cpu = process.cpuUsage(spinCpu)
  const step = spinWatchdogStep(spinState, { cpuMicros: cpu.user + cpu.system, wallMs, idle: daemonIsIdle() })
  spinCpu = process.cpuUsage()
  spinWall = now
  spinState = step.state
  if (step.verdict === "ok") return
  const pct = Math.round(step.busyFraction * 100)
  const rssMb = Math.round(process.memoryUsage().rss / 1048576)
  log(`spin watchdog: ${pct}% CPU over the last ${Math.round(wallMs / 1000)}s with no clients or in-flight requests (tick ${step.state.busyIdleTicks}/${SPIN_EXIT_TICKS}, rss ${rssMb} MiB) — issue #216`)
  emitEvent("daemon_spin_detected", { busyFraction: step.busyFraction, ticks: step.state.busyIdleTicks, rssMb })
  if (!spinSampleAttempted) {
    spinSampleAttempted = true
    void captureSpinSample().then(result => {
      log(`spin watchdog sample: ${JSON.stringify(result)}`)
      emitEvent("daemon_spin_sample", result)
    })
  }
  if (step.verdict !== "exit") return
  log("spin watchdog: exiting so the next CLI call respawns a fresh daemon (INTERCEPTOR_SPIN_WATCHDOG=off disables this)")
  emitEvent("daemon_spin_exit", { busyFraction: step.busyFraction, ticks: step.state.busyIdleTicks, rssMb })
  // gracefulShutdown ends in process.exit(0); if whatever is spinning keeps it
  // from getting there, force the exit.
  setTimeout(() => process.exit(21), 2000)
  gracefulShutdown("spin watchdog")
}

// Global keepalive — prevent Bun from exiting when stdin closes.
// Bun compiled binaries exit when the event loop is empty.
// An infinite async loop guarantees the process stays alive.
async function keepAliveForever() {
  while (true) {
    await Bun.sleep(10_000)
    try { healRuntimeFiles("keepalive tick") } catch (err) { log(`keepalive heal failed: ${err instanceof Error ? err.message : String(err)}`) }
    try { spinWatchdogTick() } catch (err) { log(`spin watchdog failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
}
keepAliveForever()

log("daemon ready, waiting for native messages")
