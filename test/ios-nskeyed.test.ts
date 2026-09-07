import { describe, expect, test } from "bun:test"
import { nskeyedArchive } from "../daemon/ios/usertunnel"
import { nskeyedUnarchive } from "../daemon/ios/nskeyed"
import { decodePlist, PlistUID } from "../daemon/ios/webinspector-plist"
import { HAS_PLUTIL } from "./helpers/macos-tools"

// Round-trips NSKeyedArchiver: archive a PlistNode → binary plist → unarchive to
// plain JS. Proves the $objects/CF$UID graph resolves and bounds hold.

// nskeyedArchive builds the object graph as XML and hands it to `plutil
// -convert binary1`, so the whole suite needs the macOS tool present.
describe.skipIf(!HAS_PLUTIL)("nskeyed round-trip", () => {
  test("string", () => {
    expect(nskeyedUnarchive(nskeyedArchive({ str: "hello" }))).toBe("hello")
  })

  test("integer", () => {
    expect(nskeyedUnarchive(nskeyedArchive({ int: 42 }))).toBe(42)
  })

  test("array of strings", () => {
    const buf = nskeyedArchive({ arr: [{ str: "a" }, { str: "b" }, { str: "c" }] })
    expect(nskeyedUnarchive(buf)).toEqual(["a", "b", "c"])
  })

  test("nested dict (a process-list-shaped record)", () => {
    const buf = nskeyedArchive({ dict: { pid: { int: 501 }, name: { str: "SpringBoard" } } })
    expect(nskeyedUnarchive(buf)).toEqual({ pid: 501, name: "SpringBoard" })
  })

  test("array of dicts", () => {
    const buf = nskeyedArchive({ arr: [
      { dict: { pid: { int: 1 }, name: { str: "launchd" } } },
      { dict: { pid: { int: 2 }, name: { str: "kernel_task" } } },
    ] })
    expect(nskeyedUnarchive(buf)).toEqual([
      { pid: 1, name: "launchd" },
      { pid: 2, name: "kernel_task" },
    ])
  })

  test("UID surfaces as PlistUID, not a bare integer", () => {
    // The archived buffer's $top.root is a CF$UID; decoding the raw plist must
    // yield a PlistUID so the graph is resolvable.
    const raw = decodePlist(nskeyedArchive({ str: "x" })) as Record<string, unknown>
    const top = raw["$top"] as Record<string, unknown>
    expect(top.root).toBeInstanceOf(PlistUID)
  })
})

describe("nskeyed bounds", () => {
  test("non-dict top-level throws", () => {
    expect(() => nskeyedUnarchive(Buffer.from("not a plist"))).toThrow()
  })
})
