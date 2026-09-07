/**
 * test/install-modes.test.ts
 *
 * Asserts the two install modes produce the expected step lists under
 * INSTALL_DRY_RUN=1 (or --dry-run). These tests do NOT modify any system
 * state — they shell out to scripts/install.sh with the dry-run flag and
 * inspect its stdout.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const INSTALL_SCRIPT = resolve(REPO_ROOT, "scripts/install.sh")

/** True on macOS; flips test expectations from `~/Library/...` paths to `~/.config/...`. */
const IS_DARWIN = process.platform === "darwin"

/**
 * Platform-specific NM-dir substring the dry-run output should contain for Chrome.
 *
 * macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`
 * Linux: `~/.config/google-chrome/NativeMessagingHosts`
 */
const CHROME_NM_SUBSTR = IS_DARWIN ? "Google/Chrome/NativeMessagingHosts" : "google-chrome/NativeMessagingHosts"

/**
 * Platform-specific NM-dir substring the dry-run output should contain for Brave.
 *
 * macOS: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts`
 * Linux: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts`
 */
const BRAVE_NM_SUBSTR = IS_DARWIN
  ? "BraveSoftware/Brave-Browser/NativeMessagingHosts"
  : ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"

// Chromium é alvo só-Linux nesta revisão (o install.sh o adiciona na fase-2 do port). NM dir:
// `~/.config/chromium/NativeMessagingHosts`.
const CHROMIUM_NM_SUBSTR = "chromium/NativeMessagingHosts"

/**
 * Whether a browser binary/app is detectable on this platform.
 *
 * Mirrors the `browser_installed` helper in scripts/install.sh — looks for the
 * `.app` bundle on macOS and any candidate binary on `$PATH` on Linux. Tests
 * that need a specific browser to be auto-detected skip themselves when it's
 * absent so CI without browsers installed stays green.
 */
function browserInstalled(target: "chrome" | "brave" | "edge" | "vivaldi" | "chromium"): boolean {
  if (IS_DARWIN) {
    if (target === "chromium") return false // chromium é alvo só-Linux neste teste (port fase-2)
    const apps: Record<"chrome" | "brave" | "edge" | "vivaldi", string> = {
      chrome: "/Applications/Google Chrome.app",
      brave: "/Applications/Brave Browser.app",
      edge: "/Applications/Microsoft Edge.app",
      vivaldi: "/Applications/Vivaldi.app",
    }
    return spawnSync("test", ["-d", apps[target]]).status === 0
  }
  // Edge / Vivaldi on Linux are out of scope in this revision (a follow-up).
  // chrome, brave e chromium têm detecção de instalação no Linux (chromium veio na fase-2 do port).
  if (target === "edge" || target === "vivaldi") return false
  const candidates =
    target === "chrome"
      ? ["google-chrome", "google-chrome-stable"]
      : target === "chromium"
        ? ["chromium", "chromium-browser"]
        : ["brave-browser", "brave"]
  return candidates.some(b => spawnSync("command", ["-v", b], { shell: true }).status === 0)
}

/**
 * Run scripts/install.sh in dry-run mode and capture stdout/stderr/exit status.
 *
 * Sets both `--dry-run` and `INSTALL_DRY_RUN=1` so the script never mutates
 * the filesystem or installs native-messaging manifests during tests.
 */
function runInstallDryRun(args: string[]): { stdout: string; status: number; stderr: string } {
  const proc = spawnSync("bash", [INSTALL_SCRIPT, "--dry-run", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, INSTALL_DRY_RUN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  })
  return {
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
    status: proc.status ?? -1,
  }
}

