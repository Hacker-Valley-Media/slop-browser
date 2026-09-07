import { describe, expect, test } from "bun:test"

import { classify, gate, parseAllow } from "../cli/mcp/tiers"

describe("classify — tier by (surface, verb, sub-verb)", () => {
  test("task verification is arbitrary exec even with reordered flags", () => {
    for (const surface of ["browser", "local"] as const) {
      for (const op of ["verify", "complete", "unknown"]) {
        const c = classify(surface, "monitor", ["--json", "task", op, "task-id"])
        expect(c.tier).toBe("exec")
        expect(gate(c, parseAllow(undefined), true).allowed).toBe(false)
      }
      expect(classify(surface, "monitor", ["task", "resume", "task-id"]).tier).toBe("read")
      expect(classify(surface, "monitor", ["--file", "x", "task", "checkpoint", "task-id"]).tier).toBe("mutate")
    }
  })
  test("browser reads/mutates/exec", () => {
    expect(classify("browser", "tree", []).tier).toBe("read")
    expect(classify("browser", "text", []).tier).toBe("read")
    expect(classify("browser", "click", ["e5"]).tier).toBe("mutate")
    expect(classify("browser", "eval", ["1+1"]).tier).toBe("exec")
    expect(classify("browser", "save", ["--out", "/tmp/x", "blob"]).tier).toBe("exec")
  })

  test("macOS vm family splits by sub-verb", () => {
    expect(classify("macos", "vm", ["list"]).tier).toBe("read")
    expect(classify("macos", "vm", ["get", "x"]).tier).toBe("read")
    expect(classify("macos", "vm", ["delete", "x"]).tier).toBe("destructive")
    expect(classify("macos", "vm", ["stop", "x"]).tier).toBe("destructive")
    expect(classify("macos", "vm", ["exec", "x", "--", "rm"]).tier).toBe("exec")
    // unknown sub-verb of a dangerous family falls back to the family floor (fail-safe)
    expect(classify("macos", "vm", ["frobnicate"]).tier).toBe("destructive")
  })

  test("macOS app family: activate mutate, quit destructive", () => {
    expect(classify("macos", "app", ["activate", "Safari"]).tier).toBe("mutate")
    expect(classify("macos", "app", ["launch", "Safari"]).tier).toBe("mutate")
    expect(classify("macos", "app", ["quit", "Safari"]).tier).toBe("destructive")
    expect(classify("macos", "app", ["terminate", "Safari"]).tier).toBe("destructive")
    expect(classify("macos", "app", ["banish"]).tier).toBe("destructive") // floor
  })

  test("macOS exec + runtime floor", () => {
    expect(classify("macos", "script", ["run", "--script", "..."]).tier).toBe("exec")
    expect(classify("macos", "intent", ["dispatch"]).tier).toBe("exec")
    expect(classify("macos", "container", ["run", "img"]).tier).toBe("exec")
    expect(classify("macos", "runtime", ["status"]).tier).toBe("read")
    expect(classify("macos", "runtime", ["enable"]).tier).toBe("destructive")
    expect(classify("macos", "runtime", ["js", "code"]).tier).toBe("exec")
    expect(classify("macos", "runtime", ["novelverb"]).tier).toBe("exec") // floor
  })

  test("macOS personal-data + fs + share", () => {
    expect(classify("macos", "calendar", ["list"]).tier).toBe("read")
    expect(classify("macos", "calendar", ["create"]).tier).toBe("destructive")
    expect(classify("macos", "fs", ["read", "/x"]).tier).toBe("read")
    expect(classify("macos", "fs", ["write", "/x"]).tier).toBe("destructive")
    expect(classify("macos", "share", ["email"]).tier).toBe("destructive")
    expect(classify("macos", "clipboard", ["read"]).tier).toBe("read")
  })

  test("iOS tiers", () => {
    expect(classify("ios", "tree", []).tier).toBe("read")
    expect(classify("ios", "click", ["r1"]).tier).toBe("mutate")
    expect(classify("ios", "kill", ["123"]).tier).toBe("destructive")
    expect(classify("ios", "setup", []).tier).toBe("destructive")
    expect(classify("ios", "eval", ["Interceptor.tree()"]).tier).toBe("exec")
    expect(classify("ios", "app", ["terminate", "com.x"]).tier).toBe("destructive")
    expect(classify("ios", "app", ["launch", "com.x"]).tier).toBe("mutate")
    expect(classify("ios", "fs", ["push", "a", "b"]).tier).toBe("destructive")
    expect(classify("ios", "fs", ["ls", "/"]).tier).toBe("read")
    expect(classify("ios", "web", ["eval", "1"]).tier).toBe("exec")
    expect(classify("ios", "web", ["text"]).tier).toBe("read")
  })
})

