/**
 * daemon/browser-creds.ts — read a Chromium browser's saved logins at rest
 * (issue #248; generalized from PR #247's Chrome-only reader).
 *
 * A Chromium browser does not fire its autofill dropdown for a synthetic/CDP
 * click, so the only reliable way to reuse a saved password is to read the
 * credential store directly. On macOS every Chromium browser keeps it at:
 *
 *   ~/Library/Application Support/<userDataDir>/<Profile>/Login Data   (SQLite)
 *
 * with each `password_value` blob encrypted under a per-user key kept in the
 * login keychain as the generic password "<Brand> Safe Storage". The macOS
 * scheme is identical across Chrome, Brave, Vivaldi, Edge, Chromium and Arc —
 * AES-128-CBC:
 *
 *   key = PBKDF2-HMAC-SHA1(safeStorageKey, salt="saltysalt", iters=1003, len=16)
 *   iv  = 16 bytes of 0x20 (space)
 *   ciphertext = blob after the 3-byte "v10" version prefix
 *
 * This is deliberately NOT AES-256-GCM (that is the Windows/Linux `v11` shape
 * and the newer app-bound scheme). We version-gate on the prefix and fail loud
 * on anything we do not recognize, rather than returning garbage.
 *
 * Only two facts vary per browser: the user-data directory and the keychain
 * "Safe Storage" service/account. Those live in the CHROMIUM_BROWSERS table.
 * Which browsers are *installed* is discovered dynamically by scanning disk for
 * a Login Data database — no browser is hardcoded as "the" browser. Enumerating
 * every "* Safe Storage" keychain item instead is not viable: that namespace is
 * shared with Electron apps (Slack, Discord, VS Code, …), and reading a key the
 * daemon is not yet approved for blocks on a GUI keychain prompt.
 *
 * Only the daemon ever touches this. The decrypted value is handed straight to
 * a delivery leg (daemon/index.ts deliverWithBrowserLogin) with `sensitive:true`
 * so it never reaches argv, logs, events, monitor artifacts, or MCP results.
 * The plaintext is never returned to a CLI/MCP caller — enumeration verbs
 * expose host + username + browser only.
 */

import { Database } from "bun:sqlite"
import { pbkdf2Sync, createDecipheriv } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

export type BrowserLoginField = "user" | "pass"

export class BrowserCredsError extends Error {
  constructor(public code: BrowserCredsErrorCode, message: string) {
    super(message)
    this.name = "BrowserCredsError"
  }
}
export type BrowserCredsErrorCode =
  | "unsupported_platform"
  | "no_browser_data"
  | "unknown_browser"
  | "keychain_denied"
  | "decrypt_failed"
  | "unsupported_cipher"
  | "not_found"
  | "host_mismatch"

/**
 * One Chromium-family browser. `key` is the stable CLI/API selector; `label`
 * is for humans; `userDataDir` is the path under ~/Library/Application Support;
 * `keychainService`/`keychainAccount` name the login-keychain Safe Storage item.
 * `overrideEnv` lets tests point the root at a fixture directory.
 */
export type ChromiumBrowser = {
  key: string
  label: string
  userDataDir: string
  keychainService: string
  keychainAccount: string
  overrideEnv: string
}

// The macOS crypto is identical across all of these; only the two strings
// (path + keychain name) differ. Add a browser by adding a row — no code path
// is browser-specific. Order is the deterministic search order when a fill does
// not name a browser (the tab's own brand is not knowable from a context yet).
export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { key: "chrome",   label: "Google Chrome",  userDataDir: "Google/Chrome",             keychainService: "Chrome Safe Storage",         keychainAccount: "Chrome",         overrideEnv: "INTERCEPTOR_CHROME_USER_DATA" },
  { key: "brave",    label: "Brave",          userDataDir: "BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage",        keychainAccount: "Brave",          overrideEnv: "INTERCEPTOR_BRAVE_USER_DATA" },
  { key: "vivaldi",  label: "Vivaldi",        userDataDir: "Vivaldi",                    keychainService: "Vivaldi Safe Storage",       keychainAccount: "Vivaldi",        overrideEnv: "INTERCEPTOR_VIVALDI_USER_DATA" },
  { key: "edge",     label: "Microsoft Edge", userDataDir: "Microsoft Edge",             keychainService: "Microsoft Edge Safe Storage", keychainAccount: "Microsoft Edge", overrideEnv: "INTERCEPTOR_EDGE_USER_DATA" },
  { key: "chromium", label: "Chromium",       userDataDir: "Chromium",                   keychainService: "Chromium Safe Storage",      keychainAccount: "Chromium",       overrideEnv: "INTERCEPTOR_CHROMIUM_USER_DATA" },
  { key: "arc",      label: "Arc",            userDataDir: "Arc/User Data",              keychainService: "Arc Safe Storage",           keychainAccount: "Arc",            overrideEnv: "INTERCEPTOR_ARC_USER_DATA" },
]

