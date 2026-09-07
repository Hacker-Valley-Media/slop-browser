import type {
  SceneProfile,
  SceneObject,
  SceneEngineResult,
  SceneProfileDescription,
  SceneRenderResult,
  SceneResolvedTarget,
  SceneInsertResult
} from "./types"
import { genericProfile } from "./profiles/generic"
import { canvaProfile } from "./profiles/canva"
import { googleDocsProfile } from "./profiles/google-docs"
import { googleSlidesProfile } from "./profiles/google-slides"
import { waitForMutation } from "../input-simulation"

const profiles: SceneProfile[] = []
let genericRegistered = false
let builtinsRegistered = false

function ensureBuiltins(): void {
  if (builtinsRegistered) return
  builtinsRegistered = true
  profiles.push(canvaProfile)
  profiles.push(googleSlidesProfile)
  profiles.push(googleDocsProfile)
}

export function registerProfile(p: SceneProfile): void {
  profiles.push(p)
}

function ensureGeneric(): void {
  if (genericRegistered) return
  genericRegistered = true
  profiles.push(genericProfile)
}

export function detectProfile(override?: string): SceneProfile {
  ensureBuiltins()
  ensureGeneric()
  if (override) {
    const match = profiles.find((p) => p.name === override)
    if (match) return match
  }
  for (const p of profiles) {
    try {
      if (p === genericProfile) continue
      if (p.autoDetect === false) continue
      if (p.detect()) return p
    } catch {}
  }
  return genericProfile
}

function wrap<T>(profile: SceneProfile, fn: () => T | null | undefined): SceneEngineResult<T> {
  try {
    const data = fn()
    if (data === null || data === undefined) {
      return { success: false, error: "no data", profile: profile.name }
    }
    return { success: true, data: data as T, profile: profile.name }
  } catch (err) {
    return { success: false, error: (err as Error).message, profile: profile.name }
  }
}

async function wrapAsync<T>(profile: SceneProfile, fn: () => Promise<T | null | undefined>): Promise<SceneEngineResult<T>> {
  try {
    const data = await fn()
    if (data === null || data === undefined) {
      return { success: false, error: "no data", profile: profile.name }
    }
    return { success: true, data: data as T, profile: profile.name }
  } catch (err) {
    return { success: false, error: (err as Error).message, profile: profile.name }
  }
}

function inferDescription(p: SceneProfile): SceneProfileDescription {
  const caps: string[] = []
  if (p.list) caps.push("list")
  if (p.resolve) caps.push("resolve")
  if (p.selected) caps.push("selected")
  if (p.zoom) caps.push("zoom")
  if (p.text) caps.push("text")
  if (p.writeAtCursor) caps.push("writeAtCursor")
  if (p.cursorTo) caps.push("cursorTo")
  if (p.render) caps.push("render")
  if (p.slides) caps.push("slides")
  if (p.slideCurrent) caps.push("slideCurrent")
  if (p.slideGoto) caps.push("slideGoto")
  if (p.notes) caps.push("notes")
  if (p.hitTest) caps.push("hitTest")
  caps.push("trustedInput")
  return {
    name: p.name,
    capabilities: caps,
    strategies: [`profile:${p.name}`],
    geometryAddressable: !!(p.list || p.resolve || p.hitTest),
    focusAddressable: !!p.selected,
    textWritable: !!p.writeAtCursor,
    modelProbe: false,
    trustedInput: true
  }
}

export function canvasProfileName(override?: string): SceneEngineResult<SceneProfileDescription> {
  const p = detectProfile(override)
  const data = p.describe ? p.describe() : inferDescription(p)
  return { success: true, data, profile: p.name }
}

export function canvasList(opts?: { type?: string; profile?: string }): SceneEngineResult<SceneObject[]> {
  const p = detectProfile(opts?.profile)
  if (!p.list) return { success: false, error: `profile '${p.name}' does not support list()`, profile: p.name }
  return wrap(p, () => p.list!({ type: opts?.type }))
}

export function canvasResolve(id: string, profileOverride?: string): SceneEngineResult<SceneResolvedTarget> {
  const p = detectProfile(profileOverride)
  if (!p.resolve) return { success: false, error: `profile '${p.name}' does not support resolve()`, profile: p.name }
  const resolved = p.resolve(id)
  if (!resolved) return { success: false, error: `no element matches id '${id}'`, profile: p.name }
  return { success: true, data: resolved, profile: p.name }
}

