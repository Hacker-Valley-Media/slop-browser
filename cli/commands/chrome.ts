/**
 * cli/commands/chrome.ts — interceptor chrome <subcommand>
 *
 * Read-only helpers over Chrome's saved logins (issue #246). The daemon does
 * the reading and decryption; this only shapes the request. The password is
 * never returned by these verbs — enumeration shows host + username only. To
 * USE a saved password, fill it into the page with:
 *
 *   interceptor type <field> --chrome-login <host> [--user]
 */

type Action = { type: string; [key: string]: unknown }

export function parseChromeCommand(filtered: string[]): Action {
  // filtered = ["chrome", "creds", <verb?>, ...]
  const family = filtered[1]
  if (family !== "creds") {
    console.error("error: chrome requires 'creds' (interceptor chrome creds list|status [--host <host>])")
    process.exit(1)
  }
  const verb = filtered[2] && !filtered[2].startsWith("--") ? filtered[2] : "list"
  if (verb !== "list" && verb !== "status") {
    console.error(`error: unknown chrome creds verb '${verb}' (list|status)`)
    process.exit(1)
  }
  const action: Action = { type: "chrome_creds", sub: verb }
  const hostIdx = filtered.indexOf("--host")
  if (hostIdx !== -1) {
    const host = filtered[hostIdx + 1]
    if (!host || host.startsWith("--")) { console.error("error: --host requires a value"); process.exit(1) }
    action.host = host
  }
  return action
}
