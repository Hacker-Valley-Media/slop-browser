# Interceptor iOS — command catalog

Every command is `interceptor ios <sub> [args] [--on <name>] [--json]`. A phone is
addressed by alias (`--on phone`), by udid (`ios:<udid>`), or omitted when only one
phone is set up. Phones auto-connect on the first drive verb.

## Setup (one-time)

| Command | What it does |
|---|---|
| `interceptor ios setup [<device>] [--team <id>]` | Xcode self-service: build + sign + install + launch the runner using the Apple ID signed into Xcode. |
| `interceptor ios login --apple-id <id> --password <pw> [--code <2fa>]` | No-Xcode path: sign in with the user's own Apple ID (token stored in the Keychain, never the password). One time. |
| `interceptor ios logout` | Drop the stored Apple-ID token. |
| `interceptor ios refresh [<device>]` | Re-sign the installed runner now (also automatic before certificate expiry). |
| `interceptor ios install [<device>]` | Push / refresh the prebuilt agent (operator path). |
| `interceptor ios devices` | Phones with the agent installed, plus aliases, transport (USB/network), and iOS version. |
| `interceptor ios discover` | Full device discovery with toolchain + readiness notes. |
| `interceptor ios status` | Per-phone connection state: `connected` while driving, `disconnected` when installed but idle. |
| `interceptor ios name <device> <alias>` | Alias a phone so you can use `--on <alias>` (e.g. `--on phone`). |

## Drive verbs

| Command | What it does |
|---|---|
| `interceptor ios tree [--filter interactive\|all\|full]` | Ref-tagged element tree of the foreground app. Re-read before acting. |
| `interceptor ios find --label "Send" [--role button]` | Find elements by label and/or role; returns refs + frames. |
| `interceptor ios inspect <ref>` | Element details (type, label, enabled, frame). |
| `interceptor ios click <ref> \| --x N --y N` | Deterministic coordinate tap at the ref's frame center (or raw coordinates). |
| `interceptor ios type <ref> "text"` | Focus the field at `<ref>`, then type. Most reliable text entry — focus is atomic. |
| `interceptor ios keys "text"` | Type into whatever is already focused (append). |
| `interceptor ios type <ref> --secret <name>` / `ios keys --secret <name>` | Type a vault secret (passcode) by name; the daemon resolves it and the runner falls back to SpringBoard when a system passcode sheet owns the keyboard. Register once: `interceptor macos secret register ios-passcode --target ios`. |
| `interceptor ios unlock --secret <name>` / `ios unlock --probe` | Lock screen: wake, swipe up, type the passcode into SpringBoard's passcode field, wait for unlock. Needs the runner resident (it cannot start on a locked phone). `--probe` reports lock state + whether the passcode field appeared, without typing. |
| `interceptor ios scroll [<ref>] --dir up\|down\|left\|right` | Scroll the view (or the element at `<ref>`). |
| `interceptor ios drag <from> <to> [--duration s]` | Drag between two element refs (frame center to frame center). |
| `interceptor ios press home\|lock\|volume-up\|volume-down` | Hardware button. `lock` locks the phone (avoid mid-flow — it blocks launches). |
| `interceptor ios screenshot` | Capture the screen; saved as a VLM-budget-resized JPG. |
| `interceptor ios apps` | Installed apps on the phone (bundle id, name, version). |
| `interceptor ios app launch\|activate\|terminate <bundleId>` | App lifecycle by bundle id (e.g. `com.apple.Preferences`). |

## Runner-free lanes (Instruments / DTX / telemetry)

These reach the device over the RemoteXPC tunnel **without** the XCUITest runner, so
they work even when the runner is idle or asleep. Routed before the runner fallback.

