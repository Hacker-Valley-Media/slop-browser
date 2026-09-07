/**
 * test/nmh-locations.test.ts
 *
 * Where each browser's native-messaging host manifest lives, per platform.
 *
 * This is the table `interceptor diagnose` uses to catch a binary mismatch (the
 * daemon the CLI talks to vs the one the browser would spawn), so a wrong or
 * missing entry makes the diagnostic silently blind for that browser rather
 * than noisy. Three shapes have to stay right at once:
 *
 *   macOS   ~/Library/Application Support/<vendor>/NativeMessagingHosts
 *   Linux   $XDG_CONFIG_HOME/<product>/NativeMessagingHosts   (Chromium family)
 *   Linux   ~/.mozilla/native-messaging-hosts                 (Gecko — NOT XDG,
 *                                                              and one dir for
 *                                                              every profile)
 *
 * The platform and env are injected, so every case runs on any host.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installedNmhManifests } from "../cli/lib/status-renderer"

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "interceptor-nmh-")) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function writeManifest(relativeDir: string): void {
  const dir = join(home, relativeDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "com.interceptor.host.json"), JSON.stringify({ path: "/opt/interceptor/daemon/interceptor-daemon" }), "utf-8")
}

const linuxEnv = () => ({ HOME: home })

describe("installedNmhManifests — Linux", () => {
  test("finds the Chromium-family browsers under the XDG config home", () => {
    writeManifest(".config/google-chrome/NativeMessagingHosts")
    writeManifest(".config/chromium/NativeMessagingHosts")
    writeManifest(".config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    const found = installedNmhManifests("linux", linuxEnv()).map(m => m.browser).sort()
    expect(found).toEqual(["brave", "chrome", "chromium"])
  })

  test("finds Firefox under ~/.mozilla, which is not an XDG path", () => {
    writeManifest(".mozilla/native-messaging-hosts")
    const found = installedNmhManifests("linux", linuxEnv())
    expect(found).toEqual([
      { browser: "firefox", manifestFile: join(home, ".mozilla/native-messaging-hosts/com.interceptor.host.json") },
    ])
  })

  test("honors XDG_CONFIG_HOME for the Chromium family but not for Firefox", () => {
    const xdg = join(home, "custom-config")
    mkdirSync(join(xdg, "chromium", "NativeMessagingHosts"), { recursive: true })
    writeFileSync(join(xdg, "chromium", "NativeMessagingHosts", "com.interceptor.host.json"), "{}", "utf-8")
    writeManifest(".mozilla/native-messaging-hosts")
    // A manifest at the DEFAULT ~/.config location must not be found once
    // XDG_CONFIG_HOME points elsewhere — that would be a false positive.
    writeManifest(".config/google-chrome/NativeMessagingHosts")

    const found = installedNmhManifests("linux", { HOME: home, XDG_CONFIG_HOME: xdg }).map(m => m.browser).sort()
    expect(found).toEqual(["chromium", "firefox"])
  })

  test("no manifests installed → empty, not a throw", () => {
    expect(installedNmhManifests("linux", linuxEnv())).toEqual([])
  })
})

describe("installedNmhManifests — macOS", () => {
  test("uses the Application Support layout and the macOS browser set", () => {
    writeManifest("Library/Application Support/Google/Chrome/NativeMessagingHosts")
    writeManifest("Library/Application Support/Google/Chrome Canary/NativeMessagingHosts")
    writeManifest("Library/Application Support/Vivaldi/NativeMessagingHosts")
    const found = installedNmhManifests("darwin", { HOME: home }).map(m => m.browser).sort()
    expect(found).toEqual(["chrome", "chrome-canary", "vivaldi"])
  })

  test("the Linux layout is not consulted on darwin", () => {
    writeManifest(".config/google-chrome/NativeMessagingHosts")
    writeManifest(".mozilla/native-messaging-hosts")
    expect(installedNmhManifests("darwin", { HOME: home })).toEqual([])
  })
})

describe("installedNmhManifests — Windows", () => {
  test("returns nothing: Windows registers native hosts in the registry", () => {
    writeManifest(".config/google-chrome/NativeMessagingHosts")
    expect(installedNmhManifests("win32", { HOME: home })).toEqual([])
  })
})

describe("installedNmhManifests — no HOME", () => {
  test("returns empty rather than scanning from the filesystem root", () => {
    expect(installedNmhManifests("linux", {})).toEqual([])
    expect(installedNmhManifests("darwin", {})).toEqual([])
  })
})
