/**
 * cli/normalize.ts — order-independent argument normalization
 *
 * Rewrites a command's argv so positionals keep their relative order and come
 * first, followed by flags (each with its value). Existing command parsers
 * read positionals at fixed indices (filtered[1], filtered[2]) and locate
 * flags via indexOf/includes — both patterns work on the normalized shape, so
 * every browser-surface command gains flag-order independence at this single
 * choke point instead of 27 per-module rewrites. Fixes the class of bug where
 * `interceptor open --text-only <url>` created a tab whose URL was literally
 * "--text-only".
 *
 * Also gained for free on normalized commands:
 *   --flag=value   split into `--flag value` (indexOf parsers understand it)
 *   --             option terminator: everything after is positional verbatim
 *   strict flags   unknown `--x` tokens are rejected (exit 1) instead of being
 *                  silently ignored — a typo'd flag used to produce a
 *                  plausible-looking success (e.g. `screenshot --out <path>`
 *                  wrote nothing and exited 0). INTERCEPTOR_LAX_FLAGS=1
 *                  downgrades the rejection to a stderr warning.
 *
 * The macos/ios surfaces are NOT normalized: they parse nested verbs with
 * per-subverb flag semantics (e.g. --activate is a boolean for `macos open`
 * but takes a value for `macos native tcc`, --on is a boolean for overlays
 * but names a device for ios). ponytail: verb-first grammars there keep
 * order-dependence livable; per-subverb specs are a later phase. Strict flag
 * rejection therefore also does not apply to them (or to mcp/update, which
 * bypass normalization entirely).
 *
 * CORRECTNESS CONTRACT: every flag that consumes a following value token in a
 * command module MUST be listed for that command family below, and every
 * boolean flag MUST be listed in the boolean map — a value flag missing from
 * the map has its operand reordered into the positionals (breaking
 * `indexOf(flag) + 1` reads), and a flag missing from both maps is rejected
 * as unknown. The sets below were harvested from every
 * indexOf("--x")/includes("--x")/flagValue(...) site in cli/commands/*.ts
 * (2026-08-20 sweep).
 */

// Flags whose value token is optional (consume the next token only when it
// does not look like another flag). Mirrors monitor.ts's own parsing.
const OPTIONAL_VALUE_FLAGS = new Set(["--persist-bodies"])

// buildFilteredArgs strips --tab/--context/--group/--group-color (+values)
// before normalization, but --frame keeps its value in filtered args. The
// stripped four stay listed defensively: only their FIRST occurrence is
// stripped upstream, so a duplicate would otherwise have its value hoisted.
const GLOBAL_VALUE_FLAGS = ["--frame", "--tab", "--context", "--group", "--group-color"]

// Global booleans legal on every normalized command (harness-level concerns
// handled in cli/index.ts before or after dispatch).
const GLOBAL_BOOLEAN_FLAGS = new Set([
  "--json", "--ws", "--no-ws", "--any-tab", "--shared-group", "--changes", "--all-surfaces",
  "--help", "-h",
  // stderr-hint suppressors read from raw argv on any command
  // (cli/commands/skills.ts maybeEmitSkillsHint) or from `open`'s filtered
  // args (cli/commands/research.ts maybeEmitResearchHint).
  "--no-skills-hint", "--no-research-hint",
])

