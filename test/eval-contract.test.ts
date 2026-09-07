import { afterEach, expect, test } from "bun:test"
import { parseEvalCommand } from "../cli/commands/eval"
import { buildFilteredArgs, parseFrameFlag } from "../cli/global-flags"
import { normalizeArgsSplit } from "../cli/normalize"
import { handleEvaluateActions, runWithCspStripBypass } from "../extension/src/background/capabilities/evaluate"

const originalChrome = globalThis.chrome
afterEach(() => { globalThis.chrome = originalChrome })

test("verification eval refuses CSP recovery that would reload the checked page", async () => {
  globalThis.chrome = { scripting: { executeScript: async () => [{ frameId: 0, result: { success: false, error: "TrustedScript required" } }] },
    declarativeNetRequest: { updateSessionRules: async () => { throw new Error("must not be called") } } } as any
  const result = await handleEvaluateActions({ type: "evaluate", code: "true", world: "MAIN", noCspReload: true }, 42)
  expect(result).toEqual({ success: false, error: "TrustedScript required" })
})

test("frame flags reject partial, negative, conflicting and missing values", () => {
  for (const value of ["-1", "1x", "1.2", "", "9007199254740992"]) {
    expect(() => parseFrameFlag(["eval", "1", "--frame", value])).toThrow("safe integer")
  }
  expect(() => parseFrameFlag(["--frame", "1", "eval", "1", "--frame=2"])).toThrow("conflicting")
  expect(parseFrameFlag(["--frame=0", "eval", "1"])).toBe(0)
  expect(parseFrameFlag(["eval", "--", "--frame", "12"])).toBeUndefined()
  expect(() => parseEvalCommand(["eval", "--main"])).toThrow("requires JavaScript")
})

test("eval consumes only normalized code, leaving global flags out", () => {
  const args = normalizeArgsSplit(buildFilteredArgs(["eval", "--main", "1+1", "--json", "--frame", "12"]))
  expect(parseEvalCommand(args.argv, args.positionalCount)).toEqual({ type: "evaluate", code: "1+1", world: "MAIN" })
})

test("eval preserves flag-looking literal positionals after --", () => {
  const args = normalizeArgsSplit(["eval", "--", "--main"])
  expect(parseEvalCommand(args.argv, args.positionalCount)).toEqual({ type: "evaluate", code: "--main", world: "ISOLATED" })
})

test("leading frame modifiers do not become the command", () => {
  expect(buildFilteredArgs(["--frame", "12", "eval", "1+1"])).toEqual(["eval", "1+1"])
  expect(buildFilteredArgs(["--frame=12", "eval", "1+1"])).toEqual(["eval", "1+1"])
  expect(buildFilteredArgs(["eval", "--", "--frame", "12"])).toEqual(["eval", "--", "--frame", "12"])
})

test("both eval injection backends preserve a requested frame", async () => {
  const targets: unknown[] = []
  globalThis.chrome = { userScripts: { execute: async (options: any) => {
    targets.push(options.target)
    return [{ frameId: 12, result: "child" }]
  } } } as any
  expect((await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "document.title", frameId: 12 }, 42)).data).toBe("child")
  globalThis.chrome = { scripting: { executeScript: async (options: any) => {
    targets.push(options.target)
    return [{ frameId: 12, result: { success: true, data: "child" } }]
  } } } as any
  expect((await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "document.title", frameId: 12 }, 42)).data).toBe("child")
  expect(targets).toEqual([{ tabId: 42, frameIds: [12] }, { tabId: 42, frameIds: [12] }])
})

test("a missing requested frame never accepts a top-frame result", async () => {
  globalThis.chrome = { userScripts: { execute: async () => [{ frameId: 0, result: "top" }] } } as any
  const result = await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "document.title", frameId: 12 }, 42)
  expect(result.success).toBe(false)
  expect(result.error).toContain("frame 12")
})

test("Safari's single frame result may omit frameId", async () => {
  globalThis.chrome = { scripting: { executeScript: async () => [{ result: { success: true, data: "child" } }] } } as any
  const result = await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "document.title", frameId: 12 }, 42)
  expect(result).toEqual({ success: true, data: "child" })
})

test("unavailable userScripts explains an isolated eval failure", async () => {
  globalThis.chrome = { scripting: { executeScript: async () => [{ frameId: 0, result: {
    success: false, error: "Evaluating a string violates Content Security Policy script-src unsafe-eval",
  } }] } } as any
  const result = await handleEvaluateActions({ type: "evaluate", world: "ISOLATED", code: "1+1" }, 42)
  expect(result.success).toBe(false)
  expect(result.error).toContain("userScripts")
  expect(result.error).toContain("--main")
})

