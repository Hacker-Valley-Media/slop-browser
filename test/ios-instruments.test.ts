import { describe, expect, test } from "bun:test"
import { nskeyedArchive } from "../daemon/ios/usertunnel"
import { _decodeReturn } from "../daemon/ios/instruments"
import { INSTRUMENTS_CHANNEL } from "../shared/ios-dev"
import { HAS_PLUTIL } from "./helpers/macos-tools"

// Instruments reply decoding: a DTX reply carries the return value nskeyed-encoded
// in payloadRaw (else the first archived aux entry).

const t_null = 0x0a, t_bytearray = 0x02
function auxBytes(archived: Buffer): Buffer {
  const nul = Buffer.alloc(4); nul.writeUInt32LE(t_null, 0)
  const h = Buffer.alloc(8); h.writeUInt32LE(t_bytearray, 0); h.writeUInt32LE(archived.length, 4)
  return Buffer.concat([nul, h, archived])
}

// Fixtures are produced by nskeyedArchive, which shells out to plutil.
describe.skipIf(!HAS_PLUTIL)("instruments reply decode", () => {
  test("runningProcesses-shaped array from payloadRaw", () => {
    const payloadRaw = nskeyedArchive({ arr: [
      { dict: { pid: { int: 501 }, name: { str: "SpringBoard" } } },
      { dict: { pid: { int: 1 }, name: { str: "launchd" } } },
    ] })
    const out = _decodeReturn({ payloadRaw, aux: Buffer.alloc(0) } as any)
    expect(out).toEqual([
      { pid: 501, name: "SpringBoard" },
      { pid: 1, name: "launchd" },
    ])
  })

  test("scalar pid from payloadRaw (processcontrol launch)", () => {
    const out = _decodeReturn({ payloadRaw: nskeyedArchive({ int: 4321 }), aux: Buffer.alloc(0) } as any)
    expect(out).toBe(4321)
  })

  test("falls back to the first archived aux entry when payload is empty", () => {
    const aux = auxBytes(nskeyedArchive({ str: "from-aux" }))
    const out = _decodeReturn({ payloadRaw: Buffer.alloc(0), aux } as any)
    expect(out).toBe("from-aux")
  })

  test("null reply → null", () => {
    expect(_decodeReturn(null)).toBeNull()
  })
})

describe("instruments channel identifiers", () => {
  test("all six channels are the canonical Apple identifiers", () => {
    expect(INSTRUMENTS_CHANNEL.deviceinfo).toBe("com.apple.instruments.server.services.deviceinfo")
    expect(INSTRUMENTS_CHANNEL.sysmontap).toBe("com.apple.instruments.server.services.sysmontap")
    expect(INSTRUMENTS_CHANNEL.processcontrol).toBe("com.apple.instruments.server.services.processcontrol")
    expect(INSTRUMENTS_CHANNEL.location).toContain("LocationSimulation")
  })
})