const COMPOUND = ["--filter", "--keys", "--limit", "--timeout", "--tree-format"]
const STATE = ["--depth", "--filter", "--limit", "--max-chars", "--role"]
// --selector/--nth take VALUES. Without them declared here the normalizer
// treats them as booleans and strips their operands, so
// `click --selector button --nth 4` arrives with selector === "--nth".
// --secret names a vault entry for `type` (issue #244); the value never rides argv.
// --browser-login names the host whose saved login to fill; --browser picks one
// Chromium browser to read (issue #248).
const ACTIONS = ["--at", "--browser", "--browser-login", "--duration", "--from", "--nth", "--secret", "--selector", "--steps", "--to"]
const NAV = ["--amount", "--ms", "--timeout"]
const NET = ["--filter", "--format", "--limit", "--out", "--since", "--pattern", "--patterns", "--type"]
const SCREENSHOT = ["--clip", "--element", "--filter", "--format", "--kind", "--limit", "--quality", "--ref", "--region", "--scale", "--selector", "--target-max-long-edge", "--threshold"]
const DATA = ["--since"]
const META = ["--css", "--frame-ids", "--since"]
const SAVE = ["--out", "--chunk-size"]
const BATCH = ["--timeout"]
const MONITOR = ["--capture", "--file", "--format", "--guard-policy", "--instruction", "--mode", "--out", "--retention-policy", "--session", "--task", "--verifier-policy", "--persist-bodies"]
const SCENE = ["--profile", "--slide", "--type"]
const SSE = ["--filter", "--limit", "--timeout"]
const RESEARCH = ["--dir", "--effort", "--note", "--slug", "--status"]
const SKILLS = ["--into", "--owned-root"]
const DAEMON = ["--reason", "--timeout"]
// window resize takes geometry/state values (cli/commands/tabs.ts) — leaving
// these unlisted hoisted `--width 800`'s operand into the positionals, where
// it misparsed as a window id.
const WINDOW = ["--left", "--top", "--width", "--height", "--state"]
// brand tab-group --title/--color take values (cli/commands/brand.ts).
const BRAND = ["--title", "--color"]
// keepawake/idle (cli/commands/power.ts) parse with indexOf and work on the
// normalized shape; listing them here brings the power family into the
// contract instead of leaving a lax, order-dependent island.
const POWER = ["--interval", "--since"]

const VALUE_FLAGS_BY_CMD: Record<string, string[]> = {
  // compound
  open: COMPOUND, read: COMPOUND, act: COMPOUND, inspect: COMPOUND,
  websearch: COMPOUND, search: COMPOUND,
  // state
  state: STATE, tree: STATE, diff: STATE, find: STATE, text: STATE, html: STATE,
  // actions
  click: ACTIONS, type: ACTIONS, select: ACTIONS, focus: ACTIONS, blur: ACTIONS,
  hover: ACTIONS, drag: ACTIONS, dblclick: ACTIONS, rightclick: ACTIONS,
  check: ACTIONS, keys: ACTIONS, "click-at": ACTIONS, "what-at": ACTIONS, regions: ACTIONS,
  // navigation
  navigate: NAV, back: NAV, forward: NAV, scroll: NAV, wait: NAV, "wait-stable": NAV, wait_for: NAV,
  // tabs (window carries the resize value flags; the rest are boolean-only)
  tabs: [], tab: [], window: WINDOW, frames: [], session: [],
  // network
  network: NET, net: NET, headers: NET,
  // screenshot
  screenshot: SCREENSHOT, canvas: SCREENSHOT, capture: SCREENSHOT, ocr: SCREENSHOT,
  // data
  cookies: DATA, storage: DATA, history: DATA, bookmarks: DATA, downloads: DATA, clear: DATA, clipboard: DATA,
  // meta
  status: META, reload: META, meta: META, links: META, images: META, forms: META,
  info: META, page_info: META, query: META, exists: META, count: META, table: META,
  attr: META, style: META, events: META, notify: META, sessions: META,
  capabilities: META, modals: META, panels: META,
  // singles
  eval: [], save: SAVE, brand: BRAND, group: [], batch: BATCH, raw: BATCH,
  monitor: MONITOR, scene: SCENE, sse: SSE, override: [],
  upgrade: [], init: [], research: RESEARCH, extensions: [], contexts: [],
  skills: SKILLS, daemon: DAEMON, manifest: [],
  keepawake: POWER, idle: POWER,
}