test("a MAIN Trusted Types failure never retries in another world", async () => {
  const worlds: string[] = []
  globalThis.chrome = { declarativeNetRequest: { updateSessionRules: async () => { throw new Error("fixture: reload disabled") } } } as any
  const result = await runWithCspStripBypass(42, "MAIN", async (_tab, world) => {
    worlds.push(world)
    return world === "MAIN" ? { success: false, error: "TrustedScript required" } : { success: true, data: "wrong-world" }
  })
  expect(result.success).toBe(false)
  expect(worlds).toEqual(["MAIN"])
})

test("userScripts MAIN failure does not silently use USER_SCRIPT", async () => {
  const worlds: string[] = []
  globalThis.chrome = {
    userScripts: { execute: async (o: any) => { worlds.push(o.world); return [{ frameId: 0, error: "TrustedScript required" }] } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { success: false, error: "ReferenceError: pageOnly is not defined" } }] },
  } as any
  expect((await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "pageOnly" }, 42)).success).toBe(false)
  expect(worlds).toEqual(["MAIN"])
})

// ── userScripts exception honesty (review 2026-09-07) ─────────────────────────
// Chrome 152 `userScripts.execute` returns NO `error` and NO `result` when the
// injected script throws, rejects, or fails to parse (live on the main profile:
// `eval --main 'throw new Error("boom")'` → success:true, data:null). This fake
// reproduces that contract by evaluating the injected text like a classic script.
function chromeLikeUserScripts(sink: string[] = []) {
  return { userScripts: { execute: async (o: any) => {
    const code: string = o.js[0].code
    sink.push(code)
    try {
      let r = (0, eval)(code)
      if (r && typeof r.then === "function") r = await r
      if (r === undefined) return [{ frameId: 0 }]
      return [{ frameId: 0, result: JSON.parse(JSON.stringify(r)) }]
    } catch { return [{ frameId: 0 }] }
  } } } as any
}

test("userScripts eval reports thrown exceptions, rejections and reference errors instead of success:null", async () => {
  globalThis.chrome = chromeLikeUserScripts()
  const ev = (code: string, world = "MAIN") => handleEvaluateActions({ type: "evaluate", world, code }, 42)
  expect(await ev('throw new Error("boom")')).toMatchObject({ success: false, error: "boom" })
  expect((await ev("nonexistentVar")).success).toBe(false)
  expect((await ev("nonexistentVar")).error).toContain("nonexistentVar is not defined")
  expect(await ev('Promise.reject(new Error("rej"))')).toMatchObject({ success: false, error: "rej" })
  expect(await ev('throw new Error("iso")', "ISOLATED")).toMatchObject({ success: false, error: "iso" })
})

test("userScripts eval preserves completion values, undefined, await and object literals", async () => {
  globalThis.chrome = chromeLikeUserScripts()
  const ev = (code: string) => handleEvaluateActions({ type: "evaluate", world: "MAIN", code }, 42)
  expect(await ev("1+1")).toEqual({ success: true, data: 2 })
  expect(await ev("const x = 41; x + 1")).toEqual({ success: true, data: 42 })   // baseline 0.24.7 behavior kept
  expect(await ev("var z = 1")).toMatchObject({ success: true })
  expect((await ev("var z = 1")).data).toBeUndefined()
  expect(await ev("await Promise.resolve(7)")).toEqual({ success: true, data: 7 })
  expect(await ev("({a:1})")).toEqual({ success: true, data: { a: 1 } })
  expect(await ev("null")).toEqual({ success: true, data: null })
})

test("userScripts eval names a parse failure as a SyntaxError instead of success:null", async () => {
  globalThis.chrome = chromeLikeUserScripts()
  const r = await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "1 +" }, 42)
  expect(r.success).toBe(false)
  expect(r.error).toMatch(/SyntaxError/)
})

test("userScripts eval never evaluates the code twice", async () => {
  const sink: string[] = []
  globalThis.chrome = chromeLikeUserScripts(sink)
  ;(globalThis as any).__ikCount = 0
  await handleEvaluateActions({ type: "evaluate", world: "MAIN", code: "globalThis.__ikCount++; globalThis.__ikCount" }, 42)
  expect((globalThis as any).__ikCount).toBe(1)
  delete (globalThis as any).__ikCount
})