| Command | What it does |
|---|---|
| `interceptor ios proc` | Live process list (Instruments deviceinfo). |
| `interceptor ios top [--follow]` | Per-process CPU/mem + per-core load (sysmontap). First real sample lands ~1.2 s in. |
| `interceptor ios gpu [--follow]` | FPS / GPU sampling (graphics.opengl). |
| `interceptor ios spawn <bundle> [--env K=V ...] [--arg X ...]` | Launch an app with env/args (processcontrol) → returns pid. |
| `interceptor ios kill <pid>` | Kill a process by pid. |
| `interceptor ios location set <lat> <lon>` / `location clear` | Simulate / clear the device GPS fix. |
| `interceptor ios shot [<out.png>]` | One-shot screenshot via Instruments (runner-free; falls back to the runner). |
| `interceptor ios backup` | mobilebackup2 handshake + protocol info. |
| `interceptor ios screen [--out <dir>] [--seconds N] [--fps F]` | Live screen frames (via the runner). |
| `interceptor ios axtree` | Runner-free accessibility probe (axAuditDaemon). |

## On-device JS brain

| Command | What it does |
|---|---|
| `interceptor ios eval "<js>" \| --file <f.js>` | Run a JS program inside the runner's JSContext. An `Interceptor` global bridges to the device: `tree()`, `tap(x,y)`, `type(text)`, `sleep(ms)`, `log(msg)`, `foreground()`. A whole observe→decide→act loop runs on the phone in **one round-trip**. `tree()` nodes carry `{label, type, rect:{x,y,width,height}, children[]}`; a `rect` center is directly tappable. |

## Other lanes

- `interceptor ios web <targets\|attach\|read\|text\|find\|eval\|call\|console\|network\|...>` — inspect/drive Safari & WKWebView content (WebInspector). `interceptor ios web --help`.
- `interceptor ios <logs\|diag\|fs\|crash\|profiles\|notify\|springboard>` — runner-free classic-Lockdown device services (diagnostics, syslog, AFC files, crash reports, profiles, Darwin notifications, SpringBoard). `interceptor ios <sub> --help`.

## Addressing

- `--on <alias>` — the friendly name set with `interceptor ios name`.
- `--context ios:<udid>` — explicit context id; also how `interceptor contexts` lists the phone.
- Omit both when exactly one phone is set up.

## Notes

- **Refs are coordinates, not handles.** They are re-minted on every `tree` read, so
  they never go stale the way server-side element ids do — but they only reflect the
  screen at read time. Re-read after any navigation.
- **Unlocked + foreground.** A locked phone refuses app launches. Keep Auto-Lock off so
  the runner stays resident; while connected, `ios unlock --secret <name>` attempts
  passcode entry and requires an observed unlocked state for success. Disconnected unlock
  and `--probe` fail immediately. Unlock once and run `ios tree` to connect first.
- **Passcodes come from the vault.** Nothing can fake Face ID or Apple Pay. A passcode sheet
  is typed with `ios type <ref> --secret <name>` / `ios keys --secret <name>`; never put a
  passcode in a literal `type` call. Register it once with
  `interceptor macos secret register <name> --target ios`.
- **After a device reboot.** The phone drops off usbmux (its Wi‑Fi route is cleared even though `xcrun devicectl list devices` still lists it) → a brief USB cable touch reseeds it. The first runner launch also pops an on-device *"Enter iPhone Passcode for XCTest — Enable UI Automation"* dialog; approve it, then a daemon restart clears the stale testmanagerd session. Runner-free lanes (`proc`/`shot`) keep working through all of this.
- **Runner never registers (`did not register within 120s`).** The error names the address the runner was handed and the rung that chose it (`ios status` → `dialBack` / `dialBackVia`). A local-network address (rungs `interface`, `subnet`, `default-route`, `first`) is silently denied while the runner's Local Network privilege is still undetermined: XCTest backgrounds the runner before it dials, and iOS denies a backgrounded app's local-network connection without showing the alert (TN3179). Once Settings › Privacy & Security › Local Network shows InterceptorRunner-Runner switched on, LAN dial-back registers in about 10 s. Fixes: grant that switch, or put the phone and Mac on the same VPN (Tailscale), which the daemon prefers automatically (`dialBackVia: vpn`). `INTERCEPTOR_WS_URL` overrides the ladder.
- **Away from home (phone on cellular + VPN only).** Not driveable: iOS does not expose lockdown (62078) or RemotePairing (49152) on the VPN interface (`Connection refused`), so usbmuxd cannot see the phone and no runner can be launched. A computer next to the phone (USB or its Wi-Fi) must run the daemon. Runner-free lanes are equally blocked.
- Add `--json` to any command for machine-readable output.
