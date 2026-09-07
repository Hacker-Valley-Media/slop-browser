/**
 * cli/commands/diagnose.ts — interceptor diagnose
 *
 * Surfaces a concise debugging snapshot for agent diagnosis. Call this when
 * a command fails or when an agent needs to orient itself without issuing 4-5
 * follow-up commands to reconstruct system state.
 *
 * Works without a running daemon (reports what it can locally) and surfaces
 * progressively richer context when the daemon + extension are reachable.
 *
 * Context-aware: without --context, enumerates ALL connected browser contexts
 * and probes each one. In a dual-browser setup (Chrome + Brave) you see both
 * contexts side-by-side, making context mismatches immediately visible.
 *
 * Binary mismatch detection: compares the execPath recorded in the lock file
 * (which binary the socket daemon is actually running) against the path in
 * each browser's NMH manifest (which binary Chrome/Brave will spawn on
 * extension connect). A mismatch means the extension and CLI are talking to
 * different daemon processes — the root cause of "no extensions connected"
 * when Chrome appears open and the extension appears loaded.
 */

import { readFileSync } from "node:fs"
import { readStatusSnapshot, installedNmhManifests } from "../lib/status-renderer"
import { sendCommand } from "../transport"
import { listSessions } from "./monitor"
import { readLockFile, type LockFileData } from "../../daemon/lifecycle"
import { LOCK_PATH } from "../../shared/platform"
import { IOS_CONTEXT_PREFIX } from "../../shared/ios-device"
import { CDP_CONTEXT_PREFIX } from "../../shared/cdp-app"
import { VERSION } from "../version"

type BinaryMismatch = {
  browser: string
  manifestPath: string
  runningPath: string
}

type ContextProbe = {
  contextId: string
  kind: "extension" | "ios" | "cdp"
  extension: { reachable: boolean; reason?: string; version?: string }
  tab: { id: number; url: string; title: string } | null
  elements: number | null
}

/**
 * Issue #241: a pkg install replaces the extension on disk, but a running
 * browser keeps executing the OLD extension snapshot until it is reloaded. The
 * symptom is a CLI that reports one version while the extension behaves like
 * an older one (e.g. asking for a bundle file the build no longer ships). The
 * daemon now records the version each extension registered with; when it
 * differs from this CLI's, say so and name the fix.
 */
export function extensionVersionMismatchLine(
  contextId: string,
  extensionVersion: string | undefined,
  cliVersion: string,
): string | null {
  if (!extensionVersion || extensionVersion === cliVersion) return null
  return `⚠ extension snapshot ${extensionVersion} ≠ CLI ${cliVersion} — the browser is still running the old extension; run 'interceptor reload --context ${contextId}' and retry.`
}

// `contexts` returns extension ids plus ios:/cdp: manager contexts. Browser
// probes (tab_list / get_a11y_tree) only make sense against extension
// contexts — an ios:/cdp: id appearing in the list is already proof the
// device/app is connected, and probing it with browser verbs would render a
// misleading "extension not responding".
function contextKind(contextId: string | undefined): ContextProbe["kind"] {
  if (contextId?.startsWith(IOS_CONTEXT_PREFIX)) return "ios"
  if (contextId?.startsWith(CDP_CONTEXT_PREFIX)) return "cdp"
  return "extension"
}

type DiagnoseSnapshot = {
  daemon: { running: boolean; pid: number | null; execPath?: string; version?: string; startedAt?: string }
  binaryMismatches: BinaryMismatch[]
  contexts: ContextProbe[]
  monitor: { active: number; total: number }
}

// Clear the timer in `finally` so it never keeps the process alive after
// fn() resolves — the original race left the timer running until it fired.
async function probeWithTimeout<T>(fn: () => Promise<T>, ms = 2000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timed out")), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function readNmhManifestPath(manifestFile: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as { path?: string }
    return manifest.path ?? null
  } catch {
    return null
  }
}

export function detectBinaryMismatches(lock: LockFileData | null): BinaryMismatch[] {
  if (!lock?.execPath) return []
  const mismatches: BinaryMismatch[] = []
  for (const { browser, manifestFile } of installedNmhManifests()) {
    const manifestPath = readNmhManifestPath(manifestFile)
    if (manifestPath && manifestPath !== lock.execPath) {
      mismatches.push({ browser, manifestPath, runningPath: lock.execPath })
    }
  }
  return mismatches
}

export async function probeContext(contextId: string | undefined, version?: string): Promise<ContextProbe> {
  const label = contextId ?? "default"
  const kind = contextKind(contextId)

  if (kind !== "extension") {
    // Presence in the `contexts` list means the manager holds a live
    // registration for this device/app; report it without browser probes.
    return {
      contextId: label,
      kind,
      extension: { reachable: true },
      tab: null,
      elements: null,
    }
  }

  const [tabResp, treeResp] = await Promise.all([
    probeWithTimeout(() => sendCommand({ type: "tab_list" }, undefined, contextId)),
    probeWithTimeout(() =>
      sendCommand({ type: "get_a11y_tree", filter: "interactive", depth: 3, maxChars: 100_000 }, undefined, contextId)
    ),
  ])

  let extension: ContextProbe["extension"] = { reachable: false }
  let tab: ContextProbe["tab"] = null
  let elements: number | null = null

  if (tabResp?.result.success) {
    const tabs = tabResp.result.data as
      | Array<{ id: number; url: string; title: string; active: boolean }>
      | undefined
    if (Array.isArray(tabs) && tabs.length > 0) {
      const active = tabs.find(t => t.active) ?? tabs[0]
      tab = { id: active.id, url: active.url, title: active.title }
      extension = { reachable: true }
    } else {
      extension = { reachable: false, reason: "no tabs in interceptor group — run 'interceptor open <url>'" }
    }
  } else {
    extension = { reachable: false, reason: tabResp?.result.error || "extension not responding" }
  }

  if (treeResp?.result.success && typeof treeResp.result.data === "string") {
    elements = (treeResp.result.data.match(/\be\d+\b/g) ?? []).length
  }

  if (version) extension.version = version
  return { contextId: label, kind, extension, tab, elements }
}

