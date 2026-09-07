/**
 * cli/commands/meta.ts — status, reload, meta, links, images, forms, info, query, exists, count,
 *                        table, attr, style, events, notify, sessions, capabilities,
 *                        modals, panels
 *
 * Returns null for "status" and "events" (handled locally, no daemon connection needed).
 */

import { existsSync, readFileSync } from "node:fs"
import { parseElementTarget } from "../parse"
import {
  readStatusSnapshot,
  detectConfiguredBrowsers,
  detectSystemDefaultBrowser,
  defaultBrowserMatchesConfigured,
  formatStatus,
  snapshotToJson,
  type StatusSnapshot,
} from "../lib/status-renderer"
import { sendCommand } from "../transport"

type Action = { type: string; [key: string]: unknown }

/**
 * Best-effort extension-reachability probe (#49). Sends a `tab_list` to the
 * daemon and reads back. Reachable = the response carries at least one
 * interceptor-group tab. Probe is skipped silently when the daemon isn't
 * running, so `status` stays a true local-pre-spawn check by default.
 */
async function probeExtensionReachability(contextId?: string): Promise<{ reachable: boolean; reason?: string }> {
  try {
    const resp = await Promise.race([
      sendCommand({ type: "tab_list" }, undefined, contextId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timed out after 2s")), 2000)
      ),
    ])
    const result = resp.result
    if (!result.success) {
      return { reachable: false, reason: result.error || "tab_list failed" }
    }
    const tabs = (result.data as Array<unknown>) || []
    if (Array.isArray(tabs) && tabs.length > 0) {
      return { reachable: true }
    }
    return { reachable: false, reason: "no tabs in interceptor group; run 'interceptor open <url>' to verify" }
  } catch (err) {
    return { reachable: false, reason: (err as Error).message }
  }
}

