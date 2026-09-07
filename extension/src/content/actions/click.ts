import { resolveElement, scrollIntoViewIfNeeded, dispatchClickSequence, waitForMutation } from "../input-simulation"
import { getOrAssignRef } from "../ref-registry"
import { getEffectiveRole, getAccessibleName } from "../a11y-tree"

type Action = { type: string; [key: string]: unknown }
// refId: structured ref of the acted-on element, for callers (the background
// router's OS-click escalation) that need to re-target it without parsing
// the human-facing data string.
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown; refId?: string }

export async function handleClick(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  scrollIntoViewIfNeeded(el)
  // Register the observer before the dispatch: both dispatch paths are
  // synchronous, so a listener that mutates inline would otherwise be missed
  // and the click would escalate as "no DOM change" (review 2026-09-07).
  const mutation = waitForMutation(200)
  dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
  const clickMsg = `clicked [${action.ref || action.index}]${action.x !== undefined ? ` at (${action.x},${action.y})` : ""}`
  const mutated = await mutation
  if (!mutated) {
    return { success: true, data: clickMsg, warning: "no DOM change after click — if the site requires trusted events, try: interceptor click --trusted " + (action.ref || action.index) }
  }
  return { success: true, data: clickMsg }
}

/**
 * Click by CSS selector.
 *
 * The gap this closes: `handleClick` resolves only a11y refs and indices, so a
 * page whose accessibility tree is empty is unclickable even when `query`
 * locates the element perfectly. That is not hypothetical — perplexity.ai
 * answer pages return an empty tree while `query "button span"` finds the
 * sources control exactly, so the sources panel could be seen and never opened.
 *
 * `nth` disambiguates rather than guessing: a selector matching several
 * elements is a caller error to surface, not one to silently resolve to the
 * first match, so the count comes back in the error.
 */
export async function handleClickSelector(action: Action): Promise<ActionResult> {
  const selector = String(action.selector ?? "")
  if (!selector) return { success: false, error: "click_selector: no selector given" }
  let matches: NodeListOf<Element>
  try {
    matches = document.querySelectorAll(selector)
  } catch {
    return { success: false, error: `click_selector: invalid CSS selector ${JSON.stringify(selector)}` }
  }
  const nth = typeof action.nth === "number" ? action.nth : 0
  const el = matches[nth] as HTMLElement | undefined
  if (!el) {
    return {
      success: false,
      error: `click_selector: ${selector} matched ${matches.length} element(s); no index ${nth}`,
    }
  }
  scrollIntoViewIfNeeded(el)
  const mutation = waitForMutation(200)
  dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
  const clickedRef = getOrAssignRef(el)
  const mutated = await mutation
  const msg = `clicked ${clickedRef} — ${selector}[${nth}] of ${matches.length}`
  if (!mutated) {
    return { success: true, data: msg, refId: clickedRef, warning: `no DOM change after click — if the site requires trusted events, try: interceptor click --trusted ${clickedRef}` }
  }
  return { success: true, data: msg, refId: clickedRef }
}

export async function handleDblclick(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  scrollIntoViewIfNeeded(el)
  dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
  const rect = el.getBoundingClientRect()
  const cx = action.x !== undefined ? rect.left + (action.x as number) : rect.left + rect.width / 2
  const cy = action.y !== undefined ? rect.top + (action.y as number) : rect.top + rect.height / 2
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
  return { success: true }
}

export async function handleRightclick(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  scrollIntoViewIfNeeded(el)
  const rect = el.getBoundingClientRect()
  const x = action.x !== undefined ? rect.left + (action.x as number) : rect.left + rect.width / 2
  const y = action.y !== undefined ? rect.top + (action.y as number) : rect.top + rect.height / 2
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
  return { success: true }
}

export async function handleClickAt(action: Action): Promise<ActionResult> {
  const cx = action.x as number
  const cy = action.y as number
  const targetEl = document.elementFromPoint(cx, cy)
  if (!targetEl) return { success: false, error: `no element at viewport coordinates (${cx}, ${cy})` }
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }
  targetEl.dispatchEvent(new PointerEvent("pointerover", opts))
  targetEl.dispatchEvent(new MouseEvent("mouseover", opts))
  targetEl.dispatchEvent(new PointerEvent("pointerdown", opts))
  targetEl.dispatchEvent(new MouseEvent("mousedown", opts))
  if ((targetEl as HTMLElement).focus) (targetEl as HTMLElement).focus()
  targetEl.dispatchEvent(new PointerEvent("pointerup", opts))
  targetEl.dispatchEvent(new MouseEvent("mouseup", opts))
  targetEl.dispatchEvent(new MouseEvent("click", opts))
  const targetRef = getOrAssignRef(targetEl)
  return { success: true, data: { clicked: targetRef, tag: targetEl.tagName.toLowerCase(), at: { x: cx, y: cy } } }
}

export async function handleWhatAt(action: Action): Promise<ActionResult> {
  const wx = action.x as number
  const wy = action.y as number
  const whatEl = document.elementFromPoint(wx, wy)
  if (!whatEl) return { success: true, data: { element: null, at: { x: wx, y: wy } } }
  const whatRef = getOrAssignRef(whatEl)
  const whatRect = whatEl.getBoundingClientRect()
  return {
    success: true,
    data: {
      ref: whatRef,
      tag: whatEl.tagName.toLowerCase(),
      role: getEffectiveRole(whatEl),
      name: getAccessibleName(whatEl),
      rect: { top: whatRect.top, left: whatRect.left, width: whatRect.width, height: whatRect.height }
    }
  }
}
