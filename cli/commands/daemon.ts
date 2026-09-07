import { existsSync } from "node:fs"
import { readLockFile, type LockFileData } from "../../daemon/lifecycle"
import { IPC_PORT, LOCK_PATH, WS_PORT, isProcessAlive } from "../../shared/platform"
import { sendCommand } from "../transport"

export type DaemonStopOptions = {
  reason: string
  timeoutMs: number
}

export type DaemonStopResult = {
  stopped: boolean
  alreadyStopped: boolean
  pid: number | null
  reason: string
}

export function parseDaemonStopArgs(args: string[]): DaemonStopOptions {
  if (args[0] !== "daemon" || args[1] !== "stop") {
    throw new Error("usage: interceptor daemon stop [--reason installer|manual] [--timeout 10000]")
  }
  const allowedFlags = new Set(["--reason", "--timeout", "--json"])
  for (let index = 2; index < args.length; index++) {
    const arg = args[index]
    if (!arg.startsWith("--")) throw new Error(`unexpected daemon argument '${arg}'`)
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
    if (!allowedFlags.has(name)) throw new Error(`unknown daemon stop flag '${name}'`)
    if ((name === "--reason" || name === "--timeout") && !arg.includes("=")) index++
  }

  const readFlag = (name: string, fallback: string): string => {
    const exact = args.indexOf(name)
    if (exact >= 0) {
      const value = args[exact + 1]
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
      return value
    }
    const prefix = `${name}=`
    const joined = args.find(arg => arg.startsWith(prefix))
    return joined ? joined.slice(prefix.length) : fallback
  }

  const reason = readFlag("--reason", "manual")
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(reason)) throw new Error("--reason must be a short lowercase identifier")
  const timeoutRaw = readFlag("--timeout", "10000")
  if (!/^\d+$/.test(timeoutRaw)) throw new Error("--timeout must be an integer number of milliseconds")
  const timeoutMs = Number(timeoutRaw)
  if (timeoutMs < 100 || timeoutMs > 60_000) throw new Error("--timeout must be between 100 and 60000 milliseconds")
  return { reason, timeoutMs }
}

// Zombie-aware: a detached daemon reparented to a non-reaping PID 1 (any
// container started without an init) keeps answering signal 0 after it exits,
// which would make waitForStopped below time out on a daemon that did stop.
function processAlive(pid: number): boolean {
  return isProcessAlive(pid)
}

async function tcpPortOpen(port: number, timeoutMs = 150): Promise<boolean> {
  return await new Promise(resolve => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          try { socket.end() } catch {}
          finish(true)
        },
        data() {},
        connectError() { finish(false) },
        error() { finish(false) },
      },
    }).catch(() => finish(false))
  })
}

export function validateDaemonStopAcknowledgement(lock: LockFileData, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("daemon returned a malformed shutdown acknowledgement")
  const ack = data as Record<string, unknown>
  if (ack.accepted !== true || ack.protocolVersion !== 1) throw new Error("daemon rejected the authenticated shutdown request")
  if (ack.pid !== lock.pid || ack.execPath !== lock.execPath || ack.startedAt !== lock.startedAt) {
    throw new Error("daemon shutdown acknowledgement does not match the locked process identity")
  }
}

async function waitForStopped(lock: LockFileData, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [ipcOpen, wsOpen] = await Promise.all([tcpPortOpen(IPC_PORT), tcpPortOpen(WS_PORT)])
    if (!processAlive(lock.pid) && !ipcOpen && !wsOpen) return
    await Bun.sleep(100)
  }
  throw new Error(`daemon did not exit and release ports ${IPC_PORT}/${WS_PORT} within ${timeoutMs}ms`)
}

export async function stopDaemon(options: DaemonStopOptions): Promise<DaemonStopResult> {
  if (!existsSync(LOCK_PATH)) {
    return { stopped: true, alreadyStopped: true, pid: null, reason: options.reason }
  }
  const lock = readLockFile(LOCK_PATH)
  if (!lock) throw new Error("daemon lock file is malformed")
  if (!processAlive(lock.pid)) {
    return { stopped: true, alreadyStopped: true, pid: lock.pid, reason: options.reason }
  }
  if (lock.shutdownProtocolVersion !== 1 || !lock.shutdownToken) {
    throw new Error("running daemon does not support authenticated shutdown; use the installer legacy migration path")
  }

  const response = await sendCommand({
    type: "daemon_shutdown",
    protocolVersion: 1,
    token: lock.shutdownToken,
    reason: options.reason,
    timeoutMs: options.timeoutMs,
  })
  if (!response.result.success) throw new Error(response.result.error || "daemon shutdown failed")
  validateDaemonStopAcknowledgement(lock, response.result.data)
  await waitForStopped(lock, options.timeoutMs)
  return { stopped: true, alreadyStopped: false, pid: lock.pid, reason: options.reason }
}

export async function runDaemonCommand(args: string[], jsonMode: boolean): Promise<void> {
  try {
    const options = parseDaemonStopArgs(args)
    const result = await stopDaemon(options)
    if (jsonMode) console.log(JSON.stringify({ success: true, ...result }))
    else if (result.alreadyStopped) console.log("daemon already stopped")
    else console.log(`daemon stopped (pid ${result.pid})`)
  } catch (error) {
    const message = (error as Error).message
    if (jsonMode) console.log(JSON.stringify({ success: false, error: message }))
    else console.error(`error: ${message}`)
    process.exitCode = 1
  }
}
