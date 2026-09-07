/**
 * test/secrets-redaction.test.ts — issue #244: the daemon's log line never
 * carries a credential. Covers the vault verbs, every --secret delivery,
 * the resolved `sensitive` deliveries, and the Apple ID login.
 */

import { describe, expect, test } from "bun:test"
import { actionLogSummary, inboundLogSummary, isSecretBearing, redactAction } from "../daemon/redact"

const VALUE = "hunter2-CORRECT-horse"

describe("actionLogSummary", () => {
  test("plain actions are unchanged (first 100 chars)", () => {
    expect(actionLogSummary({ type: "macos_type", text: "hello" })).toBe(JSON.stringify({ type: "macos_type", text: "hello" }))
    expect(actionLogSummary({ type: "click", ref: "e1" })).toContain('"ref":"e1"')
  })

  test("vault writes never show the value", () => {
    const line = actionLogSummary({ type: "macos_secret", sub: "set", name: "admin", value: VALUE, targets: ["sudo"] })
    expect(line).not.toContain(VALUE)
    expect(line).toContain('"name":"admin"')
    expect(line).toContain("<redacted>")
  })

  test("every --secret delivery logs the name only", () => {
    for (const a of [
      { type: "input_text", ref: "e3", secret: "site-pw" },
      { type: "find_and_type", name: "Password", secret: "site-pw" },
      { type: "os_type", secret: "site-pw" },
      { type: "macos_type", secret: "admin" },
      { type: "ios_type", ref: "e2", secret: "ios-passcode" },
      { type: "ios_keys", secret: "ios-passcode" },
      { type: "ios_unlock", secret: "ios-passcode" },
      { type: "macos_sudo", secret: "admin", cmd: ["/usr/bin/id"] },
      { type: "macos_authdialog", sub: "fill", secret: "admin", submit: true },
    ]) {
      const line = actionLogSummary(a)
      expect(line).toContain(`"secret":"${a.secret}"`)
      expect(line).not.toContain(VALUE)
    }
  })

  test("resolved deliveries (sensitive) hide text, inputText, and passcode", () => {
    expect(actionLogSummary({ type: "macos_type", text: VALUE, sensitive: true })).not.toContain(VALUE)
    expect(actionLogSummary({ type: "find_and_type", inputText: VALUE, sensitive: true })).not.toContain(VALUE)
    expect(actionLogSummary({ type: "ios_unlock", passcode: VALUE, sensitive: true })).not.toContain(VALUE)
    expect(actionLogSummary({ type: "os_type", text: VALUE, sensitive: true })).toContain("<redacted>")
  })

  test("chrome-login deliveries are secret-bearing and hide the filled value", () => {
    // issue #248: the request carries host+field only (safe to log), the
    // resolved delivery carries the value in text/inputText with sensitive:true.
    expect(isSecretBearing({ type: "input_text", ref: "e1", chromeLogin: { host: "my.functionhealth.com", field: "pass" } })).toBe(true)
    const req = actionLogSummary({ type: "input_text", ref: "e1", chromeLogin: { host: "my.functionhealth.com", field: "pass" } })
    expect(req).toContain("my.functionhealth.com")
    const delivered = actionLogSummary({ type: "input_text", ref: "e1", text: VALUE, sensitive: true })
    expect(delivered).not.toContain(VALUE)
    expect(delivered).toContain("<redacted>")
  })

  test("ios_login never logs the password", () => {
    const line = actionLogSummary({ type: "ios_login", appleId: "a@b.c", password: VALUE })
    expect(line).not.toContain(VALUE)
    expect(line).toContain("a@b.c")
  })

  test("daemon_shutdown still redacts its token", () => {
    const line = actionLogSummary({ type: "daemon_shutdown", protocolVersion: 1, reason: "x", token: "shutdown-TOKEN-value" })
    expect(line).not.toContain("shutdown-TOKEN-value")
    expect(line).toContain('"token":"<redacted>"')
  })

  test("redaction leaves the original object untouched", () => {
    const a = { type: "macos_secret", sub: "set", name: "n", value: VALUE }
    redactAction(a)
    expect(a.value).toBe(VALUE)
    expect(isSecretBearing({ type: "click" })).toBe(false)
  })

  test("inbound frames carrying a sensitive action are summarized by shape", () => {
    const line = inboundLogSummary({ id: "1", action: { type: "os_type", text: VALUE, sensitive: true } })
    expect(line).not.toContain(VALUE)
    expect(inboundLogSummary({ id: "2", result: { success: true } })).toContain('"success":true')
  })
})

describe("outbound frames (daemon → extension) never carry the value", () => {
  test("input_text / find_and_type / os_type envelopes are redacted", async () => {
    const { outboundLogSummary } = await import("../daemon/redact")
    for (const action of [
      { type: "input_text", ref: "e1", text: VALUE, sensitive: true, clear: true },
      { type: "find_and_type", name: "Password", role: "textbox", inputText: VALUE, sensitive: true },
      { type: "os_type", ref: "e1", text: VALUE, sensitive: true },
    ]) {
      const line = outboundLogSummary({ id: "abc", action, tabId: 7 })
      expect(line).not.toContain(VALUE)
      expect(line).toContain('"id":"abc"')
      expect(line).toContain(`"type":"${action.type}"`)
    }
    expect(outboundLogSummary({ id: "x", action: { type: "click", ref: "e2" } })).toContain('"ref":"e2"')
  })
})

describe("content monitor masks secret-typed fields of every kind", () => {
  test("handleInput and handleChange check isSensitive before reading any value", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("../extension/src/content/monitor.ts", import.meta.url), "utf-8")
    for (const fn of ["function handleInput(", "function handleChange("]) {
      const start = src.indexOf(fn)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf("\n}\n", start))
      const sensitiveAt = body.indexOf("isSensitive(target)")
      const truncateAt = body.indexOf("truncate(")
      expect(sensitiveAt).toBeGreaterThan(-1)
      expect(truncateAt).toBeGreaterThan(sensitiveAt)
      expect(body.slice(sensitiveAt, truncateAt)).toContain("SECURE_MASK")
    }
  })
})
