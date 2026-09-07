import { format } from "node:util"
import { HELP, shortHelp, fullHelp, helpForCommand } from "./help"
import { detectSurfaces, SURFACE_UPGRADE_HINT } from "./lib/surfaces"
import { runSkillsCommand, maybeEmitSkillsHint } from "./commands/skills"
import { runManifestCommand } from "./manifest"
import { parseTabFlag, parseContextFlag, resolveGroupScope, parseGroupColorFlag } from "./parse"
import { formatState, formatTabs, formatCookies, formatFind, formatResult } from "./format"
import { sendCommand, sendCommandWs, setGlobalGroup, setGlobalFrame, type DaemonResult, type DaemonResponse, type Action } from "./transport"
import { UPLOAD_CHUNK_B64_BYTES } from "../shared/platform"
import { chunkBase64 } from "../shared/upload"
import { fromPassive, writeExport, type PassiveNetEntry, type ExportFormat } from "../shared/exports"
import {
  attachMonitorTaskSource,
  markMonitorTaskSourceAttachFailed,
  resolveOrCreateMonitorTask,
} from "../shared/monitor-tasks"
import { ensureDaemon } from "./daemon-spawn"
import { parseStateCommand } from "./commands/state"
import { parseActionsCommand } from "./commands/actions"
import { parsePowerCommand, runDelegateCommand } from "./commands/power"
import { parseNavigationCommand } from "./commands/navigation"
import { parseTabsCommand } from "./commands/tabs"
import { parseNetworkCommand } from "./commands/network"
import { parseScreenshotCommand } from "./commands/screenshot"
import { parseDataCommand } from "./commands/data"
import { parseMetaCommand } from "./commands/meta"
import { parseEvalCommand } from "./commands/eval"
import { parseSaveCommand } from "./commands/save"
import { parseBrandCommand } from "./commands/brand"
import { parseGroupCommand } from "./commands/group"
import { parseBatchCommand } from "./commands/batch"
import { parseMonitorCommand } from "./commands/monitor"
import { parseSceneCommand } from "./commands/scene"
import { parseSseCommand } from "./commands/sse"
import { runCompoundCommand, webSearchQuery, webSearchTimeout } from "./commands/compound"
import { runOverride } from "./commands/override"
import { runMacosCommand } from "./commands/macos"
import { runIosCommand } from "./commands/ios"
import { runUpgradeCommand } from "./commands/upgrade"
import { runInitCommand } from "./commands/init"
import { runResearchCommand } from "./commands/research"
import { runDiagnoseCommand } from "./commands/diagnose"
import { runExtensionsCommand } from "./commands/extensions"
import { runDaemonCommand } from "./commands/daemon"
import { VERSION, BUILD_SHA, BUILD_DATE } from "./version"
import { buildFilteredArgs, parseFrameFlag } from "./global-flags"
import { normalizeArgsSplit } from "./normalize"

// console.log must not be used for CLI output: Bun's console.log writer
// silently drops everything past 64 KiB at exit when stderr and stdout share
// one pipe (`2>&1`) and a stderr write (our transport trace line) precedes the
// payload — on Bun 1.3.11 and 1.3.14, interpreted and compiled, any size.
// process.stdout.write does not exhibit this, so route every console.log in
// the process through it. console.error stays native: stderr payloads are
// always smaller than the 64 KiB pipe buffer and never at risk.
console.log = (...args: unknown[]): void => {
  process.stdout.write(format(...args) + "\n")
}

