import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLockFile, writeLockFile, clearLockFile, clearDaemonRuntimeFiles, type LockFileData } from "../daemon/lifecycle"

// Lock-file contract: a metadata record for `interceptor diagnose`,
// written only by the singleton-gate winner, cleared on every shutdown path.
// NOT a duplicate-prevention mechanism — that's the WS-port bind (#104).

const LOCK: LockFileData = {
  pid: 4242,
  version: "0.22.1",
  execPath: "/opt/homebrew/bin/interceptor-daemon",
  startedAt: "2026-07-03T00:00:00.000Z",
  socketPath: "/tmp/interceptor.sock",
  wsPort: 19222,
  mode: "standalone",
}

// installedNmhManifests() scans the platform's real native-messaging layout:
// ~/Library/Application Support/<vendor dir> on macOS, $XDG_CONFIG_HOME (or
// ~/.config) on Linux, and a different browser set on each. Build fixtures in
// whichever shape the host uses so the same assertions hold on both.
const IS_LINUX = process.platform === "linux"
const NMH_ROOT_REL = IS_LINUX ? ".config" : "Library/Application Support"
const NMH_DIRS: Record<string, string> = IS_LINUX
  ? { chrome: "google-chrome", brave: "BraveSoftware/Brave-Browser" }
  : { chrome: "Google/Chrome", brave: "BraveSoftware/Brave-Browser", "chrome-canary": "Google/Chrome Canary" }
// A configurable browser other than the one the primary cases use, so
// "non-default browser" coverage stays meaningful on both platforms.
const SECOND_BROWSER = IS_LINUX ? "chrome" : "chrome-canary"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "interceptor-lock-test-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lock file helpers", () => {
  test("write → read roundtrip", () => {
    const lockPath = join(dir, "interceptor.lock")
    writeLockFile(lockPath, LOCK)
    expect(readLockFile(lockPath)).toEqual(LOCK)
  })

  test("absent file reads as null", () => {
    expect(readLockFile(join(dir, "nope.lock"))).toBeNull()
  })

  test("corrupt file reads as null", () => {
    const lockPath = join(dir, "interceptor.lock")
    writeFileSync(lockPath, "{not json", "utf-8")
    expect(readLockFile(lockPath)).toBeNull()
  })

  test("clearLockFile removes the file and is idempotent", () => {
    const lockPath = join(dir, "interceptor.lock")
    writeLockFile(lockPath, LOCK)
    clearLockFile(lockPath)
    expect(existsSync(lockPath)).toBe(false)
    clearLockFile(lockPath) // second clear must not throw
  })

  test("clearDaemonRuntimeFiles unlinks the lock alongside pid + socket", () => {
    const unlinked: string[] = []
    clearDaemonRuntimeFiles(
      {
        unlinkSync(path: string) { unlinked.push(path) },
        pidPath: "/tmp/i.pid",
        lockPath: "/tmp/i.lock",
        socketPath: "/tmp/i.sock",
        isWin: false,
        log() {},
      },
      "test",
    )
    expect(unlinked).toEqual(["/tmp/i.sock", "/tmp/i.pid", "/tmp/i.lock"])
  })
})

