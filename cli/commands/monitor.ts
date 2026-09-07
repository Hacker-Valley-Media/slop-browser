/**
 * cli/commands/monitor.ts — interceptor monitor start/stop/status/pause/resume/tail/list/export
 *
 * Subcommands that hit the daemon return an Action object.
 * Subcommands that read EVENTS_PATH directly (tail, list, export) return null
 * after handling their own output, matching the pattern in cli/commands/meta.ts case "events".
 */

import { existsSync, readFileSync } from "node:fs"
import { EVENTS_PATH } from "../../shared/platform"
import {
  MONITOR_EVENT_NAMES,
  hasSessionArtifacts,
  listPersistedSessionIds,
  readSessionEvents,
  readSessionMeta,
  readSessionNetArtifacts,
} from "../../shared/monitor-artifacts"
import {
  assertMonitorTaskBlueprintReady,
  attachMonitorTaskSource,
  buildMonitorTaskTimeline,
  generateMonitorTaskCaptureQuality,
  monitorTaskExportObject,
  readMonitorTaskCaptureQuality,
  readMonitorTaskMeta,
  readMonitorTaskTranscriptSegments,
  renderMonitorTaskStatus,
  renderMonitorTaskQualitySummary,
  resolveMonitorTaskId,
  snapshotMonitorTaskSources,
  stopMonitorTask,
  repairMonitorTask,
  synthesizeMonitorTaskTranscript,
  validateMonitorTaskMode,
  createMonitorTask,
  checkpointMonitorTask,
  resumeMonitorTask,
  verifyMonitorTask,
} from "../../shared/monitor-tasks"
import { sendCommand, sendCommandWs } from "../transport"
import { fromMonitorEvents, writeExport } from "../../shared/exports"
import { VERSION } from "../version"

type Action = { type: string; [key: string]: unknown }

interface MonEvent {
  timestamp?: string
  event?: string
  sid?: string
  s?: number
  t?: number
  tid?: number
  url?: string
  ins?: string
  ref?: string
  r?: string
  n?: string
  tg?: string
  x?: number
  y?: number
  v?: string
  ic?: boolean
  tr?: boolean
  kc?: string
  sx?: number
  sy?: number
  c?: number
  add?: number
  rem?: number
  attr?: number
  txt?: number
  tgts?: string[]
  u?: string
  m?: string
  st?: number
  bz?: number
  ct?: string
  typ?: string
  cause?: number
  evt?: number
  mut?: number
  net?: number
  nav?: number
  dur?: number
  reason?: string
  fid?: number
  dir?: string
  pk?: string
  bp?: string
  bt?: number
  enc?: string
  skt?: string
  ch?: string
  cn?: string
  rv?: boolean
  [key: string]: unknown
}

function isMonitorNetEvent(eventName: unknown): boolean {
  if (typeof eventName !== "string") return false
  return eventName === "fetch" ||
    eventName === "xhr" ||
    eventName === "sse" ||
    eventName.startsWith("ws_") ||
    eventName === "beacon" ||
    eventName === "beacon_error" ||
    eventName.startsWith("broadcast_")
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  return args[i + 1]
}

function flagPresent(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1
}

function readGlobalMonEvents(filterSid?: string): MonEvent[] {
  if (!existsSync(EVENTS_PATH)) return []
  const content = readFileSync(EVENTS_PATH, "utf-8")
  if (!content.trim()) return []
  const out: MonEvent[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as MonEvent
      if (!ev.event || !MONITOR_EVENT_NAMES.has(ev.event)) continue
      if (filterSid && ev.sid !== filterSid) continue
      out.push(ev)
    } catch {}
  }
  return out
}

function monitorEventKey(ev: MonEvent): string {
  return [
    ev.event || "",
    ev.sid || "",
    ev.s ?? "",
    ev.t ?? "",
    ev.tid ?? "",
    ev.doc || "",
    ev.u || ev.url || "",
  ].join("|")
}

function mergeMonEvents(primary: MonEvent[], secondary: MonEvent[]): MonEvent[] {
  if (primary.length === 0) return secondary
  if (secondary.length === 0) return primary
  const seen = new Set<string>()
  const merged: MonEvent[] = []
  for (const ev of [...primary, ...secondary]) {
    const key = monitorEventKey(ev)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(ev)
  }
  return merged.sort((a, b) => {
    const at = typeof a.t === "number" ? a.t : Date.parse(a.timestamp || "")
    const bt = typeof b.t === "number" ? b.t : Date.parse(b.timestamp || "")
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0)
  })
}

export function readMonEvents(filterSid?: string): MonEvent[] {
  if (filterSid && hasSessionArtifacts(filterSid)) {
    const sessionEvents = readSessionEvents(filterSid) as MonEvent[]
    if (sessionEvents.length > 0) {
      const sessionEventNames = new Set(sessionEvents.map((ev) => ev.event).filter(Boolean))
      const missingEventFamilies = readGlobalMonEvents(filterSid)
        .filter((ev) => ev.event && !sessionEventNames.has(ev.event))
      return mergeMonEvents(sessionEvents, missingEventFamilies)
    }
  }
  return readGlobalMonEvents(filterSid)
}

