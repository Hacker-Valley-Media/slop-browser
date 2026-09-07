import { sendToContentScript } from "./content-bridge"
import { activeTransport } from "./transport"
import { handleOsInputActions } from "./capabilities/os-input"
import { handleScreenshotActions } from "./capabilities/screenshot"
import { handleCaptureStreamActions } from "./capabilities/capture-stream"
import { handleCanvasActions } from "./capabilities/canvas"
import { handleTabActions } from "./capabilities/tabs"
import { handleWindowActions } from "./capabilities/windows"
import { handleNavigationActions } from "./capabilities/navigation"
import { handleCookieActions } from "./capabilities/cookies"
import { handleHistoryActions } from "./capabilities/history"
import { handleBookmarkActions } from "./capabilities/bookmarks"
import { handleDownloadActions } from "./capabilities/downloads"
import { handleSessionActions } from "./capabilities/sessions"
import { handleNotificationActions } from "./capabilities/notifications"
import { handleSearchActions } from "./capabilities/search"
import { handleBrowsingDataActions } from "./capabilities/browsing-data"
import { handleHeaderActions } from "./capabilities/headers"
import { handleEvaluateActions } from "./capabilities/evaluate"
import { handleBinarySinkActions } from "./capabilities/binary-sink"
import { handleStyleActions } from "./capabilities/style"
import { handleFrameActions } from "./capabilities/frames"
import { handleMetaActions } from "./capabilities/meta"
import { handlePassiveNetActions, restorePageCommCaptureConfig } from "./capabilities/passive-net"
import { handleCdpNetworkActions } from "./capabilities/cdp-network-actions"
import { handleMonitorActions, registerMonitorListeners } from "./capabilities/monitor"
import { handlePowerIdleActions } from "./keepawake"

// Keep this module import-safe. `transport.ts` imports the message dispatcher,
// which imports this router, so any top-level browser API call here runs before
// an entrypoint can select its browser-specific transport and capabilities.
// Safari treats an exception during that phase as a background-content load
// failure and never reaches the daemon. Each entrypoint calls this explicitly
// after it has configured its own runtime.
export function initializeActionRouter(): void {
  registerMonitorListeners()
  restorePageCommCaptureConfig()
}

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number; warning?: string }

