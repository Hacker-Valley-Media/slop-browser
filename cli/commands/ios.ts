/**
 * cli/commands/ios.ts — `interceptor ios <sub>`.
 *
 * Drive any installed app on an owned, unlocked, Developer-Mode iPhone via our
 * own on-device InterceptorRunner (XCUITest), brokered by the daemon-resident
 * IosManager and addressed by `--context ios:<udid>`. Needs the daemon but NOT
 * the Swift bridge — the device channel is daemon-side (xcrun devicectl/simctl +
 * xcodebuild launch; the runner then dials back over WebSocket), so
 * `interceptor ios` works in browser-only mode too.
 */

import { sendCommand, type DaemonResponse, type DaemonResult } from "../transport"
import { runIosWebCommand } from "./ios-web"
import { runIosSvcCommand } from "./ios-svc"
import { runIosDevCommand } from "./ios-dev"
import { readSecretValue } from "../prompt"

/** Device-service introspection subcommands, delegated to ios-svc.ts. */
const IOS_SVC_SUBCOMMANDS = new Set(["diag", "logs", "fs", "crash", "profiles", "notify", "springboard"])

/** Instruments / telemetry / developer-service subcommands, delegated to ios-dev.ts. */
const IOS_DEV_SUBCOMMANDS = new Set(["proc", "ps", "top", "spawn", "kill", "location", "gpu", "shot", "backup", "screen", "axtree"])

type Action = { type: string; [key: string]: unknown }

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const v = args[idx + 1]
  if (!v || v.startsWith("--")) return undefined
  return v
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

/** Non-flag tokens from `start` on, skipping the operands of the listed value flags. */
function positionalsExcept(args: string[], start: number, valueFlags: string[]): string[] {
  const out: string[] = []
  for (let i = start; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { if (valueFlags.includes(a)) i++; continue }
    out.push(a)
  }
  return out
}