function summarizeEvents(
  sid: string,
  events: MonEvent[],
  meta?: ReturnType<typeof readSessionMeta>
): {
  sid: string; tid?: number; url?: string; ins?: string;
  startedAt: number; endedAt?: number; evt: number; mut: number;
  net: number; dur?: number; status: "active" | "stopped"
} {
  const start = events.find((ev) => ev.event === "mon_start")
  const stop = events.find((ev) => ev.event === "mon_stop")
  let evtCount = 0
  let mutCount = 0
  let netCount = 0
  for (const ev of events) {
    evtCount += 1
    if (ev.event === "mut") mutCount += 1
    if (isMonitorNetEvent(ev.event)) netCount += 1
  }
  return {
    sid,
    tid: meta?.rootTabId ?? start?.tid,
    url: meta?.url ?? start?.url,
    ins: meta?.instruction ?? start?.ins,
    startedAt: meta?.startedAt ?? start?.t ?? 0,
    endedAt: meta?.endedAt ?? stop?.t,
    evt: meta?.counts?.evt ?? evtCount,
    mut: meta?.counts?.mut ?? mutCount,
    net: meta?.counts?.net ?? netCount,
    dur: stop?.dur ?? (meta?.endedAt && meta.startedAt ? meta.endedAt - meta.startedAt : undefined),
    status: meta?.status ?? (stop ? "stopped" : "active")
  }
}

export function listSessions(): Array<{
  sid: string; tid?: number; url?: string; ins?: string;
  startedAt: number; endedAt?: number; evt: number; mut: number;
  net: number; dur?: number; status: "active" | "stopped"
}> {
  const map = new Map<string, ReturnType<typeof listSessions>[number]>()
  for (const sid of listPersistedSessionIds()) {
    const events = readSessionEvents(sid) as MonEvent[]
    const meta = readSessionMeta(sid)
    if (!meta && events.length === 0) continue
    map.set(sid, summarizeEvents(sid, events, meta))
  }

  const events = readGlobalMonEvents()
  const grouped = new Map<string, MonEvent[]>()
  for (const ev of events) {
    if (!ev.sid) continue
    const bucket = grouped.get(ev.sid) || []
    bucket.push(ev)
    grouped.set(ev.sid, bucket)
  }
  for (const [sid, group] of grouped) {
    if (map.has(sid)) continue
    map.set(sid, summarizeEvents(sid, group))
  }

  return Array.from(map.values()).sort((a, b) => a.startedAt - b.startedAt)
}

function pad(s: string, w: number, right = false): string {
  if (s.length >= w) return s
  const fill = " ".repeat(w - s.length)
  return right ? fill + s : s + fill
}

function relSeconds(t: number, base: number): string {
  const d = (t - base) / 1000
  const sign = d >= 0 ? "+" : "-"
  return `[${sign}${Math.abs(d).toFixed(3)}]`
}

function shortUrl(u: string): string {
  try {
    const parsed = new URL(u)
    return parsed.pathname + parsed.search
  } catch {
    return u
  }
}

