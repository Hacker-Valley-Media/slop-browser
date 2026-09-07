/**
 * cli/manifest.ts — interceptor manifest
 *
 * Machine-readable capability discovery for AI agents: what each verb does,
 * what it RETURNS (the load-bearing part — innerText vs textContent vs
 * markdown vs a11y tree are different answers to "get me the text"), which
 * surfaces exist on this install, and skill-pack adoption state. An agent
 * that never loaded a skill can ask the binary itself in one structured call
 * instead of grepping a 33KB help dump.
 *
 * The returns: strings are verified against the extension implementation
 * (extension/src/content/data/extract.ts, cli/commands/*.ts) — keep them in
 * lockstep when extraction semantics change.
 */

import { VERSION, BUILD_SHA } from "./version"
import { detectSurfaces } from "./lib/surfaces"
import { skillsStatusSummary } from "./commands/skills"

export type FlagSpec = { name: string; value?: string; description: string }
export type CommandSpec = {
  name: string
  surface: "browser" | "macos" | "ios" | "local"
  usage: string
  summary: string
  returns: string
  flags?: FlagSpec[]
  example?: string
}

export const COMMAND_SPECS: CommandSpec[] = [
  // ── compound (agent-optimized) ──────────────────────────────────────────────
  {
    name: "open", surface: "browser",
    usage: "interceptor open <url> [--tree-only|--text-only] [--markdown] [--full] [--reuse|--no-reuse] [--activate] [--no-wait] [--timeout <ms>]",
    summary: "Open URL in a background tab, wait for stability, return a11y tree + page text",
    returns: "tree: a11y tree (interactive elements + e<n> refs). text: document.body.innerText (visible rendered text), capped at 8,000 chars unless --full (200K). --markdown swaps text for a structure-preserving markdown render.",
    flags: [
      { name: "--tree-only", description: "skip text" },
      { name: "--text-only", description: "skip tree" },
      { name: "--markdown", description: "render text as markdown (headings/bold/lists/tables preserved)" },
      { name: "--full", description: "lift the 8K text cap (up to 200K)" },
      { name: "--reuse", description: "navigate the most recent managed tab instead of opening a new one (the DEFAULT for --group calls, per the extension's tab-lifecycle policy)" },
      { name: "--no-reuse", description: "force a new tab (overrides the named-group reuse default)" },
      { name: "--activate", description: "foreground the tab (default is background-first)" },
      { name: "--no-wait", description: "return immediately after tab creation" },
      { name: "--timeout", value: "<ms>", description: "wait-stable timeout (default 5000)" },
    ],
    example: "interceptor open https://example.com --text-only",
  },
  {
    name: "read", surface: "browser",
    usage: "interceptor read [e<ref>] [--tree-only|--text-only] [--markdown] [--full] [--filter <mode>] [--tree-format compact|verbose] [--include-style] [--include-frames]",
    summary: "Tree + text for the active tab (or an element subtree)",
    returns: "Same shapes as open. With e<ref>: element-scoped — element text uses textContent (INCLUDES display:none text, unlike page-level innerText).",
    flags: [
      { name: "--tree-only", description: "a11y tree only (the way to find refs for act)" },
      { name: "--text-only", description: "visible text only (innerText; flattens headings into prose)" },
      { name: "--markdown", description: "text with structure: use when headings/tables matter" },
      { name: "--full", description: "lift the 8K text cap" },
      { name: "--filter", value: "interactive|all", description: "tree filter (default interactive)" },
      { name: "--tree-format", value: "compact|verbose", description: "compact saves agent context" },
      { name: "--include-frames", description: "walk all reachable frames (refs become e<frameId>_<n>)" },
    ],
    example: "interceptor read --markdown --full",
  },
  {
    name: "act", surface: "browser",
    usage: "interceptor act <ref> [value…] [--keys <combo>] [--trusted] [--append] [--no-read] [--timeout <ms>]",
    summary: "Click (no value) or type (with value) on a ref, wait, return updated tree + diff",
    returns: "Updated a11y tree + '--- diff ---' of what changed. 'ok (page navigated…)' when the action triggered navigation.",
    flags: [
      { name: "--keys", value: "<combo>", description: "send a keyboard shortcut instead (e.g. Enter, cmd+shift+p)" },
      { name: "--trusted", description: "HID-sourced input — page sees isTrusted: true; requires the target tab active in the OS-focused window (refuses otherwise, never moves focus)" },
      { name: "--append", description: "type without clearing the field first" },
      { name: "--no-read", description: "skip the post-action tree read" },
    ],
    example: "interceptor act e5 \"hello world\"",
  },
  {
    name: "inspect", surface: "browser",
    usage: "interceptor inspect [--net-only] [--limit <n>] [--filter <pattern>]",
    summary: "Tree + text + network log + request headers in one call",
    returns: "a11y tree, 2,000-char text summary, recent network entries, request headers.",
    example: "interceptor inspect --net-only --filter api",
  },
  // ── reading & finding ───────────────────────────────────────────────────────
  {
    name: "text", surface: "browser",
    usage: "interceptor text [e<ref>] [--markdown]",
    summary: "Page or element text",
    returns: "Page: document.body.innerText (visible only). Element: textContent (includes hidden text). --markdown preserves headings/lists/tables — 'get the headings' means --markdown or tree, NOT plain text.",
  },
  {
    name: "html", surface: "browser",
    usage: "interceptor html e<ref>",
    summary: "Raw markup for an element",
    returns: "outerHTML of the element subtree (raw markup — harder for agents to parse than rendered text; prefer text/read unless you need attributes).",
  },
  {
    name: "tree", surface: "browser",
    usage: "interceptor tree [--filter interactive|all] [--depth <n>] [--max-chars <n>] [--native]",
    summary: "Accessibility tree with e<n> refs",
    returns: "Indented a11y tree; refs are the input to act/click/type. filter=all includes headings and static text — use it to see document structure.",
  },
  {
    name: "find", surface: "browser",
    usage: "interceptor find \"<term>\" [--text-only|--elements-only] [--role <role>] [--include-frames] [--limit <n>]",
    summary: "Find rendered passages and accessible elements on the current page",
    returns: "Typed text and element sections. Text scans the complete document.body.innerText snapshot (not read's 8K output cap) and returns bounded literal, case-insensitive snippets plus total/returned/truncated counts. Elements preserve accessible-name/ID/placeholder/value scoring and actionable refs.",
    flags: [
      { name: "--text-only", description: "return rendered-text snippets only" },
      { name: "--elements-only", description: "return accessible element matches only" },
      { name: "--role", value: "<role>", description: "element-only mode filtered by accessibility role" },
      { name: "--include-frames", description: "aggregate all reachable frames and emit framed refs" },
      { name: "--limit", value: "<n>", description: "maximum returned matches per enabled category (default 10); totals remain truthful" },
    ],
  },
  {
    name: "websearch", surface: "browser",
    usage: "interceptor websearch \"<query>\" [--tree-only|--text-only] [--markdown] [--full] [--reuse|--no-reuse] [--activate] [--no-wait] [--timeout <ms>]",
    summary: "Search via the browser's configured default provider in a managed tab",
    returns: "Managed tab ID/group/reuse metadata, actual provider URL/title, then the same a11y-tree and document.body.innerText shapes as open. Background by default; no hard-coded provider fallback.",
    flags: [
      { name: "--tree-only", description: "skip provider-page text" },
      { name: "--text-only", description: "skip provider-page tree" },
      { name: "--markdown", description: "render provider-page text as markdown" },
      { name: "--full", description: "lift the normal 8K returned-text cap" },
      { name: "--reuse", description: "reuse the most recent managed tab" },
      { name: "--no-reuse", description: "force a new managed tab" },
      { name: "--activate", description: "foreground the results tab (default is background-first)" },
      { name: "--no-wait", description: "return managed tab metadata after search dispatch" },
      { name: "--timeout", value: "<ms>", description: "provider-page stability timeout (default 5000)" },
    ],
    example: "interceptor websearch \"Bun WebSocket documentation\" --text-only",
  },
  {
    name: "state", surface: "browser",
    usage: "interceptor state [--full]",
    summary: "Current page URL/title/status snapshot",
    returns: "Structured page state (url, title, readyState, counts).",
  },
  { name: "diff", surface: "browser", usage: "interceptor diff", summary: "What changed since the last tree read", returns: "Added/removed/changed tree entries." },
  // ── structured extraction ───────────────────────────────────────────────────
  { name: "table", surface: "browser", usage: "interceptor table [selector]", summary: "Extract table data", returns: "Structured rows/columns as JSON — prefer over scraping markdown for tabular data." },
  { name: "links", surface: "browser", usage: "interceptor links", summary: "All links on the page", returns: "Array of {text, href}." },
  { name: "images", surface: "browser", usage: "interceptor images", summary: "All images", returns: "Array of {alt, src}." },
  { name: "forms", surface: "browser", usage: "interceptor forms", summary: "All forms and fields", returns: "Form structure with field names/types/values." },
  { name: "query", surface: "browser", usage: "interceptor query <css-selector>", summary: "Query elements by CSS selector", returns: "Matching elements with attributes and clickable e<ref>s." },
  { name: "exists", surface: "browser", usage: "interceptor exists <css-selector>", summary: "Does a selector match?", returns: "Boolean." },
  { name: "count", surface: "browser", usage: "interceptor count <css-selector>", summary: "How many elements match", returns: "Number." },
  { name: "attr", surface: "browser", usage: "interceptor attr e<ref> <name> | attr set e<ref> <name> <value>", summary: "Get/set an attribute", returns: "Attribute value." },
  { name: "style", surface: "browser", usage: "interceptor style e<ref> <property> | style inject --css \"<rules>\" | style remove <handle>", summary: "Computed style / stylesheet injection", returns: "Computed value, or an injection handle." },
  // ── actions ─────────────────────────────────────────────────────────────────
  { name: "click", surface: "browser", usage: "interceptor click e<ref> | --selector <css> [--nth N]", summary: "Click an element by a11y ref, index, or CSS selector", returns: "ok / error." },
  { name: "type", surface: "browser", usage: "interceptor type e<ref> <text…>", summary: "Type into a field", returns: "ok / error." },
  { name: "select", surface: "browser", usage: "interceptor select e<ref> <value>", summary: "Select an option", returns: "ok / error." },
  { name: "keys", surface: "browser", usage: "interceptor keys <combo>", summary: "Send a keyboard shortcut", returns: "ok / error." },
  { name: "scroll", surface: "browser", usage: "interceptor scroll up|down|top|bottom [--amount <px>]", summary: "Scroll the page", returns: "ok." },
  { name: "hover", surface: "browser", usage: "interceptor hover e<ref>", summary: "Hover an element", returns: "ok." },
  { name: "drag", surface: "browser", usage: "interceptor drag e<ref> [--from x,y --to x,y --steps <n>]", summary: "Drag an element or coordinates", returns: "ok." },
  { name: "upload", surface: "browser", usage: "interceptor upload e<ref> <path> [--dropzone] [--picker]", summary: "Attach a local file to an <input type=file>, drag-and-drop dropzone, or File System Access picker (--picker). Any size — large files auto-chunk. No CDP.", returns: "ok with {method, fileName, size, verified}. method: input | dropzone-trusted | dropzone-isolated | picker-staged." },
  { name: "keepawake", surface: "browser", usage: "interceptor keepawake on|off [--display]", summary: "Keep the machine awake for an unattended run (chrome.power)", returns: "ok with {on, level}." },
  { name: "idle", surface: "browser", usage: "interceptor idle state [--interval <sec>]", summary: "Query user idle state: active | idle | locked (chrome.idle)", returns: "ok with {state}." },
  { name: "delegate", surface: "browser", usage: "interceptor delegate log [--since <ms>] [--follow]", summary: "Read human→agent delegation intents (right-click menu / hotkey)", returns: "list of delegation_intent events." },
  { name: "click-at", surface: "browser", usage: "interceptor click-at <x,y>", summary: "Click page coordinates", returns: "ok." },
  { name: "navigate", surface: "browser", usage: "interceptor navigate <url>", summary: "Navigate the active tab", returns: "ok." },
  { name: "wait", surface: "browser", usage: "interceptor wait <ms>", summary: "Sleep", returns: "ok." },
  { name: "wait-stable", surface: "browser", usage: "interceptor wait-stable [--ms <n>] [--timeout <ms>]", summary: "Wait for DOM stability", returns: "ok when the DOM stops mutating." },
  // ── tabs / network / capture / data ─────────────────────────────────────────
  { name: "tabs", surface: "browser", usage: "interceptor tabs", summary: "List managed tabs", returns: "Tab list (id, url, title)." },
  {
    name: "tab", surface: "browser",
    usage: "interceptor tab new [url] [--reuse|--no-reuse] [--activate] | tab close [id] | tab switch <id>",
    summary: "Create, reuse, activate, or close managed tabs",
    returns: "Tab metadata for creation, or ok / error for exact-ID lifecycle actions.",
    flags: [
      { name: "--reuse", description: "reuse the most recent tab in the caller's managed group" },
      { name: "--no-reuse", description: "force creation of a new managed tab" },
      { name: "--activate", description: "activate the created or reused tab (default is background-first)" },
    ],
  },
  {
    name: "update", surface: "local",
    usage: "interceptor update [status]",
    summary: "Update Interceptor itself — checks with Sparkle and reports its selected version or no-update result (full install only)",
    returns: "check: started, concluded, outcome, phase, selected/latest version or error, and feed. status: the same observed lifecycle plus lastCheck, automaticChecks, checkInterval, canCheckForUpdates, and sessionInProgress.",
    example: "interceptor update",
  },
  { name: "network", surface: "browser", usage: "interceptor net [--filter <pattern>] [--limit <n>] [--format har|json|pcapng --out <path>]", summary: "Passive network log", returns: "Recent requests (method, url, status, type); exportable to HAR/pcapng." },
  { name: "headers", surface: "browser", usage: "interceptor headers [--filter <pattern>]", summary: "Request headers seen", returns: "Header sets per request." },
  { name: "screenshot", surface: "browser", usage: "interceptor screenshot [e<ref>] [--save] [--format png|jpeg|webp] [--quality <n>]", summary: "Screenshot page/element", returns: "Image (saved to disk with --save; path on stderr)." },
  { name: "eval", surface: "browser", usage: "interceptor eval <expr> [--main] [--frame <id>]", summary: "Evaluate JS in the requested frame and world (isolated by default)", returns: "Expression result. Isolated eval needs userScripts support when extension CSP blocks eval. MAIN CSP recovery can reload the tab and returns {value,cspBypassApplied,originalError}; never switches world or frame." },
  { name: "save", surface: "browser", usage: "interceptor save --out <abs-path> <expr>", summary: "Stream page-produced bytes (Blob/File/ArrayBuffer) to disk", returns: "{path, bytes, sha256} — integrity-checked." },
  { name: "cookies", surface: "browser", usage: "interceptor cookies [domain] | cookies set/delete …", summary: "Read/write cookies", returns: "Cookie list." },
  { name: "storage", surface: "browser", usage: "interceptor storage [key] | storage delete <key>", summary: "localStorage access", returns: "Values." },
  { name: "override", surface: "browser", usage: "interceptor override <sub> …", summary: "Request/response overrides", returns: "Override state." },
  { name: "monitor", surface: "browser", usage: "interceptor monitor start|stop|status|tail|export … | task create <objective> | task checkpoint <id> --file <json> | task resume|verify|complete <id>", summary: "Record activity or persist task constraints, resume state and declared browser checks", returns: "Recording session id or task JSON with revision, explicit target, scoped lessons and observed check results. task complete runs fresh predicates; false, missing or stale checks exit nonzero. task verify/complete execute authored JS and require MCP arbitrary-exec allowance. Verification never reloads the page." },
  { name: "scene", surface: "browser", usage: "interceptor scene <sub> …", summary: "Scene-graph automation for canvas/rich editors", returns: "Scene nodes / action results." },
  // ── local (no daemon) ───────────────────────────────────────────────────────
  {
    name: "skills", surface: "local",
    usage: "interceptor skills [list|status|show <name>|adopt …|unadopt [names…] [--into targets] [--all] --owned-root <path>]",
    summary: "List installed skill packs, link them into AI runtimes, or remove only installer-owned links",
    returns: "Adoption state per runtime; adopt creates links; unadopt returns per-target removed/missing/foreign/not-link/error results and never deletes a real directory.",
    example: "interceptor skills adopt --into claude",
  },
  {
    name: "daemon", surface: "local",
    usage: "interceptor daemon stop [--reason installer|manual] [--timeout 10000]",
    summary: "Stop the current-user daemon through an authenticated local control frame without auto-spawning",
    returns: "Text or JSON indicating stopped/alreadyStopped and the verified PID; shutdown tokens are never rendered.",
  },
  {
    name: "manifest", surface: "local",
    usage: "interceptor manifest",
    summary: "This machine-readable capability manifest",
    returns: "JSON: {name, version, surfaces, commands[{name,usage,summary,returns,flags}], skills}.",
  },
  { name: "status", surface: "local", usage: "interceptor status [--verbose]", summary: "Daemon/bridge/extension health + skills adoption", returns: "Status report." },
  {
    name: "diagnose", surface: "local",
    usage: "interceptor diagnose [--context <id>] [--json]",
    summary: "Post-failure snapshot: daemon binary, per-context connection state, NMH binary-mismatch detection",
    returns: "Text report or JSON {daemon, binaryMismatches, contexts[], monitor}. Never auto-spawns the daemon; use after a command fails ('status' is the pre-flight check).",
  },
  { name: "init", surface: "local", usage: "interceptor init [--verbose]", summary: "Bootstrap the daemon and report status", returns: "Status report." },
  { name: "research", surface: "local", usage: "interceptor research [init|log|status|…]", summary: "Deep-research methodology + on-disk source ledger", returns: "Playbook guidance / ledger state." },
  { name: "upgrade", surface: "local", usage: "interceptor upgrade --full", summary: "Promote browser-only install to full computer-use mode (macOS)", returns: "Installer output." },
  // ── other surfaces (verbs enumerated via their own --help) ──────────────────
  { name: "macos", surface: "macos", usage: "interceptor macos <verb> … (see: interceptor help macos)", summary: "Native macOS control: AX trees, background input, windows, screenshots, Apple Events, Electron CDP, app runtime", returns: "Per-verb; background-first — only 'app activate'/'open --activate' move focus." },
  { name: "ios", surface: "ios", usage: "interceptor ios <verb> … (see: interceptor help ios)", summary: "iPhone automation via on-device XCUITest runner over WiFi", returns: "Per-verb: element trees, taps, typing, screenshots, app lifecycle. NOTE: 'ios devices' → connected:false is the normal idle state; the runner auto-connects on the next verb. Keep the phone unlocked & awake." },
]

export function runManifestCommand(argv: string[]): null {
  const surfaces = detectSurfaces(argv)
  const commands = COMMAND_SPECS.filter(c =>
    c.surface === "browser" || c.surface === "local" ||
    (c.surface === "macos" && surfaces.macos) || (c.surface === "ios" && surfaces.ios))
  let skills: ReturnType<typeof skillsStatusSummary> | { packDir: null } = { packDir: null }
  try { skills = skillsStatusSummary() } catch {}
  console.log(JSON.stringify({
    name: "interceptor",
    version: VERSION,
    sha: BUILD_SHA,
    surfaces,
    commands,
    skills,
  }, null, 2))
  return null
}
