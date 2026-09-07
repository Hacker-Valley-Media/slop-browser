/**
 * cli/lib/status-renderer.ts — shared status-output renderer.
 *
 * Used by `interceptor status` (read-only check) and `interceptor init`
 * (bootstrap-then-check). Their output stays identical because they share
 * this single renderer — anything else would drift.
 */

import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { IS_WIN, SOCKET_PATH, PID_PATH, transportLabel, isProcessAlive } from "../../shared/platform"
import { skillsStatusSummary } from "../commands/skills"

export type StatusSnapshot = {
  mode: "browser-only" | "full" | "unknown"
  daemon: boolean
  pid: number | null
  socket: string | null
  transport: string
  bridge: boolean
  bridgePid: number | null
  bridgeSocket: string | null
  launchAgentInstalled: boolean
  // The plist path that's actually on disk (system-scoped preferred when both
  // exist, since pkg installs land there). Null when neither file exists.
  launchAgentPath: string | null
  // True iff `launchctl print gui/<uid>/com.interceptor.bridge` succeeds —
  // i.e. the plist isn't just on disk, it's actually bootstrapped into the
  // user's GUI domain. Distinguishes "needs kickstart" from "needs bootstrap".
  launchAgentLoaded: boolean
  // #52 browser-config block — populated only on macOS in verbose mode
  browser?: {
    configured: string[]                 // browsers with an NMH manifest installed
    systemDefault: DefaultBrowser
    matches: boolean | null              // null when systemDefault unknown
  }
  // #49 extension-reachability probe result — populated only when verbose+daemonAlive
  extension?: {
    probed: boolean
    reachable: boolean
    reason?: string
  }
  // tab-lifecycle policy as the extension resolved it — populated only
  // when verbose + extension reachable
  tabLifecycle?: {
    reuse: boolean
    idleCloseMinutes: number
    source: string
  }
  // skills-adoption block — pack presence + per-runtime link counts
  skills?: {
    packDir: string | null
    targets: Array<{ id: string; linked: number; total: number }>
  }
}

const BRIDGE_LABEL = "com.interceptor.bridge"

/**
 * Run `launchctl print gui/<uid>/com.interceptor.bridge` and return true iff
 * the service is actually bootstrapped into the user's GUI domain. A plist
 * file sitting in ~/Library/LaunchAgents/ or /Library/LaunchAgents/ does NOT
 * mean it's loaded — the pkg postinstall's `launchctl bootstrap` call can
 * (and does) fail silently when the GUI session isn't reachable. This is the
 * difference between "kickstart" being the right fix and "bootstrap" being
 * the right fix.
 */
export function isLaunchAgentLoaded(uid: number): boolean {
  if (process.platform !== "darwin") return false
  try {
    const result = spawnSync("launchctl", ["print", `gui/${uid}/${BRIDGE_LABEL}`], {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
    })
    return result.status === 0
  } catch {
    return false
  }
}

