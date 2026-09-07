import { describe, expect, test } from "bun:test"
import { RunnerChannel } from "../daemon/ios/channel"
import { IosRefRegistry, formatWdaTree, frameCenter, type WdaSourceNode } from "../daemon/ios/tree"

// Locks the InterceptorRunner WS protocol: the manager sends
// { id, op, ...args } and resolves on the runner's { id, result } reply. A fake
// socket captures the frames so the protocol cannot silently drift from the
// Swift runner (ios/InterceptorRunner/Sources/InterceptorRunnerUITests.swift).

function fakeSocket() {
  const sent: any[] = []
  return { sent, ws: { send: (d: string) => { sent.push(JSON.parse(d)) } } }
}

describe("RunnerChannel WS protocol", () => {
  test("tap sends an op frame with coordinates and resolves on success", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.tap(10, 20)
    expect(sent).toHaveLength(1)
    expect(sent[0].op).toBe("tap")
    expect(sent[0].x).toBe(10)
    expect(sent[0].y).toBe(20)
    expect(typeof sent[0].id).toBe("string")
    ch.handleResponse(sent[0].id, { success: true })
    await p // resolves without throwing
  })

  test("drag carries from/to/duration", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.drag(1, 2, 3, 4, 0.7)
    expect(sent[0]).toMatchObject({ op: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4, duration: 0.7 })
    ch.handleResponse(sent[0].id, { success: true })
    await p
  })

  test("an error result rejects with the runner's message", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.screenshot()
    ch.handleResponse(sent[0].id, { success: false, error: "boom" })
    await expect(p).rejects.toThrow("boom")
  })

  test("source returns the raw snapshot data", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.source()
    expect(sent[0].op).toBe("source")
    ch.handleResponse(sent[0].id, { success: true, data: { type: "XCUIElementTypeApplication" } })
    expect(await p).toEqual({ type: "XCUIElementTypeApplication" })
  })

  test("windowSize maps {width,height} into the channel's rect shape", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.windowSize()
    expect(sent[0].op).toBe("windowSize")
    ch.handleResponse(sent[0].id, { success: true, data: { width: 390, height: 844 } })
    expect(await p).toEqual({ x: 0, y: 0, width: 390, height: 844 })
  })

  test("pressButton returns the runner's observed device result", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.pressButton("lock")
    expect(sent[0]).toMatchObject({ op: "press", name: "lock" })
    ch.handleResponse(sent[0].id, { success: true, data: { via: "iohid", locked: false } })
    expect(await p).toEqual({ via: "iohid", locked: false })
  })

  test("app launch is an 'app' op with action+bundleId", async () => {
    const { sent, ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.launchApp("com.openai.chatgpt")
    expect(sent[0]).toMatchObject({ op: "app", action: "launch", bundleId: "com.openai.chatgpt" })
    ch.handleResponse(sent[0].id, { success: true })
    await p
  })

  test("teardown rejects all in-flight ops", async () => {
    const { ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    const p = ch.status()
    ch.teardown()
    await expect(p).rejects.toThrow("disconnected")
  })

  test("a stale/unknown response id is ignored (no throw)", () => {
    const { ws } = fakeSocket()
    const ch = new RunnerChannel(ws)
    expect(() => ch.handleResponse("nope", { success: true })).not.toThrow()
  })
})

describe("runner snapshot shape feeds the existing tree formatter", () => {
  // The Swift runner emits exactly this WdaSourceNode shape (type carries the
  // XCUIElementType prefix; rect is x/y/width/height). Prove tree.ts consumes it.
  test("a runner-shaped node registers a ref and computes the tap center", () => {
    const root: WdaSourceNode = {
      type: "XCUIElementTypeApplication",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        {
          type: "XCUIElementTypeButton",
          label: "Send",
          name: "send-btn",
          rawIdentifier: "send-btn",
          isEnabled: true,
          isVisible: true,
          rect: { x: 100, y: 200, width: 80, height: 40 },
          children: [],
        },
      ],
    }
    const reg = new IosRefRegistry()
    const text = formatWdaTree(root, reg, { filter: "interactive" })
    expect(text).toContain('button "Send"')
    const btn = reg.all().find((e) => e.type === "Button")
    expect(btn).toBeDefined()
    expect(frameCenter(btn!)).toEqual({ x: 140, y: 220 })
  })
})
