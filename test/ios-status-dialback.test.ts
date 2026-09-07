import { expect, test } from "bun:test"
import { IosManager } from "../daemon/ios/manager"

test("ios_status carries the resolver's dialBack + dialBackVia on a live context", async () => {
  const manager = new IosManager({ emit() {}, wsPort: 19222 }) as any
  const asked: string[] = []
  manager.resolveDialBack = async (kind: string, udid: string) => {
    asked.push(`${kind}:${udid}`)
    return { url: "ws://100.1.2.3:19222", host: "100.1.2.3", via: "vpn" }
  }
  manager.contexts.set("ios:test-dialback", {
    descriptor: { contextId: "ios:test-dialback", udid: "TEST-DIALBACK", name: "t", kind: "device", wayIn: "runner", productVersion: "27.0" },
    tunnel: "none", registeredAt: 1, channel: {},
  })
  const r = await manager.handle({ type: "ios_status" })
  expect(r.success).toBe(true)
  const mine = (r.data as any[]).find((d) => d.contextId === "ios:test-dialback")
  expect(mine.dialBack).toBe("ws://100.1.2.3:19222")
  expect(mine.dialBackVia).toBe("vpn")
  expect(asked).toContain("device:TEST-DIALBACK")
})
