import { IK_TT_POLICY, TT_POLICY_NAME } from "../../inject-keys"
import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

const CSP_BYPASS_RULE_ID_BASE = 910_000

export function isTrustedTypesError(error: string | undefined): boolean {
  if (!error) return false
  return /trusted ?types|trustedscript|require-trusted-types-for|createPolicy/i.test(error)
}

export function isCspUnsafeEvalError(error: string | undefined): boolean {
  if (!error) return false
  if (isTrustedTypesError(error)) return false
  return /content security policy|script-src|unsafe-eval/i.test(error)
    && /eval|evaluating a string|string as javascript/i.test(error)
}

export function isCspEvalError(error: string | undefined): boolean {
  if (!error) return false
  return isTrustedTypesError(error) || isCspUnsafeEvalError(error)
}

export function buildCspBypassRule(tabId: number): chrome.declarativeNetRequest.Rule {
  return {
    id: CSP_BYPASS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }
}

// Chrome 152 returns NEITHER `error` NOR `result` when a user script throws,
// rejects, or fails to parse (live 2026-09-07: `eval --main 'throw new Error("boom")'`
// came back success:true, data:null). The raw code cannot report its own failure,
// so it is wrapped textually — no eval, so page CSP stays out of it:
//   expression  — async IIFE + try/catch: catches throws and rejections,
//                 supports `await`, clones the value so it survives serialization.
//   statement   — top-level try/catch that keeps the script completion value
//                 (`const x = 41; x + 1` → 42, as before) for non-expression code.
//   probe       — an undefined result after `statement` is either an undefined
//                 completion or a parse failure; the nonce flag `statement` sets
//                 tells them apart without running the code again.
//   asyncBody   — last resort for statement code that needs `await`/`return`;
//                 only reached when `statement` did not parse, so nothing runs twice.
const USER_SCRIPT_CLONE = `const __c=v=>{if(v==null)return v;const t=typeof v;if(t==="string"||t==="number"||t==="boolean")return v;if(t==="bigint")return v.toString();try{return JSON.parse(JSON.stringify(v))}catch{try{return String(v)}catch{return null}}};`
const USER_SCRIPT_CATCH = `catch(e){return{__ik:1,ok:false,error:String(e&&e.message||e)}}`
const USER_SCRIPT_RAN_KEY = "interceptor.eval.ran"
export function userScriptForms(code: string, nonce: string): { expression: string; statement: string; probe: string; asyncBody: string } {
  const key = `Symbol.for(${JSON.stringify(USER_SCRIPT_RAN_KEY)})`
  return {
    expression: `(async()=>{${USER_SCRIPT_CLONE}try{return{__ik:1,ok:true,value:__c(await (async()=>(\n${code}\n))())}}${USER_SCRIPT_CATCH}})()`,
    statement: `globalThis[${key}]=${JSON.stringify(nonce)};try{\n${code}\n}catch(e){({__ik:1,ok:false,error:String(e&&e.message||e)})}`,
    probe: `(()=>{const k=${key};const r=globalThis[k];delete globalThis[k];return r===${JSON.stringify(nonce)}})()`,
    asyncBody: `(async()=>{${USER_SCRIPT_CLONE}try{\n${code}\n;return{__ik:1,ok:true}}${USER_SCRIPT_CATCH}})()`,
  }
}
const USER_SCRIPT_SYNTAX_ERROR = "SyntaxError: the code did not parse as an expression or as statements (or returned a value the browser could not serialize). Check quoting; multi-statement code that needs await should end with `return <value>`."

function unwrapUserScriptResult(raw: unknown): ActionResult {
  const r = raw as { __ik?: number; ok?: boolean; value?: unknown; error?: string } | null
  if (r && typeof r === "object" && r.__ik === 1) {
    return r.ok ? { success: true, data: r.value } : { success: false, error: r.error ?? "eval failed" }
  }
  return { success: true, data: raw }
}

