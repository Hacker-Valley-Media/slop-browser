import { expect, test } from "bun:test"
import { IosManager } from "../daemon/ios/manager"
import { RunnerChannel } from "../daemon/ios/channel"

test("unlock and probe never launch a disconnected runner", async () => {
  const manager = new IosManager({ emit() {}, wsPort: 0 }) as any
  manager.canonicalContextId = () => "ios:test"
  let launches = 0
  manager.ensureRunner = async () => { launches++; return { ok: false, error: "launch failed" } }
  for (const probe of [true, false]) {
    const result = await manager.executeVerb("ios:test", { type: "ios_unlock", probe })
    expect(result.success).toBe(false)
    expect(result.error).toContain("resident runner")
  }
  expect(launches).toBe(0)
})

test("resident unlock requires observed unlocked true; probe preserves locked state", async () => {
  const manager = new IosManager({ emit() {}, wsPort: 0 }) as any
  manager.canonicalContextId = () => "ios:test"
  const channel = new RunnerChannel({ send() {} })
  manager.contexts.set("ios:test", { channel })
  channel.unlock = async () => ({ unlocked: false, locked: true, passcodeField: false })
  expect((await manager.executeVerb("ios:test", { type: "ios_unlock", passcode: "test-only" })).success).toBe(false)
  expect(await manager.executeVerb("ios:test", { type: "ios_unlock", probe: true })).toMatchObject({ success: true, data: { locked: true } })
  channel.unlock = async () => ({ unlocked: true, locked: false })
  expect((await manager.executeVerb("ios:test", { type: "ios_unlock", passcode: "test-only" })).success).toBe(true)
})

test("lock reports the runner's observed state instead of request success", async () => {
  const manager = new IosManager({ emit() {}, wsPort: 0 }) as any
  manager.canonicalContextId = () => "ios:test"
  const channel = new RunnerChannel({ send() {} })
  manager.contexts.set("ios:test", { channel })
  channel.pressButton = async () => ({ via: "iohid", locked: false })
  expect(await manager.executeVerb("ios:test", { type: "ios_press", button: "lock" }))
    .toMatchObject({ success: false, data: { pressed: "lock", via: "iohid", locked: false } })
  channel.pressButton = async () => ({ via: "iohid", locked: true })
  expect(await manager.executeVerb("ios:test", { type: "ios_press", button: "lock" }))
    .toMatchObject({ success: true, data: { pressed: "lock", via: "iohid", locked: true } })
})