function numFlag(args: string[], flag: string): number | undefined {
  const v = flagValue(args, flag)
  if (v === undefined) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

async function send(action: Action, contextId?: string): Promise<DaemonResult> {
  try {
    const resp: DaemonResponse = await sendCommand(action, undefined, contextId)
    return resp.result
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function emit(result: DaemonResult, jsonMode: boolean): void {
  if (jsonMode) {
    const errPayload =
      result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? { error: result.error, ...(result.data as Record<string, unknown>) }
        : { error: result.error }
    console.log(JSON.stringify(result.success ? (result.data ?? null) : errPayload))
    return
  }
  if (!result.success) {
    console.error(`error: ${result.error || "unknown error"}`)
    return
  }
  const data = result.data
  if (data === undefined || data === null) console.log("ok")
  else if (typeof data === "string") console.log(data)
  else console.log(JSON.stringify(data, null, 2))
}

function emitExit(result: DaemonResult, jsonMode: boolean): void {
  emit(result, jsonMode)
  if (!result.success) process.exit(1)
}

// Progressive disclosure: before any phone has the agent, only the setup verbs
// are shown. Once a device is ready, the full automation surface appears.
const SETUP_HELP = `interceptor ios — automate your iPhone

Get started (requires Xcode signed in with your Apple ID) —   setup [<device>] [--team <id>] [--project <xcodeproj>]
                            build/sign + install + launch on your phone. Idempotent.
                            One-time Apple-mandated steps it will prompt for:
                              • plug in over USB, tap "Trust This Computer" (+ passcode)
                              • enable Developer Mode (Settings > Privacy & Security), reboot
                              • trust the certificate (Settings > General > VPN & Device Management)
  refresh [<device>]        force a re-sign now (also runs on a timer before expiry)

Experimental no-Xcode Apple-services path:
  login --apple-id <id> [--code <2fa>] [--stdin]   sign in; the password is read at a hidden prompt (or stdin). Token → Keychain. One time.
  logout                    drop the stored Apple-ID token

Operator path (prebuilt, needs Xcode/devicectl):
  install [<device>]        push the prebuilt agent to your iPhone (plugged in + unlocked)
  devices                   list iPhones that have the agent
  name <device> <alias>     give a phone a friendly name (e.g. "work")

Once installed, run 'interceptor ios' again to see the automation commands.`

const FULL_HELP = `interceptor ios — automate your iPhone

Setup:
  setup [<device>] [--team <id>]             Xcode self-service build/sign + install + launch
  refresh [<device>] [--team <id>]           re-sign now (also automatic before expiry)
  login --apple-id <id> [--stdin]            experimental no-Xcode Apple-services path (password at a hidden prompt)
  logout                                     drop the stored Apple-ID token
  install [<device>]                         push/refresh the prebuilt agent (operator path)
  devices                                    phones with the agent (+ names)
  name <device> <alias>                      rename a phone (use it with --on <alias>)

Drive a phone (add --on <name>, or it uses your only phone):
  tree    [--filter interactive|all|full]    on-screen elements (ref-tagged)
  find    --label "Send" [--role button]     find elements
  inspect <ref>                              element details
  click   <ref> | --x N --y N                tap
  type    <ref> "text" | --secret <name>     focus + type (a vault secret by name never shows the value)
  keys    "text" | --secret <name>           type into the focused field
  unlock  --secret <name> | --probe          lock screen: wake, swipe up, type the passcode (runner must be resident)
  scroll  [<ref>] --dir up|down|left|right   scroll
  drag    <from> <to>                        drag between elements
  press   home|lock|volume-up|volume-down    hardware button
  screenshot                                 capture the screen
  apps                                       installed apps
  app     launch|activate|terminate <id>     app lifecycle
  eval    "<js>" | --file <f.js>              run a JS program in the on-device brain (Interceptor.tree/tap/type/sleep/log/foreground)

Connection model (how the runner reaches the phone):
  • The phone runs an on-device XCUITest runner (InterceptorRunner) that DIALS IN
    to the daemon over WiFi. There is no persistent socket held open while idle.
  • 'devices' shows "connected: false" whenever the runner isn't actively dialed in.
    That is the NORMAL idle state for a correctly-installed phone — it means
    "installed, will auto-connect on the next verb", NOT "broken" or "offline".
  • You do NOT need to connect manually. Just run a verb — e.g.
    'interceptor ios tree --on <name>' — and the daemon launches the runner and
    the phone dials in. 'connected' flips to true for the life of that session.
  • 'ios unlock --secret ios-passcode' types the passcode into the lock screen while the
    runner is still resident (Auto-Lock off keeps it that way). After a reboot the runner
    cannot start on a locked phone: unlock once by hand, then drive as usual.
  • Keep the phone UNLOCKED and AWAKE while driving. Auto-lock / sleep tears the
    runner down (you'll see connected:false again and the next verb re-launches).
  • If a verb hangs or times out: confirm the phone is unlocked and reachable —
    'interceptor ios status' shows the live context plus the dial-back address the
    runner is handed (dialBack / dialBackVia); 'xcrun devicectl list devices'
    shows whether macOS sees it as "available". iOS silently blocks a backgrounded
    runner's LAN connection until Settings › Privacy & Security › Local Network
    grants InterceptorRunner-Runner, so the daemon prefers a VPN address (Tailscale)
    when the Mac has one — put the phone on the same VPN, or grant that switch once.

Troubleshooting — when things aren't working, try these IN ORDER:
  1. "device not found" / "not visible to usbmuxd" — the phone dropped off the
     Mac's device bus. Most common right after a device REBOOT: the whole tunnel
     rides usbmuxd, and its WiFi route is cleared on reboot even though
     'xcrun devicectl list devices' still shows the phone "available".
       → Plug the iPhone in by USB for ~10s (then you may unplug — WiFi resumes).
         This re-seeds usbmuxd instantly. Or restart it:
         'sudo launchctl kickstart -k system/com.apple.usbmuxd'.
  2. "Before First Unlock" — after a reboot, developer services stay locked until
     you enter the PASSCODE once (Face ID alone won't leave this state). Unlock
     with the passcode, then retry.
  2b. Runner verbs time out with 'timeout requesting channel …XCTestManager_IDEInterface'
     but Instruments (proc/top/shot) works — the FIRST XCUITest launch after a
     reboot pops an on-device dialog: "Enter iPhone Passcode for XCTest — Enable
     UI Automation". iOS gates the runner until you enter your passcode on it.
     Approve it, then restart the daemon (so it drops the stale testmanagerd
     session) and retry a verb.
  3. Verbs time out / Instruments (proc, top, shot) return nothing — the Developer
     Disk Image unmounts every boot. Re-mount it:
       'xcrun devicectl device info details --device <udid>'   (brings back
       testmanagerd/Instruments), then retry.
  4. Runner drops mid-sequence ('ios runner disconnected') — the runner dials in
     per session and iOS suspends its socket when it backgrounds to drive another
     app. Keep the phone UNLOCKED with Auto-Lock = Never (Settings › Display &
     Brightness › Auto-Lock), and run multi-step flows as a tight burst (don't let
     it idle between verbs). The next verb re-launches it automatically.
  5. Still stuck — capture detail with 'DEBUG_IOS=1 DBG=1' in the daemon env, and
     check 'interceptor ios status' (tunnel/connection) + 'interceptor ios devices'.

Phones connect automatically — no enable, no cable required once paired over WiFi.
Drives UI only: nothing can fake Face ID or Apple Pay. Passcode sheets are typed from the vault
('ios type <ref> --secret ios-passcode' after tapping "Enter Passcode"), and 'ios unlock --secret'
unlocks the lock screen while the runner is resident.`

export async function runIosCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; contextId?: string },
): Promise<void> {
  // filtered = ["ios", <sub>, ...args]
  const sub = filtered[1]
  const args = filtered
  const jsonMode = opts.jsonMode === true
  // `--on <name>` is the friendly device selector; `--context` still works.
  const contextId = opts.contextId ?? flagValue(filtered, "--on") ?? flagValue(filtered, "--context")

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    // Progressive disclosure: show the full surface only once a phone has the agent.
    const dev = await send({ type: "ios_devices" })
    const list = (dev.success && dev.data && typeof dev.data === "object") ? (dev.data as { devices?: unknown[] }).devices : undefined
    console.log(Array.isArray(list) && list.length > 0 ? FULL_HELP : SETUP_HELP)
    return
  }

  // ios web … — the WebKit-inspection lane. Delegated wholesale.
  if (sub === "web") { await runIosWebCommand(filtered, { jsonMode, contextId }); return }

  // ios diag|logs|fs|crash|profiles|notify|springboard — device-service
  // introspection lane. Runner-free classic Lockdown.
  if (sub && IOS_SVC_SUBCOMMANDS.has(sub)) { await runIosSvcCommand(filtered, { jsonMode, contextId }); return }

  // ios proc|top|spawn|kill|location|gpu|shot|backup|screen|axtree —
  // Instruments/DTX + telemetry + developer-service lanes. Runner-free.
  if (sub && IOS_DEV_SUBCOMMANDS.has(sub)) { await runIosDevCommand(filtered, { jsonMode, contextId }); return }

  // device ref for setup commands = first non-flag positional after the subcommand
  const deviceRef = args[2] && !args[2].startsWith("--") ? args[2] : undefined

  switch (sub) {
    case "install":
      emitExit(await send({ type: "ios_install", device: deviceRef }), jsonMode)
      return

    case "devices":
      emitExit(await send({ type: "ios_devices" }), jsonMode)
      return

    case "name": {
      const alias = args[3] && !args[3].startsWith("--") ? args[3] : undefined
      if (!deviceRef || !alias) { console.error("usage: interceptor ios name <device> <alias>"); process.exit(1) }
      emitExit(await send({ type: "ios_name", device: deviceRef, alias }), jsonMode)
      return
    }

    // ── self-service install (Apple-ID re-sign, no Xcode) ──────────────
    case "login": {
      // issue #244: the Apple ID password comes from a hidden prompt or stdin,
      // never argv (shell history, ps).
      const appleId = flagValue(args, "--apple-id") ?? flagValue(args, "--id")
      if (hasFlag(args, "--password") || hasFlag(args, "--pw")) {
        console.error("error: never pass the password on argv. Run 'interceptor ios login --apple-id <id>' and type it at the hidden prompt, or pipe it: printf '%s' \"$PW\" | interceptor ios login --apple-id <id> --stdin")
        process.exit(1)
      }
      const code = flagValue(args, "--code")
      if (!appleId) {
        console.error("usage: interceptor ios login --apple-id <id> [--code <2fa>] [--stdin]")
        process.exit(1)
      }
      const password = await readSecretValue(`Apple ID password for ${appleId}`, { stdin: hasFlag(args, "--stdin"), confirm: false })
      emitExit(await send({ type: "ios_login", appleId, password, code }), jsonMode)
      return
    }

    case "setup":
      emitExit(await send({
        type: "ios_setup",
        device: deviceRef,
        team: flagValue(args, "--team") ?? flagValue(args, "--team-id"),
        project: flagValue(args, "--project"),
      }), jsonMode)
      return

    case "refresh":
      emitExit(await send({
        type: "ios_refresh",
        device: deviceRef,
        team: flagValue(args, "--team") ?? flagValue(args, "--team-id"),
        project: flagValue(args, "--project"),
      }), jsonMode)
      return

    case "logout":
      emitExit(await send({ type: "ios_logout" }), jsonMode)
      return

    case "tunnel":
      // Legacy diagnostic. The no-Xcode launch path now brings up the userspace
      // CoreDeviceProxy tunnel inside ios enable/setup.
      emitExit(await send({ type: "ios_tunnel", device: deviceRef, service: flagValue(args, "--service"), rc: flagValue(args, "--rc") }), jsonMode)
      return

    case "discover":
      emitExit(await send({ type: "ios_discover" }), jsonMode)
      return

    case "enable": {
      // Mostly unnecessary now (verbs auto-connect). Kept for the --wda-url path.
      const udid = (args[2] && !args[2].startsWith("--") ? args[2] : flagValue(args, "--udid")) ?? contextId
      emitExit(await send({
        type: "ios_enable",
        udid,
        device: contextId,
        wdaUrl: flagValue(args, "--wda-url"),
        bundleId: flagValue(args, "--bundle") ?? flagValue(args, "--bundle-id"),
      }), jsonMode)
      return
    }

    case "disable": {
      const udid = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      emitExit(await send({ type: "ios_disable", udid, contextId }, contextId), jsonMode)
      return
    }

    case "status":
      emitExit(await send({ type: "ios_status" }), jsonMode)
      return

    case "fgdebug":
      emitExit(await send({ type: "ios_fgdebug" }, contextId), jsonMode)
      return

    case "eval": {
      // Lane D — the on-device JSCore brain. The script runs inside the runner's
      // JSContext with an `Interceptor` global (tree/tap/type/sleep/log/foreground),
      // so a whole observe→decide→act loop executes on the phone in one round-trip.
      const file = flagValue(args, "--file")
      const script = file ? await Bun.file(file).text() : (args[2] && !args[2].startsWith("--") ? args[2] : undefined)
      if (!script) { console.error('error: ios eval requires a script, e.g. ios eval "Interceptor.tap(200,400); Interceptor.log(Interceptor.foreground())"  (or --file loop.js)'); process.exit(1) }
      emitExit(await send({ type: "ios_eval", script }, contextId), jsonMode)
      return
    }

    case "tree":
      emitExit(await send({
        type: "ios_tree",
        all: hasFlag(args, "--all"),
        filter: flagValue(args, "--filter"),
      }, contextId), jsonMode)
      return

    case "find":
      emitExit(await send({
        type: "ios_find",
        label: flagValue(args, "--label"),
        query: flagValue(args, "--query") ?? (args[2] && !args[2].startsWith("--") ? args[2] : undefined),
        role: flagValue(args, "--role"),
      }, contextId), jsonMode)
      return

    case "inspect": {
      const ref = args[2]
      if (!ref || ref.startsWith("--")) { console.error("error: ios inspect requires a ref"); process.exit(1) }
      emitExit(await send({ type: "ios_inspect", ref }, contextId), jsonMode)
      return
    }

    case "click": {
      const ref = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      emitExit(await send({
        type: "ios_click", ref,
        x: numFlag(args, "--x"), y: numFlag(args, "--y"),
      }, contextId), jsonMode)
      return
    }

    case "type": {
      const ref = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      // issue #244: `--secret <name>` types a vault value by name (daemon-resolved).
      const secretName = flagValue(args, "--secret")
      if (hasFlag(args, "--secret")) {
        if (!secretName) { console.error("error: --secret requires a secret name"); process.exit(1) }
        // Every positional after the verb other than the ref is literal text, wherever it sits.
        const literals = positionalsExcept(args, 2, ["--secret", "--bundle", "--on", "--context"]).filter((p) => p !== ref)
        if (literals.length) { console.error("error: --secret and literal text are mutually exclusive"); process.exit(1) }
        emitExit(await send({ type: "ios_type", ref, secret: secretName, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
        return
      }
      // text is the last non-flag arg (or the only one when no ref is given)
      const text = ref ? (args[3] && !args[3].startsWith("--") ? args[3] : undefined) : (args[2] && !args[2].startsWith("--") ? args[2] : undefined)
      if (text === undefined) { console.error('error: ios type requires text, e.g. ios type e5 "hello"'); process.exit(1) }
      emitExit(await send({ type: "ios_type", ref: ref && args[3] !== undefined ? ref : undefined, text, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
      return
    }

    case "keys": {
      const secretName = flagValue(args, "--secret")
      if (hasFlag(args, "--secret")) {
        if (!secretName) { console.error("error: --secret requires a secret name"); process.exit(1) }
        if (positionalsExcept(args, 2, ["--secret", "--bundle", "--on", "--context"]).length) { console.error("error: --secret and literal text are mutually exclusive"); process.exit(1) }
        emitExit(await send({ type: "ios_keys", secret: secretName, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
        return
      }
      const text = args[2]
      if (!text || text.startsWith("--")) { console.error("error: ios keys requires text"); process.exit(1) }
      emitExit(await send({ type: "ios_keys", text, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
      return
    }

    // issue #244: unlock the lock screen with the passcode from the vault. The
    // resident runner wakes the phone, swipes up, and types into SpringBoard's
    // passcode field. `--probe` stops before typing and reports what it found.
    case "unlock": {
      const secretName = flagValue(args, "--secret")
      const probe = hasFlag(args, "--probe")
      if (!probe && (!secretName || hasFlag(args, "--secret") === false)) {
        console.error("error: ios unlock requires --secret <name> (or --probe to check the lock screen without typing)"); process.exit(1)
      }
      const action: Action = { type: "ios_unlock", probe }
      if (secretName) action.secret = secretName
      emitExit(await send(action, contextId), jsonMode)
      return
    }

    case "scroll": {
      const ref = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      emitExit(await send({ type: "ios_scroll", ref, dir: flagValue(args, "--dir") ?? "down" }, contextId), jsonMode)
      return
    }

    case "drag": {
      const from = args[2]
      const to = args[3]
      if (!from || !to || from.startsWith("--") || to.startsWith("--")) { console.error("error: ios drag requires <from> <to> refs"); process.exit(1) }
      emitExit(await send({ type: "ios_drag", from, to, duration: numFlag(args, "--duration") }, contextId), jsonMode)
      return
    }

    case "press": {
      const button = args[2]
      if (!button || button.startsWith("--")) { console.error("error: ios press requires home|lock|volume-up|volume-down"); process.exit(1) }
      emitExit(await send({ type: "ios_press", button }, contextId), jsonMode)
      return
    }

    case "screenshot": {
      const result = await send({ type: "ios_screenshot", targetMaxLongEdge: numFlag(args, "--target-max-long-edge") }, contextId)
      if (result.success && result.data && typeof result.data === "object") {
        const d = result.data as { dataUrl?: string; format?: string }
        if (d.dataUrl) {
          const base64 = d.dataUrl.split(",")[1] ?? ""
          const ext = d.format === "png" ? "png" : "jpg"
          const filename = `interceptor-ios-screenshot-${Date.now()}.${ext}`
          await Bun.write(filename, Buffer.from(base64, "base64"))
          const filePath = `${process.cwd()}/${filename}`
          if (jsonMode) console.log(JSON.stringify({ filePath, format: d.format }))
          else console.log(`saved: ${filePath}`)
          return
        }
      }
      emitExit(result, jsonMode)
      return
    }

    case "apps":
      emitExit(await send({ type: "ios_apps" }, contextId), jsonMode)
      return

    case "app": {
      const op = args[2]
      const bundleId = args[3]
      if (!op || !bundleId || op.startsWith("--") || bundleId.startsWith("--")) {
        console.error("error: ios app requires launch|activate|terminate <bundleId>"); process.exit(1)
      }
      emitExit(await send({ type: "ios_app", op, bundleId }, contextId), jsonMode)
      return
    }

    default:
      console.log(FULL_HELP)
  }
}