// Command → module routing
const STATE_CMDS = new Set(["state", "tree", "diff", "find", "text", "html"])
const ACTION_CMDS = new Set(["click", "type", "select", "focus", "blur", "hover", "drag", "upload", "dblclick", "rightclick", "check", "keys", "click-at", "what-at", "regions"])
const NAV_CMDS = new Set(["navigate", "back", "forward", "scroll", "wait", "wait-stable", "wait_for"])
const TAB_CMDS = new Set(["tabs", "tab", "window", "frames", "session"])
const NET_CMDS = new Set(["network", "net", "headers"])
const SS_CMDS = new Set(["screenshot", "canvas", "capture", "ocr"])
const DATA_CMDS = new Set(["cookies", "storage", "history", "bookmarks", "downloads", "clear", "clipboard"])
const META_CMDS = new Set(["status", "reload", "meta", "links", "images", "forms", "info", "page_info", "query", "exists", "count", "table", "attr", "style", "events", "notify", "sessions", "capabilities", "modals", "panels"])
const EVAL_CMDS = new Set(["eval"])
const SAVE_CMDS = new Set(["save"])
const BRAND_CMDS = new Set(["brand"])
const GROUP_CMDS = new Set(["group"])
const BATCH_CMDS = new Set(["batch", "raw"])
const MONITOR_CMDS = new Set(["monitor"])
const POWER_CMDS = new Set(["keepawake", "idle"])
const DELEGATE_CMDS = new Set(["delegate"])
const SCENE_CMDS = new Set(["scene"])
const SSE_CMDS = new Set(["sse"])
const COMPOUND_CMDS = new Set(["open", "read", "act", "inspect", "websearch", "search"])
const OVERRIDE_CMDS = new Set(["override"])
const MACOS_CMDS = new Set(["macos"])
const IOS_CMDS = new Set(["ios"])
const UPDATE_CMDS = new Set(["update"])
const UPGRADE_CMDS = new Set(["upgrade"])
const INIT_CMDS = new Set(["init"])
const RESEARCH_CMDS = new Set(["research"])
const DIAGNOSE_CMDS = new Set(["diagnose"])
const EXTENSIONS_CMDS = new Set(["extensions"])
const DAEMON_CMDS = new Set(["daemon"])
const SKILLS_CMDS = new Set(["skills"])
const MANIFEST_CMDS = new Set(["manifest"])
const MCP_CMDS = new Set(["mcp"])

// Commands that don't require a daemon connection (or, in init's case,
// bootstrap it themselves rather than relying on the pre-dispatch auto-spawn).
// `research` prints guidance / manages an on-disk ledger — no browser, no daemon.
// `diagnose` reads local state + optionally probes the daemon — never auto-spawns.
const NO_DAEMON = new Set(["status", "help", "events", "delegate", "session", "upgrade", "init", "research", "extensions", "skills", "manifest", "diagnose", "mcp", "daemon"])

// Every command the CLI dispatches. Used to reject unknown commands
// before any daemon-spawning side effect runs.
const ALL_KNOWN_CMDS = new Set<string>([
  ...STATE_CMDS, ...ACTION_CMDS, ...NAV_CMDS, ...TAB_CMDS, ...NET_CMDS,
  ...SS_CMDS, ...DATA_CMDS, ...META_CMDS, ...EVAL_CMDS,
  ...SAVE_CMDS, ...BRAND_CMDS, ...GROUP_CMDS, ...BATCH_CMDS, ...MONITOR_CMDS, ...SCENE_CMDS, ...SSE_CMDS,
  ...COMPOUND_CMDS, ...OVERRIDE_CMDS, ...MACOS_CMDS, ...IOS_CMDS,
  ...UPDATE_CMDS, ...UPGRADE_CMDS, ...INIT_CMDS, ...RESEARCH_CMDS, ...EXTENSIONS_CMDS,
  ...SKILLS_CMDS, ...MANIFEST_CMDS, ...DIAGNOSE_CMDS, ...MCP_CMDS, ...DAEMON_CMDS,
  ...POWER_CMDS, ...DELEGATE_CMDS,
  "help", "contexts",
])

// Monitor subcommands that are handled locally (no daemon needed)
const MONITOR_LOCAL_SUBCOMMANDS = new Set(["tail", "list", "export", "task", "repair"])

function unwrapResult(response: DaemonResponse): DaemonResult {
  return response.result
}