// Boolean (valueless) flags per family — the other half of the contract,
// consulted only by the strict unknown-flag check. Originally harvested
// 2026-08-20 from every includes("--x") site in cli/commands/*.ts — which
// missed helper-mediated flags (hasTrustedFlag consumed --trusted/--os in
// compound's runAct and scene without a literal includes, so 0.23.23 rejected
// `act --trusted` while help advertised it). The reverse-direction block in
// test/strict-flags.test.ts now re-harvests module sources over every
// consumption pattern, so keep it in sync when adding a family here.
const COMPOUND_BOOL = ["--activate", "--append", "--full", "--include-frames", "--include-style", "--markdown", "--net-only", "--no-read", "--no-reuse", "--no-wait", "--os", "--reuse", "--text-only", "--tree-only", "--trusted"]
const STATE_BOOL = ["--elements-only", "--full", "--include-frames", "--markdown", "--native", "--text-only"]
const ACTIONS_BOOL = ["--append", "--dropzone", "--picker", "--trusted", "--os", "--user"]
const TABS_BOOL = ["--incognito"]
const TAB_BOOL = ["--activate", "--no-reuse", "--reuse"]
const NET_BOOL = ["--from-start", "--persist", "--reload", "--redact-auth"]
const SCREENSHOT_BOOL = ["--background", "--full", "--image", "--no-fallback", "--pixel", "--save", "--webgl"]
const DATA_BOOL = ["--session"]
const META_BOOL = ["--author", "--explain", "--tail", "--top-only", "--verbose"]
const EVAL_BOOL = ["--main"]
const SAVE_BOOL = ["--isolated", "--main"]
const BATCH_BOOL = ["--stop-on-error"]
const MONITOR_BOOL = ["--force-diagnostic", "--from-start", "--include-synthetic", "--no-regenerate", "--plan", "--raw", "--reload", "--snapshot-sources", "--stop-sources", "--with-bodies"]
const SCENE_BOOL = ["--os", "--save", "--trusted", "--verbose", "--with-html"]
const POWER_BOOL = ["--display", "--follow"]
const RESEARCH_BOOL = ["--capture", "--full", "--stdin", "--no-research-hint"]
const SKILLS_BOOL = ["--all", "--force", "--no-skills-hint"]

const BOOLEAN_FLAGS_BY_CMD: Record<string, string[]> = {
  open: COMPOUND_BOOL, read: COMPOUND_BOOL, act: COMPOUND_BOOL, inspect: COMPOUND_BOOL,
  websearch: COMPOUND_BOOL, search: COMPOUND_BOOL,
  state: STATE_BOOL, tree: STATE_BOOL, diff: STATE_BOOL, find: STATE_BOOL, text: STATE_BOOL, html: STATE_BOOL,
  click: ACTIONS_BOOL, type: ACTIONS_BOOL, select: ACTIONS_BOOL, focus: ACTIONS_BOOL, blur: ACTIONS_BOOL,
  hover: ACTIONS_BOOL, drag: ACTIONS_BOOL, dblclick: ACTIONS_BOOL, rightclick: ACTIONS_BOOL,
  check: ACTIONS_BOOL, keys: ACTIONS_BOOL, "click-at": ACTIONS_BOOL, "what-at": ACTIONS_BOOL, regions: ACTIONS_BOOL,
  navigate: [], back: [], forward: [], scroll: [], wait: [], "wait-stable": [], wait_for: [],
  tabs: TABS_BOOL, tab: TAB_BOOL, window: TABS_BOOL, frames: [], session: [],
  network: NET_BOOL, net: NET_BOOL, headers: NET_BOOL,
  screenshot: SCREENSHOT_BOOL, canvas: SCREENSHOT_BOOL, capture: SCREENSHOT_BOOL, ocr: SCREENSHOT_BOOL,
  cookies: DATA_BOOL, storage: DATA_BOOL, history: DATA_BOOL, bookmarks: DATA_BOOL, downloads: DATA_BOOL, clear: DATA_BOOL, clipboard: DATA_BOOL,
  status: META_BOOL, reload: META_BOOL, meta: META_BOOL, links: META_BOOL, images: META_BOOL, forms: META_BOOL,
  info: META_BOOL, page_info: META_BOOL, query: META_BOOL, exists: META_BOOL, count: META_BOOL, table: META_BOOL,
  attr: META_BOOL, style: META_BOOL, events: META_BOOL, notify: META_BOOL, sessions: META_BOOL,
  capabilities: META_BOOL, modals: META_BOOL, panels: META_BOOL,
  eval: EVAL_BOOL, save: SAVE_BOOL, brand: [], group: [], batch: BATCH_BOOL, raw: BATCH_BOOL,
  monitor: MONITOR_BOOL, scene: SCENE_BOOL, sse: [], override: [],
  upgrade: ["--full"], init: ["--explain", "--verbose"], research: RESEARCH_BOOL, extensions: ["--remove"], contexts: [],
  skills: SKILLS_BOOL, daemon: [], manifest: [],
  keepawake: POWER_BOOL, idle: POWER_BOOL,
}

