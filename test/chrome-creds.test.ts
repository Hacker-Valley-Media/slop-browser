/**
 * test/chrome-creds.test.ts — issue #248 Chrome saved-login reader.
 *
 * The decrypt is exercised with an injected key against a self-encrypted v10
 * blob, so no login keychain is needed. The DB sweep (listLogins / resolveLogin
 * username selection) runs against a fabricated Login Data SQLite under an
 * INTERCEPTOR_CHROME_USER_DATA override, so no real Chrome profile is touched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { pbkdf2Sync, createCipheriv } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ChromeCredsError, decryptPassword, hostMatches, listLogins, listProfiles, resolveLogin,
} from "../daemon/chrome-creds"

// A key derived like Chrome's, but from a test passphrase — never the real one.
const testKey = pbkdf2Sync(Buffer.from("test-safe-storage"), Buffer.from("saltysalt"), 1003, 16, "sha1")
const iv = Buffer.alloc(16, 0x20)

function encryptV10(plaintext: string): Buffer {
  const c = createCipheriv("aes-128-cbc", testKey, iv)
  c.setAutoPadding(true)
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
  return Buffer.concat([Buffer.from("v10", "latin1"), body])
}

const root = mkdtempSync(join(tmpdir(), "interceptor-chrome-test-"))

beforeAll(() => {
  process.env.INTERCEPTOR_CHROME_USER_DATA = root
  for (const [profile, rows] of Object.entries({
    Default: [
      { origin_url: "https://my.functionhealth.com/login", username_value: "pedram@example.com", password: "fh-secret-pw" },
      { origin_url: "https://accounts.google.com/", username_value: "pedram@gmail.com", password: "g-pw" },
    ],
    "Profile 22": [
      { origin_url: "https://my.functionhealth.com/", username_value: "ai-browser@example.com", password: "fh-profile22" },
      { origin_url: "https://sub.example.org/app", username_value: "u@example.org", password: "" }, // blank password
    ],
  })) {
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
})

afterAll(() => {
  delete process.env.INTERCEPTOR_CHROME_USER_DATA
  rmSync(root, { recursive: true, force: true })
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
    expect(() => decryptPassword(bad, testKey)).toThrow(ChromeCredsError)
    try { decryptPassword(bad, testKey) } catch (e) { expect((e as ChromeCredsError).code).toBe("unsupported_cipher") }
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

describe("profile + login enumeration", () => {
  test("finds both profiles, Default first", () => {
    const profs = listProfiles(root)
    expect(profs[0]).toBe("Default")
    expect(profs).toContain("Profile 22")
  })
  test("lists logins across profiles without passwords", () => {
    const rows = listLogins(undefined, root)
    expect(rows.length).toBe(4)
    expect(rows.every((r) => !("password" in r) && !("value" in r))).toBe(true)
    const blank = rows.find((r) => r.host === "sub.example.org")
    expect(blank?.hasPassword).toBe(false)
  })
  test("host filter narrows to matching origins", () => {
    const rows = listLogins("functionhealth.com", root)
    expect(rows.map((r) => r.host).sort()).toEqual(["my.functionhealth.com", "my.functionhealth.com"])
  })
})

describe("resolveLogin", () => {
  test("username field returns the account, no decrypt", () => {
    const r = resolveLogin("accounts.google.com", "user", root)
    expect(r.value).toBe("pedram@gmail.com")
    expect(r.username).toBe("pedram@gmail.com")
  })
  test("throws not_found for a host with no saved login", () => {
    expect(() => resolveLogin("nonesuch.example", "pass", root)).toThrow(ChromeCredsError)
    try { resolveLogin("nonesuch.example", "pass", root) } catch (e) { expect((e as ChromeCredsError).code).toBe("not_found") }
  })
  test("skips a blank-password row (treated as no saved login)", () => {
    // sub.example.org has only a blank-password row.
    expect(() => resolveLogin("sub.example.org", "pass", root)).toThrow(/no saved Chrome login/)
  })
})