/** Read the local filesystem state into a snapshot. Never spawns the daemon. */
export function readStatusSnapshot(): StatusSnapshot {
  const sockExists = !IS_WIN && existsSync(SOCKET_PATH)
  let daemonPid: number | null = null
  let daemonAlive = false
  let transport = "unknown"
  if (existsSync(PID_PATH)) {
    try {
      const pidContent = readFileSync(PID_PATH, "utf-8").trim()
      const lines = pidContent.split("\n")
      daemonPid = parseInt(lines[0])
      transport = lines[1] || transportLabel()
      if (!isNaN(daemonPid)) {
        // Zombie-aware: a stale pid file naming an unreaped daemon must read as
        // "not running", not as a daemon nothing can reach.
        daemonAlive = isProcessAlive(daemonPid)
      }
    } catch {}
  }

  const BRIDGE_PID_PATH = "/tmp/interceptor-bridge.pid"
  const BRIDGE_SOCK_PATH = "/tmp/interceptor-bridge.sock"
  const LAUNCH_AGENT_PATH_USER = `${process.env.HOME || ""}/Library/LaunchAgents/com.interceptor.bridge.plist`
  const LAUNCH_AGENT_PATH_SYSTEM = "/Library/LaunchAgents/com.interceptor.bridge.plist"
  const userPlistPresent = !IS_WIN && existsSync(LAUNCH_AGENT_PATH_USER)
  const systemPlistPresent = !IS_WIN && existsSync(LAUNCH_AGENT_PATH_SYSTEM)
  const launchAgentInstalled = userPlistPresent || systemPlistPresent
  // Prefer the system plist when both exist — that's the pkg-install path,
  // and it's the path the user's hint needs to reference for bootstrap.
  const launchAgentPath = systemPlistPresent
    ? LAUNCH_AGENT_PATH_SYSTEM
    : (userPlistPresent ? LAUNCH_AGENT_PATH_USER : null)
  const launchAgentLoaded = launchAgentInstalled && process.getuid
    ? isLaunchAgentLoaded(process.getuid())
    : false
  const bridgeSockExists = !IS_WIN && existsSync(BRIDGE_SOCK_PATH)
  let bridgePid: number | null = null
  let bridgeAlive = false
  if (existsSync(BRIDGE_PID_PATH)) {
    try {
      bridgePid = parseInt(readFileSync(BRIDGE_PID_PATH, "utf-8").trim())
      if (!isNaN(bridgePid)) {
        try { process.kill(bridgePid, 0); bridgeAlive = true } catch { bridgeAlive = false }
      }
    } catch {}
  }

  let mode: "browser-only" | "full" | "unknown"
  if (IS_WIN) {
    mode = "browser-only"
  } else if (launchAgentInstalled) {
    mode = "full"
  } else if (bridgeAlive) {
    mode = "unknown"
  } else {
    mode = "browser-only"
  }

  let skills: StatusSnapshot["skills"]
  try {
    const summary = skillsStatusSummary()
    if (summary.packDir) {
      skills = {
        packDir: summary.packDir,
        targets: summary.targets.map(t => ({ id: t.id, linked: t.linked, total: t.total })),
      }
    }
  } catch {
    // status must never fail because of skills probing
  }

  return {
    mode,
    daemon: daemonAlive,
    pid: daemonPid,
    socket: sockExists ? SOCKET_PATH : null,
    transport,
    bridge: bridgeAlive,
    bridgePid,
    bridgeSocket: bridgeSockExists ? BRIDGE_SOCK_PATH : null,
    launchAgentInstalled,
    launchAgentPath,
    launchAgentLoaded,
    skills,
  }
}

/**
 * Pure function — compute the bridge-section hint lines from a snapshot.
 * Extracted so it can be unit-tested without spawning launchctl. Called from
 * formatStatus. Returns [] when the bridge is healthy and nothing needs to
 * be said.
 */
export function computeBridgeHint(input: {
  bridge: boolean
  mode: StatusSnapshot["mode"]
  launchAgentInstalled: boolean
  launchAgentLoaded: boolean
  launchAgentPath: string | null
}): string[] {
  if (input.bridge) return []
  if (input.mode === "unknown") {
    // Bridge alive but plist file missing — handled by the caller already
    // (mode === "unknown" implies bridge is alive). Defensive default.
    return [
      "  note: bridge is alive but no LaunchAgent plist found at ~/Library/LaunchAgents/com.interceptor.bridge.plist or /Library/LaunchAgents/com.interceptor.bridge.plist.",
      "        Run 'interceptor upgrade --full' to install the LaunchAgent for persistence.",
    ]
  }
  if (input.launchAgentInstalled && !input.launchAgentLoaded) {
    const path = input.launchAgentPath ?? "/Library/LaunchAgents/com.interceptor.bridge.plist"
    return [
      `  hint: LaunchAgent plist is on disk at ${path} but is NOT bootstrapped into your gui/$(id -u) domain — the pkg postinstall's bootstrap call likely failed (common when the installer ran without an aqua-session ancestor).`,
      `        Fix: launchctl bootstrap gui/$(id -u) ${path}`,
      "        Then: launchctl kickstart -k gui/$(id -u)/com.interceptor.bridge",
      "        Or simpler: log out and back in — macOS auto-loads /Library/LaunchAgents/ at login.",
    ]
  }
  if (input.launchAgentInstalled && input.launchAgentLoaded) {
    return ["  hint: LaunchAgent is loaded but bridge is not running. Try: launchctl kickstart -k gui/$(id -u)/com.interceptor.bridge"]
  }
  // launchAgentInstalled === false, mode === "full" — shouldn't be reachable
  // (mode === "full" implies launchAgentInstalled), but kept for completeness.
  return []
}

export type DefaultBrowser = "chrome" | "chromium" | "brave" | "safari" | "firefox" | "other" | null