async function executeWithUserScripts(
  tabId: number,
  world: "MAIN" | "USER_SCRIPT",
  code: string,
  frameId?: number
): Promise<{ available: boolean; result?: ActionResult; reason?: string }> {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
      return { available: false, reason: "chrome.userScripts.execute is unavailable (check Allow User Scripts and browser support)" }
    }
    const forms = userScriptForms(code, crypto.randomUUID())
    const run = async (js: string) => {
      const results = await chrome.userScripts.execute({
        target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
        js: [{ code: js }],
        world
      })
      // Safari targets the requested frame but omits frameId from its sole result.
      // Keep rejecting an explicit mismatched frame while accepting that API shape.
      return frameId === undefined
        ? results[0]
        : results.find(r => r.frameId === frameId) ?? (results.length === 1 && results[0]?.frameId === undefined ? results[0] : undefined)
    }
    const settled = (first: { error?: string; result?: unknown } | undefined) => {
      if (!first) return { available: true, result: { success: false, error: `no result for frame ${frameId ?? 0}` } }
      if (first.error) return { available: true, result: { success: false, error: first.error } }
      return undefined
    }
    let first = await run(forms.expression)
    let done = settled(first)
    if (done) return done
    if (first!.result !== undefined && first!.result !== null) return { available: true, result: unwrapUserScriptResult(first!.result) }
    first = await run(forms.statement)
    done = settled(first)
    if (done) return done
    if (first!.result !== undefined && first!.result !== null) return { available: true, result: unwrapUserScriptResult(first!.result) }
    const ran = await run(forms.probe)
    if (ran?.result === true) return { available: true, result: { success: true, data: first!.result } }
    first = await run(forms.asyncBody)
    done = settled(first)
    if (done) return done
    if (first!.result !== undefined && first!.result !== null) return { available: true, result: unwrapUserScriptResult(first!.result) }
    return { available: true, result: { success: false, error: USER_SCRIPT_SYNTAX_ERROR } }
  } catch (err) {
    const message = (err as Error).message || String(err)
    if (/userScripts|Developer mode|Allow User Scripts|permission|undefined/i.test(message)) {
      return { available: false, reason: message }
    }
    return { available: true, result: { success: false, error: message } }
  }
}

async function executeEval(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  code: string,
  frameId?: number
): Promise<ActionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
    world,
    args: [code, IK_TT_POLICY, TT_POLICY_NAME],
    func: async (c: string, ttKey: string, ttName: string) => {
      const TT = Symbol.for(ttKey)
      function clone(v: unknown): unknown {
        if (v === null || v === undefined) return v
        const t = typeof v
        if (t === "string" || t === "number" || t === "boolean") return v
        if (t === "bigint") return (v as bigint).toString()
        try {
          return JSON.parse(JSON.stringify(v))
        } catch {
          try { return String(v) } catch { return null }
        }
      }
      try {
        const w = window as any
        let source = c
        if (w.trustedTypes) {
          if (!w[TT]) {
            try {
              w[TT] = w.trustedTypes.createPolicy(ttName, {
                createScript: (s: string) => s
              })
            } catch {
              try {
                w[TT] = w.trustedTypes.createPolicy(ttName + "-" + Date.now(), {
                  createScript: (s: string) => s
                })
              } catch {}
            }
          }
          if (w[TT]) {
            source = w[TT].createScript(c)
          }
        }
        let r: unknown = (0, eval)(source as string)
        if (r && typeof (r as any).then === "function") {
          r = await (r as Promise<unknown>)
        }
        return { success: true, data: clone(r) }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) }
      }
    }
  })
  const first = frameId === undefined
    ? results[0]
    : results.find(r => r.frameId === frameId) ?? (results.length === 1 && results[0]?.frameId === undefined ? results[0] : undefined)
  return (first?.result as ActionResult) ?? { success: false, error: `no result for frame ${frameId ?? 0}` }
}

async function installCspBypassForTab(tabId: number): Promise<void> {
  const rule = buildCspBypassRule(tabId)
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule]
  })
}

async function reloadTabForCspRetry(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache: true })
  await waitForTabLoad(tabId, 15_000)
}

