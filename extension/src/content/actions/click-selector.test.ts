/// <reference lib="dom" />

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by another test file */ }

beforeAll(() => {
  ;(globalThis as any).chrome = {
    runtime: { onMessage: { addListener() {} } },
  }
})

// No module mocks: happy-dom carries PointerEvent/MutationObserver/
// scrollIntoView, so the real input-simulation dispatch runs and clicks are
// observed through real listeners. (A mock of ../input-simulation would leak
// into the co-located file.test.ts, which needs the real module.)

afterEach(() => {
  document.body.innerHTML = ""
})

function addButtons(n: number): { buttons: HTMLButtonElement[]; clicked: number[] } {
  const clicked: number[] = []
  const buttons = Array.from({ length: n }, (_, i) => {
    const b = document.createElement("button")
    b.textContent = `btn-${i}`
    // Mutate asynchronously: waitForMutation attaches its observer after the
    // dispatch, so a synchronous mutation inside the listener would be missed.
    b.addEventListener("click", () => {
      clicked.push(i)
      setTimeout(() => document.body.appendChild(document.createElement("span")), 0)
    })
    document.body.appendChild(b)
    return b
  })
  return { buttons, clicked }
}

describe("handleClickSelector", () => {
  test("clicks the nth match and reports its ref and the match count", async () => {
    const { handleClickSelector } = await import("./click")
    const { clicked } = addButtons(3)
    const res = await handleClickSelector({ type: "click_selector", selector: "button", nth: 1 })
    expect(res.success).toBe(true)
    expect(clicked).toEqual([1])
    expect(String(res.data)).toMatch(/clicked e\d+ — button\[1\] of 3/)
    // Structured refId lets the background router escalate to os_click
    // without parsing the human-facing string.
    expect(res.refId).toMatch(/^e\d+$/)
    expect(String(res.data)).toContain(`clicked ${res.refId}`)
    // warning presence is not asserted here: whether the observer catches the
    // listener's async mutation is a happy-dom timing detail. The warning
    // path is covered deterministically below.
  })

  test("zero matches errors with the count", async () => {
    const { handleClickSelector } = await import("./click")
    const res = await handleClickSelector({ type: "click_selector", selector: "nav", nth: 0 })
    expect(res.success).toBe(false)
    expect(res.error).toContain("matched 0 element(s); no index 0")
  })

  test("nth out of bounds errors with the count and clicks nothing", async () => {
    const { handleClickSelector } = await import("./click")
    const { clicked } = addButtons(3)
    const res = await handleClickSelector({ type: "click_selector", selector: "button", nth: 5 })
    expect(res.success).toBe(false)
    expect(res.error).toContain("matched 3 element(s); no index 5")
    expect(clicked).toHaveLength(0)
  })

  test("invalid selector is reported, not thrown", async () => {
    const { handleClickSelector } = await import("./click")
    const res = await handleClickSelector({ type: "click_selector", selector: "[[", nth: 0 })
    expect(res.success).toBe(false)
    expect(res.error).toContain("invalid CSS selector")
  })

  test("empty selector is an explicit error", async () => {
    const { handleClickSelector } = await import("./click")
    const res = await handleClickSelector({ type: "click_selector", selector: "", nth: 0 })
    expect(res.success).toBe(false)
    expect(res.error).toContain("no selector given")
  })

  test("no DOM change after click warns with the trusted retry naming the ref", async () => {
    const { handleClickSelector } = await import("./click")
    // A button with no mutating listener: the click lands but nothing changes.
    const b = document.createElement("button")
    document.body.appendChild(b)
    const res = await handleClickSelector({ type: "click_selector", selector: "button", nth: 0 })
    expect(res.success).toBe(true)
    expect(res.warning).toMatch(/interceptor click --trusted e\d+/)
    expect(res.refId).toMatch(/^e\d+$/)
    expect(res.warning).toContain(`--trusted ${res.refId}`)
  })
})

// Review 2026-09-07: both dispatch paths are synchronous, so a listener that
// mutates the DOM inline used to be missed (the observer was registered after
// the dispatch) and the click escalated as "no DOM change".
describe("synchronous mutation detection", () => {
  test("handleClickSelector sees a mutation made inside the click listener", async () => {
    const b = document.createElement("button")
    b.textContent = "sync"
    b.addEventListener("click", () => document.body.appendChild(document.createElement("span")))
    document.body.appendChild(b)
    const { handleClickSelector } = await import("./click")
    const r = await handleClickSelector({ type: "click_selector", selector: "button" })
    expect(r.success).toBe(true)
    expect(r.warning).toBeUndefined()
  })
  test("handleClick (ref) sees a mutation made inside the click listener", async () => {
    const { handleClick } = await import("./click")
    const { getOrAssignRef } = await import("../ref-registry")
    const b = document.createElement("button")
    b.textContent = "sync-ref"
    b.addEventListener("click", () => { b.setAttribute("data-clicked", "1") })
    document.body.appendChild(b)
    const ref = getOrAssignRef(b)
    const r = await handleClick({ type: "click", ref })
    expect(r.success).toBe(true)
    expect(r.warning).toBeUndefined()
  })
})
