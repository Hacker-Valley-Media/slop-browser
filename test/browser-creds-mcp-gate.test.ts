/**
 * test/browser-creds-mcp-gate.test.ts — issue #248: a model must not enumerate
 * saved accounts. The refusal is enforced in the CLI parser (where the
 * INTERCEPTOR_MCP marker actually lands), so `browser creds list` under
 * INTERCEPTOR_MCP=1 exits non-zero with the refusal, before any daemon call.
 * The fill flag (`--browser-login`) is not gated — it never returns the value.
 *
 * This runs the real CLI entrypoint so it exercises the actual parse path.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const CLI = join(import.meta.dir, "..", "cli", "index.ts")

function run(args: string[], mcp: boolean) {
  const env = { ...process.env }
  if (mcp) env.INTERCEPTOR_MCP = "1"
  else delete env.INTERCEPTOR_MCP
  return spawnSync("bun", ["run", CLI, ...args], { encoding: "utf8", env })
}

describe("browser creds MCP gate", () => {
  test("browser creds list is refused under INTERCEPTOR_MCP=1", () => {
    const r = run(["browser", "creds", "list"], true)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("refused over MCP")
  })

  test("browser creds status is refused under INTERCEPTOR_MCP=1", () => {
    const r = run(["browser", "creds", "status"], true)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("refused over MCP")
  })

  test("a bad `browser` family still errors (parse reached) without MCP", () => {
    // Without the daemon we cannot assert a successful list, but the parser
    // itself must accept the command shape and only reject a wrong family.
    const r = run(["browser", "bogus"], false)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("browser requires 'creds'")
  })
})