describe("parseAllow", () => {
  test("empty ⇒ nothing extra allowed", () => {
    const a = parseAllow(undefined)
    expect(a.tiers.size).toBe(0)
    expect(a.raw).toBe(false)
    expect(a.all).toBe(false)
  })
  test("tokens", () => {
    const a = parseAllow("destructive, arbitrary-exec, raw, macos:vm")
    expect(a.tiers.has("destructive")).toBe(true)
    expect(a.tiers.has("exec")).toBe(true)
    expect(a.raw).toBe(true)
    expect(a.verbs.has("macos:vm")).toBe(true)
  })
  test("all", () => {
    expect(parseAllow("all").all).toBe(true)
  })
})

describe("gate — operator allowlist is the boundary; confirm is a speed-bump", () => {
  const dVm = classify("macos", "vm", ["delete", "x"])       // destructive
  const eEval = classify("browser", "eval", ["x"])            // exec
  const rTree = classify("browser", "tree", [])               // read
  const mClick = classify("browser", "click", ["e5"])         // mutate

  test("read + mutate always run", () => {
    expect(gate(rTree, parseAllow(undefined), false).allowed).toBe(true)
    expect(gate(mClick, parseAllow(undefined), false).allowed).toBe(true)
  })
  test("destructive refused when not operator-allowed (even with confirm)", () => {
    const g = gate(dVm, parseAllow(undefined), true)
    expect(g.allowed).toBe(false)
    expect(g.reason).toContain("INTERCEPTOR_MCP_ALLOW")
  })
  test("destructive allowed-but-needs-confirm", () => {
    const g = gate(dVm, parseAllow("destructive"), false)
    expect(g.allowed).toBe(false)
    expect(g.needsConfirm).toBe(true)
  })
  test("destructive runs when allowed + confirmed", () => {
    expect(gate(dVm, parseAllow("destructive"), true).allowed).toBe(true)
  })
  test("verb-specific allow works", () => {
    expect(gate(dVm, parseAllow("macos:vm"), true).allowed).toBe(true)
  })
  test("exec gated by arbitrary-exec, not destructive", () => {
    expect(gate(eEval, parseAllow("destructive"), true).allowed).toBe(false)
    expect(gate(eEval, parseAllow("arbitrary-exec"), true).allowed).toBe(true)
    expect(gate(eEval, parseAllow("all"), true).allowed).toBe(true)
  })
})

describe("issue #244 vault, sudo, admin prompt, auth", () => {
  test("macos secret family: list/status read, register/set/unlock/lock mutate, rm destructive, reveal exec, unknown floors destructive", () => {
    expect(classify("macos", "secret", ["list"]).tier).toBe("read")
    expect(classify("macos", "secret", ["status"]).tier).toBe("read")
    expect(classify("macos", "secret", ["register", "admin"]).tier).toBe("mutate")
    expect(classify("macos", "secret", ["set", "admin", "--stdin"]).tier).toBe("mutate")
    expect(classify("macos", "secret", ["unlock", "admin", "--for", "30m"]).tier).toBe("mutate")
    expect(classify("macos", "secret", ["lock"]).tier).toBe("mutate")
    expect(classify("macos", "secret", ["rm", "admin"]).tier).toBe("destructive")
    expect(classify("macos", "secret", ["reveal", "admin"]).tier).toBe("exec")
    expect(classify("macos", "secret", ["export"]).tier).toBe("destructive")
  })

  test("sudo is exec, authdialog fill destructive, authdialog status read", () => {
    expect(classify("macos", "sudo", ["--secret", "admin", "--", "id"]).tier).toBe("exec")
    expect(classify("macos", "authdialog", ["fill", "--secret", "admin"]).tier).toBe("destructive")
    expect(classify("macos", "authdialog", ["status"]).tier).toBe("read")
  })

  test("auth is explicitly mutate; status reads", () => {
    expect(classify("macos", "auth", ["confirm", "why"]).tier).toBe("mutate")
    expect(classify("macos", "auth", ["status"]).tier).toBe("read")
  })

  test("the gate refuses sudo and reveal without operator opt-in", () => {
    const allow = parseAllow(undefined)
    expect(gate(classify("macos", "sudo", ["--secret", "a", "--", "id"]), allow, true).allowed).toBe(false)
    expect(gate(classify("macos", "secret", ["reveal", "a"]), allow, true).allowed).toBe(false)
    expect(gate(classify("macos", "secret", ["list"]), allow, false).allowed).toBe(true)
  })
})
