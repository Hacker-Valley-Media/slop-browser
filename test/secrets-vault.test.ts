/**
 * test/secrets-vault.test.ts — issue #244 vault rules.
 *
 * Round-trips through the REAL login keychain under a throwaway service name
 * (same posture as test/ios-keychain.test.ts), keeps metadata in a temp file,
 * and exercises the pure rules: names, gates, targets, unlock windows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BunSecretsVault, SecretError, assertName, describeTarget, isUnlocked, listSecrets, loadMeta, lock, openUnlock, openUnlocks,
  parseDuration, parseGate, parseTargets, removeSecret, resolveSecret, storeSecret, targetAllowed, type Vault,
} from "../daemon/secrets"

const dir = mkdtempSync(join(tmpdir(), "interceptor-secrets-"))
const metaPath = join(dir, "secrets.json")
const vault = new BunSecretsVault("com.interceptor.secrets.test")
const noGate = async () => ({ ok: true })

beforeAll(async () => { await vault.delete("roundtrip"); await vault.delete("gated") })
afterAll(async () => {
  await vault.delete("roundtrip"); await vault.delete("gated")
  rmSync(dir, { recursive: true, force: true })
})

// O bloco de round-trip usa o keychain REAL do SO (Bun.secrets → Keychain no macOS, libsecret/
// Secret Service no Linux). Num container/CI headless não há Secret Service, então `set` lança e o
// bloco é PULADO (mesma postura env-dependente do ios-keychain no port Linux) em vez de falhar.
// `delete` engole o erro (retorna false), então a sonda usa `set`, que lança sem backend.
const KEYCHAIN_OK: boolean = await (async () => {
  try {
    await vault.set("__probe__", "x")
    await vault.delete("__probe__")
    return true
  } catch {
    return false
  }
})()

describe("names, gates, targets, durations", () => {
  test("names are bounded and safe", () => {
    expect(assertName("admin")).toBe("admin")
    expect(assertName("ios-passcode.v2_x")).toBe("ios-passcode.v2_x")
    expect(() => assertName("")).toThrow(SecretError)
    expect(() => assertName("-leading")).toThrow(SecretError)
    expect(() => assertName("has space")).toThrow(SecretError)
    expect(() => assertName("a".repeat(65))).toThrow(SecretError)
    expect(() => assertName(42)).toThrow(SecretError)
  })

  test("gate defaults to none (unattended) and rejects unknown values", () => {
    expect(parseGate(undefined)).toBe("none")
    expect(parseGate("")).toBe("none")
    expect(parseGate("touchid")).toBe("touchid")
    expect(parseGate("biometry")).toBe("biometry")
    expect(() => parseGate("face")).toThrow(SecretError)
  })

  test("targets parse, dedupe, and default to any", () => {
    expect(parseTargets(undefined)).toEqual(["any"])
    expect(parseTargets("sudo,macos:com.apple.SecurityAgent, browser:Example.COM")).toEqual(["sudo", "macos:com.apple.SecurityAgent", "browser:example.com"])
    expect(parseTargets(["ios", "ios", "SUDO"])).toEqual(["ios", "sudo"])
    expect(() => parseTargets("windows:x")).toThrow(SecretError)
    expect(() => parseTargets("macos:")).toThrow(SecretError)
  })

  test("durations", () => {
    expect(parseDuration("30m")).toBe(1800)
    expect(parseDuration("2h")).toBe(7200)
    expect(parseDuration("90s")).toBe(90)
    expect(parseDuration("45")).toBe(45)
    expect(parseDuration(120)).toBe(120)
    expect(() => parseDuration("soon")).toThrow(SecretError)
  })

  test("target matching table", () => {
    const t = ["sudo", "macos:com.apple.SecurityAgent", "browser:example.com"]
    expect(targetAllowed(t, { kind: "sudo" })).toBe(true)
    expect(targetAllowed(t, { kind: "ios" })).toBe(false)
    expect(targetAllowed(t, { kind: "macos", id: "com.apple.securityagent" })).toBe(true)
    expect(targetAllowed(t, { kind: "macos", id: "com.apple.finder" })).toBe(false)
    expect(targetAllowed(t, { kind: "browser", id: "example.com" })).toBe(true)
    expect(targetAllowed(t, { kind: "browser", id: "login.example.com" })).toBe(true)
    expect(targetAllowed(t, { kind: "browser", id: "notexample.com" })).toBe(false)
    expect(targetAllowed(t, { kind: "browser", id: "evil.com" })).toBe(false)
    expect(targetAllowed(["any"], { kind: "browser", id: "evil.com" })).toBe(true)
    expect(targetAllowed(["macos:*"], { kind: "macos", id: "com.x.y" })).toBe(true)
    expect(targetAllowed(["browser:*"], { kind: "browser", id: "x.y" })).toBe(true)
    // reveal is never target-checked (it is always OS-gated instead)
    expect(targetAllowed(["sudo"], { kind: "reveal" })).toBe(true)
    expect(describeTarget({ kind: "browser", id: "a.b" })).toContain("a.b")
  })
})

describe("unlock windows", () => {
  test("open, check, expire, lock", () => {
    const now = 1_000_000
    expect(isUnlocked("w", now)).toBe(false)
    openUnlock("w", 60, now)
    expect(isUnlocked("w", now + 59_000)).toBe(true)
    expect(isUnlocked("w", now + 61_000)).toBe(false)
    openUnlock("w", 60, now)
    openUnlock("v", 60, now)
    expect(openUnlocks(now).map((u) => u.name).sort()).toEqual(["v", "w"])
    expect(lock("w")).toEqual(["w"])
    expect(lock()).toEqual(["v"])
    expect(openUnlocks(now)).toEqual([])
  })
})

describe.skipIf(!KEYCHAIN_OK)("store, list, resolve, remove (real keychain, throwaway service)", () => {
  test("round trip with metadata and release accounting", async () => {
    const meta = await storeSecret(vault, "roundtrip", "hunter2-value", { targets: "sudo,browser:example.com", metaPath })
    expect(meta.gate).toBe("none")
    expect(meta.targets).toEqual(["sudo", "browser:example.com"])
    expect(meta.releases).toBe(0)

    const file = JSON.parse(readFileSync(metaPath, "utf-8"))
    expect(JSON.stringify(file)).not.toContain("hunter2-value")
    expect(file.secrets.roundtrip.targets).toEqual(["sudo", "browser:example.com"])

    const listed = listSecrets(metaPath)
    expect(listed.map((s) => s.name)).toEqual(["roundtrip"])
    expect(JSON.stringify(listed)).not.toContain("hunter2-value")

    let gateCalls = 0
    const res = await resolveSecret(vault, "roundtrip", { kind: "sudo" }, { gate: async () => { gateCalls++; return { ok: true } }, metaPath })
    expect(res.value).toBe("hunter2-value")
    expect(res.gated).toBe(false)
    expect(gateCalls).toBe(0)
    expect(loadMeta(metaPath).secrets.roundtrip.releases).toBe(1)

    await expect(resolveSecret(vault, "roundtrip", { kind: "browser", id: "evil.com" }, { gate: noGate, metaPath })).rejects.toMatchObject({ code: "target_denied" })
    await expect(resolveSecret(vault, "missing", { kind: "sudo" }, { gate: noGate, metaPath })).rejects.toMatchObject({ code: "not_found" })

    // update keeps createdAt and releases, changes gate/targets
    const updated = await storeSecret(vault, "roundtrip", "new-value", { gate: "touchid", targets: ["any"], metaPath })
    expect(updated.createdAt).toBe(meta.createdAt)
    expect(updated.releases).toBe(1)
    expect(updated.gate).toBe("touchid")

    expect(await removeSecret(vault, "roundtrip", metaPath)).toBe(true)
    expect(listSecrets(metaPath)).toEqual([])
    expect(await vault.get("roundtrip")).toBeNull()
  })

  test("empty value and bad gate are refused before touching the keychain", async () => {
    const calls: string[] = []
    const spy: Vault = { backend: "spy", set: async (n) => { calls.push(n) }, get: async () => null, delete: async () => true }
    await expect(storeSecret(spy, "x", "", { metaPath })).rejects.toMatchObject({ code: "vault_error" })
    await expect(storeSecret(spy, "x", "v", { gate: "retina", metaPath })).rejects.toMatchObject({ code: "invalid_gate" })
    expect(calls).toEqual([])
  })
})