describe("install modes — dry-run", () => {
  test("--browser-only prints browser steps but never bridge steps", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--chrome"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode: browser-only")
    expect(stdout).toContain("Browser: chrome")
    expect(stdout).toContain("DRY RUN")
    expect(stdout).toContain("[browser] Generating native messaging manifest")
    expect(stdout).toContain("[browser] Installing native messaging symlink")
    expect(stdout).toContain("Done. Installed in browser-only mode.")

    // The bridge MUST NOT be referenced in the browser-only step list. The
    // browser-only contract is that browser-only installs never mention
    // LaunchAgent or install-bridge.sh in their executed steps.
    expect(stdout).not.toContain("install-bridge.sh")
    expect(stdout).not.toContain("com.interceptor.bridge.plist")
    expect(stdout).not.toContain("[bridge]")
  })

  test.skipIf(!IS_DARWIN)("--full prints both browser steps and bridge steps", () => {
    const { stdout, status } = runInstallDryRun(["--full", "--chrome"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode: full")
    expect(stdout).toContain("Browser: chrome")
    expect(stdout).toContain("DRY RUN")
    expect(stdout).toContain("[browser] Generating native messaging manifest")
    expect(stdout).toContain("[browser] Installing native messaging symlink")
    expect(stdout).toContain("[bridge] Chaining into install-bridge.sh")
    expect(stdout).toContain("com.interceptor.bridge.plist")
    expect(stdout).toContain("DRY-RUN complete (full mode)")
  })

  test("--browser-only and --full are mutually exclusive", () => {
    const { status, stderr } = runInstallDryRun(["--browser-only", "--full"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("mutually exclusive")
  })

  test("unknown flags exit non-zero with usage hint", () => {
    const { status, stderr } = runInstallDryRun(["--bogus-flag"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("Unknown flag")
  })

  test("--browser-only --skip-extension still does only browser steps", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--chrome", "--skip-extension"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode: browser-only")
    expect(stdout).toContain("Skipping extension loading")
    expect(stdout).not.toContain("install-bridge.sh")
  })

  test("non-interactive (no flags) defaults to platform-appropriate mode", () => {
    // With INSTALL_DRY_RUN=1 the script picks the platform default rather than
    // blocking on stdin. On Darwin → full, elsewhere → browser-only.
    const { stdout, status } = runInstallDryRun([])
    expect(status).toBe(0)
    if (process.platform === "darwin") {
      expect(stdout).toContain("Mode: full")
    } else {
      expect(stdout).toContain("Mode: browser-only")
    }
  })
})

describe("install platform routing — dry-run", () => {
  test("dry-run output matches the platform's NM dir convention", () => {
    if (!browserInstalled("chrome") && !browserInstalled("brave")) return
    const target = browserInstalled("chrome") ? "chrome" : "brave"
    const { stdout, status } = runInstallDryRun(["--browser-only", `--${target}`])
    expect(status).toBe(0)

    if (IS_DARWIN) {
      // macOS: ~/Library/Application Support/<vendor>/<product>/NativeMessagingHosts
      expect(stdout).toContain("Library/Application Support")
      expect(stdout).not.toContain(".config/")
    } else {
      // Linux: ~/.config/<product>/NativeMessagingHosts
      expect(stdout).toContain(".config/")
      expect(stdout).not.toContain("Library/Application Support")
    }
  })

  test.skipIf(IS_DARWIN)("--full mode is rejected on non-Darwin platforms", () => {
    const { stderr, status } = runInstallDryRun(["--full", "--chrome"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("--full mode is macOS only")
  })
})

describe("install browser selection — dry-run", () => {
  test.skipIf(!browserInstalled("chrome"))("--chrome installs only the Chrome native-messaging path", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--chrome"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: chrome")
    expect(stdout).toContain(CHROME_NM_SUBSTR)
    expect(stdout).not.toContain(BRAVE_NM_SUBSTR)
  })

  test.skipIf(!browserInstalled("brave"))("--brave installs only the Brave native-messaging path", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--brave"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: brave")
    expect(stdout).toContain(BRAVE_NM_SUBSTR)
    expect(stdout).not.toContain(CHROME_NM_SUBSTR)
  })

  test("non-interactive default (no --chrome/--brave) auto-selects an installed browser", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only"])
    expect(status).toBe(0)
    // Two valid auto-select paths:
    //   1. Both browsers installed → script prints "defaulting to 'chrome' (non-interactive, first installed)"
    //   2. Only one installed     → script prints "Browser: <X> (only supported browser found)"
    const hasBoth = browserInstalled("chrome") && browserInstalled("brave")
    if (hasBoth) {
      expect(stdout).toContain("defaulting to 'chrome' (non-interactive")
      expect(stdout).toContain("Browser: chrome")
      expect(stdout).toContain(CHROME_NM_SUBSTR)
      expect(stdout).not.toContain(BRAVE_NM_SUBSTR)
    } else if (browserInstalled("chrome")) {
      // Either "only supported browser found" or the non-interactive default —
      // both are valid auto-selections of the single installed browser. (The
      // install script's detection can differ from browserInstalled() on CI
      // runners, so assert the outcome, not the exact phrasing.)
      expect(stdout).toMatch(/only supported browser found|defaulting to 'chrome' \(non-interactive/)
      expect(stdout).toContain("Browser: chrome")
      expect(stdout).toContain(CHROME_NM_SUBSTR)
    } else if (browserInstalled("brave")) {
      expect(stdout).toMatch(/only supported browser found|defaulting to 'brave' \(non-interactive/)
      expect(stdout).toContain("Browser: brave")
      expect(stdout).toContain(BRAVE_NM_SUBSTR)
    } else if (browserInstalled("chromium")) {
      // Chromium-only host (Linux; chromium virou alvo de primeira classe na fase-2 do port), então
      // o install.sh auto-seleciona chromium em vez de abortar.
      expect(stdout).toMatch(/only supported browser found|defaulting to 'chromium' \(non-interactive/)
      expect(stdout).toContain("Browser: chromium")
      expect(stdout).toContain(CHROMIUM_NM_SUBSTR)
    } else {
      // No browser installed — script aborts before NM resolution. Documented exit path.
      expect(status).not.toBe(0)
    }
  })
})

/**
 * coverage for the Edge + Vivaldi vendors added by PR #75.
 *
 * Both browsers are macOS-only in this revision (Linux support deferred to a
 * follow-up). Each test is gated on Darwin so CI on Linux
 * stays green, and on the `.app` bundle's presence so a maintainer Mac without
 * Edge/Vivaldi installed also stays green.
 *
 * Evidence the paths come from:
 *   - Edge macOS NM dir:    derived from chrome-extensions docs/extensions/
 *                           develop/concepts/native-messaging.md:70 +
 *                           Microsoft's published Edge User Data dir
 *                           (~/Library/Application Support/Microsoft Edge).
 *   - Vivaldi macOS NM dir: same rule + Vivaldi's User Data dir
 *                           (~/Library/Application Support/Vivaldi).
 *   - manifest `key` field at extension/manifest.json:9 pins the extension ID
 *                           deterministically across Chromium vendors per
 *                           manifest/key.md:10,18.
 */
describe("install browser selection — Edge + Vivaldi (Darwin)", () => {
  test.skipIf(!IS_DARWIN || !browserInstalled("edge"))(
    "--edge dry-run targets Microsoft Edge NM dir on macOS",
    () => {
      const { stdout, status } = runInstallDryRun(["--browser-only", "--edge"])
      expect(status).toBe(0)
      expect(stdout).toContain("Browser: edge")
      expect(stdout).toContain("Library/Application Support/Microsoft Edge/NativeMessagingHosts")
      // Chrome and Brave paths must NOT leak into Edge output.
      expect(stdout).not.toContain("Google/Chrome/NativeMessagingHosts")
      expect(stdout).not.toContain("Brave-Browser/NativeMessagingHosts")
    }
  )

  test.skipIf(!IS_DARWIN || !browserInstalled("vivaldi"))(
    "--vivaldi dry-run targets Vivaldi NM dir on macOS",
    () => {
      const { stdout, status } = runInstallDryRun(["--browser-only", "--vivaldi"])
      expect(status).toBe(0)
      expect(stdout).toContain("Browser: vivaldi")
      expect(stdout).toContain("Library/Application Support/Vivaldi/NativeMessagingHosts")
      expect(stdout).not.toContain("Google/Chrome/NativeMessagingHosts")
      expect(stdout).not.toContain("Brave-Browser/NativeMessagingHosts")
    }
  )

  // --edge / --vivaldi must be ACCEPTED as flags even when the corresponding
  // .app isn't installed (the user gets the NM-symlink step; the dry-run
  // prints what WOULD have been done). The flag-parser regression here is
  // important: PR #75 added these flags but kept install detection optional.
  test.skipIf(!IS_DARWIN)("--edge flag is accepted (no install detection required)", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--edge"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: edge")
  })

  test.skipIf(!IS_DARWIN)("--vivaldi flag is accepted (no install detection required)", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--vivaldi"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: vivaldi")
  })
})

