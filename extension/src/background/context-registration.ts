type BadgeDetails = { text?: string; color?: string }

export type ActionBadgeApi = {
  setBadgeText: (details: { text: string }) => unknown
  setBadgeBackgroundColor?: (details: { color: string }) => unknown
}

type ChromeLike = {
  action?: ActionBadgeApi
  browserAction?: ActionBadgeApi
}

export type ContextRegistrationControl =
  // osInput: the daemon telling us whether ITS host can deliver OS-level
  // trusted input. Only macOS can; a service worker cannot see the host OS.
  | { type: "context_registered"; contextId?: unknown; osInput?: unknown }
  | { type: "context_conflict"; contextId?: unknown; error?: unknown }

export function registrationControlType(msg: unknown): ContextRegistrationControl["type"] | null {
  const candidate = msg as { type?: unknown } | null
  if (!candidate || typeof candidate.type !== "string") return null
  if (candidate.type === "context_registered" || candidate.type === "context_conflict") return candidate.type
  return null
}

function getBadgeApi(chromeApi: ChromeLike): ActionBadgeApi | null {
  const api = chromeApi.action ?? chromeApi.browserAction
  if (!api || typeof api.setBadgeText !== "function") return null
  return api
}

function ignoreAsyncResult(result: unknown): void {
  if (result && typeof (result as Promise<unknown>).catch === "function") {
    ;(result as Promise<unknown>).catch((err) => console.error("action badge update failed:", err))
  }
}

export function updateContextBadge(chromeApi: ChromeLike, details: BadgeDetails): boolean {
  const api = getBadgeApi(chromeApi)
  if (!api) return false
  ignoreAsyncResult(api.setBadgeText({ text: details.text ?? "" }))
  if (details.color && api.setBadgeBackgroundColor) {
    ignoreAsyncResult(api.setBadgeBackgroundColor({ color: details.color }))
  }
  return true
}

export function setContextConflictBadge(chromeApi: ChromeLike): boolean {
  return updateContextBadge(chromeApi, { text: "!", color: "#e53e3e" })
}

export function clearContextConflictBadge(chromeApi: ChromeLike): boolean {
  return updateContextBadge(chromeApi, { text: "" })
}