// Exposed for the table-driven inventory test (test/strict-flags.test.ts):
// any flag a command module parses that is missing here fails CI instead of
// silently regressing to a strict-mode rejection.
export const FLAG_INVENTORY = {
  value: VALUE_FLAGS_BY_CMD,
  boolean: BOOLEAN_FLAGS_BY_CMD,
  globalValue: GLOBAL_VALUE_FLAGS,
  globalBoolean: GLOBAL_BOOLEAN_FLAGS,
} as const

let warnedLaxFlags = false

function rejectUnknownFlag(cmd: string, tok: string): void {
  const lax = process.env.INTERCEPTOR_LAX_FLAGS === "1"
  let extra = ""
  // The trap issue #212 documents verbatim: --out belongs to save/net; the
  // screenshot family's write-to-disk flag is --save.
  const name = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok
  if (name === "--out" && (cmd === "screenshot" || cmd === "canvas" || cmd === "capture" || cmd === "ocr")) {
    extra = " (--out belongs to 'save' and 'net'; 'screenshot --save' writes the image to disk)"
  }
  const msg = `unknown flag '${tok}' for '${cmd}'${extra}. Run 'interceptor help ${cmd}' for its flags; use '--' before positional values that begin with --.`
  if (lax) {
    if (!warnedLaxFlags) {
      warnedLaxFlags = true
      console.error(`warning: ${msg}`)
    }
    return
  }
  throw new Error(msg)
}

export type NormalizedArgs = { argv: string[]; positionalCount: number }

/**
 * Normalize `[cmd, ...rest]` to `[cmd, ...positionals, ...flags]` and report
 * how many positionals there are (they occupy argv[1 .. positionalCount]).
 * Commands without a value-flag map (macos, ios, mcp, update) are returned
 * untouched with positionalCount = 0 (callers of the boundary never see them).
 */
export function normalizeArgsSplit(filtered: string[]): NormalizedArgs {
  const cmd = filtered[0]
  const familyFlags = VALUE_FLAGS_BY_CMD[cmd]
  if (!familyFlags) return { argv: filtered, positionalCount: 0 }
  const vf = new Set([...familyFlags, ...GLOBAL_VALUE_FLAGS])
  const bf = new Set(BOOLEAN_FLAGS_BY_CMD[cmd] || [])

  const positionals: string[] = []
  const flags: string[] = []
  let terminated = false

  for (let i = 1; i < filtered.length; i++) {
    const tok = filtered[i]
    if (terminated) { positionals.push(tok); continue }
    if (tok === "--") { terminated = true; continue }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=")
      const name = eq > 2 ? tok.slice(0, eq) : tok
      if (!vf.has(name) && !bf.has(name) && !GLOBAL_BOOLEAN_FLAGS.has(name)) {
        rejectUnknownFlag(cmd, tok)
        // lax mode falls through: keep today's bare-flag behavior.
      }
      if (eq > 2) {
        if (vf.has(name)) { flags.push(name, tok.slice(eq + 1)); continue }
        if (bf.has(name) || GLOBAL_BOOLEAN_FLAGS.has(name)) {
          // A boolean flag with a value would travel as one raw token no
          // parser recognizes — `net log --redact-auth=true` would export
          // credentials unredacted and exit 0. Never legal, so no lax mode.
          throw new Error(`flag '${name}' for '${cmd}' does not take a value (use '${name}').`)
        }
        flags.push(tok)
        continue
      }
      flags.push(tok)
      if (vf.has(tok) && i + 1 < filtered.length) {
        const next = filtered[i + 1]
        if (OPTIONAL_VALUE_FLAGS.has(tok) && next.startsWith("-")) continue
        flags.push(next)
        i++
      }
      continue
    }
    // includes single-dash tokens ("-100", "-h" is handled upstream) — they
    // are values/positionals in this grammar, never short-option groups
    positionals.push(tok)
  }

  if (cmd === "tab" && positionals[0] !== "new") {
    const unsupported = TAB_BOOL.find((flag) => flags.includes(flag))
    if (unsupported) {
      throw new Error(`flag '${unsupported}' is only valid with 'tab new'.`)
    }
  }

  return { argv: [cmd, ...positionals, ...flags], positionalCount: positionals.length }
}

/** Back-compat flat shape (tests, simple callers). */
export function normalizeArgs(filtered: string[]): string[] {
  return normalizeArgsSplit(filtered).argv
}
