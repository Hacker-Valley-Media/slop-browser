/**
 * test/helpers/macos-tools.ts — availability probes for the base-macOS command
 * line tools some daemon/ios code shells out to.
 *
 * The iOS surface only ever runs on a macOS host (usbmux, codesign, Xcode), so
 * `daemon/ios/*` is free to call /usr/bin/plutil and /usr/bin/security directly.
 * Their tests inherit that dependency. On a Linux host — a Linux port build, or
 * CI running the suite in a container — those binaries do not exist and the
 * affected tests fail with "Executable not found in $PATH" rather than telling
 * anyone anything about the code.
 *
 * Gate on the tool, not on `process.platform`: that keeps the tests running
 * anywhere the dependency is actually satisfied, and keeps the skip reason
 * honest.
 */

import { existsSync } from "node:fs"

// Probe the absolute paths the daemon/ios code actually invokes. Do NOT probe by
// spawning: Bun's spawnSync reports a missing executable as exit status 127 with
// `error` left undefined, so the obvious `result.error === undefined` check
// reports every tool as present on a host that has none of them.
function toolExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** Apple's property-list converter — used to build/validate real bplist00 bytes. */
export const HAS_PLUTIL = toolExists("/usr/bin/plutil")

/** Apple's keychain CLI — used by daemon/ios/keychain.ts to store the Apple-ID token. */
export const HAS_SECURITY = toolExists("/usr/bin/security")
