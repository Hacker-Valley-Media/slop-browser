import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  decodePlist, decodeBinaryPlist, decodeXmlPlist, encodeXmlPlist, isBinaryPlist,
  PlistError, DEFAULT_PLIST_LIMITS, type PlistValue,
} from "../daemon/ios/webinspector-plist"
import { HAS_PLUTIL } from "./helpers/macos-tools"

// Locks the bounded WIR plist codec: binary + XML decode incl. <data>, hard
// caps that fail before allocation, and well-formed XML encode. Validated
// against Apple's real `plutil` binary encoder.

/** Convert an XML plist string to a real bplist00 via Apple's plutil. */
function toBinaryPlist(xml: string): Buffer {
  const r = spawnSync("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "-"], { input: Buffer.from(xml) })
  if (r.status !== 0) throw new Error(`plutil failed: ${r.stderr?.toString()}`)
  return r.stdout
}

const SAMPLE_XML = encodeXmlPlist({
  __selector: "_rpc_applicationSentListing:",
  __argument: {
    WIRApplicationIdentifierKey: "PID:1234",
    WIRListingKey: {
      "1": { WIRPageIdentifierKey: 1, WIRTitleKey: "Example <b>&amp;</b>", WIRURLKey: "https://example.com/", WIRTypeKey: "WIRTypeWeb" },
    },
    WIRConnectionIdentifierKey: "conn-1",
    WIRSocketDataKey: Buffer.from("hello-socket-bytes"),
    WIRAutomaticInspectionKey: false,
  },
})

describe("webinspector plist codec", () => {
  test("XML plist round-trips through the in-process decoder", () => {
    const v = decodeXmlPlist(SAMPLE_XML) as any
    expect(v.__selector).toBe("_rpc_applicationSentListing:")
    expect(v.__argument.WIRApplicationIdentifierKey).toBe("PID:1234")
    expect(v.__argument.WIRListingKey["1"].WIRPageIdentifierKey).toBe(1)
    expect(v.__argument.WIRListingKey["1"].WIRTitleKey).toBe("Example <b>&amp;</b>") // round-trip fidelity
    expect(v.__argument.WIRAutomaticInspectionKey).toBe(false)
    expect(Buffer.isBuffer(v.__argument.WIRSocketDataKey)).toBe(true)
    expect((v.__argument.WIRSocketDataKey as Buffer).toString()).toBe("hello-socket-bytes")
  })

  // The three tests below validate against bytes only Apple's plutil can produce.
  test.skipIf(!HAS_PLUTIL)("binary plist decodes identically to XML (incl. <data> socket payload)", () => {
    const bin = toBinaryPlist(SAMPLE_XML)
    expect(isBinaryPlist(bin)).toBe(true)
    const v = decodeBinaryPlist(bin) as any
    expect(v.__selector).toBe("_rpc_applicationSentListing:")
    expect(v.__argument.WIRListingKey["1"].WIRURLKey).toBe("https://example.com/")
    expect((v.__argument.WIRSocketDataKey as Buffer).toString()).toBe("hello-socket-bytes")
  })

  test.skipIf(!HAS_PLUTIL)("decodePlist sniffs binary vs XML", () => {
    const bin = toBinaryPlist(SAMPLE_XML)
    expect((decodePlist(bin) as any).__selector).toBe("_rpc_applicationSentListing:")
    expect((decodePlist(Buffer.from(SAMPLE_XML)) as any).__selector).toBe("_rpc_applicationSentListing:")
  })

  test.skipIf(!HAS_PLUTIL)("integers, reals, booleans, nested arrays survive binary encode", () => {
    const obj: PlistValue = { n: 42, big: 70000, neg: -5, f: 1.5, t: true, f2: false, arr: [1, "two", Buffer.from("x")] }
    const bin = toBinaryPlist(encodeXmlPlist(obj))
    const v = decodeBinaryPlist(bin) as any
    expect(v.n).toBe(42)
    expect(v.big).toBe(70000)
    expect(v.neg).toBe(-5)
    expect(v.f).toBeCloseTo(1.5)
    expect(v.t).toBe(true)
    expect(v.f2).toBe(false)
    expect(v.arr[1]).toBe("two")
    expect((v.arr[2] as Buffer).toString()).toBe("x")
  })

  test("a declared frame past the byte cap fails before allocation", () => {
    const big = Buffer.alloc(DEFAULT_PLIST_LIMITS.maxBytes + 1)
    expect(() => decodePlist(big)).toThrow(PlistError)
  })

  test("malformed binary plist (bad trailer) throws PlistError, not a crash", () => {
    const junk = Buffer.concat([Buffer.from("bplist00", "latin1"), Buffer.alloc(4)])
    expect(() => decodeBinaryPlist(junk)).toThrow(PlistError)
  })

  test("malformed XML plist throws PlistError", () => {
    expect(() => decodeXmlPlist("<plist><dict><key>a</key></dict></plist>")).toThrow(PlistError)
    expect(() => decodeXmlPlist("not xml at all")).toThrow(PlistError)
  })

  test("depth cap is enforced", () => {
    let xml = "<plist>"
    for (let i = 0; i < 70; i++) xml += "<array>"
    xml += "<integer>1</integer>"
    for (let i = 0; i < 70; i++) xml += "</array>"
    xml += "</plist>"
    expect(() => decodeXmlPlist(xml, { ...DEFAULT_PLIST_LIMITS, maxDepth: 64 })).toThrow(PlistError)
  })

  test("string leaf cap is enforced", () => {
    const xml = `<plist><string>${"x".repeat(100)}</string></plist>`
    expect(() => decodeXmlPlist(xml, { ...DEFAULT_PLIST_LIMITS, maxLeafBytes: 10 })).toThrow(PlistError)
  })

  test("empty <string/> and <data/> self-close cleanly", () => {
    const v = decodeXmlPlist("<plist><dict><key>s</key><string/><key>d</key><data/></dict></plist>") as any
    expect(v.s).toBe("")
    expect((v.d as Buffer).length).toBe(0)
  })
})
