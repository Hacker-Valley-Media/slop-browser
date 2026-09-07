import { describe, expect, test } from "bun:test"
import {
  AFC_MAGIC, encodeAfcHeader, decodeAfcHeader,
  installProxyInstallRequest, encodeInstallProxyFrame, tryReadInstallProxyFrame,
} from "../daemon/ios/installer"
import { plistToObject } from "../daemon/ios/lockdown"
import { HAS_PLUTIL } from "./helpers/macos-tools"

// Locks the AFC header (magic + 4×u64 LE) and the installation_proxy request
// framing (shared 4-byte-BE + plist with lockdown).

describe("AFC header codec", () => {
  test("magic + 4×u64 LE fields roundtrip", () => {
    const h = encodeAfcHeader(0x10 /*FileWrite*/, 48, 40 + 12345, 7)
    expect(h.length).toBe(40)
    expect(h.toString("ascii", 0, 8)).toBe(AFC_MAGIC)
    const d = decodeAfcHeader(h)!
    expect(d.op).toBe(0x10)
    expect(d.thisLen).toBe(48)
    expect(d.entireLen).toBe(40 + 12345)
    expect(d.packetNum).toBe(7)
  })
  test("rejects a non-AFC buffer", () => {
    expect(decodeAfcHeader(Buffer.from("not-afc-header-bytes-padding-to-40......."))).toBeUndefined()
  })
})

// Asserting the request body means parsing it back with plistToObject,
// which shells out to /usr/bin/plutil.
describe.skipIf(!HAS_PLUTIL)("installation_proxy request", () => {
  test("Install carries PackageType Developer + the bundle id", () => {
    const req = installProxyInstallRequest("PublicStaging/Runner.app", "com.interceptor.InterceptorRunner.xctrunner")
    const frame = encodeInstallProxyFrame(req)
    const read = tryReadInstallProxyFrame(frame)!
    const obj = plistToObject(read.body)
    expect(obj.Command).toBe("Install")
    expect(obj.PackagePath).toBe("PublicStaging/Runner.app")
    const opts = obj.ClientOptions as Record<string, unknown>
    expect(opts.PackageType).toBe("Developer")
    expect(opts.CFBundleIdentifier).toBe("com.interceptor.InterceptorRunner.xctrunner")
  })
})