const OS_INPUT_ACTIONS = new Set(["os_click", "os_key", "os_type", "os_move"])
const SCREENSHOT_ACTIONS = new Set(["screenshot", "screenshot_background", "page_capture", "ocr"])
const CAPTURE_STREAM_ACTIONS = new Set(["capture_start", "capture_frame", "capture_stop", "canvas_diff"])
const CANVAS_ACTIONS = new Set([
  "canvas_list",
  "canvas_read",
  "canvas_status",
  "canvas_log",
  "canvas_objects",
  "canvas_model",
  "canvas_routes",
  "canvas_ocr"
])
const TAB_ACTIONS = new Set([
  "tab_create", "tab_close", "tab_switch", "tab_list", "tab_duplicate",
  "tab_reload", "tab_mute", "tab_pin", "tab_zoom_get", "tab_zoom_set",
  "tab_group", "tab_ungroup", "tab_move", "tab_discard",
  "group_list", "group_close"
])
const WINDOW_ACTIONS = new Set([
  "window_create", "window_close", "window_focus", "window_resize", "window_list", "window_get_all"
])
const NAVIGATION_ACTIONS = new Set(["navigate", "go_back", "go_forward", "reload"])
const COOKIE_ACTIONS = new Set(["cookies_get", "cookies_set", "cookies_delete"])
const HISTORY_ACTIONS = new Set([
  "history_search", "history_visits", "history_delete", "history_delete_range", "history_delete_all"
])
const BOOKMARK_ACTIONS = new Set([
  "bookmark_tree", "bookmark_search", "bookmark_create", "bookmark_delete", "bookmark_update"
])
const DOWNLOAD_ACTIONS = new Set([
  "downloads_start", "downloads_search", "downloads_cancel", "downloads_pause", "downloads_resume"
])
const SESSION_ACTIONS = new Set(["session_list", "session_restore"])
const NOTIFICATION_ACTIONS = new Set(["notification_create", "notification_clear"])
const SEARCH_ACTIONS = new Set(["search_capability", "search_query"])
const BROWSING_DATA_ACTIONS = new Set(["browsing_data_remove"])
const HEADER_ACTIONS = new Set(["headers_modify"])
const EVALUATE_ACTIONS = new Set(["evaluate"])
const BINARY_SINK_ACTIONS = new Set(["binary_sink_save"])
const STYLE_ACTIONS = new Set(["style_inject", "style_remove"])
const FRAME_ACTIONS = new Set(["frames_list", "frames_read_tree", "frames_find"])
const META_ACTIONS = new Set(["status", "reload_extension", "capabilities", "cdp_tree", "brand_set_tab_group"])
const PASSIVE_NET_ACTIONS = new Set([
  "net_log", "net_clear", "net_headers", "sse_log", "sse_streams", "sse_chunk",
  "set_net_overrides", "clear_net_overrides",
  "page_comm_log", "page_comm_clear", "page_comm_enable", "page_comm_disable", "page_comm_status"
])
const CDP_NETWORK_ACTIONS = new Set(["network_intercept", "network_log", "network_override"])
const MONITOR_ACTIONS = new Set(["monitor_start", "monitor_stop", "monitor_status", "monitor_pause", "monitor_resume"])
const POWER_IDLE_ACTIONS = new Set(["keepawake", "idle_state"])
const SCENE_ACTIONS = new Set([
  "scene_list", "scene_click", "scene_dblclick", "scene_select", "scene_hit",
  "scene_selected", "scene_text", "scene_insert", "scene_cursor_to", "scene_cursor",
  "scene_slide_list", "scene_slide_goto", "scene_slide_current",
  "scene_notes", "scene_render", "scene_zoom", "scene_profile"
])

