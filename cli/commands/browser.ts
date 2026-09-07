/**
 * cli/commands/browser.ts — interceptor browser <subcommand>
 *
 * Read-only helpers over a Chromium browser's saved logins (issue #248). The
 * daemon does the reading and decryption; this only shapes the request. The
 * password is never returned by these verbs — enumeration shows host +
 * username + which browser only. To USE a saved password, fill it into the
 * page with:
 *
 *   interceptor type <field> --browser-login <host> [--user] [--browser <key>]
 *
 * Enumeration is refused for model callers: a model must not list the user's
 * saved accounts. The refusal is enforced here in the CLI process, where the
 * INTERCEPTOR_MCP marker actually lives (the MCP adapter sets it on the CLI
 * subprocess it spawns; the long-lived daemon never sees it). This mirrors
 * `secret reveal` in cli/commands/macos.ts. The fill path is unaffected — it
 * never returns the value.
 */

type Action = { type: string; [key: string]: unknown }

export function parseBrowserCommand(filtered: string[]): Action {
  // filtered = ["browser", "creds", <verb?>, ...]
  const family = filtered[1]
  if (family !== "creds") {
    console.error("error: browser requires 'creds' (interceptor browser creds list|status [--host <host>] [--browser <key>])")
    process.exit(1)
  }
  if (process.env.INTERCEPTOR_MCP === "1") {
    console.error("error: browser creds enumeration is refused over MCP (a model must not list saved accounts); use `type --browser-login <host>` to fill")
    process.exit(1)
  }
  const verb = filtered[2] && !filtered[2].startsWith("--") ? filtered[2] : "list"
  if (verb !== "list" && verb !== "status") {
    console.error(`error: unknown browser creds verb '${verb}' (list|status)`)
    process.exit(1)
  }
  const action: Action = { type: "browser_creds", sub: verb }
  const hostIdx = filtered.indexOf("--host")
  if (hostIdx !== -1) {
    const host = filtered[hostIdx + 1]
    if (!host || host.startsWith("--")) { console.error("error: --host requires a value"); process.exit(1) }
    action.host = host
  }
  const browserIdx = filtered.indexOf("--browser")
  if (browserIdx !== -1) {
    const browser = filtered[browserIdx + 1]
    if (!browser || browser.startsWith("--")) { console.error("error: --browser requires a value (chrome|brave|vivaldi|edge|chromium|arc)"); process.exit(1) }
    action.browser = browser
  }
  return action
}
