/**
 * daemon/redact.ts — log-line redaction for the daemon (issue #244).
 *
 * The daemon logs the first 100 characters of every request action. Actions
 * that carry a credential (a vault write, a resolved delivery, the Apple ID
 * login) must never reach that line with the value in them. Kept in its own
 * module so the rule is unit-testable without importing the daemon entry.
 */

const VALUE_FIELDS = ["value", "text", "inputText", "password", "pw", "passcode", "token"]

export function isSecretBearing(action: unknown): boolean {
  if (!action || typeof action !== "object" || Array.isArray(action)) return false
  const a = action as Record<string, unknown>
  if (a.type === "macos_secret" || a.type === "ios_login") return true
  if (typeof a.secret === "string") return true
  // issue #248: a Chrome saved-login fill; the delivered value rides text/inputText.
  if (a.chromeLogin && typeof a.chromeLogin === "object") return true
  if (a.sensitive === true) return true
  return false
}

/** The action with every value-carrying field replaced by a marker. */
export function redactAction(action: unknown): unknown {
  if (!isSecretBearing(action)) return action
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(action as Record<string, unknown>)) {
    out[k] = VALUE_FIELDS.includes(k) && v !== undefined ? "<redacted>" : v
  }
  return out
}

export function actionLogSummary(action: unknown): string {
  if (action && typeof action === "object" && !Array.isArray(action) && (action as { type?: string }).type === "daemon_shutdown") {
    const value = action as { type: string; protocolVersion?: unknown; reason?: unknown }
    return JSON.stringify({ type: value.type, protocolVersion: value.protocolVersion, reason: value.reason, token: "<redacted>" })
  }
  return JSON.stringify(redactAction(action)).slice(0, 100)
}

/**
 * A request/response envelope (`{ id, action, … }` or `{ id, result, … }`) with a
 * secret-bearing action, or a vault read's `{ name, value }` result, redacted.
 */
export function redactMessage(msg: unknown): unknown {
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const m = msg as Record<string, unknown>
    if (isSecretBearing(m.action)) return { ...m, action: redactAction(m.action) }
    const result = m.result as { data?: unknown } | undefined
    const data = result?.data as Record<string, unknown> | undefined
    if (data && typeof data === "object" && typeof data.name === "string" && typeof data.value === "string") {
      return { ...m, result: { ...result, data: { ...data, value: "<redacted>" } } }
    }
  }
  return msg
}

/** Inbound native-messaging frames: responses and events. Only the shape is logged when a value could be inside. */
export function inboundLogSummary(msg: unknown): string {
  return JSON.stringify(redactMessage(msg)).slice(0, 200)
}

/** Outbound frames (daemon → extension / relay / runtime agent), same rule. */
export function outboundLogSummary(msg: unknown): string {
  return JSON.stringify(redactMessage(msg)).slice(0, 200)
}