export function renderEvent(ev: MonEvent, base: number): string {
  const rel = relSeconds(ev.t || base, base)
  const k = pad(ev.event || "?", 9)
  switch (ev.event) {
    case "mon_start":
      return `  ${rel}  ${k}  ${ev.sid?.slice(0, 8) || ""}  tab ${ev.tid || ""}  ${ev.url || ""}${ev.ins ? `\n            instruction: ${ev.ins}` : ""}`
    case "mon_stop":
      return `  ${rel}  ${k}  reason=${ev.reason || "?"}  ${ev.evt}evt ${ev.mut}mut ${ev.net}net ${ev.nav || 0}nav  ${((ev.dur || 0) / 1000).toFixed(3)}s`
    case "mon_pause":
    case "mon_resume":
      return `  ${rel}  ${k}`
    case "click":
    case "dblclick":
    case "rclick": {
      const trusted = ev.tr === false ? " synthetic" : ""
      const ref = ev.ref ? pad(ev.ref, 5) : pad("?", 5)
      const role = pad(ev.r || ev.tg || "?", 10)
      const name = ev.n ? `"${ev.n}"` : ""
      const at = ev.x !== undefined && ev.y !== undefined ? `(${ev.x},${ev.y})` : ""
      return `  ${rel}  ${k}  ${ref} ${role} ${name}  ${at}${trusted}`
    }
    case "input":
    case "change": {
      const ref = ev.ref ? pad(ev.ref, 5) : pad("?", 5)
      const role = pad(ev.r || ev.tg || "?", 10)
      const name = ev.n ? `"${ev.n}"` : ""
      const val = ev.v !== undefined ? `v="${ev.v}"` : ""
      return `  ${rel}  ${k}  ${ref} ${role} ${name}  ${val}`
    }
    case "key":
      return `  ${rel}  ${k}  ${ev.kc || "?"}${ev.ref ? `  ${ev.ref}` : ""}`
    case "scroll":
      return `  ${rel}  ${k}  dx=${ev.sx || 0} dy=${ev.sy || 0}`
    case "focus":
    case "blur":
      return `  ${rel}  ${k}  ${ev.ref || "?"}  ${ev.r || ""}  ${ev.n ? `"${ev.n}"` : ""}`
    case "copy":
    case "paste":
      return `  ${rel}  ${k}  ${ev.ref || "?"}`
    case "submit":
      return `  ${rel}  ${k}  ${ev.ref || "?"}  ${ev.n ? `"${ev.n}"` : ""}`
    case "mut": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : "(autonomous)"
      const counts = `+${ev.add || 0} -${ev.rem || 0} attr:${ev.attr || 0}${ev.txt ? ` txt:${ev.txt}` : ""}`
      return `  ${rel}  ${k}  ${counts}  ${cause}`
    }
    case "fetch":
    case "xhr": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : "(autonomous)"
      const u = ev.u ? shortUrl(ev.u) : "?"
      const sz = ev.bz ? `${(ev.bz / 1024).toFixed(1)}kB` : ""
      return `  ${rel}  ${k}  ${ev.m || "GET"} ${u} ${ev.st || 0}  ${sz}  ${cause}`
    }
    case "sse": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : "(autonomous)"
      const u = ev.u ? shortUrl(ev.u) : "?"
      const sz = ev.bz ? `${(ev.bz / 1024).toFixed(1)}kB` : ""
      return `  ${rel}  ${k}  SSE ${u} ${sz}  ${cause}`
    }
    case "ws_opening":
    case "ws_open":
    case "ws_send":
    case "ws_message":
    case "ws_error":
    case "ws_close": {
      const u = ev.u ? shortUrl(ev.u) : "?"
      const payload = ev.pk ? ` ${ev.pk}${ev.bt !== undefined ? ` ${ev.bt}B` : ""}` : ""
      return `  ${rel}  ${k}  ${ev.dir || ""} ${u}${payload}${ev.skt ? `  ${ev.skt}` : ""}`
    }
    case "beacon":
    case "beacon_error": {
      const u = ev.u ? shortUrl(ev.u) : "?"
      const payload = ev.pk ? ` ${ev.pk}${ev.bt !== undefined ? ` ${ev.bt}B` : ""}` : ""
      const rv = ev.rv !== undefined ? ` return=${ev.rv}` : ""
      return `  ${rel}  ${k}  POST ${u}${payload}${rv}`
    }
    case "broadcast_open":
    case "broadcast_send":
    case "broadcast_message":
    case "broadcast_error":
    case "broadcast_close": {
      const payload = ev.pk ? ` ${ev.pk}${ev.bt !== undefined ? ` ${ev.bt}B` : ""}` : ""
      return `  ${rel}  ${k}  ${ev.dir || ""} ${ev.cn || "?"}${payload}${ev.ch ? `  ${ev.ch}` : ""}`
    }
    case "nav": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : ""
      const u = ev.u ? shortUrl(ev.u) : "?"
      return `  ${rel}  ${k}  ${ev.typ || "?"} \u2192 ${u}  ${cause}`
    }
    // macOS event-kind rendering. Each row: relative-time, padded
    // event name, then the most-distinctive payload field for the kind.
    case "frontmost":
    case "app_launch":
    case "app_terminate":
    case "app_hide":
    case "app_unhide":
    case "app_deactivate": {
      const app = (ev as { app?: string }).app || "?"
      const bid = (ev as { bundleId?: string }).bundleId
      return `  ${rel}  ${k}  ${app}${bid ? `  (${bid})` : ""}`
    }
    case "space":
    case "wake":
    case "sleep":
    case "session_active":
    case "session_inactive":
      return `  ${rel}  ${k}`
    case "mount":
    case "unmount":
    case "volume_rename": {
      const path = (ev as { path?: string }).path || "?"
      return `  ${rel}  ${k}  ${path}`
    }
    case "window_create":
    case "window_move":
    case "window_resize":
    case "window_min":
    case "window_demin":
    case "window_focus": {
      const app = (ev as { app?: string }).app || ""
      const title = (ev as { n?: string }).n
      const frame = (ev as { frame?: { x: number; y: number; w: number; h: number } }).frame
      const f = frame ? `[${frame.x},${frame.y} ${frame.w}x${frame.h}]` : ""
      return `  ${rel}  ${k}  ${app}  ${title ? `"${title}"` : ""}  ${f}`
    }
    case "menu_open":
    case "menu_close":
    case "menu_select": {
      const name = (ev as { n?: string }).n || ""
      const app = (ev as { app?: string }).app || ""
      return `  ${rel}  ${k}  ${app}  "${name}"`
    }
    case "sheet":
    case "layout_change":
    case "ax_app_activated":
    case "ax_app_deactivated":
    case "ax_create":
    case "ax_destroy":
    case "ax_other": {
      const app = (ev as { app?: string }).app || ""
      const role = (ev as { r?: string }).r || ""
      return `  ${rel}  ${k}  ${app}  ${role}`
    }
    case "selection":
    case "selection_rows":
    case "title_change": {
      const role = (ev as { r?: string }).r || ""
      const title = (ev as { n?: string }).n || ""
      return `  ${rel}  ${k}  ${role}  "${title}"`
    }
    case "mouseup":
    case "move": {
      const x = (ev as { x?: number }).x ?? 0
      const y = (ev as { y?: number }).y ?? 0
      return `  ${rel}  ${k}  (${x},${y})`
    }
    case "mods": {
      const m = (ev as { mods?: string }).mods || ""
      return `  ${rel}  ${k}  ${m}`
    }
    case "clipboard": {
      const cc = (ev as { changeCount?: number }).changeCount ?? 0
      const types = ((ev as { types?: string[] }).types || []).slice(0, 3).join(",")
      const preview = ((ev as { preview?: string }).preview || "").slice(0, 40)
      return `  ${rel}  ${k}  cc=${cc}  ${types}  "${preview}"`
    }
    case "file_change": {
      const path = (ev as { path?: string }).path || "?"
      return `  ${rel}  ${k}  ${path}`
    }
    case "network_path": {
      const status = (ev as { status?: string }).status || ""
      const ifs = ((ev as { interfaces?: string[] }).interfaces || []).join(",")
      return `  ${rel}  ${k}  ${status}  ${ifs}`
    }
    case "notification": {
      const name = (ev as { name?: string }).name || ""
      const src = (ev as { source?: string }).source || ""
      return `  ${rel}  ${k}  ${src}:${name}`
    }
    case "log": {
      const level = (ev as { level?: string }).level || ""
      const subsystem = (ev as { subsystem?: string }).subsystem || ""
      const msg = ((ev as { message?: string }).message || "").slice(0, 80)
      return `  ${rel}  ${k}  [${level}]  ${subsystem}  ${msg}`
    }
    case "frame": {
      const w = (ev as { w?: number }).w ?? 0
      const h = (ev as { h?: number }).h ?? 0
      const path = (ev as { path?: string }).path || ""
      return `  ${rel}  ${k}  ${w}x${h}  ${path}`
    }
    case "ocr_text": {
      const blocks = ((ev as { blocks?: unknown[] }).blocks || []).length
      return `  ${rel}  ${k}  ${blocks} blocks`
    }
    case "speech_segment": {
      const text = ((ev as { text?: string }).text || "").slice(0, 60)
      return `  ${rel}  ${k}  "${text}"`
    }
    default:
      return `  ${rel}  ${k}  ${JSON.stringify(ev).slice(0, 200)}`
  }
}

