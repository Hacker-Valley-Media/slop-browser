import { describe, expect, test } from "bun:test"
import {
  plistNode, buildPlist, encodeLockdownFrame, tryReadLockdownFrame, plistToObject,
} from "../daemon/ios/lockdown"
import { HAS_PLUTIL } from "./helpers/macos-tools"

// Locks the lockdown wire format: 4-byte BIG-endian length + XML plist body
// (distinct from usbmux's little-endian typed header), and the richer plist
// builder (nested dict / data / bool) the handshake + services need.

describe("lockdown plist + frame codec", () => {
  test("plistNode encodes each type", () => {
    expect(plistNode("hi")).toBe("<string>hi</string>")
    expect(plistNode(7)).toBe("<integer>7</integer>")
    expect(plistNode(true)).toBe("<true/>")
    expect(plistNode(false)).toBe("<false/>")
    expect(plistNode(Buffer.from("AB"))).toBe(`<data>${Buffer.from("AB").toString("base64")}</data>`)
    expect(plistNode({ a: "b" })).toBe("<dict><key>a</key><string>b</string></dict>")
    expect(plistNode(["x", 1])).toBe("<array><string>x</string><integer>1</integer></array>")
  })

  test("StartSession request carries HostID + SystemBUID", () => {
    const xml = buildPlist({ Request: "StartSession", HostID: "H-1", SystemBUID: "B-2" })
    expect(xml).toContain("<key>Request</key><string>StartSession</string>")
    expect(xml).toContain("<key>HostID</key><string>H-1</string>")
    expect(xml).toContain("<key>SystemBUID</key><string>B-2</string>")
    expect(xml.startsWith("<?xml")).toBe(true)
  })

  test("frame = 4-byte BE length prefix + body, and reads back", () => {
    const frame = encodeLockdownFrame({ Request: "QueryType" })
    const bodyLen = frame.length - 4
    expect(frame.readUInt32BE(0)).toBe(bodyLen)
    const read = tryReadLockdownFrame(frame)
    expect(read).toBeDefined()
    expect(read!.rest.length).toBe(0)
    expect(read!.body.toString("utf-8")).toContain("QueryType")
  })

  test("tryReadLockdownFrame returns undefined on a partial frame, splits multiple", () => {
    const a = encodeLockdownFrame({ Request: "A" })
    const b = encodeLockdownFrame({ Request: "B" })
    expect(tryReadLockdownFrame(a.subarray(0, 3))).toBeUndefined()   // header incomplete
    expect(tryReadLockdownFrame(a.subarray(0, a.length - 1))).toBeUndefined() // body incomplete
    const both = Buffer.concat([a, b])
    const first = tryReadLockdownFrame(both)!
    expect(first.body.toString()).toContain("<string>A</string>")
    const second = tryReadLockdownFrame(first.rest)!
    expect(second.body.toString()).toContain("<string>B</string>")
  })

  // plistToObject shells out to /usr/bin/plutil; the rest of the codec is pure JS.
  test.skipIf(!HAS_PLUTIL)("plistToObject roundtrips a built plist through plutil", () => {
    const xml = Buffer.from(buildPlist({ Request: "StartService", Service: "com.apple.afc", Flag: true, N: 5 }))
    const obj = plistToObject(xml)
    expect(obj.Request).toBe("StartService")
    expect(obj.Service).toBe("com.apple.afc")
    expect(obj.Flag).toBe(true)
    expect(obj.N).toBe(5)
  })
})
