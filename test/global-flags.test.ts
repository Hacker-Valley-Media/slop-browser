import { describe, expect, test } from "bun:test"

import { buildFilteredArgs } from "../cli/global-flags"

describe("buildFilteredArgs", () => {
  test("removes --context and only its value", () => {
    expect(buildFilteredArgs(["read", "work", "--context", "work"])).toEqual(["read", "work"])
  })

  test("removes --tab and only its value", () => {
    expect(buildFilteredArgs(["read", "42", "--tab", "42"])).toEqual(["read", "42"])
  })

  test("removes standalone global transport flags", () => {
    expect(buildFilteredArgs(["read", "--ws", "--any-tab", "main"])).toEqual(["read", "main"])
  })

  test("removes global --json in leading positions", () => {
    expect(buildFilteredArgs(["--json", "status"])).toEqual(["status"])
    expect(buildFilteredArgs(["status", "--json"])).toEqual(["status"])
    expect(buildFilteredArgs(["--frame", "0", "--json", "eval", "1+1"])).toEqual(["eval", "1+1"])
  })

  test("strips the global --frame flag from native argv as well", () => {
    expect(buildFilteredArgs(["--frame", "7", "ios", "tree"])).toEqual(["ios", "tree"])
    expect(buildFilteredArgs(["macos", "tree", "--frame=7"])).toEqual(["macos", "tree"])
    expect(buildFilteredArgs(["macos", "monitor", "start", "--frames", "1"])).toEqual(["macos", "monitor", "start", "--frames", "1"])
  })

  test("preserves command-local --json outside leading global positions", () => {
    expect(buildFilteredArgs(["macos", "translate", "batch", "--json", "payload"])).toEqual(["macos", "translate", "batch", "--json", "payload"])
  })

  test("preserves global-looking tokens after the option terminator", () => {
    expect(buildFilteredArgs(["type", "e1", "--", "--shared-group", "--group", "literal"]))
      .toEqual(["type", "e1", "--", "--shared-group", "--group", "literal"])
    expect(buildFilteredArgs(["type", "e1", "--", "--json"]))
      .toEqual(["type", "e1", "--", "--json"])
  })
})
