/**
 * test/chrome-login-parse.test.ts — issue #248: `type --chrome-login <host>`
 * parses into a browser fill action carrying host+field only. The host operand
 * must survive normalization (it is a value flag), and the value never appears.
 */

import { describe, expect, test } from "bun:test"
import { normalizeArgsSplit } from "../cli/normalize"
import { parseActionsCommand } from "../cli/commands/actions"

function parse(argv: string[]) {
  const norm = normalizeArgsSplit(argv)
  return parseActionsCommand(norm.argv, norm.positionalCount)
}

describe("type --chrome-login", () => {
  test("password fill by ref carries host+field, no text", () => {
    expect(parse(["type", "e5", "--chrome-login", "my.functionhealth.com"]))
      .toMatchObject({ type: "input_text", ref: "e5", chromeLogin: { host: "my.functionhealth.com", field: "pass" }, clear: true })
  })

  test("--user selects the username field", () => {
    expect(parse(["type", "e2", "--chrome-login", "my.functionhealth.com", "--user"]))
      .toMatchObject({ type: "input_text", ref: "e2", chromeLogin: { host: "my.functionhealth.com", field: "user" } })
  })

  test("semantic target routes to find_and_type", () => {
    expect(parse(["type", "textbox:Password", "--chrome-login", "example.com"]))
      .toMatchObject({ type: "find_and_type", name: "Password", chromeLogin: { host: "example.com", field: "pass" } })
  })

  test("the host operand is not swept into typed text", () => {
    const a = parse(["type", "e1", "--chrome-login", "example.com"]) as any
    expect(a.text).toBeUndefined()
    expect(a.inputText).toBeUndefined()
  })
})