export function canvasSelected(profileOverride?: string): SceneEngineResult<unknown> {
  const p = detectProfile(profileOverride)
  if (!p.selected) return { success: false, error: `profile '${p.name}' does not support selected()`, profile: p.name }
  return wrap(p, () => p.selected!())
}

export function canvasZoom(profileOverride?: string): SceneEngineResult<number> {
  const p = detectProfile(profileOverride)
  if (!p.zoom) return { success: false, error: `profile '${p.name}' does not support zoom()`, profile: p.name }
  return wrap(p, () => p.zoom!())
}

export function canvasText(opts?: { withHtml?: boolean; profile?: string }): SceneEngineResult<unknown> {
  const p = detectProfile(opts?.profile)
  if (!p.text) return { success: false, error: `profile '${p.name}' does not support text()`, profile: p.name }
  return wrap(p, () => p.text!({ withHtml: opts?.withHtml }))
}

export function canvasInsertText(text: string, profileOverride?: string): SceneEngineResult<SceneInsertResult> {
  const p = detectProfile(profileOverride)
  if (!p.writeAtCursor) return { success: false, error: `profile '${p.name}' does not support writeAtCursor()`, profile: p.name }
  const r = p.writeAtCursor(text)
  if (!r.success) return { success: false, error: r.error || "writeAtCursor failed", profile: p.name }
  return {
    success: true,
    data: {
      inserted: text.length,
      method: r.method || "dom",
      verified: r.verified !== false,
      text: r.text
    },
    profile: p.name
  }
}

export function canvasCursorTo(x: number, y: number, profileOverride?: string): SceneEngineResult<{ x: number; y: number }> {
  const p = detectProfile(profileOverride)
  if (!p.cursorTo) return { success: false, error: `profile '${p.name}' does not support cursorTo()`, profile: p.name }
  const r = p.cursorTo({ x, y })
  if (!r.success) return { success: false, error: r.error || "cursorTo failed", profile: p.name }
  return { success: true, data: { x, y }, profile: p.name }
}

export async function canvasRender(id: string, profileOverride?: string): Promise<SceneEngineResult<SceneRenderResult>> {
  const p = detectProfile(profileOverride)
  if (!p.render) return { success: false, error: `profile '${p.name}' does not support render()`, profile: p.name }
  return wrapAsync(p, () => p.render!(id))
}

export function canvasSlideList(profileOverride?: string): SceneEngineResult<unknown> {
  const p = detectProfile(profileOverride)
  if (!p.slides) return { success: false, error: `profile '${p.name}' does not support slides()`, profile: p.name }
  return wrap(p, () => p.slides!())
}

export function canvasSlideCurrent(profileOverride?: string): SceneEngineResult<unknown> {
  const p = detectProfile(profileOverride)
  if (!p.slideCurrent) return { success: false, error: `profile '${p.name}' does not support slideCurrent()`, profile: p.name }
  return wrap(p, () => p.slideCurrent!())
}

export function canvasSlideGoto(index: number, profileOverride?: string): SceneEngineResult<{ index: number }> {
  const p = detectProfile(profileOverride)
  if (!p.slideGoto) return { success: false, error: `profile '${p.name}' does not support slideGoto()`, profile: p.name }
  const r = p.slideGoto(index)
  if (!r.success) return { success: false, error: r.error || "slideGoto failed", profile: p.name }
  return { success: true, data: { index }, profile: p.name }
}

export function canvasNotes(slideIndex?: number, profileOverride?: string): SceneEngineResult<string> {
  const p = detectProfile(profileOverride)
  if (!p.notes) return { success: false, error: `profile '${p.name}' does not support notes()`, profile: p.name }
  return wrap(p, () => p.notes!(slideIndex))
}

export function canvasHit(x: number, y: number, profileOverride?: string): SceneEngineResult<SceneObject | null> {
  const p = detectProfile(profileOverride)
  if (p.hitTest) return wrap(p, () => p.hitTest!(x, y))
  if (p.list) {
    const list = p.list({}) || []
    const best = list.find((o) => x >= o.rect.x && x <= o.rect.x + o.rect.w && y >= o.rect.y && y <= o.rect.y + o.rect.h)
    if (!best) return { success: false, error: "no scene object at coordinates", profile: p.name }
    return { success: true, data: best, profile: p.name }
  }
  return { success: false, error: `profile '${p.name}' cannot hit-test`, profile: p.name }
}

