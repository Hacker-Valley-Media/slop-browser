import { activeTransport, isOsInputAvailable } from "../transport"
import { debuggerAttached, cdpAttachActDetach } from "../cdp"
import { resolveTabLifecycle } from "../tab-lifecycle"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleMetaActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "status": {
      // tabLifecycle: the resolved policy + which tier supplied it,
      // so agents can observe the reuse/idle-close behavior instead of fighting it.
      let tabLifecycle: Record<string, unknown> | undefined
      try {
        const resolved = await resolveTabLifecycle()
        tabLifecycle = { ...resolved.policy, source: resolved.source }
      } catch {}
      return {
        success: true,
        data: {
          connected: true,
          version: chrome.runtime.getManifest().version,
          ...(tabLifecycle ? { tabLifecycle } : {})
        }
      }
    }

    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100)
      return { success: true, data: "reloading in 100ms" }

    case "capabilities": {
      const daemonConnected = activeTransport !== "none"
      const hasDebugger = chrome.runtime.getManifest().permissions?.includes("debugger") ?? false
      const hasUserScriptsPermission = chrome.runtime.getManifest().permissions?.includes("userScripts") ?? false
      const debuggerActive = debuggerAttached.size > 0
      let userScriptsApi = false
      let userScriptsEnabled = false
      let userScriptsError: string | undefined
      try {
        userScriptsApi = !!chrome.userScripts
        if (chrome.userScripts) {
          await chrome.userScripts.getScripts()
          userScriptsEnabled = true
        }
      } catch (err) {
        userScriptsError = (err as Error).message || String(err)
      }
      return {
        success: true,
        data: {
          layers: {
            // Report the value the router will actually consult, not just
            // "a daemon is connected": on a host with no OS-input backend the
            // daemon says so at registration and every escalation is skipped.
            os_input: daemonConnected && await isOsInputAvailable(),
            tabCapture: true,
            cdp_debugger: hasDebugger,
            debugger_active: debuggerActive
          },
          userScripts: {
            manifest_permission: hasUserScriptsPermission,
            api_present: userScriptsApi,
            enabled: userScriptsEnabled,
            ...(userScriptsError ? { error: userScriptsError } : {})
          },
          daemon: daemonConnected,
          infoBannerHeight: debuggerActive ? 35 : 0
        }
      }
    }

    case "cdp_tree": {
      const depth = (action.depth as number) || undefined
      const result = await cdpAttachActDetach<{ nodes: unknown[] }>(
        tabId, "Accessibility.getFullAXTree", depth ? { depth } : undefined
      )
      if (!result.success) return { success: false, error: result.error }
      const nodes = result.data?.nodes || []
      const formatted = nodes.map((n: any) => {
        const role = n.role?.value || ""
        const name = n.name?.value || ""
        const nodeId = n.nodeId || ""
        return `[${nodeId}] ${role} "${name}"`
      }).join("\n")
      return { success: true, data: formatted || "empty tree" }
    }

    case "brand_set_tab_group": {
      // No-tab storage write that drives the runtime tab-group identity. The background
      // brand-tab-group `onChanged` listener picks this up and live-retitles the group.
      const title = typeof action.title === "string" ? action.title.trim() : ""
      if (!title) return { success: false, error: "brand_set_tab_group requires a non-empty title" }
      const color = typeof action.color === "string" ? action.color : "cyan"
      await chrome.storage.local.set({ brandTabGroup: { title, color } })
      return { success: true, data: { brandTabGroup: { title, color } } }
    }
  }
  return { success: false, error: `unknown meta action: ${action.type}` }
}