function renderPersistedBodyComments(sid: string, cause: number | undefined): string[] {
  if (cause === undefined) return []
  const artifacts = readSessionNetArtifacts(sid).filter((artifact) => artifact.cause === cause)
  const lines: string[] = []
  for (const artifact of artifacts) {
    lines.push(`            persisted body: ${artifact.kind.toUpperCase()} ${artifact.method || "GET"} ${artifact.url}`)
    if (artifact.contentType) lines.push(`            content-type: ${artifact.contentType}`)
    lines.push(`            bytes: ${artifact.bodyBytes || artifact.bodyPreview.length}${artifact.truncated ? " (truncated)" : ""}`)
    for (const previewLine of artifact.bodyPreview.split("\n").slice(0, 12)) {
      lines.push(`            ${previewLine}`)
    }
  }
  return lines
}

export function renderSession(sid: string, includeBodies = false): string {
  const events = readMonEvents(sid)
  if (events.length === 0) return `(no events for session ${sid})`
  const start = events.find((e) => e.event === "mon_start")
  const stop = events.find((e) => e.event === "mon_stop")
  const base = start?.t || events[0].t || 0
  const lines: string[] = []
  const startedAt = start?.t ? new Date(start.t).toISOString().replace("T", " ").slice(0, 19) : "?"
  lines.push(`session ${sid}  started ${startedAt}  tab ${start?.tid || "?"}  ${start?.url || ""}`)
  if (start?.ins) lines.push(`  instruction: ${start.ins}`)
  if (stop) lines.push(`  ended after ${((stop.dur || 0) / 1000).toFixed(3)}s  ${stop.evt}evt ${stop.mut}mut ${stop.net}net`)
  else lines.push(`  status: active`)
  lines.push("")
  for (const ev of events) {
    if (ev.event === "mon_start" || ev.event === "mon_stop") continue
    lines.push(renderEvent(ev, base))
    if (includeBodies && isMonitorNetEvent(ev.event)) {
      lines.push(...renderPersistedBodyComments(sid, typeof ev.cause === "number" ? ev.cause : undefined))
    }
  }
  return lines.join("\n")
}