// -----------------------------------------------------------------------------
// Top-level action dispatcher for content.ts
// -----------------------------------------------------------------------------

type Action = { type: string; [key: string]: unknown }
type ContentResult = { success: boolean; error?: string; data?: unknown; warning?: string }

function selectionChanged(before: unknown, after: unknown): boolean {
  try {
    return JSON.stringify(before) !== JSON.stringify(after)
  } catch {
    return before !== after
  }
}

export async function handleCanvasAction(action: Action): Promise<ContentResult> {
  const profileOverride = action.profile as string | undefined
  try {
    switch (action.type) {
      case "scene_profile": {
        const verbose = !!action.verbose
        const r = canvasProfileName(profileOverride)
        if (verbose) return r as ContentResult
        if (r.success && r.data) return { success: true, data: (r.data as { name: string }).name }
        return r as ContentResult
      }
      case "scene_list": {
        const r = canvasList({ type: action.filter as string | undefined, profile: profileOverride })
        return r as ContentResult
      }
      case "scene_click":
      case "scene_dblclick":
      case "scene_select": {
        const id = action.id as string
        if (!id) return { success: false, error: "missing id" }
        const resolved = canvasResolve(id, profileOverride)
        if (!resolved.success) return resolved as ContentResult
        const { clickElementCenter, dblclickElementCenter } = await import("./ops")
        const target = resolved.data as SceneResolvedTarget
        const beforeSelection = canvasSelected(profileOverride)
        const cx = Math.round(target.rect.cx)
        const cy = Math.round(target.rect.cy)
        if (action.type === "scene_click" && action.os) {
          return {
            success: true,
            data: {
              id,
              clicked: false,
              at: { x: cx, y: cy },
              method: "os_click"
            }
          }
        }
        if (action.type === "scene_dblclick") {
          if (target.element) dblclickElementCenter(target.element)
          else {
            const clicked = document.elementFromPoint(cx, cy)
            if (clicked) dblclickElementCenter(clicked)
          }
          return {
            success: true,
            data: { id, clicked: true, at: { x: cx, y: cy }, method: "synthetic" }
          }
        }
        const click = target.element
          ? () => clickElementCenter(target.element!)
          : await import("./ops").then(({ clickAtViewport }) => () => clickAtViewport(cx, cy))
        const mutation = waitForMutation(200)  // observe before the synchronous dispatch
        click()
        const mutated = await mutation
        const afterSelection = canvasSelected(profileOverride)
        const changed = mutated || selectionChanged(beforeSelection.data, afterSelection.data)
        return {
          success: true,
          data: { id, clicked: true, at: { x: cx, y: cy }, method: "synthetic" },
          warning: changed || action.escalate === false
            ? undefined
            : "no DOM change after scene click — try: interceptor scene click --trusted " + id
        }
      }
      case "scene_selected":
        return canvasSelected(profileOverride) as ContentResult
      case "scene_zoom":
        return canvasZoom(profileOverride) as ContentResult
      case "scene_text":
        return canvasText({ withHtml: !!action.withHtml, profile: profileOverride }) as ContentResult
      case "scene_insert":
        return canvasInsertText(action.text as string, profileOverride) as ContentResult
      case "scene_cursor_to":
        return canvasCursorTo(action.x as number, action.y as number, profileOverride) as ContentResult
      case "scene_cursor":
        return canvasSelected(profileOverride) as ContentResult
      case "scene_slide_list":
        return canvasSlideList(profileOverride) as ContentResult
      case "scene_slide_current":
        return canvasSlideCurrent(profileOverride) as ContentResult
      case "scene_slide_goto":
        return canvasSlideGoto(action.index as number, profileOverride) as ContentResult
      case "scene_notes":
        return canvasNotes(action.slideIndex as number | undefined, profileOverride) as ContentResult
      case "scene_render": {
        const r = await canvasRender(action.id as string, profileOverride)
        return r as ContentResult
      }
      case "scene_hit":
        return canvasHit(action.x as number, action.y as number, profileOverride) as ContentResult
      default:
        return { success: false, error: `unknown scene action: ${action.type}` }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