/** A saved-login record, without the password plaintext. */
export type BrowserLoginRecord = {
  browser: string
  profile: string
  originUrl: string
  host: string
  username: string
  hasPassword: boolean
}

const PBKDF2_SALT = "saltysalt"
const PBKDF2_ITERS = 1003
const PBKDF2_KEYLEN = 16
const CBC_IV = Buffer.alloc(16, 0x20)

export function browserByKey(key: string): ChromiumBrowser {
  const b = CHROMIUM_BROWSERS.find((x) => x.key === key.toLowerCase())
  if (!b) throw new BrowserCredsError("unknown_browser", `unknown browser '${key}' (${CHROMIUM_BROWSERS.map((x) => x.key).join(", ")})`)
  return b
}

/** Root of one browser's user-data directory, honoring the test override. */
export function userDataDir(browser: ChromiumBrowser): string {
  const override = process.env[browser.overrideEnv]
  if (override) return override
  const home = process.env.HOME
  if (!home) throw new BrowserCredsError("unsupported_platform", "no $HOME to locate the browser profile directory")
  if (process.platform !== "darwin") {
    throw new BrowserCredsError("unsupported_platform", "saved-login reading is implemented for macOS only")
  }
  return join(home, "Library", "Application Support", browser.userDataDir)
}

/** Profile directories that hold a Login Data database, "Default" first. */
export function listProfiles(browser: ChromiumBrowser): string[] {
  const root = userDataDir(browser)
  if (!existsSync(root)) return []
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const profiles = entries.filter((name) => name === "Default" || /^Profile /.test(name))
  const withDb = profiles.filter((name) => existsSync(join(root, name, "Login Data")))
  withDb.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })))
  return withDb
}

/**
 * Browsers that are actually installed AND hold at least one Login Data store.
 * This is the dynamic half: the table lists what a Chromium browser *could* be,
 * disk decides which ones exist here. Electron apps have a Safe Storage key but
 * no Login Data, so they self-exclude.
 */
export function detectInstalledBrowsers(): ChromiumBrowser[] {
  return CHROMIUM_BROWSERS.filter((b) => listProfiles(b).length > 0)
}

/** Fetch and derive the AES key from the login keychain. Cached per browser. */
const keyCache = new Map<string, Buffer>()
export function safeStorageKey(browser: ChromiumBrowser): Buffer {
  const hit = keyCache.get(browser.key)
  if (hit) return hit
  let raw: string
  try {
    raw = execFileSync("security", ["find-generic-password", "-wa", browser.keychainAccount, "-s", browser.keychainService], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch (err) {
    throw new BrowserCredsError(
      "keychain_denied",
      `could not read the "${browser.keychainService}" key from the login keychain (grant the daemon access, or unlock the keychain): ${(err as Error).message}`,
    )
  }
  if (!raw) throw new BrowserCredsError("keychain_denied", `the "${browser.keychainService}" keychain item is empty`)
  const key = pbkdf2Sync(Buffer.from(raw, "utf8"), Buffer.from(PBKDF2_SALT), PBKDF2_ITERS, PBKDF2_KEYLEN, "sha1")
  keyCache.set(browser.key, key)
  return key
}

/** For tests: clear the cached keys so new keys/overrides take effect. */
export function resetKeyCache(): void { keyCache.clear() }

/** For tests: prime a browser's derived key so resolveLogin can decrypt a
 * fixture blob without touching the real login keychain. */
export function primeKeyForTest(browserKey: string, key: Buffer): void { keyCache.set(browserKey, key) }

/**
 * Decrypt one `password_value` blob. Version-gates on the prefix: `v10` is the
 * macOS CBC shape we support; `v11`/`v20`/anything else is refused rather than
 * mis-decrypted.
 */
export function decryptPassword(blob: Buffer, key: Buffer): string {
  if (blob.length === 0) return ""
  const prefix = blob.length >= 3 ? blob.subarray(0, 3).toString("latin1") : ""
  if (prefix !== "v10") {
    // A blob with no recognized version prefix is either legacy plaintext
    // (pre-encryption) or a cipher we do not implement. Legacy rows are
    // vanishingly rare on macOS; treat an unknown prefix as unsupported.
    if (prefix.startsWith("v1") || prefix.startsWith("v2")) {
      throw new BrowserCredsError("unsupported_cipher", `unsupported Chromium cipher '${prefix}' (app-bound encryption); only macOS v10 (AES-128-CBC) is supported`)
    }
    throw new BrowserCredsError("unsupported_cipher", `unrecognized password blob (no v10 prefix)`)
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CBC_IV)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8")
  } catch (err) {
    throw new BrowserCredsError("decrypt_failed", `failed to decrypt a saved password (wrong key or corrupt blob): ${(err as Error).message}`)
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return "" }
}

/** The browser holds Login Data open; copy it and read the copy read-only. */
function withLoginDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "interceptor-browsercreds-"))
  const copy = join(dir, "Login Data")
  try {
    copyFileSync(dbPath, copy)
    const db = new Database(copy, { readonly: true })
    try { return fn(db) } finally { db.close() }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/** All saved-login rows for one browser (no passwords). */
function loginsForBrowser(browser: ChromiumBrowser, host: string | undefined, out: BrowserLoginRecord[]): void {
  const root = userDataDir(browser)
  for (const profile of listProfiles(browser)) {
    const dbPath = join(root, profile, "Login Data")
    let rows: Array<{ origin_url: string; username_value: string; pw_len: number }>
    try {
      // NOTE: the `logins` schema drifts across versions (e.g. older profiles
      // have no `blank_password` column). Depend only on columns that have been
      // stable for years: origin_url, username_value, password_value.
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
        browser: browser.key,
        profile,
        originUrl: r.origin_url,
        host: h,
        username: r.username_value ?? "",
        hasPassword: r.pw_len > 0,
      })
    }
  }
}