/**
 * Detect the system default browser. macOS reads LaunchServices preferences;
 * Linux asks xdg-settings (the freedesktop equivalent — a `.desktop` file id
 * such as `google-chrome.desktop`). Returns null on unsupported platforms or
 * when detection fails. Best-effort — surfaces "unknown" rather than throwing.
 */
export function detectSystemDefaultBrowser(): DefaultBrowser {
  if (process.platform === "linux") return detectLinuxDefaultBrowser()
  return detectMacOSDefaultBrowser()
}

/**
 * Linux default browser via `xdg-settings get default-web-browser`. Returns
 * null when xdg-utils is absent (common in minimal containers) or the setting
 * is unset — both mean "unknown", not "none".
 */
function detectLinuxDefaultBrowser(): DefaultBrowser {
  try {
    const result = spawnSync("xdg-settings", ["get", "default-web-browser"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.status !== 0 || !result.stdout) return null
    const desktopId = result.stdout.trim().toLowerCase()
    if (!desktopId) return null
    // chromium before chrome: they are separate install targets with separate
    // native-messaging dirs, so collapsing them would report a false match.
    if (desktopId.includes("brave")) return "brave"
    if (desktopId.includes("chromium")) return "chromium"
    if (desktopId.includes("chrome")) return "chrome"
    if (desktopId.includes("firefox")) return "firefox"
    return "other"
  } catch {
    return null
  }
}

/**
 * Detect the macOS system default browser via LaunchServices preferences.
 * Returns null on non-macOS or when detection fails. Best-effort — surfaces
 * "unknown" rather than throwing.
 */
export function detectMacOSDefaultBrowser(): DefaultBrowser {
  if (process.platform !== "darwin") return null
  try {
    // LaunchServices preferences live in a binary plist; convert to JSON.
    const home = process.env.HOME || ""
    const plistPath = `${home}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`
    if (!existsSync(plistPath)) return null
    const result = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf-8" })
    if (result.status !== 0 || !result.stdout) return null
    const data = JSON.parse(result.stdout) as { LSHandlers?: Array<Record<string, unknown>> }
    const handlers = data.LSHandlers || []
    const httpHandler = handlers.find(h =>
      h.LSHandlerURLScheme === "http" || h.LSHandlerContentType === "public.html"
    )
    const bundle = (httpHandler?.LSHandlerRoleAll as string) || ""
    const lower = bundle.toLowerCase()
    if (lower.includes("brave")) return "brave"
    if (lower.includes("google.chrome")) return "chrome"
    if (lower.includes("safari")) return "safari"
    if (lower.includes("firefox")) return "firefox"
    if (!bundle) return null
    return "other"
  } catch {
    return null
  }
}

// One source of truth for per-user NMH manifest locations — the same browser
// set scripts/install.sh can configure, per platform. Used by `status`
// (presence) and `diagnose` (manifest-path vs running-binary mismatch
// detection). Chromium resolves these dirs itself, so the shapes differ:
// macOS nests them under ~/Library/Application Support, Linux under the
// XDG config home. Keep in lockstep with nm_dir_for() in scripts/install.sh —
// a browser listed here but not there can never have a manifest to find.
const NMH_MANIFEST_FILE = "com.interceptor.host.json"

const NMH_BROWSER_DIRS_DARWIN: Record<string, string> = {
  "chrome":             "Google/Chrome",
  "brave":              "BraveSoftware/Brave-Browser",
  "chrome-beta":        "Google/Chrome Beta",
  "chrome-canary":      "Google/Chrome Canary",
  "chrome-dev":         "Google/Chrome Dev",
  "chrome-for-testing": "Google/ChromeForTesting",
  "edge":               "Microsoft Edge",
  "vivaldi":            "Vivaldi",
}

// Linux: the four targets scripts/install.sh can configure. Chrome, Brave and
// Chromium hang off the XDG config home; Firefox does not — Gecko keeps one
// native-messaging dir per user under ~/.mozilla, outside both the XDG tree and
// the profile tree, so it is resolved separately in nmhDirsFor().
const NMH_BROWSER_DIRS_LINUX: Record<string, string> = {
  "chrome":   "google-chrome",
  "brave":    "BraveSoftware/Brave-Browser",
  "chromium": "chromium",
}

/** Firefox's per-user native-messaging dir, relative to $HOME. Not XDG-based. */
const NMH_FIREFOX_DIR_LINUX = ".mozilla/native-messaging-hosts"

/** Root the per-browser NMH dirs hang off, per platform. Null when unsupported. */
function nmhRoot(platform: string, home: string, env: Record<string, string | undefined>): string | null {
  if (!home) return null
  if (platform === "darwin") return `${home}/Library/Application Support`
  if (platform === "linux") return env.XDG_CONFIG_HOME || `${home}/.config`
  // Windows registers native hosts in the registry, not on disk — nothing to scan.
  return null
}

/** Every installed Interceptor NMH manifest: browser slug + manifest file path. */
export function installedNmhManifests(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): Array<{ browser: string; manifestFile: string }> {
  const home = env.HOME || ""
  const root = nmhRoot(platform, home, env)
  if (!root) return []
  const dirs = platform === "linux" ? NMH_BROWSER_DIRS_LINUX : NMH_BROWSER_DIRS_DARWIN
  const out: Array<{ browser: string; manifestFile: string }> = []
  for (const [browser, dir] of Object.entries(dirs)) {
    const manifestFile = `${root}/${dir}/NativeMessagingHosts/${NMH_MANIFEST_FILE}`
    if (existsSync(manifestFile)) out.push({ browser, manifestFile })
  }
  if (platform === "linux" && home) {
    const firefoxManifest = `${home}/${NMH_FIREFOX_DIR_LINUX}/${NMH_MANIFEST_FILE}`
    if (existsSync(firefoxManifest)) out.push({ browser: "firefox", manifestFile: firefoxManifest })
  }
  return out
}

/**
 * Detect which browsers have an Interceptor native messaging host manifest
 * installed in their per-user dir.
 */
export function detectConfiguredBrowsers(): string[] {
  return installedNmhManifests().map(m => m.browser)
}

/**
 * Does the system default browser have an Interceptor native-messaging host?
 *
 * null when the default is unknown or nothing is configured — "unknown", not
 * "mismatch". A mismatch is only worth reporting when both sides are known:
 * URLs opened from other apps follow the OS default and bypass Interceptor,
 * while `interceptor open` always lands in a configured browser.
 */
export function defaultBrowserMatchesConfigured(
  configured: string[],
  systemDefault: DefaultBrowser,
): boolean | null {
  if (!systemDefault || configured.length === 0) return null
  return configured.includes(systemDefault)
}

/**
 * Format a status snapshot as text. Default = terse (matches today's output
 * for backwards compat with parsing scripts). Verbose adds per-line
 * annotations that explain what each layer is, plus the optional browser:
 * and extension: blocks.
 */
export function formatStatus(snap: StatusSnapshot, opts: { verbose?: boolean }): string {
  const lines: string[] = []
  const v = !!opts.verbose

  lines.push(`mode: ${snap.mode}`)
  lines.push("")

  // daemon block
  if (v) {
    lines.push(`daemon (long-lived host process bridging CLI and the browser extension): ${snap.daemon ? "running" : "not running"}`)
  } else {
    lines.push(`daemon: ${snap.daemon ? "running" : "not running"}`)
  }
  if (snap.pid) lines.push(`pid: ${snap.pid}`)
  // Only render the socket line on platforms that actually use a Unix socket.
  // On Windows the daemon is reached over TCP (transport: tcp:127.0.0.1:...),
  // so a "socket: not found" line next to "daemon: running" reads as a
  // contradiction to anything (or anyone) parsing this output. The transport
  // line below already reports the real connection path.
  const usesUnixSocket = snap.transport.startsWith("unix:")
  if (usesUnixSocket) {
    if (v) {
      lines.push(`socket (Unix socket the CLI uses to reach the daemon): ${snap.socket ?? "not found"}`)
    } else {
      lines.push(`socket: ${snap.socket ?? "not found"}`)
    }
  }
  if (v) {
    lines.push(`transport (how the CLI reaches the daemon): ${snap.transport}`)
  } else {
    lines.push(`transport: ${snap.transport}`)
  }

  // bridge block (only when in full or unknown mode)
  if (snap.mode !== "browser-only") {
    lines.push("")
    if (v) {
      lines.push(`bridge (separate macOS native automation bridge — only needed for 'interceptor macos *'): ${snap.bridge ? "running" : "not running"}`)
    } else {
      lines.push(`bridge: ${snap.bridge ? "running" : "not running"}`)
    }
    if (snap.bridgePid) lines.push(`  pid: ${snap.bridgePid}`)
    lines.push(`  socket: ${snap.bridgeSocket ?? "not found"}`)
    for (const line of computeBridgeHint({
      bridge: snap.bridge,
      mode: snap.mode,
      launchAgentInstalled: snap.launchAgentInstalled,
      launchAgentLoaded: snap.launchAgentLoaded,
      launchAgentPath: snap.launchAgentPath,
    })) {
      lines.push(line)
    }
  } else if (process.platform === "darwin") {
    // Only advertised on macOS: `upgrade --full` installs the Swift bridge and
    // hard-errors everywhere else, so printing it on Linux/Windows would send
    // the user at a command that cannot succeed on their machine.
    lines.push("")
    lines.push("To enable native macOS control:    interceptor upgrade --full")
  }

  // browser config block (#52) — verbose-only on macOS
  if (snap.browser) {
    lines.push("")
    if (v) {
      lines.push("browser (which browser the extension is installed into; whether system default matches):")
    } else {
      lines.push("browser:")
    }
    const cfg = snap.browser.configured.length === 0
      ? "(none — run scripts/install.sh and load the extension)"
      : snap.browser.configured.join(", ")
    lines.push(`  configured:     ${cfg}`)
    lines.push(`  system default: ${snap.browser.systemDefault ?? "unknown"}`)
    if (snap.browser.matches === true) {
      lines.push("  status:         ✓ matches")
    } else if (snap.browser.matches === false) {
      lines.push("  status:         ⚠ mismatch — URLs opened from other apps follow the OS default and bypass the interceptor extension.")
      lines.push("                  'interceptor open <url>' always lands in the configured browser, so 'interceptor' commands are unaffected.")
    }
  }

  // extension reachability block (#49) — verbose-only when daemon alive
  if (snap.extension) {
    lines.push("")
    if (snap.extension.reachable) {
      lines.push(`extension: reachable${v ? " (a content-script ping succeeded against an interceptor-group tab)" : ""}`)
    } else if (snap.extension.probed) {
      lines.push(`extension: not reachable — ${snap.extension.reason || "no tabs in interceptor group; run 'interceptor open <url>' to verify"}`)
    } else {
      lines.push("extension: not probed (daemon not running)")
    }
  }

  // tab-lifecycle policy — verbose-only when extension reachable
  if (snap.tabLifecycle) {
    const lc = snap.tabLifecycle
    const idle = lc.idleCloseMinutes > 0 ? `close idle groups after ${lc.idleCloseMinutes}m` : "idle-close off"
    lines.push(`tab lifecycle: reuse ${lc.reuse ? "on (named groups)" : "off"} · ${idle} (source: ${lc.source})`)
  }

  // skills adoption block — pack presence + per-runtime link counts
  if (snap.skills && snap.skills.targets.length > 0) {
    lines.push("")
    if (v) {
      lines.push("skills (Interceptor skill packs linked into AI runtimes — see 'interceptor skills status'):")
    } else {
      lines.push("skills:")
    }
    for (const t of snap.skills.targets) {
      const mark = t.linked === t.total ? "✓" : "⚠"
      lines.push(`  ${mark} ${t.id}: ${t.linked}/${t.total} linked`)
    }
    if (snap.skills.targets.some(t => t.linked < t.total)) {
      lines.push("  hint: interceptor skills adopt")
    }
  }

  if (!snap.daemon) {
    lines.push("")
    lines.push("hint: run any interceptor command and the daemon will auto-start.")
    lines.push("ensure Chrome/Brave has the Interceptor extension loaded for browser control.")
  }

  return lines.join("\n")
}

/** JSON shape for `--json` mode. Stable contract for parsing scripts. */
export function snapshotToJson(snap: StatusSnapshot): Record<string, unknown> {
  const base: Record<string, unknown> = {
    mode: snap.mode,
    daemon: snap.daemon,
    pid: snap.pid,
    socket: snap.socket,
    transport: snap.transport,
    bridge: snap.bridge,
    bridgePid: snap.bridgePid,
    bridgeSocket: snap.bridgeSocket,
    launchAgentInstalled: snap.launchAgentInstalled,
    launchAgentPath: snap.launchAgentPath,
    launchAgentLoaded: snap.launchAgentLoaded,
  }
  if (snap.browser) base.browser = snap.browser
  if (snap.extension) base.extension = snap.extension
  if (snap.tabLifecycle) base.tabLifecycle = snap.tabLifecycle
  if (snap.skills) base.skills = snap.skills
  return base
}
