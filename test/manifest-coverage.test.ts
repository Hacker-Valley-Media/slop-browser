import { describe, expect, test } from "bun:test"

import { COMMAND_SPECS } from "../cli/manifest"

// The agent-facing compound + reading verbs are the manifest's reason to
// exist — every one must carry a non-empty returns: contract.
const MUST_HAVE_RETURNS = [
  "open", "read", "act", "inspect",
  "text", "html", "tree", "find", "websearch",
  "table", "links", "forms", "query",
  "skills", "manifest",
]

describe("manifest command specs", () => {
  test("every agent-critical verb has a spec with returns semantics", () => {
    for (const name of MUST_HAVE_RETURNS) {
      const spec = COMMAND_SPECS.find(s => s.name === name)
      expect(spec, `missing spec for '${name}'`).toBeDefined()
      expect(spec!.returns.length, `empty returns for '${name}'`).toBeGreaterThan(10)
      expect(spec!.usage.startsWith("interceptor "), `usage for '${name}' must be a full invocation`).toBe(true)
    }
  })

  test("the text-verb disambiguation is explicit (innerText vs textContent vs markdown)", () => {
    const text = COMMAND_SPECS.find(s => s.name === "text")!
    expect(text.returns).toContain("innerText")
    expect(text.returns).toContain("textContent")
    const read = COMMAND_SPECS.find(s => s.name === "read")!
    expect(read.returns).toContain("textContent")
    const html = COMMAND_SPECS.find(s => s.name === "html")!
    expect(html.returns).toContain("outerHTML")
  })

  test("no duplicate command names", () => {
    const names = COMMAND_SPECS.map(s => s.name)
    expect(new Set(names).size).toBe(names.length)
    // MCP puts each manifest name into one argv token; subcommands belong in usage.
    for (const spec of COMMAND_SPECS.filter(s => s.surface === "browser")) expect(spec.name).not.toMatch(/\s/)
  })

  test("browser search semantics cannot drift back to false in-page wording", () => {
    const websearch = COMMAND_SPECS.find(s => s.name === "websearch")!
    expect(websearch.summary).toContain("default provider")
    expect(websearch.returns).toContain("Managed tab")
    expect(COMMAND_SPECS.find(s => s.name === "search")).toBeUndefined()
    const find = COMMAND_SPECS.find(s => s.name === "find")!
    expect(find.returns).toContain("document.body.innerText")
    expect(find.returns).toContain("actionable refs")
  })

  test("every spec has a valid surface", () => {
    for (const s of COMMAND_SPECS) {
      expect(["browser", "macos", "ios", "local"]).toContain(s.surface)
    }
  })
})