describe("binary mismatch detection", () => {
  // installedNmhManifests + detectBinaryMismatches read $HOME — point it at a
  // fixture home per test. Restore afterwards so other tests are unaffected.
  const realHome = process.env.HOME
  afterEach(() => { process.env.HOME = realHome })

  function fixtureHome(manifests: Record<string, { path?: string } | "corrupt">): string {
    const home = join(dir, "home")
    const dirs = NMH_DIRS
    for (const [browser, content] of Object.entries(manifests)) {
      if (!dirs[browser]) continue
      const nmhDir = join(home, NMH_ROOT_REL, dirs[browser], "NativeMessagingHosts")
      mkdirSync(nmhDir, { recursive: true })
      writeFileSync(
        join(nmhDir, "com.interceptor.host.json"),
        content === "corrupt" ? "{not json" : JSON.stringify(content),
        "utf-8",
      )
    }
    process.env.HOME = home
    return home
  }

  async function detect(lock: LockFileData | null) {
    const { detectBinaryMismatches } = await import("../cli/commands/diagnose")
    return detectBinaryMismatches(lock)
  }

  test("matching manifest path → no mismatch", async () => {
    fixtureHome({ chrome: { path: LOCK.execPath } })
    expect(await detect(LOCK)).toEqual([])
  })

  test("differing manifest path → mismatch with browser + both paths", async () => {
    fixtureHome({ chrome: { path: "/Users/dev/Projects/interceptor/daemon/interceptor-daemon" } })
    expect(await detect(LOCK)).toEqual([
      {
        browser: "chrome",
        manifestPath: "/Users/dev/Projects/interceptor/daemon/interceptor-daemon",
        runningPath: LOCK.execPath,
      },
    ])
  })

  test("covers non-default browsers from the install.sh set", async () => {
    fixtureHome({
      brave: { path: LOCK.execPath },
      [SECOND_BROWSER]: { path: "/stale/dev/build" },
    })
    const mismatches = await detect(LOCK)
    expect(mismatches).toEqual([
      { browser: SECOND_BROWSER, manifestPath: "/stale/dev/build", runningPath: LOCK.execPath },
    ])
  })

  test("corrupt or pathless manifests are skipped, no lock → no detection", async () => {
    fixtureHome({ chrome: "corrupt", brave: {} })
    expect(await detect(LOCK)).toEqual([])
    expect(await detect(null)).toEqual([])
  })
})

describe("context-kind-aware probes", () => {
  // ios:/cdp: contexts must never be probed with browser verbs — presence in
  // the contexts list is the liveness signal. The early return means these
  // calls complete without any daemon connection (which is also what lets
  // this test run daemon-less).
  test("ios: context reports kind ios, connected, no extension probe", async () => {
    const { probeContext } = await import("../cli/commands/diagnose")
    const probe = await probeContext("ios:00008150")
    expect(probe).toEqual({
      contextId: "ios:00008150",
      kind: "ios",
      extension: { reachable: true },
      tab: null,
      elements: null,
    })
  })

  test("cdp: context reports kind cdp", async () => {
    const { probeContext } = await import("../cli/commands/diagnose")
    const probe = await probeContext("cdp:some-app")
    expect(probe.kind).toBe("cdp")
    expect(probe.extension.reachable).toBe(true)
  })
})

describe("interceptor diagnose (spawned, no daemon)", () => {
  test("--json reports daemon down + mismatch from fixtures, never spawns a daemon", () => {
    const home = join(dir, "home")
    const nmhDir = join(home, NMH_ROOT_REL, NMH_DIRS.chrome, "NativeMessagingHosts")
    mkdirSync(nmhDir, { recursive: true })
    writeFileSync(join(nmhDir, "com.interceptor.host.json"), JSON.stringify({ path: "/somewhere/else" }), "utf-8")

    const lockPath = join(dir, "interceptor.lock")
    writeLockFile(lockPath, LOCK)
    const pidPath = join(dir, "interceptor.pid") // never created — daemon down

    const proc = Bun.spawnSync(["bun", "cli/index.ts", "diagnose", "--json"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: home,
        INTERCEPTOR_LOCK_PATH: lockPath,
        INTERCEPTOR_PID_PATH: pidPath,
        INTERCEPTOR_SOCKET_PATH: join(dir, "interceptor.sock"),
      },
    })

    expect(proc.exitCode).toBe(0)
    const snap = JSON.parse(proc.stdout.toString())
    expect(snap.daemon.running).toBe(false)
    expect(snap.binaryMismatches).toEqual([
      { browser: "chrome", manifestPath: "/somewhere/else", runningPath: LOCK.execPath },
    ])
    expect(snap.contexts).toEqual([])
    // NO_DAEMON contract: diagnose must never auto-spawn
    expect(existsSync(pidPath)).toBe(false)
  })
})
