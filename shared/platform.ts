import { readFileSync } from "node:fs"

export type PlatformName = "win32" | "darwin" | string

export type PlatformConfig = {
  isWin: boolean
  temp: string
  sep: string
  socketPath: string
  ipcPort: number
  wsPort: number
  pidPath: string
  lockPath: string
  logPath: string
  eventsPath: string
  monitorSessionsDir: string
  maintenanceGuardPath: string
  transportLabel: string
}

export function resolvePlatformConfig(platform: PlatformName = process.platform, tempOverride = process.env.TEMP): PlatformConfig {
  const isWin = platform === "win32"
  const explicitTemp = process.env.INTERCEPTOR_TEMP
  const temp = explicitTemp || (isWin ? (tempOverride || "C:\\Temp") : "/tmp")
  const sep = isWin ? "\\" : "/"
  const socketPath = process.env.INTERCEPTOR_SOCKET_PATH || `${temp}${sep}interceptor.sock`
  const ipcPort = parseInt(process.env.INTERCEPTOR_IPC_PORT || "19221")
  const wsPort = parseInt(process.env.INTERCEPTOR_WS_PORT || "19222")
  const pidPath = process.env.INTERCEPTOR_PID_PATH || `${temp}${sep}interceptor.pid`
  const lockPath = process.env.INTERCEPTOR_LOCK_PATH || `${temp}${sep}interceptor.lock`
  const logPath = process.env.INTERCEPTOR_LOG_PATH || `${temp}${sep}interceptor.log`
  const eventsPath = process.env.INTERCEPTOR_EVENTS_PATH || `${temp}${sep}interceptor-events.jsonl`
  const monitorSessionsDir = process.env.INTERCEPTOR_MONITOR_SESSIONS_DIR || `${temp}${sep}interceptor-monitor-sessions`
  const maintenanceGuardPath = process.env.INTERCEPTOR_INSTALL_MAINTENANCE_PATH || `${temp}${sep}interceptor.installing`
  const transportLabel = isWin ? `tcp:127.0.0.1:${ipcPort}` : `unix:${socketPath}`
  return { isWin, temp, sep, socketPath, ipcPort, wsPort, pidPath, lockPath, logPath, eventsPath, monitorSessionsDir, maintenanceGuardPath, transportLabel }
}

const current = resolvePlatformConfig()

export const IS_WIN = current.isWin
export const TEMP = current.temp
export const SEP = current.sep
export const SOCKET_PATH = current.socketPath
export const IPC_PORT = current.ipcPort
export const WS_PORT = current.wsPort
export const PID_PATH = current.pidPath
export const LOCK_PATH = current.lockPath
export const LOG_PATH = current.logPath
export const EVENTS_PATH = current.eventsPath
export const MONITOR_SESSIONS_DIR = current.monitorSessionsDir
export const MAINTENANCE_GUARD_PATH = current.maintenanceGuardPath
export const EVENTS_MAX_SIZE = 10 * 1024 * 1024

/**
 * Is `pid` a live process — counting a zombie as dead?
 *
 * `process.kill(pid, 0)` is the usual liveness probe, but it succeeds for a
 * zombie: an exited child whose parent has not reaped it still owns its PID and
 * still accepts signal 0. That matters on Linux specifically, because the daemon
 * is spawned detached and gets reparented to PID 1 — and in a container PID 1 is
 * frequently the app's own entrypoint rather than an init that reaps (plain
 * `docker run` without `--init`, most CI containers, many Kubernetes pods). There
 * the exited daemon stays a zombie forever, so a bare kill(pid, 0) reports a
 * daemon that is long gone as running: `interceptor daemon stop` then waits out
 * its whole timeout and exits non-zero on a daemon it successfully stopped.
 *
 * Linux exposes the real answer in /proc/<pid>/stat field 3 (state); "Z" is a
 * zombie. Read that when /proc is available and fall back to the signal probe
 * everywhere else (macOS has no /proc, and its launchd always reaps).
 */
export function isProcessAlive(pid: number, readStat: (path: string) => string = (p) => readFileSync(p, "utf-8")): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== "linux") return true
  try {
    const stat = readStat(`/proc/${pid}/stat`)
    // comm (field 2) is parenthesized and may itself contain spaces/parens, so
    // split after the LAST ')' — state is the first token after it.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim()
    const state = afterComm.split(/\s+/)[0]
    return state !== "Z"
  } catch {
    // No /proc entry (already reaped, or /proc not mounted): trust the signal probe.
    return true
  }
}

/**
 * Does this host have an OS-level trusted-input backend?
 *
 * Only macOS does: daemon/os-input.ts drives CoreGraphics CGEvents, and both
 * the Windows stub (daemon/os-input-win.ts) and the non-Darwin branch of
 * os-input.ts return an explicit "not supported" sentinel. The extension
 * reports this layer as available whenever a daemon is connected — it has no
 * way to see the host OS — so the CLI corrects the answer for `capabilities`
 * rather than letting an agent plan around a layer that cannot fire here.
 */
export function osInputSupported(platform: PlatformName = process.platform): boolean {
  return platform === "darwin"
}

// File-upload transport sizing. The `upload` verb ships file bytes
// base64-encoded inside the command JSON. Three limits gate the path:
//  - MAX_UPLOAD_FRAME_BYTES: the largest single length-prefixed frame the
//    CLI<->daemon Unix socket will accept. Raised from the historical 1 MiB
//    (which silently discarded any file > ~768 KiB) to 64 MiB so a single-shot
//    upload can ride the WS daemon<->extension transport up to the
//    tabs.sendMessage ceiling.
//  - UPLOAD_CHUNK_B64_BYTES: base64 length above which the CLI splits the file
//    into sequential `file_upload_chunk` actions. Kept well under Chrome's hard
//    1 MiB native-messaging host->extension limit so chunked uploads work on
//    EVERY daemon<->extension transport (ws / native / relay), not just WS.
//  - MAX_UPLOAD_FILE_BYTES: raw-file preflight ceiling. Above this the CLI
//    fails fast with an honest error instead of a silent timeout.
export const MAX_UPLOAD_FRAME_BYTES = 64 * 1024 * 1024
export const UPLOAD_CHUNK_B64_BYTES = 512 * 1024
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024

export function listenOptions(socketHandlers: Record<string, unknown>) {
  if (IS_WIN) {
    return { hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers }
  }
  return { unix: SOCKET_PATH, socket: socketHandlers }
}

export function connectOptions(socketHandlers: Record<string, unknown>) {
  if (IS_WIN) {
    return { hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers }
  }
  return { unix: SOCKET_PATH, socket: socketHandlers }
}

export function transportLabel(): string {
  return current.transportLabel
}