export async function routeAction(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (OS_INPUT_ACTIONS.has(action.type)) return handleOsInputActions(action, tabId)
  if (SCREENSHOT_ACTIONS.has(action.type)) return handleScreenshotActions(action, tabId)
  if (CAPTURE_STREAM_ACTIONS.has(action.type)) return handleCaptureStreamActions(action, tabId)
  if (CANVAS_ACTIONS.has(action.type)) return handleCanvasActions(action, tabId)
  if (TAB_ACTIONS.has(action.type)) return handleTabActions(action, tabId)
  if (WINDOW_ACTIONS.has(action.type)) return handleWindowActions(action, tabId)
  if (NAVIGATION_ACTIONS.has(action.type)) return handleNavigationActions(action, tabId)
  if (COOKIE_ACTIONS.has(action.type)) return handleCookieActions(action, tabId)
  if (HISTORY_ACTIONS.has(action.type)) return handleHistoryActions(action, tabId)
  if (BOOKMARK_ACTIONS.has(action.type)) return handleBookmarkActions(action, tabId)
  if (DOWNLOAD_ACTIONS.has(action.type)) return handleDownloadActions(action, tabId)
  if (SESSION_ACTIONS.has(action.type)) return handleSessionActions(action, tabId)
  if (NOTIFICATION_ACTIONS.has(action.type)) return handleNotificationActions(action, tabId)
  if (SEARCH_ACTIONS.has(action.type)) return handleSearchActions(action, tabId)
  if (BROWSING_DATA_ACTIONS.has(action.type)) return handleBrowsingDataActions(action, tabId)
  if (HEADER_ACTIONS.has(action.type)) return handleHeaderActions(action, tabId)
  if (EVALUATE_ACTIONS.has(action.type)) return handleEvaluateActions(action, tabId)
  if (BINARY_SINK_ACTIONS.has(action.type)) return handleBinarySinkActions(action, tabId)
  if (STYLE_ACTIONS.has(action.type)) return handleStyleActions(action, tabId)
  if (FRAME_ACTIONS.has(action.type)) return handleFrameActions(action, tabId)
  if (META_ACTIONS.has(action.type)) return handleMetaActions(action, tabId)
  if (PASSIVE_NET_ACTIONS.has(action.type)) return handlePassiveNetActions(action, tabId)
  if (CDP_NETWORK_ACTIONS.has(action.type)) return handleCdpNetworkActions(action, tabId)
  if (MONITOR_ACTIONS.has(action.type)) return handleMonitorActions(action, tabId)
  if (POWER_IDLE_ACTIONS.has(action.type)) return handlePowerIdleActions(action)

  // Default: forward to content script
  const contentResult = await sendToContentScript(
    tabId, action, action.frameId as number | undefined
  ) as { success: boolean; error?: string; data?: unknown; warning?: string; refId?: string }

  const shouldSceneEscalate =
    action.type === "scene_click" &&
    contentResult.success &&
    ((action.os === true) || contentResult.warning?.includes("no DOM change")) &&
    activeTransport !== "none"

  // click_selector escalates through the same path: the content handler
  // reports the clicked element's refId, which os_click resolves to screen
  // coordinates exactly like a ref-targeted click.
  const shouldClickEscalate =
    (action.type === "click" || action.type === "click_selector") &&
    contentResult.success &&
    contentResult.warning?.includes("no DOM change") &&
    activeTransport !== "none"

  if (shouldClickEscalate || shouldSceneEscalate) {
    const resolvedAt = typeof contentResult.data === "object" && contentResult.data
      ? (contentResult.data as { at?: { x?: number; y?: number } }).at
      : undefined
    console.log(`auto-escalating ${action.type} to OS-level input`)
    const osResult = await handleOsInputActions({
      ...action,
      type: "os_click",
      ref: contentResult.refId ?? action.ref,
      x: resolvedAt?.x ?? action.x,
      y: resolvedAt?.y ?? action.y
    }, tabId)
    if (osResult.success) {
      return {
        success: true,
        data: {
          ...((typeof osResult.data === "object" && osResult.data) || {}),
          escalated: {
            from: action.os === true ? "explicit" : "synthetic",
            to: "os_click",
            reason: action.os === true ? "scene click requested trusted input" : "no DOM mutation after synthetic click"
          }
        },
        tabId
      }
    }
    const guardRefused = action.os !== true
      && !!(typeof osResult.data === "object" && osResult.data && (osResult.data as { hint?: string }).hint)
    if (guardRefused) {
      // Only the synthetic layer ran: the foreground guard (issue #166) refused
      // to fire an OS event at a backgrounded tab. That is a skipped escalation,
      // not a failed click, so report the synthetic delivery and say so.
      return {
        ...contentResult,
        warning: `${contentResult.warning}; OS-level escalation skipped: ${osResult.error}`,
        tabId
      }
    }
    return {
      success: false,
      error: "click failed at all layers",
      data: {
        diagnostics: {
          layers_tried: ["synthetic", "os_click"],
          reason: action.os === true
            ? "trusted scene click failed"
            : "synthetic produced no DOM change, os_click failed",
          os_error: osResult.error,
          suggestion: (typeof osResult.data === "object" && osResult.data &&
            (osResult.data as { hint?: string }).hint) ||
            "verify element is interactive and Chrome window is visible"
        }
      }
    }
  }

  if (!contentResult.success && contentResult.error) {
    (contentResult as Record<string, unknown>).data = {
      ...(typeof contentResult.data === "object" && contentResult.data ? contentResult.data : {}),
      diagnostics: {
        layer_tried: "content_script",
        reason: contentResult.error,
        suggestion: action.type === "click"
          ? "try: interceptor click --trusted " + (action.ref || action.index || "")
          : action.type === "scene_click"
            ? "try: interceptor scene click --trusted " + (action.id || "")
          : undefined
      }
    }
  }

  return contentResult
}