export async function runDiagnoseCommand(jsonMode: boolean, contextId?: string): Promise<void> {
  const status = readStatusSnapshot()
  const lock = readLockFile(LOCK_PATH)

  const snap: DiagnoseSnapshot = {
    daemon: {
      running: status.daemon,
      pid: status.pid,
      ...(lock ? { execPath: lock.execPath, version: lock.version, startedAt: lock.startedAt } : {}),
    },
    binaryMismatches: detectBinaryMismatches(lock),
    contexts: [],
    monitor: { active: 0, total: 0 },
  }

  if (status.daemon) {
    // verbose: true → [{contextId, kind, version}] on a current daemon; an
    // older daemon ignores the flag and returns plain ids — accept both.
    const contextsResp = await probeWithTimeout(() => sendCommand({ type: "contexts", verbose: true }))
    const raw = contextsResp?.result.success && Array.isArray(contextsResp.result.data)
      ? (contextsResp.result.data as Array<string | { contextId: string; version?: string }>)
      : []
    const contexts = raw.map(entry => typeof entry === "string" ? { contextId: entry } : entry)
    const versionOf = (id: string | undefined) => contexts.find(c => c.contextId === id)?.version

    if (contextId) {
      snap.contexts = [await probeContext(contextId, versionOf(contextId))]
    } else {
      snap.contexts = await Promise.all(
        contexts.length > 0
          ? contexts.map(c => probeContext(c.contextId, c.version))
          : [probeContext(undefined)]
      )
    }
  }

  try {
    const sessions = listSessions()
    snap.monitor = {
      active: sessions.filter(s => s.status === "active").length,
      total: sessions.length,
    }
  } catch {
    // monitor artifacts absent or unreadable; leave defaults
  }

  if (jsonMode) {
    console.log(JSON.stringify(snap, null, 2))
    return
  }

  const lines: string[] = []

  // Daemon block — include binary path when lock file is present
  if (status.daemon) {
    const daemonDetail = lock?.execPath
      ? `running  (pid ${status.pid}, ${lock.execPath})`
      : `running  (pid ${status.pid})`
    lines.push(`daemon:    ${daemonDetail}`)
  } else {
    lines.push("daemon:    not running  — open Chrome with the Interceptor extension, then run 'interceptor init'")
  }

  // Binary mismatch warning — the root cause of "no extensions connected" when
  // Chrome is open. Surface it immediately after the daemon line so it's impossible to miss.
  for (const m of snap.binaryMismatches) {
    lines.push(`⚠ binary mismatch (${m.browser}):`)
    lines.push(`    socket daemon: ${m.runningPath}`)
    lines.push(`    NMH manifest:  ${m.manifestPath}`)
    // Browser-neutral: the same mismatch applies to Chromium, Brave, and
    // Firefox, all of which now have their own native-messaging host dir.
    lines.push(`    ${m.browser} will spawn the manifest binary; CLI talks to the socket binary.`)
    lines.push(`    Fix: run 'interceptor init' or update the NMH manifest to match.`)
  }

  if (status.daemon) {
    const multiCtx = snap.contexts.length > 1 || snap.contexts[0]?.contextId !== "default"

    for (const ctx of snap.contexts) {
      if (multiCtx) lines.push(`context ${ctx.contextId}:`)
      const indent = multiCtx ? "  " : ""

      if (ctx.kind !== "extension") {
        lines.push(`${indent}${ctx.kind === "ios" ? "ios device" : "cdp app"}: connected`)
        continue
      }

      lines.push(
        `${indent}extension: ${
          ctx.extension.reachable
            ? "connected"
            : `disconnected${ctx.extension.reason ? `  (${ctx.extension.reason})` : ""}`
        }${ctx.extension.version ? `  (extension ${ctx.extension.version})` : ""}`
      )
      const mismatch = extensionVersionMismatchLine(ctx.contextId, ctx.extension.version, VERSION)
      if (mismatch) lines.push(`${indent}${mismatch}`)

      if (ctx.tab) {
        const { id, url, title } = ctx.tab
        lines.push(`${indent}tab ${id}:     ${url}  "${title}"`)
      } else {
        lines.push(`${indent}tab:       no active interceptor-group tab`)
      }

      if (ctx.elements !== null) {
        lines.push(`${indent}elements:  ${ctx.elements} interactive`)
      }
    }
  }

  lines.push(
    `monitor:   ${
      snap.monitor.active > 0
        ? `${snap.monitor.active} active  (${snap.monitor.total} total)`
        : snap.monitor.total > 0
        ? `none active  (${snap.monitor.total} stopped)`
        : "no sessions"
    }`
  )

  console.log(lines.join("\n"))
}
