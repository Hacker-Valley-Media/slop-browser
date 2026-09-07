/**
 * test/strict-flags.test.ts
 *
 * Issue #212: unknown CLI flags exited 0 and looked like success
 * (`screenshot --out <path>` wrote nothing). normalizeArgsSplit now rejects
 * flags outside the per-family inventory. The table-driven block walks the
 * ENTIRE inventory so a flag added to a command module but not to the map
 * fails CI here instead of regressing into a strict-mode rejection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeArgs, normalizeArgsSplit, FLAG_INVENTORY } from "../cli/normalize"
import { TRUSTED_FLAG_VALUES } from "../cli/commands/flags"

let exitCode: number | undefined
let errors: string[] = []
const realExit = process.exit
const realConsoleError = console.error

beforeEach(() => {
  exitCode = undefined
  errors = []
  process.exit = ((code?: number) => {
    exitCode = code
    throw new Error(`__exit_${code}`)
  }) as never
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
  delete process.env.INTERCEPTOR_LAX_FLAGS
})

afterEach(() => {
  process.exit = realExit
  console.error = realConsoleError
  delete process.env.INTERCEPTOR_LAX_FLAGS
})

describe("strict unknown-flag rejection (#212)", () => {
  test("a typo'd flag throws naming the flag and command without exiting its host", () => {
    expect(() => normalizeArgs(["screenshot", "--zzz-nonsense-flag", "foo"])).toThrow("unknown flag '--zzz-nonsense-flag' for 'screenshot'")
    expect(exitCode).toBeUndefined()
  })

  test("the issue's sharpest trap: screenshot --out points at --save", () => {
    expect(() => normalizeArgs(["screenshot", "--out", "/tmp/shot.png"])).toThrow("'screenshot --save' writes the image to disk")
  })

  test("--flag=value form validates the name before '='", () => {
    expect(() => normalizeArgs(["open", "--bogus=1", "https://example.com"])).toThrow("unknown flag '--bogus=1' for 'open'")
  })

  test("a boolean flag given a value is rejected — net log --redact-auth=true must not export unredacted", () => {
    expect(() => normalizeArgs(["net", "log", "--redact-auth=true"])).toThrow("flag '--redact-auth' for 'net' does not take a value")
  })

  test("global booleans reject values too, and lax mode does not soften it", () => {
    process.env.INTERCEPTOR_LAX_FLAGS = "1"
    expect(() => normalizeArgs(["open", "--json=1", "https://example.com"])).toThrow("does not take a value")
  })

  test("the unreleased --no-group spelling is rejected in favor of --shared-group", () => {
    expect(() => normalizeArgs(["open", "--no-group", "https://example.com"])).toThrow("unknown flag '--no-group' for 'open'")
  })

  test("tab new accepts the reuse controls consumed by its shared create parser", () => {
    expect(normalizeArgs(["tab", "new", "https://example.com", "--reuse"]))
      .toEqual(["tab", "new", "https://example.com", "--reuse"])
    expect(normalizeArgs(["tab", "new", "https://example.com", "--no-reuse"]))
      .toEqual(["tab", "new", "https://example.com", "--no-reuse"])
    expect(exitCode).toBeUndefined()
  })

  test("tab new accepts the explicit activation flag consumed by its shared create parser", () => {
    expect(normalizeArgs(["tab", "new", "https://example.com", "--activate"]))
      .toEqual(["tab", "new", "https://example.com", "--activate"])
    expect(exitCode).toBeUndefined()
  })

  test("tab close and tab switch reject tab-creation flags", () => {
    for (const args of [
      ["tab", "close", "123", "--reuse"],
      ["tab", "close", "123", "--no-reuse"],
      ["tab", "switch", "123", "--activate"],
    ]) {
      errors = []
      expect(() => normalizeArgs(args)).toThrow("is only valid with 'tab new'")
    }
  })

  test("INTERCEPTOR_LAX_FLAGS=1 downgrades to a warning and keeps going", () => {
    process.env.INTERCEPTOR_LAX_FLAGS = "1"
    const argv = normalizeArgs(["screenshot", "--zzz-lax-flag"])
    expect(exitCode).toBeUndefined()
    expect(argv).toEqual(["screenshot", "--zzz-lax-flag"])
  })

  test("single-dash tokens stay positionals (negative scroll amounts)", () => {
    expect(normalizeArgs(["scroll", "-100"])).toEqual(["scroll", "-100"])
    expect(exitCode).toBeUndefined()
  })

  test("'--' terminator admits flag-looking positionals", () => {
    const norm = normalizeArgsSplit(["type", "e1", "--", "--whatever"])
    expect(norm.argv).toEqual(["type", "e1", "--whatever"])
    expect(norm.positionalCount).toBe(2)
    expect(exitCode).toBeUndefined()
  })

  test("un-normalized surfaces (macos/ios/mcp/update) are untouched", () => {
    expect(normalizeArgs(["macos", "tree", "--zzz"])).toEqual(["macos", "tree", "--zzz"])
    expect(exitCode).toBeUndefined()
  })
})

// ── Reverse direction: every flag a command module consumes must be declared ──
//
// The original inventory was harvested from literal includes("--x") sites, so
// flags consumed through helpers (hasTrustedFlag, flagPresent/flagValue) or
// indexOf were dropped — that is how `act --trusted` and `scene click --trusted`
// shipped broken in 0.23.23 while help still advertised them. This block
// re-harvests each module's source over every consumption pattern and asserts
// the inventory covers it, so a dropped flag fails CI instead of the user.

const COMMANDS_DIR = join(import.meta.dir, "..", "cli", "commands")

// Module file → commands dispatched to it (normalized surfaces only; matches
// BOOLEAN_FLAGS_BY_CMD's family grouping in cli/normalize.ts).
const MODULE_COMMANDS: Record<string, string[]> = {
  "compound.ts": ["open", "read", "act", "inspect", "websearch", "search"],
  "state.ts": ["state", "tree", "diff", "find", "text", "html"],
  "actions.ts": ["click", "type", "select", "focus", "blur", "hover", "drag", "dblclick", "rightclick", "check", "keys", "click-at", "what-at", "regions"],
  "navigation.ts": ["navigate", "back", "forward", "scroll", "wait", "wait-stable", "wait_for"],
  "tabs.ts": ["tabs", "tab", "window", "frames", "session"],
  "network.ts": ["network", "net", "headers"],
  "screenshot.ts": ["screenshot", "canvas", "capture", "ocr"],
  "data.ts": ["cookies", "storage", "history", "bookmarks", "downloads", "clear", "clipboard"],
  "meta.ts": ["status", "reload", "meta", "links", "images", "forms", "info", "page_info", "query", "exists", "count", "table", "attr", "style", "events", "notify", "sessions", "capabilities", "modals", "panels"],
  "eval.ts": ["eval"], "save.ts": ["save"], "brand.ts": ["brand"], "group.ts": ["group"],
  "batch.ts": ["batch", "raw"], "monitor.ts": ["monitor"], "scene.ts": ["scene"], "sse.ts": ["sse"],
  "override.ts": ["override"], "upgrade.ts": ["upgrade"], "init.ts": ["init"],
  "research.ts": ["research"], "extensions.ts": ["extensions", "contexts"], "skills.ts": ["skills"],
  "daemon.ts": ["daemon"], "power.ts": ["keepawake", "idle"],
}

// Inventory commands with no harvestable module: dispatched inline in
// cli/index.ts and declare no flags of their own.
const UNMAPPED_OK = new Set(["manifest"])

const CONSUMPTION_PATTERNS = [
  /\.includes\(\s*["'](--[a-z][a-z-]*)["']\s*\)/g,
  /\.indexOf\(\s*["'](--[a-z][a-z-]*)["']\s*\)/g,
  /flagPresent\([^,]+,\s*["'](--[a-z][a-z-]*)["']\s*\)/g,
  /flagValue\([^,]+,\s*["'](--[a-z][a-z-]*)["']\s*\)/g,
]

describe("every module-consumed flag is declared (reverse direction)", () => {
  for (const [file, cmds] of Object.entries(MODULE_COMMANDS)) {
    test(`${file} consumes no flag missing from the '${cmds[0]}' family inventory`, () => {
      const src = readFileSync(join(COMMANDS_DIR, file), "utf8")
      const consumed = new Set<string>()
      for (const rx of CONSUMPTION_PATTERNS) {
        for (const m of src.matchAll(rx)) consumed.add(m[1])
      }
      if (/\bhasTrustedFlag\(/.test(src)) {
        for (const f of TRUSTED_FLAG_VALUES) consumed.add(f)
      }
      const declared = new Set<string>([...FLAG_INVENTORY.globalValue, ...FLAG_INVENTORY.globalBoolean])
      for (const c of cmds) {
        for (const f of FLAG_INVENTORY.value[c] ?? []) declared.add(f)
        for (const f of FLAG_INVENTORY.boolean[c] ?? []) declared.add(f)
      }
      const missing = [...consumed].filter(f => !declared.has(f)).sort()
      expect(missing).toEqual([])
    })
  }

  test("the module map covers every normalized command in the inventory", () => {
    const mapped = new Set(Object.values(MODULE_COMMANDS).flat())
    const uncovered = [...new Set([...Object.keys(FLAG_INVENTORY.boolean), ...Object.keys(FLAG_INVENTORY.value)])]
      .filter(c => !mapped.has(c) && !UNMAPPED_OK.has(c))
      .sort()
    expect(uncovered).toEqual([])
  })
})

describe("the whole inventory is accepted (table-driven)", () => {
  for (const [cmd, valueFlags] of Object.entries(FLAG_INVENTORY.value)) {
    test(`every declared flag parses for '${cmd}'`, () => {
      const prefix = cmd === "tab" ? [cmd, "new"] : [cmd]
      for (const flag of valueFlags) {
        normalizeArgsSplit([...prefix, flag, "x"])
      }
      for (const flag of FLAG_INVENTORY.boolean[cmd] || []) {
        normalizeArgsSplit([...prefix, flag])
      }
      for (const flag of FLAG_INVENTORY.globalValue) {
        normalizeArgsSplit([...prefix, flag, "x"])
      }
      for (const flag of FLAG_INVENTORY.globalBoolean) {
        if (flag.startsWith("--")) normalizeArgsSplit([...prefix, flag])
      }
      expect(exitCode).toBeUndefined()
    })
  }
})
