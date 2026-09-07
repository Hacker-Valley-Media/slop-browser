import { describe, expect, test } from "bun:test"
import {
  claimContextId,
  contextConflictMessage,
  contextRegisteredMessage,
  type ContextSocket,
} from "../daemon/context-registration"

function socket(sent: string[] = []): ContextSocket {
  return {
    send: (data: string) => sent.push(data),
  }
}

describe("registration ack — host OS-input capability", () => {
  // The extension cannot see the host OS from a service worker, so the daemon
  // reports it here. Without the flag the extension assumes an OS-input lane
  // exists and escalates clicks into it; on Linux/Windows that escalation
  // always fails and reports a click that DID land as a total failure.
  test("omits osInput entirely when the daemon does not report it", () => {
    const message = contextRegisteredMessage("work")
    expect(message).toEqual({ type: "context_registered", contextId: "work" })
    expect("osInput" in message).toBe(false)
  })

  test("carries osInput:false for a host with no OS-input backend", () => {
    expect(contextRegisteredMessage("work", false)).toEqual({
      type: "context_registered",
      contextId: "work",
      osInput: false,
    })
  })

  test("carries osInput:true on a host that has one", () => {
    expect(contextRegisteredMessage("work", true)).toEqual({
      type: "context_registered",
      contextId: "work",
      osInput: true,
    })
  })

  test("claimContextId forwards the flag into the ack it hands the socket", () => {
    const map = new Map<string, ContextSocket>()
    const result = claimContextId(map, socket(), "work", false)
    expect(result.message).toEqual({
      type: "context_registered",
      contextId: "work",
      osInput: false,
    })
  })
})

describe("context name uniqueness guard", () => {
  test("allows first registration", () => {
    const map = new Map<string, ContextSocket>()
    const wsA = socket()

    const result = claimContextId(map, wsA, "work")

    expect(result).toEqual({
      status: "registered",
      contextId: "work",
      previousContextId: undefined,
      message: contextRegisteredMessage("work"),
    })
    expect(map.get("work")).toBe(wsA)
    expect(wsA.__contextId).toBe("work")
  })

  test("rejects a different socket claiming the same name", () => {
    const map = new Map<string, ContextSocket>()
    const wsA = socket()
    const wsB = socket()

    claimContextId(map, wsA, "work")
    const result = claimContextId(map, wsB, "work")

    expect(result).toEqual({
      status: "conflict",
      contextId: "work",
      message: contextConflictMessage("work"),
    })
    expect(map.get("work")).toBe(wsA)
    expect(wsB.__contextId).toBeUndefined()
  })

  test("allows same socket to re-register with same name", () => {
    const map = new Map<string, ContextSocket>()
    const wsA = socket()

    claimContextId(map, wsA, "work")
    const result = claimContextId(map, wsA, "work")

    expect(result.status).toBe("registered")
    if (result.status !== "registered") throw new Error("expected registration")
    expect(result.previousContextId).toBeUndefined()
    expect(map.get("work")).toBe(wsA)
  })

  test("allows re-registration after old entry removal", () => {
    const map = new Map<string, ContextSocket>()
    const wsA = socket()
    const wsB = socket()

    claimContextId(map, wsA, "work")
    map.delete("work")
    const result = claimContextId(map, wsB, "work")

    expect(result.status).toBe("registered")
    expect(map.get("work")).toBe(wsB)
  })

  test("allows same socket to rename its context", () => {
    const map = new Map<string, ContextSocket>()
    const wsA = socket()

    claimContextId(map, wsA, "work")
    const result = claimContextId(map, wsA, "home")

    expect(result).toEqual({
      status: "registered",
      contextId: "home",
      previousContextId: "work",
      message: contextRegisteredMessage("home"),
    })
    expect(map.has("work")).toBe(false)
    expect(map.get("home")).toBe(wsA)
    expect(wsA.__contextId).toBe("home")
  })

  test("rejects duplicate native runtime context ownership", () => {
    const map = new Map<string, ContextSocket>()
    const wsA = socket()
    const wsB = socket()

    claimContextId(map, wsA, "runtime:target")
    const result = claimContextId(map, wsB, "runtime:target")

    expect(result.status).toBe("conflict")
    expect(result.message).toEqual(contextConflictMessage("runtime:target"))
    expect(map.get("runtime:target")).toBe(wsA)
  })

  test("registration and conflict messages are daemon control messages", () => {
    expect(contextRegisteredMessage("work")).toEqual({
      type: "context_registered",
      contextId: "work",
    })
    expect(contextConflictMessage("work")).toEqual({
      type: "context_conflict",
      contextId: "work",
      error: "context 'work' is already in use",
    })
  })
})
