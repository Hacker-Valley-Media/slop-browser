/**
 * daemon/chrome-creds.ts — read Chrome's saved logins at rest (issue #248).
 *
 * Chrome does not fire its autofill dropdown for a synthetic/CDP click, so the
 * only reliable way to reuse a saved password is to read the credential store
 * directly. On macOS that store is:
 *
 *   ~/Library/Application Support/Google/Chrome/<Profile>/Login Data   (SQLite)
 *
 * with each `password_value` blob encrypted under a per-user key kept in the
 * login keychain as the generic password "Chrome Safe Storage" (account
 * "Chrome"). The macOS scheme is AES-128-CBC:
 *
 *   key = PBKDF2-HMAC-SHA1(safeStorageKey, salt="saltysalt", iters=1003, len=16)
 *   iv  = 16 bytes of 0x20 (space)
 *   ciphertext = blob after the 3-byte "v10" version prefix
 *
 * This is deliberately NOT AES-256-GCM (that is the Windows/Linux `v11` shape
 * and the newer app-bound scheme). We version-gate on the prefix and fail loud
 * on anything we do not recognize, rather than returning garbage.
 *
 * Only the daemon ever touches this. The decrypted value is handed straight to
 * a delivery leg (daemon/index.ts deliverWithChromeLogin) with `sensitive:true`
 * so it never reaches argv, logs, events, monitor artifacts, or MCP results.
 * The plaintext is never returned to a CLI/MCP caller — enumeration verbs
 * expose host + username only.
 */

import { Database } from "bun:sqlite"
import { pbkdf2Sync, createDecipheriv } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

export type ChromeLoginField = "user" | "pass"

export class ChromeCredsError extends Error {
  constructor(public code: ChromeCredsErrorCode, message: string) {
    super(message)
    this.name = "ChromeCredsError"
  }
}
export type ChromeCredsErrorCode =
  | "unsupported_platform"
  | "no_chrome_data"
  | "keychain_denied"
  | "decrypt_failed"
  | "unsupported_cipher"
  | "not_found"
  | "host_mismatch"

/** A saved-login record, without the password plaintext. */
export type ChromeLoginRecord = {
  profile: string
  originUrl: string
  host: string
  username: string
  hasPassword: boolean
}

const SAFE_STORAGE_SERVICE = "Chrome Safe Storage"
const SAFE_STORAGE_ACCOUNT = "Chrome"
const PBKDF2_SALT = "saltysalt"
const PBKDF2_ITERS = 1003
const PBKDF2_KEYLEN = 16
const CBC_IV = Buffer.alloc(16, 0x20)

/** Root of the Chrome user-data directory, honoring an override for tests. */
export function chromeUserDataDir(): string {
  const override = process.env.INTERCEPTOR_CHROME_USER_DATA
  if (override) return override
  const home = process.env.HOME
  if (!home) throw new ChromeCredsError("unsupported_platform", "no $HOME to locate the Chrome profile directory")
  if (process.platform !== "darwin") {
    throw new ChromeCredsError("unsupported_platform", "chrome saved-login reading is implemented for macOS only")
  }
  return join(home, "Library", "Application Support", "Google", "Chrome")
}

/** Profile directories that hold a Login Data database, "Default" first. */
export function listProfiles(root = chromeUserDataDir()): string[] {
  if (!existsSync(root)) throw new ChromeCredsError("no_chrome_data", `no Chrome user-data directory at ${root}`)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    throw new ChromeCredsError("no_chrome_data", `cannot read the Chrome user-data directory: ${(err as Error).message}`)
  }
  const profiles = entries.filter((name) => name === "Default" || /^Profile /.test(name))
  const withDb = profiles.filter((name) => existsSync(join(root, name, "Login Data")))
  withDb.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })))
  return withDb
}