async function main() {
  const args = process.argv.slice(2)
  const optionTerminator = args.indexOf("--")
  const globalArgs = optionTerminator === -1 ? args : args.slice(0, optionTerminator)
  const jsonMode = globalArgs.includes("--json")
  // Screenshot responses can carry tens-to-hundreds of KB of base64
  // dataUrl payloads. Native-messaging port-based responses for that size
  // are unreliable on Brave/Chromium (messages are silently dropped despite
  // the documented 1MB native-messaging limit). The WebSocket transport does
  // not exhibit this issue, so we auto-route screenshot through it.
  const isScreenshotCmd = args[0] === "screenshot"
  const isSaveCmd = args[0] === "save"
  // `save` streams bytes over the WebSocket binary-framing protocol and cannot
  // be delivered over the native-messaging / unix-socket path (that path mangles
  // the action payload, e.g. "Unexpected token 'new'"). It therefore always
  // routes over WS — a stray --no-ws would otherwise produce a confusing parse
  // error. Screenshot still honors --no-ws as an escape hatch.
  // issue #244: a secret-bearing action resolves inside the daemon's IPC handler,
  // so it never takes the WebSocket lane.
  const carriesSecret = args.includes("--secret") || (args[0] === "macos" && (args[1] === "secret" || args[1] === "sudo" || args[1] === "authdialog"))
  const useWs = !carriesSecret && (globalArgs.includes("--ws") || isSaveCmd || (isScreenshotCmd && !globalArgs.includes("--no-ws")))
  const anyTab = globalArgs.includes("--any-tab")
  const globalTabId = parseTabFlag(globalArgs)
  const globalContextId = parseContextFlag(globalArgs)
  // Explicit or automatic session scope is injected into every outgoing
  // action at the transport choke point, covering simple, compound, and loop paths.
  const groupScope = resolveGroupScope(args)
  setGlobalGroup(groupScope.label, parseGroupColorFlag(globalArgs), groupScope.soft)

  // Build filtered args (strip global flags). Native surfaces retain nested
  // command-local JSON payload flags such as `macos translate batch --json`.
  let filtered = buildFilteredArgs(args)
  if (filtered[0] !== "macos" && filtered[0] !== "ios") setGlobalFrame(parseFrameFlag(globalArgs))

  // progressive disclosure. Bare invocation and `help` print the
  // concise tier-0 card; `help <cmd>` prints one command's contract; `help
  // --all` prints the exhaustive reference filtered to installed surfaces.
  if (filtered.length === 0 || filtered[0] === "help") {
    const helpArg = filtered[1]
    if (helpArg && !helpArg.startsWith("-")) {
      const sub = helpForCommand(helpArg)
      if (sub) {
        console.log(sub)
      } else {
        console.error(`error: no help for '${helpArg}'. Run 'interceptor help --all' for the full reference.`)
        process.exit(1)
      }
    } else if (filtered.includes("--all")) {
      console.log(fullHelp(detectSurfaces(args)))
    } else {
      console.log(shortHelp(detectSurfaces(args)))
    }
    return
  }

  // --version / -V short-circuit. Runs before any daemon-spawn side effect.
  if (filtered[0] === "--version" || filtered[0] === "-V") {
    if (jsonMode) {
      console.log(JSON.stringify({
        name: "interceptor",
        version: VERSION,
        sha: BUILD_SHA,
        buildDate: BUILD_DATE,
      }))
    } else {
      console.log(`interceptor ${VERSION} (${BUILD_SHA}, ${BUILD_DATE})`)
    }
    return
  }

  const cmd = filtered[0]
  const filteredOptionTerminator = filtered.indexOf("--")
  const commandOptions = filtered.slice(1, filteredOptionTerminator === -1 ? filtered.length : filteredOptionTerminator)

  // rewrite argv to [cmd, ...positionals, ...flags] so flag
  // position never changes meaning (e.g. `open --text-only <url>` used to
  // create a tab whose URL was literally "--text-only"). macos/ios pass
  // through untouched — see cli/normalize.ts. positionalCount marks where the
  // positional span ends so text-sweeping parsers (type) never ingest flags.
  const normalized = normalizeArgsSplit(filtered)
  filtered = normalized.argv

  // Per-command --help / -h short-circuit. `interceptor open --help` prints
  // the open-specific help block; `interceptor --help` (no command) falls
  // back to the full HELP. Runs before any daemon-spawn side effect.
  if (cmd === "--help" || cmd === "-h" || commandOptions.includes("--help") || commandOptions.includes("-h")) {
    // Bare `interceptor --help` (no command) prints the tier-0 card.
    if (cmd.startsWith("-")) {
      console.log(shortHelp(detectSurfaces(args)))
      return
    }
    if (cmd === "macos" && (filtered[1] === "cdp" || filtered[1] === "runtime")) {
      await runMacosCommand(filtered, { jsonMode, useWs, globalTabId, contextId: globalContextId })
      return
    }
    if (cmd === "ios") {
      await runIosCommand(filtered, { jsonMode, contextId: globalContextId })
      return
    }
    if (cmd === "extensions") {
      runExtensionsCommand(filtered, jsonMode)
      return
    }
    const sub = helpForCommand(cmd)
    if (sub) {
      console.log(sub)
    } else {
      console.log(shortHelp(detectSurfaces(args)))
    }
    return
  }

  if (!ALL_KNOWN_CMDS.has(cmd)) {
    console.error(`error: unknown command '${cmd}'. Run 'interceptor help' for usage.`)
    process.exit(1)
  }

  // `websearch` validation happens before daemon auto-spawn so a malformed
  // invocation has no browser or process side effects. The retained `search`
  // alias uses the identical parser and lifecycle.
  if ((cmd === "websearch" || cmd === "search") && !webSearchQuery(filtered)) {
    console.error(`error: interceptor ${cmd} requires a non-empty query. Usage: interceptor ${cmd} "<query>"`)
    process.exit(1)
  }
  if ((cmd === "websearch" || cmd === "search") && webSearchTimeout(filtered) === null) {
    console.error("error: --timeout must be a non-negative integer")
    process.exit(1)
  }

  // fail fast (before any daemon spawn) when a surface is not
  // part of this install. Override with --all-surfaces / INTERCEPTOR_ALL_SURFACES.
  // `update` rides the macos surface: Sparkle lives in the bridge, so a mac
  // browser-only install gets the upgrade hint instead of a bridge error.
  // On win32 `update` skips the gate — its dispatch branch prints the
  // Windows installer guidance instead of the macOS-only hint.
  if (MACOS_CMDS.has(cmd) || IOS_CMDS.has(cmd) || (UPDATE_CMDS.has(cmd) && process.platform !== "win32")) {
    const surfaces = detectSurfaces(args)
    const available = IOS_CMDS.has(cmd) ? surfaces.ios : surfaces.macos
    if (!available) {
      console.error(`error: ${SURFACE_UPGRADE_HINT}`)
      process.exit(1)
    }
  }

  // one rate-limited stderr hint when installed skill packs are
  // not linked into detected AI runtimes (fires after installs and updates).
  if (cmd !== "skills" && cmd !== "manifest") maybeEmitSkillsHint(args)

  let needsDaemon = !NO_DAEMON.has(cmd)
  // win32 `update` prints static installer guidance — no daemon involved
  // (on macOS it routes through the daemon to the bridge's Sparkle updater).
  if (UPDATE_CMDS.has(cmd) && process.platform === "win32") {
    needsDaemon = false
  }
  if (cmd === "monitor" && filtered[1] && MONITOR_LOCAL_SUBCOMMANDS.has(filtered[1])) {
    needsDaemon = false
  }
  if (cmd === "monitor" && (filtered[1] === "status" || filtered[1] === "stop") && filtered.includes("--task")) {
    needsDaemon = false
  }

  if (needsDaemon && !useWs) {
    await ensureDaemon()
  }

  // Dispatch to command module
  let action: { type: string; [key: string]: unknown } | null

  if (UPDATE_CMDS.has(cmd)) {
    // `interceptor update` is the front door for updating Interceptor itself
    // sugar for the retained-but-hidden
    // `interceptor macos update check` — a user-initiated Sparkle check via the
    // bridge that reports Sparkle's selected version, no-update result, or
    // error. `interceptor update status` passes through to the lifecycle state.
    //
    // Windows has no Sparkle: updates ship as a signed installer (see
    // docs/windows-install.md — run a newer architecture-matched Setup; the
    // surface gate's macOS-only upgrade hint would be nonsense here).
    if (process.platform === "win32") {
      const msg = {
        message: "Windows updates ship as a signed installer — download the latest Interceptor-Browser-<version>-windows-<arch>.exe and run Setup (upgrades preserve the install directory; downgrades are refused).",
        releases: "https://github.com/Hacker-Valley-Media/Interceptor/releases",
      }
      console.log(jsonMode ? JSON.stringify({ success: true, data: msg }, null, 2) : `${msg.message}\n${msg.releases}`)
      return
    }
    const sub = filtered[1] && !filtered[1].startsWith("-") ? filtered[1] : "check"
    await runMacosCommand(["macos", "update", sub], { jsonMode, useWs, globalTabId, contextId: globalContextId })
    return
  }

  if (MACOS_CMDS.has(cmd)) {
    await runMacosCommand(filtered, { jsonMode, useWs, globalTabId, contextId: globalContextId })
    return
  }

  if (IOS_CMDS.has(cmd)) {
    await runIosCommand(filtered, { jsonMode, contextId: globalContextId })
    return
  }

  if (MCP_CMDS.has(cmd)) {
    // Dynamic import keeps the MCP SDK out of the hot path for every other verb.
    const { runMcpCommand } = await import("./commands/mcp")
    await runMcpCommand(filtered)
    return
  }

  if (UPGRADE_CMDS.has(cmd)) {
    await runUpgradeCommand(filtered)
    return
  }

  if (INIT_CMDS.has(cmd)) {
    await runInitCommand(filtered)
    return
  }

  if (RESEARCH_CMDS.has(cmd)) {
    await runResearchCommand(filtered, jsonMode)
    return
  }

  if (DIAGNOSE_CMDS.has(cmd)) {
    await runDiagnoseCommand(jsonMode, globalContextId)
    return
  }

  if (EXTENSIONS_CMDS.has(cmd)) {
    runExtensionsCommand(filtered, jsonMode)
    return
  }

  if (DAEMON_CMDS.has(cmd)) {
    await runDaemonCommand(filtered, jsonMode)
    return
  }

  if (SKILLS_CMDS.has(cmd)) {
    runSkillsCommand(filtered, jsonMode)
    return
  }

  if (MANIFEST_CMDS.has(cmd)) {
    runManifestCommand(args)
    return
  }

  if (cmd === "contexts") {
    try {
      const response = await sendCommand({ type: "contexts" }, undefined, undefined)
      const result = response.result
      if (!result.success) {
        console.error(`error: ${result.error || "failed to list browser contexts"}`)
        process.exit(1)
      }
      const ids = Array.isArray(result.data) ? result.data as string[] : []
      if (jsonMode) {
        console.log(JSON.stringify(ids))
      } else if (ids.length === 0) {
        console.log("no browser contexts connected")
      } else {
        ids.forEach(id => console.log(id))
      }
    } catch (err) {
      console.error(`error: ${(err as Error).message}`)
      process.exit(1)
    }
    return
  }

  if (COMPOUND_CMDS.has(cmd)) {
    await runCompoundCommand(cmd, filtered, { jsonMode, useWs, globalTabId, anyTab, contextId: globalContextId, positionalCount: normalized.positionalCount })
    return
  }

  if (OVERRIDE_CMDS.has(cmd)) {
    await runOverride(filtered, { jsonMode, useWs, globalTabId, contextId: globalContextId })
    return
  }

  if (DELEGATE_CMDS.has(cmd)) {
    await runDelegateCommand(filtered, jsonMode)
    return
  }

  if (STATE_CMDS.has(cmd))       action = parseStateCommand(filtered)
  else if (ACTION_CMDS.has(cmd)) action = parseActionsCommand(filtered, normalized.positionalCount)
  else if (NAV_CMDS.has(cmd))    action = parseNavigationCommand(filtered)
  else if (TAB_CMDS.has(cmd))    action = await parseTabsCommand(filtered)
  else if (NET_CMDS.has(cmd))    action = parseNetworkCommand(filtered)
  else if (SS_CMDS.has(cmd))     action = parseScreenshotCommand(filtered)
  else if (DATA_CMDS.has(cmd))   action = parseDataCommand(filtered)
  else if (META_CMDS.has(cmd))   action = await parseMetaCommand(filtered, jsonMode, globalContextId)
  else if (EVAL_CMDS.has(cmd))   action = parseEvalCommand(filtered, normalized.positionalCount)
  else if (SAVE_CMDS.has(cmd))   action = parseSaveCommand(filtered)
  else if (BRAND_CMDS.has(cmd))  action = parseBrandCommand(filtered)
  else if (GROUP_CMDS.has(cmd))  action = parseGroupCommand(filtered)
  else if (BATCH_CMDS.has(cmd))  action = parseBatchCommand(filtered)
  else if (POWER_CMDS.has(cmd))   action = parsePowerCommand(filtered)
  else if (MONITOR_CMDS.has(cmd)) action = await parseMonitorCommand(filtered, jsonMode, useWs)
  else if (SCENE_CMDS.has(cmd))   action = await parseSceneCommand(filtered, jsonMode)
  else if (SSE_CMDS.has(cmd))     action = parseSseCommand(filtered)
  else {
    // Unreachable: ALL_KNOWN_CMDS guard above rejects unknown commands
    // before this dispatch chain runs.
    console.error(`error: unhandled command '${cmd}'`)
    process.exit(1)
  }

  // null means the command handled its own output (status, events, session)
  if (action === null) return

  // Large-file upload: split the base64 payload into sequential
  // chunks so every daemon<->extension transport carries it (each chunk stays
  // under Chrome's hard 1 MiB native-messaging limit), then a final assemble
  // message attaches the file. Small files still go single-shot below.
  if (action && action.type === "file_upload" && typeof action.dataBase64 === "string" && (action.dataBase64 as string).length > UPLOAD_CHUNK_B64_BYTES) {
    const full = action.dataBase64 as string
    const uploadId = crypto.randomUUID()
    const chunks = chunkBase64(full, UPLOAD_CHUNK_B64_BYTES)
    const total = chunks.length
    const send = (a: Action) => useWs
      ? sendCommandWs(a, globalTabId, globalContextId)
      : sendCommand(a, globalTabId, globalContextId)
    try {
      for (let seq = 0; seq < total; seq++) {
        const r = unwrapResult(await send({ type: "file_upload_chunk", uploadId, seq, total, chunk: chunks[seq] }))
        if (!r.success) {
          console.error(`error: upload chunk ${seq + 1}/${total} failed: ${r.error || "unknown"}`)
          process.exit(1)
        }
      }
      const assemble: Action = { type: "file_upload", uploadId, fileName: action.fileName, mimeType: action.mimeType }
      if (action.ref !== undefined) assemble.ref = action.ref
      if (action.index !== undefined) assemble.index = action.index
      if (action.dropzone) assemble.dropzone = true
      const finalResult = unwrapResult(await send(assemble))
      console.log(formatResult(finalResult, jsonMode))
    } catch (err) {
      console.error(`error: ${(err as Error).message}`)
      process.exit(1)
    }
    return
  }

  if (action && action.type === "sse_tail") {
    const filter = (action.filter as string) || ""
    const timeout = (action.timeout as number) || 60000
    const startTime = Date.now()
    let offset = 0
    let lastActive = true

    while (Date.now() - startTime < timeout) {
      try {
        const chunkAction = { type: "sse_chunk", filter, since: offset }
        const resp = useWs
          ? await sendCommandWs(chunkAction, globalTabId, globalContextId)
          : await sendCommand(chunkAction, globalTabId, globalContextId)
        const result = unwrapResult(resp)
        if (result?.success && result.data) {
          const d = result.data as { active: boolean; text?: string; offset?: number }
          if (d.text) {
            process.stdout.write(d.text)
            offset = d.offset || offset
          }
          if (!d.active && lastActive) {
            // stream ended
            break
          }
          lastActive = d.active
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200))
    }
    process.exit(0)
  }

  let pendingMonitorTaskId: string | undefined
  if (action?.type === "monitor_start" && typeof action.taskRef === "string") {
    try {
      const { task } = resolveOrCreateMonitorTask({
        taskRef: action.taskRef,
        mode: typeof action.taskMode === "string" ? action.taskMode : undefined,
        instruction: typeof action.instruction === "string" ? action.instruction : undefined,
        createdBy: "browser-monitor",
        retentionPolicyId: typeof action.retentionPolicyId === "string" ? action.retentionPolicyId : undefined,
        guardPolicyId: typeof action.guardPolicyId === "string" ? action.guardPolicyId : undefined,
        verifierPolicyId: typeof action.verifierPolicyId === "string" ? action.verifierPolicyId : undefined,
      })
      pendingMonitorTaskId = task.taskId
      action.taskId = task.taskId
    } catch (err) {
      console.error(`error: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  // Apply global modifiers
  if (anyTab) action.anyTab = true
  if (filtered.includes("--changes")) action.changes = true

  try {
    const response = useWs
      ? await sendCommandWs(action, globalTabId, globalContextId)
      : await sendCommand(action, globalTabId, globalContextId)
    const result = unwrapResult(response)
    if (pendingMonitorTaskId) {
      if (result.success) {
        const data = (result.data || {}) as Record<string, unknown>
        const sid = typeof data.sessionId === "string" ? data.sessionId : typeof data.sid === "string" ? data.sid : undefined
        if (sid) {
          try {
            attachMonitorTaskSource(pendingMonitorTaskId, sid, {
              surface: "browser",
              rootTabId: typeof data.tabId === "number" ? data.tabId : undefined,
            })
            ;(data as Record<string, unknown>).taskId = pendingMonitorTaskId
            result.data = data
          } catch (err) {
            markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, sid, (err as Error).message)
            console.error(`error: monitor session ${sid} started but task attachment failed: ${(err as Error).message}`)
            process.exit(1)
          }
        } else {
          markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, undefined, "monitor_start response did not include sessionId")
        }
      } else {
        markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, undefined, result.error || "monitor_start failed")
      }
    }

    // Screenshot save-to-disk post-processing
    if (result.success && result.data && typeof result.data === "object" &&
        (result.data as Record<string, unknown>).save &&
        (result.data as Record<string, unknown>).dataUrl) {
      const d = result.data as Record<string, unknown>
      const dataUrl = d.dataUrl as string
      const base64 = dataUrl.split(",")[1]
      const formatStr = d.format as string
      const ext = formatStr === "png" ? "png" : formatStr === "webp" ? "webp" : "jpg"
      const filename = `interceptor-screenshot-${Date.now()}.${ext}`
      const bytes = Buffer.from(base64, "base64")
      await Bun.write(filename, bytes)
      d.filePath = `${process.cwd()}/${filename}`
      delete d.save
      delete d.dataUrl
      process.stderr.write(`saved: ${d.filePath}\n`)
    }

    // Net-log export: route through the new format pipeline when --format is set
    // and not the default text. Text remains on the existing formatResult path.
    if (action.type === "net_log" && result.success && action.format && action.format !== "text") {
      const format = action.format as ExportFormat
      const entries = (result.data as PassiveNetEntry[] | undefined) || []
      const captures = fromPassive(entries)
      try {
        await writeExport({
          format,
          captures,
          meta: {
            generatorName: "interceptor",
            generatorVersion: VERSION,
            generatedAt: new Date(),
            source: "net-log",
            comment: `net log buffer dump (${captures.length} entries)`,
          },
          out: action.out as string | undefined,
          redactAuth: action.redactAuth === true,
        })
        // pcapng with --out: also report saved path. har/json with --out: same. Both go to stderr so stdout stays clean.
        if (action.out) process.stderr.write(`saved: ${action.out}\n`)
      } catch (err) {
        console.error(`error: ${(err as Error).message}`)
        process.exit(1)
      }
      return
    }

    // Pretty-print known result types
    if (!jsonMode && result.success) {
      if (action.type === "get_state") {
        console.log(formatState(result.data as Parameters<typeof formatState>[0]))
        return
      }
      if (action.type === "tab_list") {
        console.log(formatTabs(result.data as Parameters<typeof formatTabs>[0]))
        return
      }
      if (action.type === "cookies_get") {
        console.log(formatCookies(result.data as Parameters<typeof formatCookies>[0]))
        return
      }
      if (action.type === "find_element" || action.type === "frames_find") {
        console.log(formatFind(result.data as Parameters<typeof formatFind>[0]))
        return
      }
    }

    // A background router older than this CLI forwards unrecognized action
    // types to the content script, which answers "unknown action type: <t>" —
    // the stale-extension-snapshot symptom after a pkg install (the running
    // browser keeps the old service worker until reloaded). Label it.
    if (!result.success && typeof result.error === "string" && result.error.startsWith("unknown action type:")) {
      process.stderr.write(
        `hint: the browser may be running an older Interceptor extension snapshot than this CLI (${VERSION}). ` +
        `Run 'interceptor reload' (or reload the extension in the browser) and retry.\n`,
      )
    }
    console.log(formatResult(result, jsonMode))
    // Issue #237: a failed action (`back` with no history, a rejected
    // `navigate`, …) printed `error:` but the process still exited 0, so a
    // scripted check read the failure as success. Every generic action funnels
    // through this print, so the exit code is mapped once here. exitCode (not
    // exit()) lets stdout drain and the transport close normally.
    if (!result.success) process.exitCode = 1
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
