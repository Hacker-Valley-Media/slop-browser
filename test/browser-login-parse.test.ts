/**
 * test/browser-login-parse.test.ts — issue #248: `type --browser-login <host>`
 * parses into a browser fill action carrying host+field(+browser) only. The
 * host and --browser operands must survive normalization (value flags), and
 * the value never appears.
 */

import { describe, expect, test } from "bun:test"
import { normalizeArgsSplit } from "../cli/normalize"
import { parseActionsCommand } from "../cli/commands/actions"

function parse(argv: string[]) {
  const norm = normalizeArgsSplit(argv)
  return parseActionsCommand(norm.argv, norm.positionalCount)
}

describe("type --browser-login", () => {
  test("password fill by ref carries host+field, no text", () => {
    expect(parse(["type", "e5", "--browser-login", "my.functionhealth.com"]))
      .toMatchObject({ type: "input_text", ref: "e5", browserLogin: { host: "my.functionhealth.com", field: "pass" }, clear: true })
  })

  test("--user selects the username field", () => {
    expect(parse(["type", "e2", "--browser-login", "my.functionhealth.com", "--user"]))
      .toMatchObject({ type: "input_text", ref: "e2", browserLogin: { host: "my.functionhealth.com", field: "user" } })
  })

  test("--browser restricts to one browser", () => {
    expect(parse(["type", "e3", "--browser-login", "example.com", "--browser", "brave"]))
      .toMatchObject({ type: "input_text", ref: "e3", browserLogin: { host: "example.com", field: "pass", browser: "brave" } })
  })

  test("semantic target routes to find_and_type", () => {
    expect(parse(["type", "textbox:Password", "--browser-login", "example.com"]))
      .toMatchObject({ type: "find_and_type", name: "Password", browserLogin: { host: "example.com", field: "pass" } })
  })

  test("the host and browser operands are not swept into typed text", () => {
    const a = parse(["type", "e1", "--browser-login", "example.com", "--browser", "vivaldi"]) as any
    expect(a.text).toBeUndefined()
    expect(a.inputText).toBeUndefined()
  })
})