/** Fetch and derive the AES key from the login keychain. Cached per process. */
let cachedKey: Buffer | null = null
export function safeStorageKey(): Buffer {
  if (cachedKey) return cachedKey
  let raw: string
  try {
    raw = execFileSync("security", ["find-generic-password", "-wa", SAFE_STORAGE_ACCOUNT, "-s", SAFE_STORAGE_SERVICE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch (err) {
    throw new ChromeCredsError(
      "keychain_denied",
      `could not read the "${SAFE_STORAGE_SERVICE}" key from the login keychain (grant the daemon access, or unlock the keychain): ${(err as Error).message}`,
    )
  }
  if (!raw) throw new ChromeCredsError("keychain_denied", `the "${SAFE_STORAGE_SERVICE}" keychain item is empty`)
  cachedKey = pbkdf2Sync(Buffer.from(raw, "utf8"), Buffer.from(PBKDF2_SALT), PBKDF2_ITERS, PBKDF2_KEYLEN, "sha1")
  return cachedKey
}

/** For tests: clear the cached key so a new key/override takes effect. */
export function resetKeyCache(): void { cachedKey = null }

/**
 * Decrypt one `password_value` blob. Version-gates on the prefix: `v10` is the
 * macOS CBC shape we support; `v11`/`v20`/anything else is refused rather than
 * mis-decrypted.
 */
export function decryptPassword(blob: Buffer, key = safeStorageKey()): string {
  if (blob.length === 0) return ""
  const prefix = blob.length >= 3 ? blob.subarray(0, 3).toString("latin1") : ""
  if (prefix !== "v10") {
    // A blob with no recognized version prefix is either legacy plaintext
    // (pre-encryption Chrome) or a cipher we do not implement. Legacy rows are
    // vanishingly rare on macOS; treat an unknown prefix as unsupported.
    if (prefix.startsWith("v1") || prefix.startsWith("v2")) {
      throw new ChromeCredsError("unsupported_cipher", `unsupported Chrome cipher '${prefix}' (app-bound encryption); only macOS v10 (AES-128-CBC) is supported`)
    }
    throw new ChromeCredsError("unsupported_cipher", `unrecognized Chrome password blob (no v10 prefix)`)
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CBC_IV)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8")
  } catch (err) {
    throw new ChromeCredsError("decrypt_failed", `failed to decrypt a Chrome password (wrong key or corrupt blob): ${(err as Error).message}`)
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return "" }
}

/** Chrome holds Login Data open; copy it and read the copy read-only. */
function withLoginDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "interceptor-chrome-"))
  const copy = join(dir, "Login Data")
  try {
    copyFileSync(dbPath, copy)
    const db = new Database(copy, { readonly: true })
    try { return fn(db) } finally { db.close() }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * List saved logins (no passwords). If `host` is given, only rows whose origin
 * host equals it (or is a subdomain of it) are returned.
 */
export function listLogins(host?: string, root = chromeUserDataDir()): ChromeLoginRecord[] {
  const out: ChromeLoginRecord[] = []
  for (const profile of listProfiles(root)) {
    const dbPath = join(root, profile, "Login Data")
    let rows: Array<{ origin_url: string; username_value: string; pw_len: number }>
    try {
      // NOTE: the `logins` schema drifts across Chrome versions (e.g. older
      // profiles have no `blank_password` column). Depend only on columns that
      // have been stable for years: origin_url, username_value, password_value.
      rows = withLoginDb(dbPath, (db) =>
        db.query("SELECT origin_url, username_value, length(password_value) AS pw_len FROM logins").all() as any[],
      )
    } catch {
      continue // a profile whose DB is unreadable should not sink the whole sweep
    }
    for (const r of rows) {
      const h = hostOf(r.origin_url)
      if (!h) continue
      if (host && !hostMatches(h, host)) continue
      out.push({
        profile,
        originUrl: r.origin_url,
        host: h,
        username: r.username_value ?? "",
        hasPassword: r.pw_len > 0,
      })
    }
  }
  return out
}

/** A page host matches a requested host if equal or a subdomain of it. */
export function hostMatches(pageHost: string, requested: string): boolean {
  const a = pageHost.toLowerCase().replace(/\.$/, "")
  const b = requested.toLowerCase().replace(/\.$/, "")
  return a === b || a.endsWith(`.${b}`)
}

/**
 * Resolve the value for one field of the best saved login for `host`. The
 * caller (daemon) must have already verified `host` matches the live page.
 * Returns the decrypted plaintext for delivery — never expose this to a caller.
 */
export function resolveLogin(host: string, field: ChromeLoginField, root = chromeUserDataDir()): { value: string; username: string; profile: string; originUrl: string } {
  const candidates: Array<ChromeLoginRecord & { dbPath: string }> = []
  for (const profile of listProfiles(root)) {
    const dbPath = join(root, profile, "Login Data")
    let rows: Array<{ origin_url: string; username_value: string; pw_len: number }>
    try {
      rows = withLoginDb(dbPath, (db) =>
        db.query("SELECT origin_url, username_value, length(password_value) AS pw_len FROM logins").all() as any[],
      )
    } catch { continue }
    for (const r of rows) {
      const h = hostOf(r.origin_url)
      if (h && hostMatches(h, host) && r.pw_len > 0) {
        candidates.push({ profile, originUrl: r.origin_url, host: h, username: r.username_value ?? "", hasPassword: true, dbPath })
      }
    }
  }
  if (candidates.length === 0) {
    throw new ChromeCredsError("not_found", `no saved Chrome login for '${host}' (interceptor chrome creds list)`)
  }
  // Prefer an exact host match over a subdomain fallback; stable otherwise.
  candidates.sort((a, b) => Number(b.host === host) - Number(a.host === host))
  const best = candidates[0]

  if (field === "user") {
    return { value: best.username, username: best.username, profile: best.profile, originUrl: best.originUrl }
  }
  const blob = withLoginDb(best.dbPath, (db) => {
    const row = db.query("SELECT password_value FROM logins WHERE origin_url = ? AND username_value = ? LIMIT 1")
      .get(best.originUrl, best.username) as { password_value: Uint8Array } | undefined
    return row ? Buffer.from(row.password_value) : null
  })
  if (!blob) throw new ChromeCredsError("not_found", `saved login for '${host}' disappeared during read`)
  const value = decryptPassword(blob)
  return { value, username: best.username, profile: best.profile, originUrl: best.originUrl }
}
