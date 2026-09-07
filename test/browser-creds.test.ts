/**
 * test/browser-creds.test.ts — issue #248 multi-browser saved-login reader.
 *
 * The decrypt is exercised with an injected key against a self-encrypted v10
 * blob, so no login keychain is needed. The DB sweep (detectInstalledBrowsers /
 * listLogins / resolveLogin selection) runs against fabricated Login Data
 * SQLite stores under per-browser INTERCEPTOR_*_USER_DATA overrides, so no real
 * browser profile is touched. Two browsers (Chrome + Brave) are populated to
 * prove the reader is browser-agnostic and dynamic.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { pbkdf2Sync, createCipheriv } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BrowserCredsError, browserByKey, decryptPassword, detectInstalledBrowsers,
  hostMatches, listLogins, listProfiles, primeKeyForTest, resetKeyCache, resolveLogin,
} from "../daemon/browser-creds"

// A key derived like a browser's, but from a test passphrase — never the real one.
const testKey = pbkdf2Sync(Buffer.from("test-safe-storage"), Buffer.from("saltysalt"), 1003, 16, "sha1")
const iv = Buffer.alloc(16, 0x20)

function encryptV10(plaintext: string): Buffer {
  const c = createCipheriv("aes-128-cbc", testKey, iv)
  c.setAutoPadding(true)
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
  return Buffer.concat([Buffer.from("v10", "latin1"), body])
}

const chromeRoot = mkdtempSync(join(tmpdir(), "interceptor-chrome-test-"))
const braveRoot = mkdtempSync(join(tmpdir(), "interceptor-brave-test-"))

function seed(root: string, profiles: Record<string, Array<{ origin_url: string; username_value: string; password: string }>>) {
  for (const [profile, rows] of Object.entries(profiles)) {
    const pdir = join(root, profile)
    mkdirSync(pdir, { recursive: true })
    const db = new Database(join(pdir, "Login Data"))
    db.run("CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blank_password INTEGER DEFAULT 0)")
    const ins = db.prepare("INSERT INTO logins (origin_url, username_value, password_value, blank_password) VALUES (?, ?, ?, ?)")
    for (const r of rows) {
      const blank = r.password.length === 0 ? 1 : 0
      const blob = r.password.length ? encryptV10(r.password) : Buffer.alloc(0)
      ins.run(r.origin_url, r.username_value, blob, blank)
    }
    db.close()
  }
}

beforeAll(() => {
  process.env.INTERCEPTOR_CHROME_USER_DATA = chromeRoot
  process.env.INTERCEPTOR_BRAVE_USER_DATA = braveRoot
  // Point the other browsers at empty dirs so they are "not installed".
  for (const e of ["INTERCEPTOR_VIVALDI_USER_DATA", "INTERCEPTOR_EDGE_USER_DATA", "INTERCEPTOR_CHROMIUM_USER_DATA", "INTERCEPTOR_ARC_USER_DATA"]) {
    process.env[e] = mkdtempSync(join(tmpdir(), "interceptor-empty-"))
  }
  seed(chromeRoot, {
    Default: [
      { origin_url: "https://my.functionhealth.com/login", username_value: "pedram@example.com", password: "fh-secret-pw" },
      { origin_url: "https://accounts.google.com/", username_value: "pedram@gmail.com", password: "g-pw" },
    ],
    "Profile 22": [
      { origin_url: "https://sub.example.org/app", username_value: "u@example.org", password: "" }, // blank password
    ],
  })
  seed(braveRoot, {
    Default: [
      { origin_url: "https://my.functionhealth.com/", username_value: "brave-user@example.com", password: "brave-fh-pw" },
      { origin_url: "https://bravebank.example/", username_value: "b@example.com", password: "brave-only-pw" },
    ],
  })
  // Fixtures are encrypted with testKey; prime it so resolveLogin decrypts
  // without touching the real login keychain.
  resetKeyCache()
  primeKeyForTest("chrome", testKey)
  primeKeyForTest("brave", testKey)
})

afterAll(() => {
  for (const e of ["INTERCEPTOR_CHROME_USER_DATA", "INTERCEPTOR_BRAVE_USER_DATA", "INTERCEPTOR_VIVALDI_USER_DATA", "INTERCEPTOR_EDGE_USER_DATA", "INTERCEPTOR_CHROMIUM_USER_DATA", "INTERCEPTOR_ARC_USER_DATA"]) {
    delete process.env[e]
  }
  resetKeyCache()
  rmSync(chromeRoot, { recursive: true, force: true })
  rmSync(braveRoot, { recursive: true, force: true })
})

describe("v10 decrypt", () => {
  test("round-trips an AES-128-CBC v10 blob", () => {
    expect(decryptPassword(encryptV10("hunter2"), testKey)).toBe("hunter2")
    expect(decryptPassword(encryptV10(""), testKey)).toBe("")
  })
  test("empty blob decrypts to empty string", () => {
    expect(decryptPassword(Buffer.alloc(0), testKey)).toBe("")
  })
  test("rejects an app-bound / unsupported cipher prefix", () => {
    const bad = Buffer.concat([Buffer.from("v20", "latin1"), Buffer.from("garbage")])
    expect(() => decryptPassword(bad, testKey)).toThrow(BrowserCredsError)
    try { decryptPassword(bad, testKey) } catch (e) { expect((e as BrowserCredsError).code).toBe("unsupported_cipher") }
  })
  test("rejects a blob with no version prefix", () => {
    expect(() => decryptPassword(Buffer.from("plaintextish"), testKey)).toThrow(/unrecognized/)
  })
})

describe("host matching", () => {
  test("exact and subdomain match, nothing else", () => {
    expect(hostMatches("my.functionhealth.com", "my.functionhealth.com")).toBe(true)
    expect(hostMatches("a.my.functionhealth.com", "my.functionhealth.com")).toBe(true)
    expect(hostMatches("my.functionhealth.com", "functionhealth.com")).toBe(true)
    expect(hostMatches("evil.com", "my.functionhealth.com")).toBe(false)
    expect(hostMatches("notfunctionhealth.com", "functionhealth.com")).toBe(false)
  })
})

describe("browserByKey", () => {
  test("resolves a known browser and rejects an unknown one", () => {
    expect(browserByKey("brave").keychainService).toBe("Brave Safe Storage")
    expect(browserByKey("EDGE").key).toBe("edge")
    expect(() => browserByKey("firefox")).toThrow(BrowserCredsError)
    try { browserByKey("firefox") } catch (e) { expect((e as BrowserCredsError).code).toBe("unknown_browser") }
  })
})

describe("dynamic detection", () => {
  test("detectInstalledBrowsers finds only the seeded browsers", () => {
    const keys = detectInstalledBrowsers().map((b) => b.key).sort()
    expect(keys).toEqual(["brave", "chrome"])
  })
  test("listProfiles is per-browser, Default first", () => {
    expect(listProfiles(browserByKey("chrome"))[0]).toBe("Default")
    expect(listProfiles(browserByKey("chrome"))).toContain("Profile 22")
    expect(listProfiles(browserByKey("vivaldi"))).toEqual([])
  })
})

describe("cross-browser enumeration", () => {
  test("lists logins across both browsers, tagged by browser, no passwords", () => {
    const rows = listLogins()
    expect(rows.every((r) => !("password" in r) && !("value" in r))).toBe(true)
    expect(rows.some((r) => r.browser === "chrome")).toBe(true)
    expect(rows.some((r) => r.browser === "brave")).toBe(true)
    const blank = rows.find((r) => r.host === "sub.example.org")
    expect(blank?.hasPassword).toBe(false)
  })
  test("host filter narrows across browsers", () => {
    const rows = listLogins("functionhealth.com")
    expect(rows.map((r) => r.browser).sort()).toEqual(["brave", "chrome"])
  })
  test("browser filter restricts to one browser", () => {
    const rows = listLogins(undefined, "brave")
    expect(rows.every((r) => r.browser === "brave")).toBe(true)
    expect(rows.some((r) => r.host === "bravebank.example")).toBe(true)
  })
})

describe("resolveLogin", () => {
  test("username field returns the account, no decrypt", () => {
    const r = resolveLogin("accounts.google.com", "user")
    expect(r.value).toBe("pedram@gmail.com")
    expect(r.browser).toBe("chrome")
  })
  test("password decrypts from the named browser", () => {
    expect(resolveLogin("my.functionhealth.com", "pass", "brave").value).toBe("brave-fh-pw")
    expect(resolveLogin("my.functionhealth.com", "pass", "chrome").value).toBe("fh-secret-pw")
  })
  test("a brave-only host resolves without naming the browser", () => {
    const r = resolveLogin("bravebank.example", "pass")
    expect(r.value).toBe("brave-only-pw")
    expect(r.browser).toBe("brave")
  })
  test("throws not_found for a host with no saved login", () => {
    expect(() => resolveLogin("nonesuch.example", "pass")).toThrow(BrowserCredsError)
    try { resolveLogin("nonesuch.example", "pass") } catch (e) { expect((e as BrowserCredsError).code).toBe("not_found") }
  })
  test("skips a blank-password row (treated as no saved login)", () => {
    expect(() => resolveLogin("sub.example.org", "pass")).toThrow(/no saved login/)
  })
})
