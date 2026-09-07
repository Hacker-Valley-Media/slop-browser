import { describe, expect, test } from "bun:test"
import { IOS_ACTION_TYPES, IOS_VERB_TYPES } from "../shared/ios-device"
import { IOS_WEB_ACTION_TYPES } from "../shared/ios-web"
import { IOS_SVC_ACTION_TYPES } from "../shared/ios-service"
import { IOS_DEV_ACTION_TYPES, IOS_DEV_STREAM_ACTION_TYPES } from "../shared/ios-dev"
import { IosDevServiceManager } from "../daemon/ios/dev-manager"
import type { WebLaneDevice } from "../daemon/ios/device-services"
import { setAlias } from "../daemon/ios/state"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Locks the routing contract: ios_dev_* is DISJOINT from the native lifecycle/verb,
// web, and service sets, so a dev action can only reach the runner via the broad
// `ios:` fallback — which daemon/index.ts tests AFTER the ios_dev check. Plus device
// resolution + stream lifecycle.

describe("ios_dev action set", () => {
  test("has the 10 normative action types", () => {
    expect(IOS_DEV_ACTION_TYPES.size).toBe(10)
    for (const t of ["ios_proc", "ios_top", "ios_spawn", "ios_kill", "ios_location", "ios_gpu", "ios_shot", "ios_backup", "ios_screen", "ios_axtree"]) {
      expect(IOS_DEV_ACTION_TYPES.has(t)).toBe(true)
    }
  })

  test("oslog + pcap are removed (temporarily disabled — not delivering on iOS 27)", () => {
    expect(IOS_DEV_ACTION_TYPES.has("ios_oslog")).toBe(false)
    expect(IOS_DEV_ACTION_TYPES.has("ios_pcap")).toBe(false)
  })

  test("is disjoint from native lifecycle, verb, web, and svc sets", () => {
    for (const t of IOS_DEV_ACTION_TYPES) {
      expect(IOS_ACTION_TYPES.has(t)).toBe(false)
      expect(IOS_VERB_TYPES.has(t)).toBe(false) // cannot hit executeVerb by type
      expect(IOS_WEB_ACTION_TYPES.has(t)).toBe(false)
      expect(IOS_SVC_ACTION_TYPES.has(t)).toBe(false)
    }
  })

  test("stream subset is contained and holds only streaming actions", () => {
    for (const t of IOS_DEV_STREAM_ACTION_TYPES) expect(IOS_DEV_ACTION_TYPES.has(t)).toBe(true)
    expect(IOS_DEV_STREAM_ACTION_TYPES.has("ios_top")).toBe(true)
    expect(IOS_DEV_STREAM_ACTION_TYPES.has("ios_gpu")).toBe(true)
    expect(IOS_DEV_STREAM_ACTION_TYPES.has("ios_proc")).toBe(false)
  })
})

const oneDevice = async (): Promise<WebLaneDevice[]> => [{ udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" }]

describe("IosDevServiceManager", () => {
  test("no paired device → device_not_found", async () => {
    const mgr = new IosDevServiceManager({ discover: async () => [] })
    const r = await mgr.handle({ type: "ios_proc" })
    expect(r.success).toBe(false)
    expect((r.data as any).code).toBe("device_not_found")
  })

  test("multiple devices → device_not_found with candidates", async () => {
    const mgr = new IosDevServiceManager({ discover: async () => [
      { udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" },
      { udid: "U2", contextId: "ios:u2", paired: true, transport: "USB" },
    ] })
    const r = await mgr.handle({ type: "ios_proc" })
    expect((r.data as any).code).toBe("device_not_found")
    expect((r.data as any).candidates).toHaveLength(2)
  })

  test("top read with no active stream → stream_not_found (no tunnel opened)", async () => {
    const mgr = new IosDevServiceManager({ discover: oneDevice })
    const r = await mgr.handle({ type: "ios_top", operation: "read" }, "ios:u1")
    expect(r.success).toBe(false)
    expect((r.data as any).code).toBe("stream_not_found")
  })

  test("screen read with no active stream → stream_not_found (no device touch)", async () => {
    const mgr = new IosDevServiceManager({ discover: oneDevice })
    const r = await mgr.handle({ type: "ios_screen", operation: "read" }, "ios:u1")
    expect(r.success).toBe(false)
    expect((r.data as any).code).toBe("stream_not_found")
  })

  test("spawn without a bundle → bad_request (never touches the device)", async () => {
    const mgr = new IosDevServiceManager({ discover: oneDevice })
    const r = await mgr.handle({ type: "ios_spawn" }, "ios:u1")
    expect((r.data as any).code).toBe("bad_request")
  })

  test("friendly aliases resolve through the same device path as UDIDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "ios-alias-"))
    const prior = process.env.INTERCEPTOR_IOS_STATE_PATH
    process.env.INTERCEPTOR_IOS_STATE_PATH = join(root, "state.json")
    try {
      setAlias("phone", "U1")
      const mgr = new IosDevServiceManager({ discover: oneDevice })
      expect(await (mgr as any).resolveUdid({}, "phone")).toEqual({ udid: "U1", contextId: "ios:u1" })
    } finally {
      if (prior) process.env.INTERCEPTOR_IOS_STATE_PATH = prior
      else delete process.env.INTERCEPTOR_IOS_STATE_PATH
      rmSync(root, { recursive: true, force: true })
    }
  })
})