/**
 * branded-Chromium `--load-extension` flow assertion.
 *
 * Chrome and Edge both ignore --load-extension in their branded desktop
 * builds; the script must surface the developer-flow remediation rather
 * than launch a no-op. Tested under --dry-run so we don't actually launch
 * a browser.
 *
 * NB: the "branded build ignores --load-extension" remediation block
 * lives inside `load_extension()` past the DRY_RUN early-return, so the
 * dry-run path doesn't currently exercise this branch. We instead grep
 * the script source for the exact remediation message — a cheap and
 * deterministic regression assertion that catches accidental removal
 * of the Edge case.
 */
describe("install branded-Chromium messaging — static checks", () => {
  test("install.sh prints branded-build remediation for Chrome (all channels) AND Edge", () => {
    const src = require("node:fs").readFileSync(INSTALL_SCRIPT, "utf8")
    // Single block; all branded Chrome channels + Edge are handled together.
    // (#98 wrapped the condition across lines, so assert each token rather than
    // the combined single-line literal.)
    expect(src).toContain('"$target" == "chrome"')
    expect(src).toContain('"$target" == "chrome-beta"')
    expect(src).toContain('"$target" == "chrome-canary"')
    expect(src).toContain('"$target" == "chrome-dev"')
    expect(src).toContain('"$target" == "edge"')
    expect(src).toContain("ignores --load-extension in branded desktop builds")
    // Developer flow URL substitution must be present for Edge.
    expect(src).toMatch(/SCHEMA="edge"/)
  })
})

/**
 * install.ps1 carries the Edge native-messaging registry key.
 *
 * We can't run PowerShell from macOS CI, but a static grep on the .ps1
 * source catches accidental removal of the Edge key. Path shape per
 * native-messaging.md:64 (vendor-substituted: Google → Microsoft, Chrome → Edge).
 */
describe("install.ps1 — Edge registry key", () => {
  test("install.ps1 contains the Edge NativeMessagingHosts registry key", () => {
    const psScript = resolve(REPO_ROOT, "scripts/install.ps1")
    const src = require("node:fs").readFileSync(psScript, "utf8")
    expect(src).toMatch(/HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com\.interceptor\.host/)
  })
})