/**
 * Run a per-tab evaluation through the CSP / Trusted-Types escalation chain:
 *   1. try the `run` callback in the requested world
 *   2. on any unsafe-eval CSP / TT failure (MAIN), strip the page's CSP response
 *      header via a per-tab declarativeNetRequest rule + reload, then retry
 *
 * `run` performs the actual in-page work and returns an ActionResult — e.g.
 * clone-eval for the `evaluate` capability, or blob-URL normalization for the
 * binary sink. On the fallback / bypass paths the successful result's `data` is
 * wrapped as `{ value, cspBypassApplied, originalError }`;
 * callers that need the raw value should unwrap `data.value` when present.
 *
 * This is the shared bypass core (lifted out of handleEvaluateActions) so every
 * capability that evals into a page inherits the same strict-CSP / Trusted-Types
 * handling instead of reimplementing a weaker one.
 */
export async function runWithCspStripBypass(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  run: (tabId: number, world: "MAIN" | "ISOLATED") => Promise<ActionResult>
): Promise<ActionResult> {
  const first = await run(tabId, world)
  if (first.success || world !== "MAIN") {
    return first
  }

  if (!isCspUnsafeEvalError(first.error) && !isTrustedTypesError(first.error)) {
    return first
  }

  try {
    await installCspBypassForTab(tabId)
    await reloadTabForCspRetry(tabId)
  } catch (err) {
    return {
      success: false,
      error: `MAIN-world eval hit page CSP and automatic CSP bypass setup failed: ${(err as Error).message}`,
      data: { originalError: first.error, cspBypassAttempted: false }
    }
  }

  let retried: ActionResult
  try { retried = await run(tabId, "MAIN") }
  catch (err) { retried = { success: false, error: err instanceof Error ? err.message : String(err) } }
  if (retried.success) {
    return {
      ...retried,
      data: {
        value: retried.data,
        cspBypassApplied: true,
        originalError: first.error
      }
    }
  }

  return {
    success: false,
    error: retried.error || first.error || "MAIN-world eval failed after CSP bypass retry",
    data: {
      originalError: first.error,
      cspBypassApplied: true
    }
  }
}

export async function handleEvaluateActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (action.type !== "evaluate") {
    return { success: false, error: `unknown evaluate action: ${action.type}` }
  }
  const code = action.code as string
  const frameId = action.frameId as number | undefined
  if (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId < 0)) {
    return { success: false, error: "frameId must be a non-negative safe integer" }
  }
  if (typeof code !== "string" || !code.trim()) return { success: false, error: "evaluate requires JavaScript code" }
  const world = (action.world as string) === "ISOLATED" ? "ISOLATED" : "MAIN"
  const initialUserScriptWorld = world === "MAIN" ? "MAIN" : "USER_SCRIPT"
  const userScriptAttempt = await executeWithUserScripts(tabId, initialUserScriptWorld, code, frameId)
  if (userScriptAttempt.available && (world !== "MAIN" || !isCspEvalError(userScriptAttempt.result?.error))) {
    return userScriptAttempt.result ?? { success: false, error: "no result" }
  }
  // Trusted-Types / unsafe-eval CSP escalation now lives in the shared
  // runWithCspStripBypass core (see above) so `evaluate` and the binary sink
  // share one bypass implementation. The userScripts attempt above remains
  // evaluate-specific.
  try {
    const result = action.noCspReload === true
      ? await executeEval(tabId, world, code, frameId)
      : await runWithCspStripBypass(tabId, world, (t, w) => executeEval(t, w, code, frameId))
    if (!result.success && world === "ISOLATED" && isCspEvalError(result.error)) {
      return {
        success: false,
        error: `Isolated eval is unavailable: ${userScriptAttempt.reason ?? "the userScripts execution failed"}. Enable Allow User Scripts for this extension and reload it, or explicitly use eval --main for page-world access.`,
        data: { originalError: result.error, requestedWorld: world, userScriptsAvailable: userScriptAttempt.available },
      }
    }
    return result
  } catch (err) {
    return { success: false, error: `eval in frame ${frameId ?? 0} failed: ${(err as Error).message}` }
  }
}