export function escapeArg(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function buildPlan(sid: string, includeSynthetic = false, includeBodies = false): string {
  const events = readMonEvents(sid)
  if (events.length === 0) return `# (no events for session ${sid})`
  const start = events.find((e) => e.event === "mon_start")
  const lines: string[] = []
  lines.push(`# Replay plan for session ${sid}`)
  if (start?.ins) lines.push(`# Instruction: ${start.ins}`)
  lines.push(`# Generated at ${new Date().toISOString()}`)
  lines.push("")

  if (start?.url) {
    lines.push(`interceptor tab new "${escapeArg(start.url)}"`)
    lines.push(`interceptor wait-stable`)
  }

  // If no real user events exist, include synthetic clicks automatically
  const actionKinds = new Set(["click", "dblclick", "rclick", "input", "change", "key", "submit"])
  const hasRealUserEvents = events.some((e) => e.tr !== false && actionKinds.has(e.event || ""))
  const emitSynthetic = includeSynthetic || !hasRealUserEvents

  type IndexedEvent = { ev: MonEvent; idx: number }
  const evList: IndexedEvent[] = events.map((ev, idx) => ({ ev, idx }))

  function nextMutBetween(fromIdx: number, untilIdx: number): boolean {
    for (let i = fromIdx + 1; i < untilIdx; i++) {
      if (evList[i].ev.event === "mut") return true
    }
    return false
  }

  function nextActionIdx(fromIdx: number): number {
    for (let i = fromIdx + 1; i < evList.length; i++) {
      const k = evList[i].ev.event
      if (k === "click" || k === "dblclick" || k === "rclick" || k === "input" || k === "change" || k === "key" || k === "submit") return i
    }
    return evList.length
  }

  for (let i = 0; i < evList.length; i++) {
    const { ev } = evList[i]
    const k = ev.event
    if (k === "mon_start" || k === "mon_stop" || k === "mon_pause" || k === "mon_resume") continue
    if (k === "scroll" || k === "focus" || k === "blur") continue
    if (ev.tr === false && !emitSynthetic) {
      lines.push(`# skipped synthetic ${k} (interceptor-injected)`)
      continue
    }
    switch (k) {
      case "click":
      case "dblclick":
      case "rclick": {
        const role = ev.r || ev.tg || ""
        const name = ev.n || ""
        if (role && name) {
          const cmd = k === "click" ? "click" : k === "dblclick" ? "dblclick" : "rightclick"
          lines.push(`interceptor ${cmd} "${escapeArg(role)}:${escapeArg(name)}"`)
        } else if (ev.ref) {
          const cmd = k === "click" ? "click" : k === "dblclick" ? "dblclick" : "rightclick"
          lines.push(`# ref ${ev.ref} (no accessible name) — falling back to ref id, may be stale`)
          lines.push(`interceptor ${cmd} ${ev.ref}`)
        } else {
          lines.push(`# ${k} with no ref or name — skipped`)
        }
        break
      }
      case "input":
      case "change": {
        const role = ev.r || ev.tg || ""
        const name = ev.n || ""
        if (typeof ev.v === "string" && ev.v.startsWith("***") && ev.v.endsWith("***")) {
          lines.push(`# TODO: type into ${role}:${name} — original value was masked (length ${ev.v.length - 6})`)
          break
        }
        const value = (ev.v as string) || ""
        if (role && name) {
          lines.push(`interceptor type "${escapeArg(role)}:${escapeArg(name)}" "${escapeArg(value)}"`)
        } else if (ev.ref) {
          lines.push(`# ref ${ev.ref} (no accessible name)`)
          lines.push(`interceptor type ${ev.ref} "${escapeArg(value)}"`)
        }
        break
      }
      case "key":
        if (ev.kc) lines.push(`interceptor keys "${escapeArg(ev.kc)}"`)
        break
      case "submit":
        lines.push(`# form submit on ${ev.ref || "?"} (usually triggered by Enter or click — covered above)`)
        break
      case "mut":
        // Mutation events become wait-stable hints, handled below
        break
      case "fetch":
      case "xhr": {
        if (ev.cause !== undefined) {
          const u = ev.u ? shortUrl(ev.u) : ""
          lines.push(`#   correlated ${k} ${ev.m || "GET"} ${u} ${ev.st || 0}  cause:#${ev.cause}`)
          const artifacts = includeBodies
            ? readSessionNetArtifacts(sid).filter((artifact) => artifact.cause === ev.cause)
            : []
          if (artifacts.length > 0) {
            for (const artifact of artifacts) {
              lines.push(`#   persisted body ${artifact.kind.toUpperCase()} ${artifact.method || "GET"} ${artifact.url}`)
              if (artifact.contentType) lines.push(`#   content-type: ${artifact.contentType}`)
              lines.push(`#   bytes: ${artifact.bodyBytes || artifact.bodyPreview.length}${artifact.truncated ? " (truncated)" : ""}`)
              for (const previewLine of artifact.bodyPreview.split("\n").slice(0, 12)) {
                lines.push(`#   ${previewLine}`)
              }
            }
          } else if (u) {
            lines.push(`# interceptor net log --filter "${escapeArg(u)}" --limit 1`)
          }
        } else {
          lines.push(`# autonomous ${k} ${ev.m || "GET"} ${ev.u || ""} (polling/timer)`)
        }
        break
      }
      case "mon_attach": {
        if (ev.reason === "child_tab" && ev.u) {
          lines.push(`# handoff to child tab ${ev.tid || "?"}`)
          lines.push(`interceptor tab new "${escapeArg(ev.u)}"`)
          lines.push(`interceptor wait-stable`)
        } else if (ev.reason === "focus_switch" && ev.tid) {
          lines.push(`# focus-switch to tab ${ev.tid}${ev.u ? ` (${ev.u})` : ""}`)
          lines.push(`interceptor tab switch ${ev.tid}`)
          lines.push(`interceptor wait-stable`)
        }
        break
      }
      case "mon_detach":
        break
      case "nav": {
        if (ev.typ === "hard" || ev.typ === "reload") {
          if (ev.u) {
            lines.push(`interceptor navigate "${escapeArg(ev.u)}"`)
            lines.push(`interceptor wait-stable`)
          }
        } else {
          lines.push(`# nav (${ev.typ}) -> ${ev.u || ""}  (caused by previous click)`)
        }
        break
      }
    }

    // Insert wait-stable after this action if a mutation follows before the next action
    const nextIdx = nextActionIdx(i)
    if (nextMutBetween(i, nextIdx)) {
      lines.push(`interceptor wait-stable`)
    }
  }

  return lines.join("\n")
}

function withBodies(planText: string, sid: string): string {
  if (readSessionNetArtifacts(sid).length > 0) return planText
  return planText.replace(/^# interceptor net log /gm, "interceptor net log ")
}

export async function parseMonitorCommand(filtered: string[], jsonMode = false, useWs = false): Promise<Action | null> {
  const sub = filtered[1]
  if (!sub || sub === "help") {
    console.log(MONITOR_HELP)
    return null
  }

  switch (sub) {
    case "start": {
      const inst = flagValue(filtered, "--instruction")
      const action: Action = { type: "monitor_start" }
      if (inst) action.instruction = inst
      const taskRef = flagValue(filtered, "--task")
      if (taskRef) {
        action.taskRef = taskRef
        action.instruction = inst || taskRef
        const mode = flagValue(filtered, "--mode")
        try {
          action.taskMode = validateMonitorTaskMode(mode)
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
        const retentionPolicyId = flagValue(filtered, "--retention-policy")
        const guardPolicyId = flagValue(filtered, "--guard-policy")
        const verifierPolicyId = flagValue(filtered, "--verifier-policy")
        if (retentionPolicyId) action.retentionPolicyId = retentionPolicyId
        if (guardPolicyId) action.guardPolicyId = guardPolicyId
        if (verifierPolicyId) action.verifierPolicyId = verifierPolicyId
      }
      const capture = flagValue(filtered, "--capture")
      if (capture) action.capture = capture
      if (flagPresent(filtered, "--reload") || flagPresent(filtered, "--from-start")) action.reload = true
      // --persist-bodies persists response bodies for EVERY captured fetch/xhr,
      // not just cause-tracked ones. Accepts an optional KB cap (default 64).
      // Example: `monitor start --persist-bodies` or `--persist-bodies 256`.
      const pbIdx = filtered.indexOf("--persist-bodies")
      if (pbIdx !== -1) {
        action.persistBodies = true
        const next = filtered[pbIdx + 1]
        if (next && /^\d+$/.test(next)) {
          action.bodyCapBytes = parseInt(next) * 1024
        }
      }
      return action
    }
    case "stop":
      if (flagPresent(filtered, "--task")) {
        try {
          const taskId = resolveMonitorTaskId(flagValue(filtered, "--task"))
          const task = stopMonitorTask(taskId, { stopSourcesRequested: flagPresent(filtered, "--stop-sources") })
          // auto-finalize: regenerate the transcript/segments so the
          // done→export flow yields a graded, non-empty envelope with no extra steps.
          synthesizeMonitorTaskTranscript(taskId)
          if (jsonMode) console.log(JSON.stringify(task, null, 2))
          else console.log(`${renderMonitorTaskStatus(task.taskId)}\n${renderMonitorTaskQualitySummary(task.taskId)}`)
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      return { type: "monitor_stop" }
    case "pause":
      return { type: "monitor_pause" }
    case "resume":
      return { type: "monitor_resume" }
    case "status":
      if (flagPresent(filtered, "--task")) {
        try {
          const taskId = resolveMonitorTaskId(flagValue(filtered, "--task"))
          const task = readMonitorTaskMeta(taskId)
          if (!task) throw new Error(`task not found: ${taskId}`)
          if (jsonMode) console.log(JSON.stringify(task, null, 2))
          else console.log(renderMonitorTaskStatus(taskId))
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      return { type: "monitor_status" }

    case "repair": {
      // the long-advertised `monitor repair`. Recovers any
      // live-but-unattached sessions for the task, snapshots sources, transcribes
      // offline audio, regenerates the timeline/transcript/segments, and re-grades.
      if (!flagPresent(filtered, "--task")) {
        console.error("error: interceptor monitor repair requires --task <taskId>")
        process.exit(1)
      }
      try {
        const taskId = resolveMonitorTaskId(flagValue(filtered, "--task"))
        const { report, attached } = repairMonitorTask(taskId, {
          snapshotSources: flagPresent(filtered, "--snapshot-sources"),
          regenerate: !flagPresent(filtered, "--no-regenerate"),
        })
        if (jsonMode) {
          console.log(JSON.stringify({ taskId, attached, report }, null, 2))
        } else {
          if (attached.length > 0) console.log(`recovered + attached ${attached.length} session(s): ${attached.join(", ")}`)
          console.log(`${renderMonitorTaskStatus(taskId)}\n${renderMonitorTaskQualitySummary(taskId)}`)
        }
        return null
      } catch (err) {
        console.error(`error: ${(err as Error).message}`)
        process.exit(1)
      }
    }

    case "task": {
      const op = filtered[2]
      if (["create", "checkpoint", "resume", "verify", "complete"].includes(op)) {
        try {
          const ref = filtered[3]
          if (!ref || ref.startsWith("--")) throw new Error(`monitor task ${op} requires ${op === "create" ? "a quoted objective" : "a task id or name"}`)
          let result: unknown
          if (op === "create") {
            result = createMonitorTask({ instruction: ref, mode: "agent-record" })
          } else {
            const taskId = resolveMonitorTaskId(ref)
            if (op === "checkpoint") {
              const file = flagValue(filtered, "--file")
              if (!file) throw new Error("checkpoint requires --file <checkpoint.json>")
              checkpointMonitorTask(taskId, JSON.parse(readFileSync(file, "utf8")))
            } else if (op === "verify" || op === "complete") {
              const send = useWs ? sendCommandWs : sendCommand
              const task = await verifyMonitorTask(taskId, async (target, code) => {
                const response = await send({ type: "evaluate", code, world: "MAIN", noCspReload: true, group: target.group, groupSoft: false, frameId: target.frameId }, target.tabId, target.contextId)
                return response.result
              }, op === "complete")
              if (!task.verification?.passed) process.exitCode = 1
            }
            result = resumeMonitorTask(taskId)
          }
          console.log(JSON.stringify(result, null, 2))
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          if (jsonMode) console.log(JSON.stringify({ success: false, error }))
          else console.error(`error: ${error}`)
          process.exitCode = 1
        }
        return null
      }
      if (op === "repair") {
        const taskId = filtered[3]
        if (!taskId) {
          console.error("error: interceptor monitor task repair requires <taskId>")
          process.exit(1)
        }
        try {
          const { report, attached } = repairMonitorTask(taskId, { snapshotSources: true })
          if (jsonMode) console.log(JSON.stringify({ taskId, attached, report }, null, 2))
          else console.log(`${renderMonitorTaskStatus(taskId)}\n${renderMonitorTaskQualitySummary(taskId)}`)
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      if (op === "attach") {
        const taskId = filtered[3]
        const sid = filtered[4]
        if (!taskId || !sid) {
          console.error("error: interceptor monitor task attach requires <taskId> <sid>")
          process.exit(1)
        }
        try {
          const { task, source } = attachMonitorTaskSource(taskId, sid)
          if (jsonMode) console.log(JSON.stringify({ task, source }, null, 2))
          else console.log(`attached ${source.surface} session ${sid} to task ${task.taskId}`)
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      if (op === "snapshot") {
        const taskRef = filtered[3]
        if (!taskRef) {
          console.error("error: interceptor monitor task snapshot requires <taskId|name>")
          process.exit(1)
        }
        try {
          // accept the task's name (instruction) as well as its id — the id is
          // generated, the name is what the user typed at start (#218).
          const taskId = resolveMonitorTaskId(taskRef)
          const manifest = snapshotMonitorTaskSources(taskId)
          if (jsonMode) console.log(JSON.stringify(manifest, null, 2))
          else console.log(`snapshotted ${manifest.filter((entry) => entry.status === "present").length} source artifacts for task ${taskId}`)
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      if (op === "quality" || op === "diagnose") {
        const taskRef = filtered[3]
        if (!taskRef) {
          console.error(`error: interceptor monitor task ${op} requires <taskId|name>`)
          process.exit(1)
        }
        try {
          const taskId = resolveMonitorTaskId(taskRef)
          // quality only READS the transcript/segments files; without this,
          // grading a task whose synthesis never ran (e.g. stopped via
          // `stop --sid`, which skips the task epilogue) reported
          // "transcript segments: 0" no matter what the sources hold (#218).
          if (readMonitorTaskTranscriptSegments(taskId).length === 0) {
            const meta = readMonitorTaskMeta(taskId)
            if (meta && meta.sourceSessions.length > 0) {
              try {
                synthesizeMonitorTaskTranscript(taskId)
                const segmentCount = readMonitorTaskTranscriptSegments(taskId).length
                console.error(`synthesized transcript (${segmentCount} segments) — quality reflects current sources`)
              } catch {
                // fall through to plain grading; the report's findings explain what's missing
              }
            }
          }
          const report = generateMonitorTaskCaptureQuality(taskId)
          if (jsonMode) console.log(JSON.stringify(report, null, 2))
          else console.log(renderMonitorTaskQualitySummary(taskId))
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      if (op === "compile-blueprint") {
        const taskId = filtered[3]
        if (!taskId) {
          console.error("error: interceptor monitor task compile-blueprint requires <taskId>")
          process.exit(1)
        }
        try {
          const report = assertMonitorTaskBlueprintReady(taskId, { forceDiagnostic: flagPresent(filtered, "--force-diagnostic") })
          const draft = {
            version: 1,
            taskId,
            status: "draft",
            createdAt: Date.now(),
            diagnosticOnly: !report.gates.blueprintCompilationReady,
            source: "monitor-task-quality-gate",
          }
          if (jsonMode) console.log(JSON.stringify(draft, null, 2))
          else console.log(`blueprint draft allowed for task ${taskId}`)
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      console.error("error: unknown monitor task subcommand. Try: create, checkpoint, resume, verify, complete, attach, snapshot, repair, quality, diagnose, compile-blueprint")
      process.exit(1)
    }

    case "tail": {
      const sidFilter = flagValue(filtered, "--session")
      const raw = flagPresent(filtered, "--raw")
      if (!existsSync(EVENTS_PATH)) {
        console.log("(no events file yet — start a session first with: interceptor monitor start)")
        return null
      }
      const proc = Bun.spawn(["tail", "-f", "-n", "0", EVENTS_PATH], { stdout: "pipe", stderr: "inherit" })
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf("\n")
        while (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          nl = buf.indexOf("\n")
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as MonEvent
            if (!ev.event || !MONITOR_EVENT_NAMES.has(ev.event)) continue
            if (sidFilter && ev.sid !== sidFilter) continue
            if (raw || jsonMode) {
              console.log(line)
            } else {
              const base = ev.t || 0
              console.log(renderEvent(ev, base))
            }
          } catch {}
        }
      }
      return null
    }

    case "list": {
      const sessions = listSessions()
      if (sessions.length === 0) {
        console.log("(no monitor sessions found in event log)")
        return null
      }
      if (jsonMode) {
        console.log(JSON.stringify(sessions, null, 2))
        return null
      }
      console.log(`${pad("session", 38)}${pad("status", 10)}${pad("started", 22)}${pad("tab", 12)}${pad("evt", 6)}${pad("mut", 6)}${pad("net", 6)}url`)
      for (const s of sessions) {
        const started = s.startedAt ? new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19) : "?"
        const url = s.url ? shortUrl(s.url) : ""
        console.log(`${pad(s.sid, 38)}${pad(s.status, 10)}${pad(started, 22)}${pad(String(s.tid || ""), 12)}${pad(String(s.evt), 6)}${pad(String(s.mut), 6)}${pad(String(s.net), 6)}${url}`)
      }
      return null
    }

    case "export": {
      const taskRef = flagValue(filtered, "--task")
      if (taskRef) {
        const format = flagValue(filtered, "--format") || (flagPresent(filtered, "--json") || jsonMode ? "json" : flagPresent(filtered, "--plan") ? "timeline" : "transcript")
        if (!["json", "timeline", "transcript", "segments", "quality"].includes(format)) {
          console.error(`error: --format for task export must be one of json|timeline|transcript|segments|quality (got '${format}')`)
          process.exit(1)
        }
        try {
          const taskId = resolveMonitorTaskId(taskRef)
          if (format === "timeline") {
            for (const entry of buildMonitorTaskTimeline(taskId)) console.log(JSON.stringify(entry))
          } else if (format === "transcript") {
            for (const entry of synthesizeMonitorTaskTranscript(taskId)) console.log(JSON.stringify(entry))
            if (!jsonMode) console.error(renderMonitorTaskQualitySummary(taskId))
          } else if (format === "segments") {
            synthesizeMonitorTaskTranscript(taskId)
            for (const entry of readMonitorTaskTranscriptSegments(taskId)) console.log(JSON.stringify(entry))
            if (!jsonMode) console.error(renderMonitorTaskQualitySummary(taskId))
          } else if (format === "quality") {
            console.log(JSON.stringify(readMonitorTaskCaptureQuality(taskId) || generateMonitorTaskCaptureQuality(taskId), null, 2))
          } else {
            console.log(JSON.stringify(monitorTaskExportObject(taskId), null, 2))
          }
          return null
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
      }
      const sid = filtered[2]
      if (!sid || sid.startsWith("--")) {
        console.error("error: interceptor monitor export requires a sessionId. Use 'interceptor monitor list' to find one.")
        process.exit(1)
      }
      const formatRaw = flagValue(filtered, "--format")
      const allowedFormats = new Set(["text", "json", "har", "pcapng", "plan"])
      if (formatRaw && !allowedFormats.has(formatRaw)) {
        console.error(`error: --format must be one of text|json|har|pcapng|plan (got '${formatRaw}')`)
        process.exit(1)
      }
      const outPath = flagValue(filtered, "--out")
      // `--json` honours both the parsed flag (when --json was passed after the
      // sessionId) AND the global jsonMode set in cli/index.ts (when --json
      // was passed before the subcommand and got stripped). Fixes issue #74.
      const json = flagPresent(filtered, "--json") || jsonMode
      const plan = flagPresent(filtered, "--plan")
      const wb = flagPresent(filtered, "--with-bodies")

      // New --format <har|pcapng|json> path takes precedence over the legacy
      // --json / --plan booleans. Format `text` falls through to renderSession.
      // Format `plan` falls through to the buildPlan branch below.
      if (formatRaw === "har" || formatRaw === "pcapng" || formatRaw === "json") {
        const meta = readSessionMeta(sid)
        // Read the session's events timeline (fetch/xhr/sse rows) as the
        // primary source; net.jsonl artifacts (body archive) enrich each row
        // via cause-match when present.
        const events = readMonEvents(sid)
        const netArtifacts = readSessionNetArtifacts(sid)
        const captures = fromMonitorEvents(events, netArtifacts)
        ;(async () => {
          try {
            await writeExport({
              format: formatRaw,
              captures,
              meta: {
                generatorName: "interceptor",
                generatorVersion: VERSION,
                generatedAt: new Date(),
                source: "monitor-export",
                session: meta
                  ? {
                      sid: meta.sessionId,
                      startedAt: new Date(meta.startedAt).toISOString(),
                      endedAt: meta.endedAt ? new Date(meta.endedAt).toISOString() : undefined,
                      rootTabId: meta.rootTabId,
                      instruction: meta.instruction,
                      counts: meta.counts
                        ? { evt: meta.counts.evt, mut: meta.counts.mut, net: meta.counts.net, nav: meta.counts.nav }
                        : undefined,
                    }
                  : undefined,
                comment: `monitor session ${sid} (${captures.length} entries)`,
              },
              out: outPath,
            })
            if (outPath) process.stderr.write(`saved: ${outPath}\n`)
          } catch (err) {
            console.error(`error: ${(err as Error).message}`)
            process.exit(1)
          }
        })()
        return null
      }

      if (formatRaw === "plan" || plan) {
        const inclSynthetic = flagPresent(filtered, "--include-synthetic")
        let text = buildPlan(sid, inclSynthetic, wb)
        if (wb) text = withBodies(text, sid)
        console.log(text)
        return null
      }
      if (json) {
        const events = readMonEvents(sid)
        for (const ev of events) console.log(JSON.stringify(ev))
        return null
      }
      console.log(renderSession(sid, wb))
      return null
    }

    default:
      console.error(`error: unknown monitor subcommand '${sub}'. Try: start, stop, status, pause, resume, repair, tail, list, export.`)
      process.exit(1)
  }
}

const MONITOR_HELP = `interceptor monitor — record user sessions for agent replay

Usage:
  interceptor monitor start [--instruction "<text>"] [--task "<task|taskId>"] [--mode human-observe|human-teach|agent-record|mixed] [--capture page-comm] [--reload] [--persist-bodies [<KB>]]
  interceptor monitor stop [--task <taskId>] [--stop-sources]
  interceptor monitor status [--task <taskId>]
  interceptor monitor pause
  interceptor monitor resume
  interceptor monitor repair --task <taskId> [--snapshot-sources] [--no-regenerate]
  interceptor monitor task attach <taskId> <sessionId>
  interceptor monitor task snapshot <taskId>
  interceptor monitor task repair <taskId>
  interceptor monitor task quality <taskId>
  interceptor monitor task compile-blueprint <taskId> [--force-diagnostic]
  interceptor monitor task create "<objective>"
  interceptor monitor task checkpoint <taskId> --file <checkpoint.json>
  interceptor monitor task resume <taskId>
  interceptor monitor task verify <taskId>
  interceptor monitor task complete <taskId>
  interceptor monitor tail [--session <sid>] [--raw]
  interceptor monitor list
  interceptor monitor export <sessionId> [--format text|json|har|pcapng|plan] [--out <path>] [--json|--plan] [--with-bodies]
  interceptor monitor export --task <taskId> [--format json|timeline|transcript|segments|quality]

start    Begin recording on the active interceptor-group tab. --capture page-comm includes WebSocket/Beacon/BroadcastChannel events; --reload captures from page start.
         --task creates or attaches a durable task envelope before source capture starts.
stop     End the active session and emit a summary.
         --task stops the task envelope without deleting source session artifacts.
status   Show active sessions and counts, or a task envelope when --task is present.
pause    Pause emission temporarily (does not unhook listeners).
resume   Resume emission.
repair   Recover unattached sessions for a task, snapshot sources, transcribe offline audio, regenerate timeline/transcript, and re-grade.
task     Manage task-scoped source membership and durable agent task state.
         create makes a task with no recording; checkpoint saves revisioned constraints, target, checks and lessons;
         resume returns compact state with scoped lessons; verify runs the stored checks now; complete requires every check to return true.
         snapshot copies source evidence under the task root; quality renders readiness gates; compile-blueprint enforces them.
tail     Live tail of recorded events. Pretty by default; --raw for JSONL.
list     List all sessions historically present in the event log.
export   Render a session as text, JSON (--json), or replay plan (--plan).
         --task renders a task-level JSON object, deterministic timeline, semantic transcript, teachable segments, or quality report.
         --with-bodies turns commented 'interceptor net log' cues into live invocations.
`