export async function parseMetaCommand(filtered: string[], jsonMode = false, contextId?: string): Promise<Action | null> {
  const cmd = filtered[0]

  switch (cmd) {
    case "status": {
      const verbose = filtered.includes("--verbose") || filtered.includes("--explain") || filtered.includes("-v")
      const snap: StatusSnapshot = readStatusSnapshot()

      // Browser-config block (#52) — verbose-only. Renders wherever native
      // messaging hosts live on disk and a system default browser is
      // discoverable: macOS (Application Support + LaunchServices) and Linux
      // (XDG config home + xdg-settings). Windows keeps hosts in the registry,
      // so there is nothing to scan there.
      if (verbose && (process.platform === "darwin" || process.platform === "linux")) {
        const configured = detectConfiguredBrowsers()
        const sysDefault = detectSystemDefaultBrowser()
        snap.browser = {
          configured,
          systemDefault: sysDefault,
          matches: defaultBrowserMatchesConfigured(configured, sysDefault),
        }
      }

      // Extension-reachability probe (#49) — verbose-only, daemon-alive-only.
      // Stays a true local-pre-spawn check otherwise.
      if (verbose && snap.daemon) {
        const probe = await probeExtensionReachability(contextId)
        snap.extension = { probed: true, ...probe }
        // Surface the extension-resolved tab-lifecycle policy so agents
        // can observe the reuse/idle-close behavior. Best-effort, 2s-bounded.
        if (probe.reachable) {
          try {
            const resp = await Promise.race([
              sendCommand({ type: "status" }, undefined, contextId),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("status probe timed out after 2s")), 2000)
              ),
            ])
            const data = resp.result?.data as { tabLifecycle?: StatusSnapshot["tabLifecycle"] } | undefined
            if (data?.tabLifecycle) snap.tabLifecycle = data.tabLifecycle
          } catch {}
        }
      } else if (verbose && !snap.daemon) {
        snap.extension = { probed: false, reachable: false, reason: "daemon not running" }
      }

      if (jsonMode) {
        console.log(JSON.stringify(snapshotToJson(snap), null, 2))
      } else {
        console.log(formatStatus(snap, { verbose }))
      }
      return null
    }

    case "events": {
      const eventsPath = "/tmp/interceptor-events.jsonl"
      if (!existsSync(eventsPath)) {
        console.log("no events yet")
        return null
      }
      const tail = filtered.includes("--tail")
      if (tail) {
        const proc = Bun.spawn(["tail", "-f", eventsPath], { stdout: "inherit", stderr: "inherit" })
        await proc.exited
      } else {
        const since = filtered.includes("--since")
          ? parseInt(filtered[filtered.indexOf("--since") + 1])
          : 0
        const content = readFileSync(eventsPath, "utf-8").trim()
        if (!content) { console.log("no events yet"); return null }
        const lines = content.split("\n")
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (since && new Date(event.timestamp).getTime() < since) continue
            if (jsonMode) {
              console.log(line)
            } else {
              console.log(`${event.timestamp} ${event.event}${event.requestId ? ` [${event.requestId.slice(0, 8)}]` : ""}${event.action ? ` ${event.action}` : ""}${event.duration !== undefined ? ` ${event.duration}ms` : ""}${event.error ? ` error=${event.error}` : ""}`)
            }
          } catch {}
        }
      }
      return null
    }

    case "reload":
      return { type: "reload_extension" }

    case "meta":
      return { type: "meta" }

    case "links":
      return { type: "links" }

    case "images":
      return { type: "images" }

    case "forms":
      return { type: "forms" }

    case "page_info":
    case "info":
      return { type: "page_info" }

    case "query":
      return { type: "query", selector: filtered[1] }

    case "exists":
      return { type: "exists", selector: filtered[1] }

    case "count":
      return { type: "count", selector: filtered[1] }

    case "table":
      return filtered[1]
        ? { type: "table_data", selector: filtered[1] }
        : { type: "table_data" }

    case "attr":
      if (filtered[1] === "set") {
        return { type: "attr_set", ...parseElementTarget(filtered[2]), name: filtered[3], value: filtered[4] }
      } else {
        return { type: "attr_get", ...parseElementTarget(filtered[1]), name: filtered[2] }
      }

    case "style": {
      const sub = filtered[1]
      if (sub === "inject") {
        const cssIdx = filtered.indexOf("--css")
        const css = cssIdx !== -1 ? filtered.slice(cssIdx + 1).join(" ") : undefined
        if (!css) {
          console.error("style inject requires --css <rules>")
          return null
        }
        const frameIdsIdx = filtered.indexOf("--frame-ids")
        const frameIds = frameIdsIdx !== -1
          ? filtered[frameIdsIdx + 1]?.split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => Number.isFinite(n))
          : undefined
        const origin = filtered.includes("--author") ? "AUTHOR" : "USER"
        const action: Action = { type: "style_inject", css, origin }
        if (frameIds && frameIds.length) action.frameIds = frameIds
        else action.allFrames = !filtered.includes("--top-only")
        return action
      }
      if (sub === "remove") {
        const handle = filtered[2]
        if (!handle) {
          console.error("style remove requires a handle")
          return null
        }
        return { type: "style_remove", handle }
      }
      return { type: "style_get", ...parseElementTarget(filtered[1]), property: filtered[2] }
    }

    case "notify":
      return { type: "notification_create", title: filtered[1], message: filtered.slice(2).join(" ") }

    case "sessions":
      if (filtered[1] === "restore") {
        // First non-flag argument (previously `filtered[2]`, which swallowed
        // flags — `sessions restore --json` sent "--json" as the sessionId).
        const sessionId = filtered.slice(2).find(a => !a.startsWith("-"))
        // No-arg restore is deliberately refused: Chrome restores "whatever
        // closed most recently", which can be the user's own window. An undo
        // must name its target.
        if (!sessionId) {
          console.error("error: sessions restore requires a <sessionId> — run 'interceptor sessions' to list recently closed tabs/windows. (No-arg restore is disabled: it reopens whatever closed most recently, which may be the user's own window.)")
          process.exit(1)
        }
        return { type: "session_restore", sessionId }
      } else {
        const max = filtered.slice(1).find(a => !a.startsWith("-"))
        return { type: "session_list", maxResults: max ? parseInt(max) : 10 }
      }

    case "capabilities":
      return { type: "capabilities" }

    case "modals":
      return { type: "modals" }

    case "panels":
      return { type: "panels" }

    default:
      console.error(`error: unknown meta command '${cmd}'`)
      process.exit(1)
  }
}