/**
 * List saved logins (no passwords) across the installed browsers, or one named
 * browser. If `host` is given, only rows whose origin host equals it (or is a
 * subdomain of it) are returned.
 */
export function listLogins(host?: string, browserKey?: string): BrowserLoginRecord[] {
  const browsers = browserKey ? [browserByKey(browserKey)] : detectInstalledBrowsers()
  const out: BrowserLoginRecord[] = []
  for (const b of browsers) loginsForBrowser(b, host, out)
  return out
}

/** A page host matches a requested host if equal or a subdomain of it. */
export function hostMatches(pageHost: string, requested: string): boolean {
  const a = pageHost.toLowerCase().replace(/\.$/, "")
  const b = requested.toLowerCase().replace(/\.$/, "")
  return a === b || a.endsWith(`.${b}`)
}

/**
 * Resolve the value for one field of the best saved login for `host`, across
 * the installed browsers (or one named browser). The caller (daemon) must have
 * already verified `host` matches the live page. Returns the decrypted
 * plaintext for delivery — never expose this to a caller.
 */
export function resolveLogin(host: string, field: BrowserLoginField, browserKey?: string): { value: string; username: string; browser: string; profile: string; originUrl: string } {
  const browsers = browserKey ? [browserByKey(browserKey)] : detectInstalledBrowsers()
  const candidates: Array<BrowserLoginRecord & { dbPath: string; b: ChromiumBrowser }> = []
  for (const b of browsers) {
    const root = userDataDir(b)
    for (const profile of listProfiles(b)) {
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
          candidates.push({ browser: b.key, profile, originUrl: r.origin_url, host: h, username: r.username_value ?? "", hasPassword: true, dbPath, b })
        }
      }
    }
  }
  if (candidates.length === 0) {
    const where = browserKey ? `'${browserKey}'` : "any installed browser"
    throw new BrowserCredsError("not_found", `no saved login for '${host}' in ${where} (interceptor browser creds list)`)
  }
  // Prefer an exact host match over a subdomain fallback; stable otherwise
  // (keeps the deterministic CHROMIUM_BROWSERS order for a cross-browser tie).
  candidates.sort((a, b) => Number(b.host === host) - Number(a.host === host))
  const best = candidates[0]

  if (field === "user") {
    return { value: best.username, username: best.username, browser: best.browser, profile: best.profile, originUrl: best.originUrl }
  }
  const blob = withLoginDb(best.dbPath, (db) => {
    const row = db.query("SELECT password_value FROM logins WHERE origin_url = ? AND username_value = ? LIMIT 1")
      .get(best.originUrl, best.username) as { password_value: Uint8Array } | undefined
    return row ? Buffer.from(row.password_value) : null
  })
  if (!blob) throw new BrowserCredsError("not_found", `saved login for '${host}' disappeared during read`)
  const value = decryptPassword(blob, safeStorageKey(best.b))
  return { value, username: best.username, browser: best.browser, profile: best.profile, originUrl: best.originUrl }
}
