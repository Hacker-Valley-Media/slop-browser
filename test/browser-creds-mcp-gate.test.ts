/**
 * test/browser-creds-mcp-gate.test.ts — issue #248: a model must not enumerate
 * saved accounts. The refusal is enforced in the CLI parser (where the
 * INTERCEPTOR_MCP marker actually lands), so `browser creds` under
 * INTERCEPTOR_MCP=1 refuses at parse time, before any daemon call. The fill
 * flag (`--browser-login`) is not gated — it never returns the value.
 *
 * Calls parseBrowserCommand directly (stubbing process.exit + console.error) so
 * it is deterministic and needs no running daemon (CI has no daemon binary).
 */

import { describe, expect, test, spyOn } from "bun:test"
import { parseBrowserCommand } from "../cli/commands/browser"

function callParse(credsArgs: string[], mcp: boolean) {
  const prev = process.env.INTERCEPTOR_MCP
  if (mcp) process.env.INTERCEPTOR_MCP = "1"
  else delete process.env.INTERCEPTOR_MCP

  const errs: string[] = []
  const errSpy = spyOn(console, "error").mockImplementation(((...a: unknown[]) => { errs.push(a.join(" ")) }) as any)
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`__exit__${code ?? 0}`) }) as any)

  let exited: number | null = null
  let action: any = null
  try {
    action = parseBrowserCommand(["browser", ...credsArgs])
  } catch (e) {
    const m = (e as Error).message
    if (m.startsWith("__exit__")) exited = Number(m.slice("__exit__".length))
    else throw e
  } finally {
    errSpy.mockRestore()
    exitSpy.mockRestore()
    if (prev === undefined) delete process.env.INTERCEPTOR_MCP
    else process.env.INTERCEPTOR_MCP = prev
  }
  return { exited, errs: errs.join("\n"), action }
}

describe("browser creds MCP gate", () => {
  test("browser creds list is refused under INTERCEPTOR_MCP=1", () => {
    const r = callParse(["creds", "list"], true)
    expect(r.exited).toBe(1)
    expect(r.errs).toContain("refused over MCP")
  })

  test("browser creds status is refused under INTERCEPTOR_MCP=1", () => {
    const r = callParse(["creds", "status"], true)
    expect(r.exited).toBe(1)
    expect(r.errs).toContain("refused over MCP")
  })

  test("without MCP, browser creds list parses into a browser_creds action", () => {
    const r = callParse(["creds", "list"], false)
    expect(r.exited).toBeNull()
    expect(r.action).toMatchObject({ type: "browser_creds", sub: "list" })
  })

  test("a bad `browser` family still errors (wrong family, not MCP)", () => {
    const r = callParse(["bogus"], false)
    expect(r.exited).toBe(1)
    expect(r.errs).toContain("browser requires 'creds'")
  })
})
