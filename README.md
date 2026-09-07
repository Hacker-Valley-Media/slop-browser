<p align="center">
  <img src="docs/assets/interceptor-logo-square.png" alt="Interceptor logo" width="180">
</p>

<h1 align="center">Interceptor</h1>

<p align="center">
  <strong>AI agents use your real browser and macOS apps like a human would.</strong>
</p>

<p align="center">
  No CDP. No separate automated browser. No starting from zero.
</p>

<p align="center">
  <a href="#install-in-60-seconds"><strong>Install</strong></a>
  ·
  <a href="#quick-start"><strong>Quick Start</strong></a>
  ·
  <a href="#the-two-surfaces"><strong>Pick a Surface</strong></a>
  ·
  <a href="#surface-1-interceptor-browser"><strong>Browser</strong></a>
  ·
  <a href="#surface-2-interceptor-macos"><strong>macOS</strong></a>
  ·
  <a href="ARCHITECTURE.md"><strong>Architecture</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Hacker-Valley-Media/Interceptor?label=release" alt="Latest release">
  <img src="https://img.shields.io/github/license/Hacker-Valley-Media/Interceptor" alt="License">
  <img src="https://img.shields.io/badge/macOS-supported-black?logo=apple" alt="macOS supported">
  <img src="https://img.shields.io/badge/Chrome%2C%20Brave%20%26%20Safari-supported-4285F4?logo=googlechrome" alt="Chrome, Brave, and Safari supported">
</p>

![Interceptor running cinematic overlays on top of a live website](docs/assets/interceptor-cook-mode.jpg)

Interceptor gives agents human-style control of the tools you already use — **computer-use** for the native macOS apps on your desktop, **browser-use** for the web apps in your browser. Work happens in both places, so Interceptor meets you in the middle. One CLI, two product surfaces:

- **Interceptor Browser** — runs as a WebExtension inside your actual Chrome, Brave, or Safari session. Your cookies, sessions, logins, and tabs stay intact. Read pages, click, type, navigate, observe network traffic, automate rich editors, record-and-replay user flows.
- **Interceptor macOS** — runs as a Swift bridge daemon. Drives native macOS apps the same way: structured accessibility trees, OS-level trusted input, on-device vision/speech/NLP, system-wide event monitoring.
- **Interceptor iOS** — drives any installed app on an owned, unlocked, Developer-Mode iPhone via an on-device XCUITest runner that dials into the daemon over the network (`interceptor ios status` shows the address it was handed as `dialBack`/`dialBackVia`; a VPN address is preferred, and LAN works once the runner is allowed under Settings › Privacy & Security › Local Network): ref-tagged element trees, deterministic coordinate taps, reliable text entry, screenshots, and app lifecycle. Plus runner-free **Instruments/telemetry** (`ios proc / top / spawn / kill / location / gpu / shot`), an **on-device JS brain** (`ios eval` — a whole observe→decide→act loop runs on the phone in one round-trip), **WebKit inspection** (`ios web`), and classic-Lockdown **device services** (`ios logs / diag / fs / crash / profiles`). Addressed as `--on <phone>` / `ios:<udid>`. See `interceptor ios help`.

The agent calls `interceptor` CLI commands, reads the output, and decides what to do next. No MCP required. No API keys required.

> **Warning**
> Interceptor gives agents real autonomy over your browser and apps. Treat it like an agent, not a toy script runner.

## Why Interceptor Exists

Most browser automation stacks start a separate browser and talk to it through DevTools. That is fine until the site notices, your authenticated context disappears, or your agent has to relearn a workflow from scratch.

Interceptor was built from the opposite premise: use the browser and apps the human is already using, let the agent see what is really happening underneath, and make the workflow reusable after a single live walkthrough.

| Capability | Interceptor | Playwright / Puppeteer / CDP-first tooling |
|---|---|---|
| Uses your existing logged-in browser profile | Yes | Usually no |
| Reads passive fetch/XHR/SSE/WebSocket/sendBeacon/BroadcastChannel using only standard Web APIs | Yes | Partial — typically requires the DevTools protocol |
| Synthetic clicks/keys via `userActivation` override + `__interceptor_trust` event marker for `isTrusted`-gated handlers | Yes | Often requires DevTools-protocol fallback |
| Drives canvas-rendered editors (Docs / Slides / Sheets / map viewers / design tools) without OS keyboard | Yes — dispatched events on the canvas | Usually requires `--os` or OS-level CGEvent |
| Captures native client-side exports (PNG/PDF/SVG) without Save dialog | Yes — `URL.createObjectURL` patch + auto-download suppression | Not built in |
| Records real human sessions and exports replay plans | Yes | Not built in |
| Extends the same CLI to native macOS apps | Yes | No |
| Avoids a separate automated browser by default | Yes | No |

## Demo Preview

[![Preview from the current Interceptor walkthrough](docs/assets/interceptor-demo-preview.jpg)](https://hacker-valley-media.github.io/Interceptor/walkthrough.html)

Click the preview to watch the current walkthrough. It shows the CLI flow and live browser overlays working together in the same session.

## Install In 60 Seconds

Download a signed installer and double-click. macOS does the rest.

Two core installers ship per release, plus an optional Safari add-on. Pick the core installer that matches what you need, then add Safari if desired:

| Installer | What it installs | macOS TCC consents | When to pick it |
|---|---|---|---|
| **`Interceptor-Browser-<version>.pkg`** *(recommended default)* | CLI + daemon + extension | **None.** No Screen Recording / Accessibility / Apple Events prompts. | You drive web pages. Web scraping, CI flow tests, browser automation. macOS 11+. |
| **`Interceptor-Full-<version>.pkg`** | All of the above **plus** `interceptor-bridge.app` + LaunchAgent | Screen Recording, Accessibility, Apple Events (per target app, on first dispatch) | You also drive native macOS apps (Finder, Slack, Notes), need on-screen text capture, dispatch keystrokes outside the browser. macOS 14+. |
| **`Interceptor-Safari-<version>.pkg`** *(add-on)* | Safari containing app + Safari Web Extension | Safari extension/site-access consent; requires either core pkg for the CLI + daemon | You want the browser surface in Safari. macOS 14+. |

Both download from the same [Releases](https://github.com/Hacker-Valley-Media/Interceptor/releases) page. Start with **Browser** unless you know you need native macOS commands — you can always upgrade to Full later via `interceptor upgrade --full`.

**Updating:** run `interceptor update`. It waits briefly for Sparkle and reports the selected update version, a no-update reason, or the real error. If the feed is slow, it returns `checking`; `interceptor update status` then shows the latest outcome, selected version, lifecycle phase, feed, and schedule. Full installs also auto-check in the background. When an update is found, an agent can drive Sparkle's prompt like any other window (`interceptor macos read --app interceptor-bridge`, then `interceptor macos act <ref>` on **Install Update**); the final install step always asks for an administrator password, which a person must enter.

**Windows (browser-only):** a signed per-user installer (`Interceptor-Browser-<version>-windows-{x64,arm64}.exe`, Windows 11 24H2+) is attached to each [release](https://github.com/Hacker-Valley-Media/Interceptor/releases) — see [docs/windows-install.md](docs/windows-install.md) for the install, silent-install, upgrade, and uninstall contract. Windows extension acquisition is store-based (Chrome Web Store for Chrome/Brave, Edge Add-ons for Edge); the installer never edits browser profiles or force-loads an unpacked extension. Windows developers can also build from source with `scripts/install.ps1` (PowerShell 7, source checkout).

### Install steps

1. Download the matching `.pkg` from Releases.
2. Double-click it. Walk through the installer (admin password required once).
3. *(Full pkg only)* Open **System Settings → Privacy & Security**. The first time you run `interceptor macos *`, macOS will prompt for **Accessibility**, **Screen Recording**, and **Apple Events** access for `interceptor-bridge` — allow each. The Browser pkg never triggers these prompts. If Accessibility is missing, AX verbs (`tree`, `find`, `click`, …) fail with an actionable error and non-zero exit — run `interceptor macos trust --walkthrough` to fix. Note for source builds: an ad-hoc-signed dev bridge loses its TCC grants on every rebuild (the System Settings row can stay visibly on without applying) — remove the stale row (−) and re-grant, or use the signed pkg; `interceptor macos trust` reports the running binary's signing status.
4. *(Safari add-on only)* Install `Interceptor-Safari-<version>.pkg`, open **InterceptorSafari** once, then enable **Interceptor** in **Safari → Settings → Extensions** and grant website access.
5. Open a terminal:

```bash
interceptor open "https://example.com"        # browser surface (works in both pkgs)
interceptor macos tree                         # macOS surface (Full pkg only, after Privacy & Security grants)
```

### What each pkg lays down

**Browser pkg** (`Interceptor-Browser-<version>.pkg`):

| Component | Destination |
|---|---|
| `interceptor` CLI | `/usr/local/bin/interceptor` (on `PATH`) |
| Daemon + extension files | `/Library/Application Support/Interceptor/` |
| Chrome + Brave native messaging hosts | Per-user `~/Library/Application Support/.../NativeMessagingHosts/` |

**Full pkg** (`Interceptor-Full-<version>.pkg`) adds:

| Component | Destination |
|---|---|
| `interceptor-bridge.app` | `/Applications/interceptor-bridge.app` |
| LaunchAgent (auto-start at login) | `/Library/LaunchAgents/com.interceptor.bridge.plist` |

**Chrome/Brave extension load** is the one manual step the core installers cannot do for you, because those browsers do not allow programmatic extension installation outside of the Web Store. After install:

- **Brave:** open `brave://extensions/`, enable Developer Mode, click **Load unpacked**, select `/Library/Application Support/Interceptor/extension/`.
- **Chrome:** open `chrome://extensions/`, enable Developer Mode, click **Load unpacked**, select `/Library/Application Support/Interceptor/extension/`.

**Safari extension load** uses its signed containing app:

1. Install `Interceptor-Safari-<version>.pkg` after either core pkg.
2. Open `/Applications/InterceptorSafari.app` once (it need not stay open).
3. In **Safari → Settings → Extensions**, enable **Interceptor** and allow access to the sites you want to drive. This is a protected, user-present action; Safari may require Touch ID or the account password and it cannot be completed by the installer or CLI.
4. Verify that the fixed Safari context is connected:

```bash
interceptor contexts                 # includes: safari
interceptor --context safari open "https://example.com"
```

If `safari` is absent, confirm the extension is enabled before reinstalling anything. Until the user approves that switch, Safari does not run the background worker and no context can connect. A production package build rebuilds the extension bytes from source, runs `scripts/verify-safari-extension.swift`, notarizes and staples the app, and requires Gatekeeper to accept the exact app bytes placed in the installer. Its postinstall also moves identifier-verified legacy `.InterceptorSafari-*.noindex` backups out of `/Applications` to recoverable storage so LaunchServices cannot expose duplicate extensions. `INTERCEPTOR_SKIP_NOTARIZE=1` produces an explicitly named `*-UNNOTARIZED.pkg` for developer-mode testing; do not install it as a production replacement.

Safari's background worker reaches the daemon through the signed native appex: the worker exchanges bounded long-poll messages with `runtime.sendNativeMessage`, and the appex owns the loopback WebSocket to `127.0.0.1:19222`. This is intentional—direct WebSockets from Safari extension JavaScript did not establish a socket in public WebKit-host probes.

Verify after install with `interceptor status` — the `mode:` line reports `browser-only` or `full` depending on which pkg you installed.

To uninstall later: `sudo bash "/Library/Application Support/Interceptor/uninstall.sh"`. To downgrade Full → Browser: `sudo bash "/Library/Application Support/Interceptor/uninstall.sh" --bridge-only`.

Prefer to build from source instead of using the installer? See [Developer Setup](#developer-setup-build-from-source) below.

## MCP: drive Interceptor from any AI client

Interceptor is also an MCP server. Any MCP-native client — Claude Code, Codex, Gemini CLI, Cursor, Claude Desktop — can drive every surface as a small set of typed, safety-gated tools. Because Interceptor is a local binary already on your `PATH`, there is no `npx`, no remote URL, and no auth step. One command registers it everywhere:

```bash
interceptor mcp install        # auto-configures every detected AI client
interceptor mcp status         # show where it's registered
```

Restart the client and you're live. Under the hood the client runs `interceptor mcp serve` (stdio), exposing `interceptor_browser`, `interceptor_macos`, `interceptor_ios`, `interceptor_read`, `interceptor_local`, and `interceptor_raw`, plus `interceptor://…` discovery resources for the full verb reference.

**Safety is operator-controlled.** Read and UI-mutation verbs run by default; irreversible or code-executing verbs (delete, quit, `eval`, `script`, `runtime`, `share`) are refused unless you opt in at launch:

```bash
interceptor mcp install --allow destructive,arbitrary-exec
```

A connected model can never lift that restriction, and captured page/file/network content is fenced as untrusted data. Full details in [`docs/mcp.md`](docs/mcp.md).

## Quick Start

Examples below assume `interceptor` is on your `PATH`. From a repo install, use `./dist/interceptor` if you have not added a symlink.

```bash
# Browser surface
interceptor open "https://example.com"        # Open, wait, return tree + text (1 command)
interceptor act e1                             # Click element, return updated tree + diff
interceptor inspect                            # Tree + text + network log + headers
interceptor --context safari read              # Target Safari when several browsers are connected

# macOS surface (bridge installed)
interceptor macos open "Finder"                # Activate + tree + windows
interceptor macos act e5                       # Click + wait + updated tree
```

Once installed, the daemon auto-starts on first command. No manual launch needed.

## The Two Surfaces

Interceptor ships one CLI binary with two product surfaces. Pick by what you're driving — a webpage in your browser, or a native app on macOS. Both surfaces share the same daemon, the same wire format, and the same `e1`/`e2`/... ref system.

| Task | Surface | Command shape |
|---|---|---|
| Click / type on a webpage | Browser | `interceptor act e5`, `interceptor click`, `interceptor type` |
| Read a webpage's DOM tree, visible text, or HTML | Browser | `interceptor tree`, `interceptor text`, `interceptor html` |
| Capture passive `fetch`/XHR/SSE/WebSocket/Beacon/BroadcastChannel traffic on a page | Browser | `interceptor net log`, `interceptor sse log`, `interceptor net page-comm log` |
| Rewrite outbound page requests in flight | Browser | `interceptor override` |
| Drive Canva / Google Docs / Google Slides scene graph | Browser | `interceptor scene *` |
| Record & replay a human's web flow | Browser | `interceptor monitor *` |
| Click / type in a native macOS app | macOS | `interceptor macos act`, `interceptor macos click`, `interceptor macos type` |
| Read a native app's accessibility tree | macOS | `interceptor macos tree`, `interceptor macos find` |
| Capture a native app window (occluded / off-screen / cross-Space) | macOS | `interceptor macos screenshot --app "X"` |
| List / activate / move / resize native apps & windows | macOS | `interceptor macos apps`, `interceptor macos app *`, `interceptor macos move`, `interceptor macos resize` |
| Real-time speech, sound classification, OCR, on-device NLP/LLM | macOS | `interceptor macos listen / sounds / vision / nlp / ai` |
| Record & replay a human's native-app flow | macOS | `interceptor macos monitor *` |
| Drive Apple Events to background apps without raising them | macOS | `interceptor macos intent dispatch` |
| Deliver a stored password or passcode by name: admin prompts, `sudo`, native or web fields, the iPhone lock screen | macOS / Browser / iOS | `interceptor macos secret *`, `--secret <name>` on `type`, `macos sudo`, `macos authdialog`, `ios unlock` |
| Log in with a password Chrome already saved (no vault registration) | Browser (macOS) | `interceptor type <ref> --chrome-login <host> [--user]`, `interceptor chrome creds list` |
| Drive any app on an owned, unlocked iPhone (tree/tap/type/screenshot/app lifecycle/unlock) | iOS | `interceptor ios tree / find / click / type / screenshot / app * / unlock` |
| Runner-free iPhone process/telemetry, launch/kill, GPS simulation; on-device JS brain; WebKit inspection | iOS | `interceptor ios proc / top / spawn / kill / location / eval`, `ios web *` |

If the task is content **inside** a browser tab, use Browser. If the task is the **shell** the browser runs inside (or any other macOS app), use macOS. If the task is an app on your **iPhone**, use iOS.

The deep dives live in the per-surface sections below. Skill packages mirror this split: agent operators load `.agents/skills/interceptor-browser/` for web work, `.agents/skills/interceptor-macos/` for native work, and `.agents/skills/interceptor-ios/` for iPhone work.

---

<a name="surface-1-interceptor-browser"></a>

# Surface 1: Interceptor Browser

`interceptor` (no prefix) drives a real Chrome, Brave, or Safari session. Pages, network, scene graph, monitor, screenshots — every browser command lives at the top of the CLI namespace. Safari registers the stable context id `safari`; use `--context safari` whenever more than one browser is connected.

Safari reuses the portable DOM/content engine and the same command envelope. APIs Safari does not expose (`debugger`, `tabGroups`, `offscreen`, `tabCapture`, `power`, and related Chromium-only capabilities) degrade explicitly or route through `interceptor macos`; they are never allowed to abort the Safari background worker.

## Why Browser

- **Your real browser session**: operate inside the browser you already use, with your cookies, logins, tabs, and context intact.
- **Passive network visibility**: capture `fetch()`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `sendBeacon`, and `BroadcastChannel` traffic without turning on the debugger or triggering an infobanner.
- **Synthetic events that sites accept**: a pre-load `userActivation` override + per-event `__interceptor_trust` marker satisfies `isTrusted` and transient-activation checks on the vast majority of sites — `--os` is a fallback, not the default. Synthetic clicks and keystrokes drive rich-editor typing, canvas pan/zoom/click, layer selection in design tools, form fills, and keyboard shortcuts.
- **Teach-and-replay workflows**: record real clicks, keystrokes, DOM changes, and correlated network calls, then export a replayable `interceptor` plan.
- **Canvas-rendered editor input**: drive Google Docs / Slides / Sheets cell-precisely (caret positioning, table fills, paragraph styles) via dispatched iframe-window `KeyboardEvent`. See [`use-cases/interaction-skills/canvas-rendered-editor-input.md`](use-cases/interaction-skills/canvas-rendered-editor-input.md).
- **Canvas camera apps**: pan/zoom WebGL viewers via dispatched `MouseEvent`/`WheelEvent`, anchor lat/lng overlays via Web Mercator projection, restyle the rendered viewport with CSS filters. See [`use-cases/interaction-skills/canvas-camera-overlays.md`](use-cases/interaction-skills/canvas-camera-overlays.md) and [`use-cases/interaction-skills/webgl-camera-control.md`](use-cases/interaction-skills/webgl-camera-control.md).
- **Native client-side export capture**: intercept any webapp's "export as PNG/PDF/SVG" by patching `URL.createObjectURL` and suppressing the auto-download. No clipboard hop, no Save dialog. See [`use-cases/interaction-skills/blob-export-capture.md`](use-cases/interaction-skills/blob-export-capture.md).
- **Non-CDP architecture**: avoid the debugger-protocol footprint that separate automated browsers depend on.
- **Unbranded page-world footprint**: the MAIN-world scripts key their install guards, canvas observer, and Trusted-Types policies with opaque `Symbol.for()` keys rather than vendor-named globals, so a page can't fingerprint the extension with a one-line `window`-key scan. Hardening, not invisibility — `Object.getOwnPropertySymbols(window)` still lists them.

## Browser Install

The recommended install path for end users is the signed `.pkg` documented in [Install In 60 Seconds](#install-in-60-seconds) above. The sections below cover building from source if you want to modify Interceptor or run it without the installer.

### Developer Setup (build from source)

#### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Brave Browser](https://brave.com/download/) (or Chrome — see Chrome path below)
  - **macOS:** `brew install --cask brave-browser`
  - **Windows:** `winget install Brave.Brave` (or `choco install brave`)
  - **Linux:** `sudo snap install brave` or `flatpak install flathub com.brave.Browser`. For native package-manager installs (apt/dnf/zypper/AUR), see the [official Linux guide](https://brave.com/linux/).
- **Developer mode enabled** in the target Brave / Chrome profile. `--load-extension` is silently dropped by Chromium when Dev mode is off, leaving a dormant install with no error. `scripts/install.sh` preflights this and offers to flip it for you (Brave-closed only) or fail loudly with remediation steps. To enable manually: open `brave://extensions/` (or `chrome://extensions/`) and toggle Developer mode in the top-right. On Windows, `scripts/install.ps1` registers the native-messaging host and prints **Load unpacked** instructions instead — current branded Chrome ignores `--load-extension` on Windows, and the script never edits browser profiles.
- Xcode command line tools (only required if you want to build the macOS bridge)

#### Two install modes

`scripts/install.sh` ships with two named install modes. Pick by what you actually need:

| Mode | What it installs | macOS TCC prompts | When to pick it |
|---|---|---|---|
| **`--browser-only`** | CLI + daemon + extension | None | You only want browser control. Smallest footprint, no Screen Recording / Accessibility / Apple Events prompts. Works on macOS and Windows. |
| **`--full`** | Everything in browser-only **plus** the Swift bridge `.app`, the LaunchAgent, and the macOS subcommands | Screen Recording, Accessibility, Apple Events (per-target-app on first dispatch) | You need `interceptor macos *` (native AX tree, OS-level input, ScreenCaptureKit, Vision/Speech/NLP). macOS 15+. |

If you don't pass either flag, the script prompts. The default in the prompt is `--full` on macOS, `--browser-only` everywhere else.

#### Build and Install

```bash
git clone https://github.com/Hacker-Valley-Media/Interceptor.git
cd Interceptor
bun install
bash scripts/build.sh

# Pick a mode:
bash scripts/install.sh --browser-only --brave --profile Default   # browser only, no TCC
bash scripts/install.sh --full --brave --profile Default           # browser + macOS bridge
bash scripts/install.sh --brave --profile Default                  # interactive prompt
bash scripts/install.sh --chrome-beta --browser-only               # a Chrome channel (also --chrome-canary/--chrome-dev/--chrome-for-testing)
bash scripts/install.sh --full --dry-run                           # print steps without running
```

This builds the host binaries and extension, writes native messaging manifests pointing at the repo paths, and relaunches Brave with the unpacked extension from `extension/dist/`. Under `--full` it then chains into `scripts/install-bridge.sh` to install the bridge `.app`, register it with LaunchServices, and bootstrap the LaunchAgent. Use `bash scripts/install.sh --brave --profiles` to list profile directories before choosing a non-default profile.

To upgrade a `--browser-only` install later, run `interceptor upgrade --full` (macOS only).

The dev install produces and uses these artifacts:

| Artifact | Browser-only | Full |
|----------|:---:|:---:|
| `dist/interceptor` (CLI) | ✅ | ✅ |
| `daemon/interceptor-daemon` | ✅ | ✅ |
| `extension/dist/` | ✅ | ✅ |
| `~/Library/Application Support/{Chrome,Brave}/NativeMessagingHosts/com.interceptor.host.json` (symlink) | ✅ | ✅ |
| `~/.local/share/interceptor/interceptor-bridge.app` | — | ✅ |
| `~/.local/bin/interceptor-bridge` (symlink) | — | ✅ |
| `~/Library/LaunchAgents/com.interceptor.bridge.plist` | — | ✅ |

#### Put the CLI on PATH

Run commands from the repo with `./dist/interceptor ...`, or symlink the binary into an existing PATH directory:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/interceptor" ~/.local/bin/interceptor
```

#### Chrome channels & the Development Path

`scripts/install.sh` can target any Chrome channel: `--chrome` (stable), `--chrome-beta`, `--chrome-canary`, `--chrome-dev`, and `--chrome-for-testing` (macOS; Linux deferred, same as the Edge/Vivaldi gap).

All **branded** Google Chrome builds — stable, Beta, Canary, and Dev — ignore `--load-extension` in desktop builds (Chrome 137+ removed the switch for branded builds). For those, `scripts/install.sh` still writes the native messaging manifest, but load the extension manually:

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `extension/dist/`

**Chrome for Testing** is Google's unbranded automation build and *does* respect `--load-extension`, so `--chrome-for-testing` loads the extension automatically. Two caveats: its native-messaging host directory is `~/Library/Application Support/Google/ChromeForTesting/` as of Chrome 146 (the installer writes there), and it is typically installed as a standalone binary rather than into `/Applications`, so auto-detection may not find it — pass `--chrome-for-testing` explicitly.

#### Uninstall

```bash
bash scripts/uninstall.sh                   # Remove everything (both modes)
bash scripts/uninstall.sh --bridge-only     # Remove only the macOS bridge (downgrade to browser-only)
```

#### Verify

```bash
./dist/interceptor status                     # Self-check (local pre-spawn) — does NOT start the daemon
./dist/interceptor open https://example.com   # Canonical first-run check — spawns the daemon and exercises the full stack
# Browser-only install reports:
#   mode: browser-only
#   daemon: running
#   ...
# Full install reports:
#   mode: full
#   daemon: running
#   bridge: running
#   ...
```

`daemon: not running` from `status` on a fresh install is normal — `status` is a local pre-spawn check that never starts the daemon. Run `interceptor open <url>` to spawn the daemon and verify the daemon, native messaging bridge, extension, and page together.

#### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `interceptor open <url>` returns `error: timeout: no response for 'tab_create' after 15s` | Browser extension is not loaded — most often because **Developer mode is off** in the target profile. Chromium silently drops `--load-extension` when Dev mode is off. | Open `brave://extensions/` or `chrome://extensions/`, toggle Developer mode ON. Quit the browser fully. Re-run `bash scripts/install.sh` (it will preflight Dev mode and re-launch). |
| A timeout whose message says `A browser context is connected, so the extension is reachable` | The daemon still holds a live extension connection, so the request itself timed out — usually an oversized or slow response (for `net log`, too many full bodies in one reply). | Narrow the request: `net log --limit 20`, `--since <ts>` to page incrementally, or `--filter <host>`. The extension also budgets `net log` replies to 8 MiB of bodies; entries past the budget come back with `truncated: true` and an empty body. |
| `interceptor status --verbose` says `extension: not reachable` | Same as above, or extension is registered but the Interceptor extension was disabled in the browser. | Open the extensions page, confirm Interceptor (ID `hkjbaciefhhgekldhncknbjkofbpenng`) is present and enabled. If missing, click **Load unpacked** and select `extension/dist/`. |
| Chrome's extension error page shows `A preload for ... is found, but is not used because the request credentials mode does not match` attributed to `inject-net.js` | A page-level Chromium preload warning was attributed to Interceptor because the passive network shim calls through to the page's original `fetch()` there. The warning is not the same as an Interceptor connection failure. | Treat it as a site warning unless commands fail. If Interceptor commands fail, check the `extension: not reachable` row above. |
| `chrome://extensions/` reports the extension as version `0.10.0` while `interceptor --version` reports a higher version | Extension manifest drift fixed in this release — rebuild from current source: `bash scripts/build.sh` then re-run `scripts/install.sh`. | Restart the browser after re-loading the extension so Chromium picks up the bumped manifest. |

In browser-only mode, running an `interceptor macos *` command returns a structured "requires full computer-use install" error within 1 second instead of timing out at 15 seconds.

## Browser Quick Start

```bash
interceptor open "https://example.com"       # Open, wait, return tree + text (1 command)
interceptor act e1                            # Click element, return updated tree + diff
interceptor act e2 "hello world"              # Type into field, return updated tree
interceptor read                              # Re-read current page (tree + text)
interceptor inspect                           # Tree + text + network log + headers
```

The legacy individual commands (`interceptor tab new`, `interceptor tree`, `interceptor click`, etc.) still work, but the compound commands above are preferred — they reduce round-trips and agent deliberation time.

## Core Concepts

**Element Refs** — `interceptor tree` returns elements with refs like `e1`, `e5`, `e23`. Use these to click, type, hover. Refs survive between commands until the DOM changes.

**Interceptor Group** — Every `interceptor tab new` adds tabs to a managed Interceptor group. In supported agent shells, bare commands use a soft per-session group so `open` reuses one tab and idle cleanup can reap the session. `INTERCEPTOR_SESSION_ID` is the neutral contract; verified Maestro, Claude Code, and Codex variables are detected automatically and hashed into an opaque `s-<hash16>` label. Use a unique `--group <label>` or neutral session id for each concurrent lane. Explicit groups are hard-scoped by default. `--shared-group` uses the shared default Interceptor group, not unmanaged tabs. Your personal tabs stay outside the managed boundary unless you explicitly authorize `--any-tab`. `tab close <id>` and `tab switch <id>` act on exactly the id you pass; the applicable group check validates that same tab, and an explicit id takes precedence over `--tab`.

**Focus Model (Background-First Contract)** — Interceptor never steals focus from the tab you're working in. `interceptor open <url>` and `interceptor tab new <url>` create their tabs in the **background** by default — the tab you had active stays active. Only four browser verbs intentionally move focus: `open --activate`, `tab new --activate`, `tab switch <id>`, and `window focus <id>`. The reuse path preserves the reused tab's existing focus state; add `--activate` to bring it forward. All other operations (`click`, `type`, `read`, `screenshot`, `net`, `scene`, `monitor`, etc.) work against the target tab without touching whichever tab you're looking at. This mirrors the macOS surface's same background-first contract — see `AGENTS.md` "Background First (Browser + macOS)" for the full inventory.

**Tab Lifecycle Policy** — Interceptor cleans up after itself. Two behaviors are set from the extension popup. **(1) Named-group reuse (default on):** `interceptor open <url>` in an automatic session group, or `open --group <label>`, navigates that group's most-recent tab instead of opening a new one. Shared-default `open` still creates because the most recent tab could belong to another lane. Explicit `--reuse` opts in anywhere, `--no-reuse` forces a new tab, and `tab new` creates by default while accepting explicit `--reuse`. **(2) Idle group close (default 10 min):** a managed group with no tab activity for the configured minutes is closed automatically (0 disables). Metadata polls such as `status` and `group list` do not reset the timer. Safety guards protect the focused window's active tab, pinned tabs, audible tabs, and each window's last tab. Sweeps are logged and closed tabs are restorable with ⌘⇧T or `interceptor sessions restore`.

**Named Contexts** — When two browser profiles (or Chrome + Brave) both connect to the same daemon, the daemon tracks each extension as a separate named context. Each profile's extension auto-generates a stable UUID on first run (stored in `chrome.storage.local`). Run `interceptor contexts` to list connected IDs, then pass `--context <id>` to route a command to a specific profile. Without `--context`, a command succeeds only when exactly one context is connected — the daemon errors (fail-fast) when zero or multiple contexts are present. Primary use case: cross-account security testing where you need Account A and Account B active simultaneously. If two profiles are configured with the same context ID, the second profile is rejected and the extension shows a red `!` badge; open that profile's Interceptor popup, choose a unique Context ID, and it will re-register without needing an extension reload.

**Passive Network** — `fetch()` and `XMLHttpRequest` traffic on every page is captured automatically. SSE streams are exposed with `interceptor sse log`. WebSocket, Beacon, and BroadcastChannel activity is captured as page communication with `interceptor net page-comm log`; use `interceptor net monitor on --reload` when you need sockets opened during page startup. No debugger, no infobanner.

**Scene Graph** — Profile-driven access to visual editors that don't render to the DOM normally: Canva, Google Docs, Google Slides. Enumerate objects by stable ID, click shapes, read full document text, navigate slide decks, render pages to PNG. `interceptor scene` — no CDP, no vision, no screenshots needed.

**Session Monitor** — Record a user's real interactions (clicks, keystrokes, form changes, DOM mutations, network calls) as a sparse event stream that replays as an `interceptor` script. Sessions are **document-scoped and tab-following**: a single recording survives refreshes and SPA navigation, automatically hands off to child tabs that the monitored page opens (e.g. Canva's "Create new design"), and follows you when you manually switch focus between tabs in the interceptor group. Personal tabs outside the cyan interceptor group are never auto-attached. Each session writes its own durable artifact directory (`/tmp/interceptor-monitor-sessions/<sid>/`) so exports don't depend on a rolling log, and `monitor stop` is transport-resilient — it cannot throw on a disconnected native port. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full monitor model.

**Synthetic input acceptance** — The pre-load `userActivation` override (shipped in `extension/src/inject-net.ts` at `document_start`, MAIN world) is what makes synthetic clicks and keystrokes acceptable to sites that gate on transient activation — historically the reason most automation tools had to fall back to OS-level CGEvent input. With that gate satisfied, dispatched `MouseEvent`/`KeyboardEvent`/`WheelEvent` tagged with `event.__interceptor_trust = true` flow through site handlers as if the user had typed or clicked.

**Use Cases** — The [`use-cases/`](use-cases/) folder is the cookbook for workflows we have already proven in live pages. When a browser workflow is discovered or stabilized, document the exact path there so future agents can reuse it instead of rediscovering it.

## Browser Commands

### Compound Commands (Agent-Optimized)

These collapse multi-step patterns into single CLI invocations:

```bash
interceptor open "https://example.com"        # Open URL in a background tab (default), wait, return tree + text
interceptor open "https://example.com" --activate     # Foreground the new tab (explicit opt-in)
interceptor open "https://example.com" --tree-only   # Skip text
interceptor open "https://example.com" --text-only   # Skip tree
interceptor open "https://example.com" --full        # Full text (no 2000-char limit)
interceptor open "https://example.com" --no-wait     # Don't wait for load
interceptor open "https://example.com" --reuse        # Reuse the most recent managed tab (long automation: avoids tab accumulation)
interceptor open "https://example.com" --no-reuse     # Force a new tab (overrides the named-group reuse default)
interceptor open "https://example.com" --reuse --activate  # Reuse the tab and bring it to the foreground
interceptor read                              # Tree + text for current page
interceptor read e5                           # Tree + text for element subtree
interceptor read --tree-only                  # Just tree
interceptor read --include-style              # Inline computed styles (display, color, opacity, etc.) on each element
interceptor read --include-frames             # Walk every reachable frame; refs from non-top frames are e<frameId>_<n>
interceptor read e2_7 --include-frames        # Read only a framed element subtree
interceptor style inject --css "button{outline:3px solid red}" # Inject stylesheet into all frames
interceptor style inject --css "body{zoom:1.1}" --top-only     # Inject only into the top frame
interceptor style remove <handle>             # Remove a previously injected stylesheet
interceptor act e2_7                          # Act on element in frame 2 (routed automatically)
interceptor act e5                            # Click + wait + return updated tree + diff
interceptor act e3 "hello"                    # Type + wait + return updated tree
interceptor act e5 --os                       # FALLBACK ONLY — OS-level CGEvent click; try synthetic first (pre-load userActivation override + __interceptor_trust marker satisfies most isTrusted checks)
interceptor act e5 --keys "Enter"             # Send keyboard shortcut instead
interceptor act e5 --no-read                  # Skip post-action tree read
interceptor inspect                           # Tree + text + network log + headers
interceptor inspect --net-only                # Just network data
interceptor inspect --filter api              # Filter network entries
```

### Read the Page
```bash
interceptor tree                             # Interactive elements with refs
interceptor tree --filter all                # Include headings + landmarks
interceptor tree --depth 5                   # Limit tree depth
interceptor text                             # All visible text
interceptor text e5                          # Text from specific element
interceptor html e5                          # HTML of specific element
interceptor websearch "browser automation"   # Default provider → managed background results tab + page read
interceptor find "contract clause"           # Current-page rendered snippets + accessible elements
interceptor find "contract clause" --text-only # Passage snippets only (scans beyond normal 8K read output)
interceptor find "Submit" --elements-only    # Accessible controls + actionable refs only
interceptor find "Submit" --role button      # Element-only, filtered by ARIA role
interceptor diff                             # What changed since last tree read
interceptor state                            # Full DOM tree + scroll + focused element
```

### Interact
```bash
interceptor click e5                         # Click element (synthetic; default — userActivation override + __interceptor_trust marker handle most isTrusted gates)
interceptor click e5 --os                    # FALLBACK — OS-level CGEvent click (only when synthetic input is observed to fail)
interceptor click e5 --at 10,20             # Click at offset within element
interceptor click --selector "button span" --nth 4   # Click by CSS selector (0-based --nth matches query output; quote selectors with spaces)
interceptor query "button span"              # Elements matching a CSS selector — each carries a clickable e<ref>, so any verb can act on it
interceptor type e3 "hello"                  # Type into element (synthetic; default)
interceptor type e3 "more" --append          # Append without clearing
interceptor type "textbox:Search" "query"    # Type using semantic selector (role:name)
interceptor type e3 --secret <name>          # Type a stored credential by name (see "Secret vault"); the value never leaves the daemon
interceptor type e3 --chrome-login <host> [--user]   # Fill a Chrome saved login for the current page (password, or username with --user); read + decrypted in the daemon
interceptor select e7 "option-value"         # Select dropdown option
interceptor hover e5                         # Hover over element
interceptor keys "Control+A"                 # Keyboard shortcut (synthetic; default)
interceptor keys "Enter" --os               # FALLBACK — OS-level CGEvent key
interceptor focus e5                         # Focus element
interceptor drag e5 --from 0,0 --to 100,50  # Drag gesture
interceptor dblclick e5                      # Double-click
interceptor rightclick e5                    # Right-click (context menu)
interceptor upload e5 ./resume.pdf           # Attach a local file to an <input type=file> or dropzone (no OS dialog, no CDP)
interceptor upload e5 ./clip.mp4 --dropzone  # Force the drag-and-drop path (skip input detection)
interceptor upload e5 ./photo.png --picker   # Stage for a File System Access picker, then click the trigger
```
`upload` handles `<input type=file>`, drag-and-drop dropzones, and File System Access pickers. Files of any size work — large files are split into frames and reassembled automatically. The result reports the `method` used and a `verified` flag. `read` marks an uploadable element with an `upload=` hint. If a site creates its file input only on click, `interceptor click` the upload button first, then `upload`.

### Navigate
```bash
interceptor tab new "https://example.com"    # New tab in interceptor group
interceptor navigate "https://example.com"   # Navigate current tab
interceptor back                             # History back
interceptor forward                          # History forward
interceptor scroll down                      # Scroll (up/down/top/bottom)
interceptor wait 2000                        # Wait milliseconds
interceptor wait-stable                      # Wait for DOM to stop changing
```

### Tabs
```bash
interceptor tabs                             # List all tabs (* = active)
interceptor tab new "https://example.com"    # Open new tab
interceptor tab switch 12345                 # Switch to tab by ID (acts on that exact id)
interceptor tab close                        # Close the auto-target tab
interceptor tab close 12345                  # Close specific tab (acts on that exact id)
interceptor window new "https://example.com" # New window
interceptor window list                      # List all windows
interceptor window focus 123                 # Focus a window (explicit focus move)
interceptor window resize 123 1200 800       # Resize by ID
interceptor window resize 123 --left 0 --top 0 --width 960 --height 1080
                                             # Move + resize by ID
interceptor window resize --state maximized  # State change for current window; do not combine
                                             # maximized/fullscreen/minimized with geometry
```

### Network — Passive Capture (always on)
Every page's fetch/XHR traffic is intercepted automatically. Full response bodies included.
```bash
interceptor net log                          # All captured traffic
interceptor net log --filter graphql         # Filter by URL substring
interceptor net log --filter api.example.com # Any URL pattern
interceptor net log --since 1700000000000    # After timestamp
interceptor net log --limit 50              # Max entries (default 100)
interceptor net clear                        # Flush buffer
interceptor net headers                      # Captured request headers (CSRF, auth tokens)
interceptor net headers --filter api         # Filter by URL
interceptor net log --format json --out api.json          # Export json | har | pcapng (file is created mode 600)
interceptor net log --format har --out api.har --redact-auth   # Same, credential headers replaced with [redacted]
```
Exports keep the captured request and response headers by default — the auth token is usually the point of the capture — and are written owner-only (`0600`). Pass `--redact-auth` when the file will be shared: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-Token`, `X-API-Key`, and any `token` / `secret` / `session` header become `[redacted]`.

### Network — Request Overrides (rewrite before send)
Modify outgoing requests at the JavaScript level. No CDP, no debugger.
```bash
# Change a query parameter on matching URLs
interceptor override "*eventAttending*" count=50

# Multiple params
interceptor override "*api/search*" limit=50 offset=0

# Clear all overrides
interceptor override clear
```

### SSE Stream Capture

interceptor intercepts Server-Sent Events (text/event-stream) in real-time, chunk by chunk.

```bash
interceptor sse streams                                  # List active SSE streams
interceptor sse log [--filter <pattern>] [--limit N]     # Show completed SSE streams
interceptor sse tail [--filter <pattern>]                # Live tail SSE chunks
```

Works automatically on any site using fetch-based SSE or EventSource. No CDP. No setup.

### Scene Graph (Canva, Google Docs, Google Slides)
Read and manipulate visual editors whose "canvas" is actually a DOM / SVG / hidden-iframe structure. No CDP, no debugger, no detection risk. Profile-driven — each editor has its own detection and capability set. Works today on canva.com/design/, docs.google.com/document/, and docs.google.com/presentation/.

```bash
interceptor scene profile                     # Detect active editor profile
interceptor scene profile --verbose           # Include capabilities list
interceptor scene list                        # Enumerate scene objects on current page
interceptor scene list --type shape           # Filter by type (image|shape|text|page|slide|embed)
interceptor scene click <id>                  # Click a scene object by stable id (Canva: LBxxxxxxxxxxxxxx)
interceptor scene dblclick <id>               # Double-click to enter text edit
interceptor scene hit <x>,<y>                 # Identify the scene object at viewport coordinates
interceptor scene selected                    # Read current selection (host-aware)
interceptor scene zoom                        # Read editor zoom factor

interceptor scene text                        # Read full document text (Google Docs hidden iframe mirror)
interceptor scene text --with-html            # Include inline HTML with data-ri offsets
interceptor scene insert "<text>"             # Insert text at cursor position (Google Docs)

interceptor scene slide list                  # List all slides in a Google Slides deck
interceptor scene slide current               # Show current slide index and id
interceptor scene slide goto <n>              # Navigate to slide <n> (URL fragment method)
interceptor scene slide <n>                   # Shorthand for slide goto <n>
interceptor scene notes                       # Read speaker notes of current slide

interceptor scene render <id>                 # Render a scene object as PNG data URL
interceptor scene render <id> --save          # Save the PNG to disk
```

**How it works per editor:**

- **Canva**: every object on the canvas is a `<div id="LB…">` with `style.transform: translate(x, y)` and `style.width/height`. The IDs are stable per-document (they survive page reloads). `scene list` enumerates them; `scene click` computes the viewport center from `getBoundingClientRect()` and dispatches a click through `elementFromPoint`.
- **Google Docs**: the page is rendered to `<canvas>` but the full document HTML lives inside a hidden iframe at `.docs-texteventtarget-iframe > [role=textbox]`, complete with `<p>` / `<span>` elements carrying `data-ri` range-index offsets. `scene text` reads it, `scene insert` writes via `document.execCommand('insertText')` on the iframe's contenteditable.
- **Google Slides**: each slide is a SVG `<g id="filmstrip-slide-N-gd…">` with a pre-rendered PNG blob URL on the child `<image>`. The real slide-navigation page ID lives on the `data-slide-page-id` attribute of the parent `.punch-filmstrip-thumbnail`. `scene slide goto` navigates by setting `window.location.hash = "#slide=id." + pageId`.

### Recording (Session Monitor)
Record every real user click, keystroke, form change, navigation, DOM mutation, and the network calls each action triggered — then export the trace as either a pretty timeline or a runnable `interceptor` replay script. No CDP, no infobanner, no detection.

Monitor commands (`start`, `stop`, `pause`, `resume`) auto-resolve the target tab from the interceptor group when `--tab` is omitted. If the content script port is disconnected (e.g. after a service worker restart or long SPA session), the extension automatically re-injects `content.js` and retries — no `interceptor reload` needed.

A session follows your focus across the interceptor tab group. Switch to another in-group tab and the monitor emits `mon_detach (reason: focus_switch_handoff)` + `mon_attach (reason: focus_switch)` and starts capturing there. Child tabs that the monitored page opens itself (via a trusted click) take the dedicated child-tab handoff path (`reason: child_tab`). Tabs outside the cyan interceptor group are never auto-attached. Reloads and SPA history/fragment navigations create new document-scoped attachments on the same tab (`reason: reload` / `history` / `fragment`).

```bash
interceptor monitor start                              # Begin recording on the active interceptor tab
interceptor monitor start --instruction "..."          # Annotate with task intent
interceptor monitor start --task "Teach 9 AM batch" --mode human-teach
interceptor monitor stop                               # End recording, print summary
interceptor monitor stop --task <taskId>               # Stop the task envelope only
interceptor monitor status                             # Show active session(s)
interceptor monitor status --task <taskId>             # Show task envelope status
interceptor monitor pause                              # Stop emitting events without ending
interceptor monitor resume                             # Resume a paused session
interceptor monitor task attach <taskId> <sessionId>   # Attach an existing source session
interceptor monitor task create "<objective>"          # Durable agent task; no recording needed
interceptor monitor task checkpoint <taskId> --file <json>   # Save revisioned constraints, target, checks, lessons
interceptor monitor task resume <taskId>               # Compact state + scoped lessons for a later session
interceptor monitor task verify <taskId>               # Run the stored checks now; lifecycle status unchanged
interceptor monitor task complete <taskId>             # Complete only when every fresh check returns true
interceptor monitor list                               # All sessions in the event log
interceptor monitor tail                               # Live tail current session (pretty)
interceptor monitor tail --raw                         # Live tail (raw JSONL)
interceptor monitor export <sessionId>                 # Aligned text rendering
interceptor monitor export --task <taskId> --format transcript
interceptor monitor export <sessionId> --json          # Raw JSONL for that session
interceptor monitor export <sessionId> --plan          # Emit interceptor ... replay script
interceptor monitor export <sessionId> --with-bodies   # Include persisted net-body context when available
```

Each event line is sparse JSON (short keys: `t`, `s`, `k`, `sid`, `ref`, `r`, `n`, `cause`) so an agent can read a 30-minute session in a few KB. User actions get a session-monotonic `seq`; mutations and network calls fired within 500ms of an action carry `cause: <action_seq>`. Real user events have `tr: true`; interceptor's own synthetic clicks have `tr: false`. The replay-plan generator automatically includes synthetic clicks when no real user events exist in the session (common when an agent drove the browser). Use `--include-synthetic` to force inclusion regardless.

Tasks are task-scoped; monitor sessions are source-scoped. `--task` creates or attaches a durable task envelope under `${INTERCEPTOR_TASKS_DIR:-<platform app support>}/<taskId>/` while preserving the existing browser/macOS source artifacts. `interceptor monitor export <sessionId>` remains a source-session export. `interceptor monitor export --task <taskId> --format timeline|transcript|json` builds a task-level view by deterministically merging attached source logs, then validating semantic transcript entries against source references.

Task checkpoints carry the objective, constraints, owner, browser target (context, group, tab, frame, origin), next action, lessons, and JavaScript predicates. `resume` returns only lessons whose context and origin match. `verify` and `complete` evaluate the predicates fresh in the page's main world without reloading, and `complete` exits nonzero unless every check returns boolean `true`. Writers are serialized by a per-task lock with dead-owner reclaim, and a stale `expectedRevision` is rejected. Schema and workflow: `.agents/skills/interceptor-browser/workflows/task-state.md`.

The rolling live event stream lives in `/tmp/interceptor-events.jsonl`. Export prefers per-session artifacts under `/tmp/interceptor-monitor-sessions/<sessionId>/` (one directory per session containing `events.jsonl`, `session.json`, and `net.jsonl`) and falls back to the rolling event log for legacy sessions. `--with-bodies` uses persisted correlated net-body artifacts when present (body previews are capped at 64 KiB, redact `Authorization` / `Cookie` / token-shaped strings, and only persist JSON / text content types) and otherwise leaves `interceptor net log` hints in the replay output.

The replay script uses semantic selectors that survive DOM churn, and for multi-tab sessions it emits explicit tab-handoff lines:
```
interceptor tab new "https://example.com/"
interceptor wait-stable
interceptor click "button:Search"
interceptor type "textbox:Query" "bun docs"
interceptor keys "Enter"
# focus-switch to tab 1729165117 (https://www.youtube.com/)
interceptor tab switch 1729165117
interceptor wait-stable
interceptor click "button:Play"
```

### Screenshots

Default capture is **DOM render** — no `chrome.tabs.captureVisibleTab` in the hot path. Works regardless of window focus, macOS Space, or service-worker activation context. A vendored `html-to-image` bundle is injected on demand and paired with a per-tab CORS-clearance DNR rule. Use `--pixel` for compositor-accurate capture (requires Chrome focused).

```bash
interceptor screenshot                       # Default DOM-render full-page (works without focus)
interceptor screenshot --save                # Save to disk; result has filePath, no dataUrl
interceptor screenshot --selector "h1"       # Capture matching element (off-screen supported)
interceptor screenshot --element 5           # Capture by ref/index from a recent read
interceptor screenshot --region X,Y,W,H      # Render full + crop to region in content script
interceptor screenshot --scale 2             # Override pixel ratio
interceptor screenshot --pixel               # Pixel-true compositor capture (legacy captureVisibleTab)
interceptor screenshot --pixel --full        # Pixel-true full-page (scroll + in-SW stitch)
interceptor screenshot --no-fallback         # Forbid the DOM-render→pixel auto-fallback (see below)
interceptor screenshot --format webp         # png (default), jpeg, or webp
interceptor screenshot --quality 80          # Encode quality 0-100 (defaults: png 92, jpeg 92, webp 85)
interceptor screenshot --target-max-long-edge 1568   # Auto-resize at capture (clamps long edge)
```

When the DOM renderer fails outright on a heavy page (the serialized SVG won't decode), a default whole-page `screenshot` automatically retries via the pixel path so the command still produces an image. The fallback preserves the DOM path's PNG default (no silent JPEG downgrade), only applies to whole-page captures (element/ref/region requests fail honestly instead of cropping wrong), and reports itself in a `fallback` note — including that the pixel path transiently borrowed tab focus and scrolled the page (both restored). `--no-fallback` forbids the retry entirely.

`screenshot` invocations are auto-routed through the WebSocket transport because base64 dataUrl responses larger than ~50KB are unreliable over the native-messaging port on Brave/Chromium. Override with `--no-ws` if needed.

**Agent recipe for any consumer:** `interceptor screenshot --save --format webp --target-max-long-edge 1568 --quality 85` produces a ~50–100 KB WebP on disk and a path-only response — fits Anthropic's 1568 px cap exactly, eats zero context window, no auto-resize destruction.

### Data
```bash
interceptor cookies example.com              # List cookies for domain
interceptor storage                          # Read localStorage
interceptor storage set key value            # Write localStorage
interceptor eval "document.title"            # Run JS in page
interceptor history "search term"            # Search browser history
interceptor bookmarks "query"                # Search bookmarks
```

### Batch & Raw
```bash
interceptor batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500},{"type":"extract_text"}]'
interceptor batch '...' --stop-on-error      # Halt on first failure
interceptor raw '{"type":"any_action","key":"value"}'  # Send any raw action
```

### Meta
```bash
interceptor status                           # Daemon status (local check, no connection needed)
interceptor help                             # Full CLI help
interceptor contexts                         # List IDs of all connected browser contexts
interceptor reload                           # Reload extension
interceptor capabilities                     # Check available input layers
```

## Browser Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of plain text |
| `--tab <id>` | Target specific tab by ID. When an action names its own tab (`tab close <id>`, `tab switch <id>`), the explicit id wins over `--tab`. |
| `--any-tab` | Operate outside the interceptor group (also required to `tab close <id>` / `tab switch <id>` an unmanaged tab) |
| `--context <id>` | Route command to a specific browser context (profile). See `interceptor contexts`. Omitting this flag succeeds only when exactly one context is connected; the daemon errors when zero or multiple contexts are present. |
| `--os` | FALLBACK: use OS-level CGEvent (macOS) when synthetic input is observed to fail. Default to synthetic — the pre-load `userActivation` override + `__interceptor_trust` event marker satisfy most `isTrusted` checks. |
| `--frame <id>` | Target exactly that iframe on any browser verb, including `eval`. Accepted before or after the command; a missing frame fails instead of silently running in the top frame. |
| `--changes` | Include DOM diff in response |
| `--flag=value`, `--` | `--flag=value` is accepted everywhere; `--` ends flag parsing so a positional may begin with `--` |

Flags are order-independent on browser commands, and **unknown flags are rejected** (exit 1, naming the flag and the command) instead of being ignored — a typo such as `screenshot --out shot.png` no longer looks like a success (`screenshot` writes to disk with `--save`). `INTERCEPTOR_LAX_FLAGS=1` downgrades the rejection to a one-line warning for legacy scripts. `interceptor macos *` and `interceptor ios *` keep their verb-first parsing and are not strict. A command whose result is a failure prints `error: …` (or the JSON envelope under `--json`) **and exits non-zero** — since 0.23.40 that covers every browser verb (`back`/`forward` with no history used to print the error and exit 0), so scripts can trust `$?`.

`interceptor eval` reports thrown exceptions, rejected promises, and syntax errors as failures (exit 1) in both the isolated and `--main` worlds, and supports top-level `await`. `--main` on a strict-CSP page may strip the header and reload the tab once; the result discloses the reload.

## Browser Recipes

### Extract data from an SPA
```bash
interceptor tab new "https://app.example.com"
sleep 3
interceptor tree                              # Find the data
interceptor net log --filter api              # See what API calls the page made
interceptor net headers --filter api          # Grab auth tokens from captured headers
interceptor text                              # Read visible content
interceptor tab close
```

### Fill and submit a form
```bash
interceptor tab new "https://example.com/form"
sleep 2
interceptor tree                              # Find form fields
interceptor type e3 "John Doe"               # Fill name
interceptor type e5 "example user"           # Fill field
interceptor select e7 "option2"              # Pick dropdown
interceptor click e10                         # Submit
sleep 2
interceptor text                              # Read result
```

### Monitor network traffic from any page
```bash
interceptor tab new "https://app.example.com"
sleep 3
interceptor net log --filter api              # See all API calls with full response bodies
interceptor net headers --filter api          # See request headers (auth, CSRF, cookies)
# Navigate around — capture keeps running
interceptor click e5
sleep 2
interceptor net log --filter api --limit 5    # See latest calls
```

### Override API requests (change page size, params)
```bash
interceptor tab new "https://app.example.com"
sleep 2
# Push override: change page_size to 100 on any matching URL
interceptor override "*api/list*" page_size=100
# Now interact — when the page fetches, the URL is rewritten before it fires
interceptor click e5                          # Trigger a load
sleep 2
interceptor net log --filter api/list         # See the rewritten request + response
interceptor override clear                    # Clean up
```

### Interact with sites that check isTrusted

Try synthetic first. The pre-load `userActivation` override (`extension/src/inject-net.ts` at `document_start`, MAIN world) makes `navigator.userActivation.isActive` always read `true`, satisfying the transient-activation gate that most "isTrusted-checking" sites actually rely on. For sites that ALSO read `event.isTrusted` via the prototype, dispatched events tagged with `event.__interceptor_trust = true` (via `interceptor eval --main`) pass through. Only fall back to `--os` when synthetic input is observed to fail.

```bash
# Default — synthetic, no --os needed. Works on most sites with rich-editor or canvas-rendered surfaces.
interceptor open "https://strict-site.com"
interceptor act e5
interceptor act e3 "text"

# Fallback — OS-level CGEvent. Use when synthetic input is observed to fail (banking/payment gateways, IME composition, sites that cache the per-instance own-property isTrusted at boot).
interceptor click e5 --os
interceptor type e3 "text" --os
```

### Read a Google Doc programmatically
```bash
interceptor tab new "https://docs.google.com/document/d/<id>/edit"
sleep 5
interceptor scene profile                     # -> google-docs
interceptor scene text                        # Full document text from hidden iframe mirror
interceptor scene text --with-html            # Full HTML model with data-ri offsets
interceptor scene insert "new paragraph at cursor"
interceptor keys "Meta+z"                     # Undo the insert
```

### Manipulate a Canva design
```bash
interceptor tab new "https://www.canva.com/design/<id>/edit"
sleep 6
interceptor scene profile                     # -> canva
interceptor scene list --type shape           # Every LB layer that's a shape
interceptor scene zoom                        # Current editor zoom factor
interceptor scene hit 537,516                 # What's at this viewport coord?
interceptor scene click LBKfjtRwQHt7D0Cf      # Click a layer by stable id
```

### Navigate and render Google Slides
```bash
interceptor tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 6
interceptor scene slide list                  # All slides with stable IDs + blob URLs
interceptor scene slide goto 5                # Navigate via URL fragment
interceptor scene slide current               # Verify index 5 is now active
interceptor scene notes                       # Read speaker notes for current slide
interceptor scene render filmstrip-slide-3-gd02e148143_0_6 --save  # PNG of slide 3
```

### Pan/zoom a WebGL canvas viewer + anchor lat/lng overlays
```bash
interceptor open "https://example-webgl-map.com/"
# Dispatch wheel events on the canvas to pan/zoom, project lat/lng to viewport pixels
# for custom overlays. Full recipe in
# use-cases/interaction-skills/webgl-camera-control.md.
```

### Bulk-capture every native client-side export in a webapp
```bash
interceptor open "https://example.com/editor"
# Patch URL.createObjectURL to capture blobs, patch HTMLAnchorElement.prototype.click
# to swallow auto-downloads. Then loop: select each frame/slide/page, trigger the
# webapp's own Export button, fetch each blob's bytes.
interceptor eval --main "$(cat install-patches.js)"
interceptor eval --main "$(cat bulk-export-loop.js)"     # fire-and-forget
# Poll until done, then chunk-extract each PNG's base64 from window.__interceptor_pngs.
# Full recipe in use-cases/interaction-skills/blob-export-capture.md.
```

### Record a user session and replay it
```bash
interceptor monitor start --instruction "search bun docs, open first result, copy paragraph"
# ... user interacts for 60 seconds ...
interceptor monitor stop                      # Prints session summary
interceptor monitor list                      # Shows all historical sessions
interceptor monitor export <sessionId>        # Aligned text rendering
interceptor monitor export <sessionId> --plan # Replayable script of interceptor commands
```

### Inspect and read canvas-heavy pages
```bash
interceptor canvas list                       # Discover <canvas> elements (HTMLCanvasElement)
interceptor canvas status                     # Canvas list + host/model/observer signals
interceptor canvas log                        # Captured drawing operations across canvases
interceptor canvas log 0 --kind fillText      # Drawing operations for canvas index 0
interceptor canvas objects 0 --kind text      # Derived objects for canvas index 0
interceptor canvas model                      # Host-state and app-model signals
interceptor canvas routes --filter save       # First-party canvas-related network routes
interceptor canvas read 0 --format png        # Read canvas as data URL
interceptor canvas diff url1.png url2.png     # Pixel diff between images
```

Canvas indexes come from the DOM canvas order reported by `canvas list`. The observer-backed `log` and `objects` commands resolve that DOM index to the internal observer `canvasId`, so `canvas log 0` and `canvas log 1` stay separated on multi-canvas pages. `canvas ocr` exists as an experimental command, but use `canvas read` when you need a stable image export.

---

<a name="surface-2-interceptor-macos"></a>
<a name="native-computer-use"></a>
<a name="macos-native-control"></a>

# Surface 2: Interceptor macOS

`interceptor macos *` extends the same agent-first pattern to native macOS applications. No screenshots, no vision models. Structured AX trees, trusted input, real-time audio intelligence, and system-wide event monitoring. Same CLI binary, same wire format, same ref convention (`e1`, `e2`, ...) — same agent loop.

## Why macOS

Beyond the browser, Interceptor drives the rest of macOS through a Swift bridge daemon. The surface includes 28 domains across **Accessibility, Apps, Files, Filesystem (`fs`), Networking (`url_fetch`), Log query, Apple Events (`app_intent`), Containers, Capture, Stream, Display, Audio, Speech, Sound, Vision, NLP, Intelligence, Notifications, Clipboard, Trust, Monitor, Text, Compound, and Overlays** — plus a hardened `.app` bundle with TCC tracking, the panic hotkey `Ctrl+Opt+Cmd+Escape` for overlays, and the headline visual modes (particles, Godzilla-vs-Kong SpriteKit scene, dynamic scene-script, HTML HUD).

**Background-first** is the default contract: when the user names a specific app ("screenshot of Brave", "scroll Signal", "open a tab in Brave"), Interceptor stays invisible to the user. Captures use `CGSHWCaptureWindowList` (works on occluded / minimized / cross-Space windows). AX reads use `AXManualAccessibility` to wake Electron apps without focus. Apple Events deliver to a target bundle id without `activate`. Scroll routes via `CGEvent.postToPid` to a specific PID. Your focused window stays where it was — unless you ask otherwise. See [`AGENTS.md`](AGENTS.md) for the full background-first table and the browser-vs-bridge decision matrix.

### How It Works

When the native bridge is installed, the daemon routes `macos_` commands to the bridge over Unix socket. Same CLI binary, same wire format, same ref convention (`e1`, `e2`, ...). Browser automation through Brave works through the CLI install path without the native bridge.

```
CLI ──unix──▸ Daemon ──native-msg──▸ Chrome Extension (web commands)
                    ──unix──▸ Native Bridge (macOS commands)
```

<a name="surface-2-install"></a>

## macOS Install

The Brave CLI browser install does not require the macOS bridge. Use the standalone `interceptor-bridge` path below when developing or debugging native macOS automation.

### Build and Install

```bash
bash scripts/build-bridge.sh
bash scripts/install-bridge.sh
```

Requires full Xcode (not just Command Line Tools) — the bridge links Apple frameworks including ScreenCaptureKit, Speech, Vision, NaturalLanguage, **WebKit (overlays), SpriteKit (overlays), and Carbon (Apple Events)**.

### Permissions

After installing, check and grant required permissions:

```bash
interceptor macos trust                          # Permission snapshot + System Settings paths
interceptor macos trust --no-prompt              # Forced read-only (overrides every other prompt flag)
interceptor macos trust --prompt                 # Fire all three TCC prompts (non-blocking)
interceptor macos trust --walkthrough            # Prompt + open the next missing Privacy pane
interceptor macos trust --accessibility-prompt   # Single-permission prompt
interceptor macos trust --screen-prompt          # Single-permission prompt
interceptor macos trust --microphone-prompt      # Single-permission prompt
```

Every field — top-level `accessibility` / `screenRecording` / `microphone` plus `permissions[].status` — is a string drawn from Apple's `AVAuthorizationStatus` vocabulary: `granted | denied | not_determined | restricted`. AX and Screen Recording entries carry a `limitation` field because Apple's `AXIsProcessTrusted` / `CGPreflightScreenCaptureAccess` return `Bool` only and can't surface `not_determined` / `restricted`. The microphone prompt is non-blocking — when the user hasn't responded yet the response carries `microphone: "not_determined"` plus `pending_user_action: ["Microphone"]`; re-poll `interceptor macos trust` to observe the resolved state. The first time the mic prompt fires, the bridge briefly upgrades its activation policy to `.regular` (you'll see a Dock icon for ~5 s) so macOS surfaces a real modal dialog instead of a transient banner — same canonical pattern Hammerspoon and Bartender use for LSUIElement utilities.

Treat `interceptor macos trust` as a permission snapshot. Use `interceptor status` to confirm the daemon, helper, and bridge socket are actually alive before debugging native runtime failures.

| Permission | Required | What It Enables |
|-----------|----------|-----------------|
| Accessibility | Yes | UI element inspection, clicking, typing, window management |
| Screen Recording | No | Screenshots, screen capture, vision analysis |
| Microphone | No | Speech recognition, voice activity detection |
| Input Monitoring | No | `interceptor macos monitor` global key/click capture |

Grant permissions in: System Settings → Privacy & Security → [Permission] → Interceptor

## macOS Quick Start

```bash
interceptor macos open "Finder"                  # Tree + windows (background-first; pass --activate to foreground)
interceptor macos open "Finder" --activate       # Explicit foregrounding opt-in
interceptor macos read                           # Tree + frontmost app info
interceptor macos act e5                         # Click + wait + updated tree (AX press; no focus change)
interceptor macos act e3 "hello"                 # Type + wait + updated tree (AX value-set; no focus change)
interceptor macos inspect                        # Tree + apps + frontmost info
```

Background-first contract: only `interceptor macos app activate <app>` and `interceptor macos open <app> --activate` are allowed to move the user's frontmost window. Every other macOS verb leaves focus alone.

## macOS Commands

The Swift bridge exposes 28 domains. The five **daily-driver domains** are surfaced in full below; the remaining **specialized domains** are listed in tiered form with deep links to `docs/native/`. *Tiering means presentation, not deprecation — every domain the bridge supports today is still supported.*

### Daily-Driver Domain 1: Accessibility (AX)

Refs (`e1`, `e2`, ...) work the same as browser refs. AXObserver auto-invalidates when the tree changes.

**Bounded by construction.** `tree` and `find` walk under a per-command budget (node cap + wall-clock deadline). A large or slow app returns a **partial result** ending in a `… (stopped: <reason>)` marker rather than hanging — widen with `--max-nodes` / `--max-ms`, or scope with `--app` / `--depth`. **Secure fields are never emitted:** `interceptor macos text` on a password field (`AXSecureTextField`) returns `•••`, never the contents.

```bash
interceptor macos tree                           # AX tree for frontmost app
interceptor macos tree --app "Finder"            # Specific app
interceptor macos tree --filter interactive      # Only actionable elements (default)
interceptor macos tree --depth 5                 # Limit depth
interceptor macos tree --app Finder --max-nodes 500   # Bound nodes visited (partial + stop marker)
interceptor macos tree --app Finder --max-ms 3000     # Bound wall-clock time
interceptor macos find "Save" --role button      # Find elements by name/role
interceptor macos find "Save" --pid 1234         # --pid targets find/focused/windows too
interceptor macos inspect e5                     # All attributes + actions for ref
interceptor macos value e5                       # Read element value
interceptor macos value e5 "new text"            # Set element value
interceptor macos action e5 press                # Perform AX action
interceptor macos focused                        # Current focused element
interceptor macos windows                        # All windows with frames
interceptor macos windows --app "Finder"         # Specific app
interceptor macos move e1 --x 0 --y 25           # Move window
interceptor macos resize e1 --width 672 --height 983  # Resize window
interceptor macos move e1 --x 0 --y 25 --app "Finder" # --app/--pid forwarded for ref qualification
```

`move` and `resize` return a ground-truth geometry payload — the `frame`
field is read back from AX after the set, NOT echoed from the request.
When AX clamps the request against `NSScreen.visibleFrame` (e.g. height
exceeds the available rect after subtracting Dock + menu bar), the
response sets `clamped: true` and includes `clampedTo` with the legitimate
ceiling. The bridge runs one internal retry to absorb single-shot drift.
That response shape is the full contract for window geometry commands.

```jsonc
// resize within visibleFrame
{
  "frame":     {"x": 0, "y": 30, "width": 640, "height": 960},
  "requested": {"width": 640, "height": 960},
  "clamped":   false
}
// resize beyond visibleFrame ceiling
{
  "frame":     {"x": 0, "y": 25, "width": 640, "height": 970},
  "requested": {"width": 640, "height": 1040},
  "clamped":   true,
  "clampedTo": {"x": 0, "y": 25, "width": 1920, "height": 970}
}
```

### Daily-Driver Domain 2: Input (AX-first, PID-routed CGEvent fallback)

```bash
interceptor macos click e5                       # AX press on the ref — no focus change
interceptor macos click 500,300 --app "TextEdit" # CGEvent.postToPid → no focus change
interceptor macos click 500,300                  # CGEvent on system HID tap → follows frontmost (legacy)
interceptor macos click e5 --double              # Double-click
interceptor macos click e5 --right               # Right-click
interceptor macos type e5 "hello world"          # AX value-set on text-bearing role; no focus change
interceptor macos type "hello" --app "TextEdit"  # PID-routed keys; no focus change
interceptor macos type "hello world"             # Type at current focus (legacy fallback)
interceptor macos keys "Meta+C" --app "TextEdit" # PID-routed combo; no focus change
interceptor macos keys "Meta+C"                  # System HID tap (legacy)
interceptor macos scroll down --app "Signal"     # PID-routed scroll on backgrounded app
interceptor macos drag e5 e8                     # Drag between refs
interceptor macos drag 100,100 200,200 --app X   # PID-routed coordinate drag
```

Routing rule: when a ref is provided, input goes through AX (`AXUIElementPerformAction(kAXPressAction)` for clicks; `AXUIElementSetAttributeValue(kAXValueAttribute, ...)` for text-bearing roles). When `--app` or `--pid` is provided, synthesized events post via `CGEvent.postToPid` — the target does NOT need to be frontmost. With neither, input falls back to the system HID tap and follows the user's current frontmost app.

Each input verb returns a routing tag in its success message: `"ax-pressed ref"`, `"ax-set value (N chars)"`, `"clicked … → pid=NNNN"`, or `"clicked … → frontmost"`. If you see `→ frontmost` when you expected per-PID delivery, the target wasn't resolvable — pass `--app` or `--pid`.

### Daily-Driver Domain 3: Capture (ScreenCaptureKit)

```bash
interceptor macos screenshot                     # Frontmost window
interceptor macos screenshot --app "Finder"      # Specific app (works occluded / minimized / cross-Space)
interceptor macos screenshot --save              # Save to disk; payload key is `filePath` (not `path`)
interceptor macos capture start                  # Continuous 30fps capture
interceptor macos capture status                 # {active, hasFrame, frameAgeMs}
interceptor macos capture frame                  # returns {dataUrl, bytes, width, height, format} — parity with screenshot
interceptor macos capture frame --timeout-ms 5000  # Override the wait window for first-frame delivery
interceptor macos capture stop                   # Stop
```

The `--save` response contains `{ "filePath": "...", "format": ..., "bytes": ..., "width": ..., "height": ... }`. Read `filePath` for the path on disk. The `capture frame` response mirrors the same metadata shape, with `dataUrl` replacing `filePath` for in-memory delivery.

### Daily-Driver Domain 4: Monitor (Teach and Replay)

Same pattern as the browser monitor. Record what the user does across native apps via per-PID `AXObserver` + `NSWorkspace` + `NSEvent` global monitor, persist NDJSON to a per-session directory, then export a replayable script. The full surface covers AX-backed focus / value / menu / sheet / window events, NSEvent clicks / keys / scrolls / modifiers (with the coordinate-bug fix from the previous scaffold), and optional clipboard / file / network / log / notification / frame / OCR / speech inclusions gated by `--include`.

```bash
# Phase 1 — core monitor (Accessibility TCC required)
interceptor macos monitor start                  # frontmost-app default scope
interceptor macos monitor start --instruction "Show me how you file expenses"
interceptor macos monitor start --task "Teach Slack triage" --mode human-teach --app Slack
interceptor macos monitor start --app Slack      # scope to a single app
interceptor macos monitor start --apps Slack,Mail
interceptor macos monitor start --all-apps       # every running PID + new launches
interceptor macos monitor stop | pause | resume | status

# Phase 2 — optional observation sources
interceptor macos monitor start --include clipboard
interceptor macos monitor start --include files --watch-path ~/Downloads
interceptor macos monitor start --include network

# Phase 3 — analysis layers
interceptor macos monitor start --include log --log-predicate "subsystem == 'com.tinyspeck.slackmacgap'"
interceptor macos monitor start --include notifications

# Phase 4 — co-recording (Screen Recording / Microphone TCC required)
interceptor macos monitor start --frames 1                       # 1 fps SCStream
interceptor macos monitor start --frames 1 --vision-text         # + Vision OCR per frame
interceptor macos monitor start --include speech                 # SFSpeechRecognizer live

# Read paths
interceptor macos monitor tail                                   # live tail
interceptor macos monitor list                                   # all sessions on disk
interceptor macos monitor export <sid>                           # timeline
interceptor macos monitor export <sid> --plan                    # replayable interceptor macos *
interceptor macos monitor export <sid> --json                    # raw NDJSON
```

Sessions live at `${INTERCEPTOR_MONITOR_SESSIONS_DIR:-/tmp/interceptor-monitor-sessions}/<sid>/` with `events.jsonl`, `session.json`, optionally `frames/`. Records auto-stop after 24h and rotate `events.jsonl` at 100 MiB.

**Task envelopes and speech.** `--task "<name>"` wraps the session in a task that every `interceptor monitor task *` verb (`snapshot`, `quality`, `diagnose`) accepts by that name or by its generated `task-<id>`. End it with `interceptor macos monitor stop --task <taskId|name>`: that epilogue snapshots the sources, synthesizes the transcript, and grades blueprint readiness. `stop --sid <sid>` ends only the session and prints the owning task plus the two commands that finish it, and `monitor task quality` synthesizes a missing transcript itself before grading. With `--include speech`, live recognition emits throttled partials (`isFinal: false`, at most one per second) and an utterance-final `speech_segment` (`isFinal: true`, with text) at each boundary — recognition metadata, ~3 s of silence, the periodic task restart, or stop — because buffer-based `SFSpeechRecognizer` never finalizes on its own.

Permissions:

| Mode | TCC required |
|---|---|
| Default (no `--include` / no `--frames`) | Accessibility |
| `--frames N` or `--vision-text` | Accessibility + Screen Recording |
| `--include speech` | Accessibility + Microphone |
| Other `--include` flags (clipboard / files / network / log / notifications) | Accessibility |

Missing TCC produces structured errors: `missing_tcc:Accessibility` (exit 2), `missing_tcc:ScreenRecording` (exit 3), with `remediation:` field pointing at the corresponding `interceptor macos trust --*-prompt`.

### Daily-Driver Domain 5: Clipboard

```bash
interceptor macos clipboard read                 # Read clipboard
interceptor macos clipboard write "..."          # Write to clipboard
interceptor macos clipboard tail                 # Monitor clipboard changes
```

### Specialized Domains

*Every domain below is fully supported. Grouped here for discoverability — see `docs/native/` for the deep dive on each.*

#### Apps & Windows

```bash
interceptor macos apps                           # List running apps (name, pid, bundle ID)
interceptor macos app activate "Finder"          # Bring to front
interceptor macos app hide "Finder"              # Hide
interceptor macos app quit "Finder"              # Quit
interceptor macos app launch "com.apple.finder"  # Launch by bundle ID
interceptor macos frontmost                      # Current frontmost app
```

#### Menu Traversal

```bash
interceptor macos menu                           # Frontmost app's full menu tree
interceptor macos menu --app "Finder"            # Specific app
interceptor macos menu "File" "New Folder"       # Invoke menu item by path
```

#### Audio (system + microphone)

```bash
interceptor macos audio output start             # Capture system audio
interceptor macos audio input start              # Capture microphone
interceptor macos audio input start --save       # Capture mic AND write CAF file to /tmp/interceptor-audio-input-<unix-ts>.caf
interceptor macos audio input stop               # Stop; response carries `filePath` when --save was set
```

#### Speech & Voice Activity

```bash
interceptor macos listen start                   # Start speech recognition
interceptor macos listen stop                    # Stop + return transcript
interceptor macos listen transcript              # Current transcript
interceptor macos listen tail                    # Poll-friendly transcript stream
interceptor macos vad start                      # Voice activity detection
interceptor macos vad status                     # Is someone speaking? + RMS level
```

#### Sound Classification

```bash
interceptor macos sounds start                   # Sound classification (300+ types)
interceptor macos sounds status                  # Current detected sounds
```

#### Vision (on-device)

Vision derives `SCStreamConfiguration.width`/`height` from the
filter's `contentRect × pointPixelScale` (Apple's documented capture
pattern), and `recognizeText` enables `automaticallyDetectsLanguage`,
`recognitionLanguages = ["en-US"]`, and `usesLanguageCorrection`.

```bash
interceptor macos vision faces                   # Detect faces in frontmost window
interceptor macos vision text                    # OCR
interceptor macos vision text --app "Notes"      # OCR a specific (possibly occluded) window
interceptor macos vision hands                   # Hand pose detection
interceptor macos vision bodies                  # Body pose detection
```

#### Apple Intelligence (on-device LLM via FoundationModels)

The dispatch path now routes `ai` verbs to the built
`LanguageModelSession` handlers instead of returning "not implemented".
All three verbs are now functional on macOS 26+; older macOS surfaces a
structured "FoundationModels requires macOS 26.0+" error.

```bash
interceptor macos ai status                  # FoundationModels availability
interceptor macos ai prompt "Summarize this" # one-shot LanguageModelSession.respond
interceptor macos ai session start           # multi-turn session begin
interceptor macos ai session send "Hello"    # turn within active session
interceptor macos ai session history         # current session transcript
interceptor macos ai session end             # close session
```

#### Sensitive content (on-device via SensitiveContentAnalysis)

The `sensitive` verbs route to the existing `SCSensitivityAnalyzer()`
integration.

```bash
interceptor macos sensitive check            # current analysisPolicy state
interceptor macos sensitive monitor status   # monitor lifecycle
```

#### NLP (on-device, NaturalLanguage framework)

The `nlp` verbs route to the built NaturalLanguage backend. All six verbs
are functional:

```bash
interceptor macos nlp entities "Apple was founded in Cupertino"  # NLTagger / .nameType
interceptor macos nlp sentiment "great product"                  # NLTagger / .sentimentScore
interceptor macos nlp language "bonjour le monde"                # NLLanguageRecognizer
interceptor macos nlp tokens "the quick brown fox"               # NLTokenizer
interceptor macos nlp similar cat dog                            # NLEmbedding.distance
interceptor macos nlp embed "hello"                              # NLEmbedding.vector
```

#### Apple Intelligence (on-device LLM, macOS 26+)

```bash
interceptor macos ai prompt "Summarize this"     # On-device LLM (macOS 26+, Apple Intelligence)
```

#### Notifications

```bash
interceptor macos notifications tail             # Live notification stream
```

#### Trust & Permissions

```bash
interceptor macos trust                          # Read-only snapshot (status strings + System Settings paths)
interceptor macos trust --no-prompt              # Forced read-only — overrides every other prompt flag
interceptor macos trust --prompt                 # Fire all three TCC prompts (non-blocking)
interceptor macos trust --walkthrough            # Prompt + auto-open next missing Privacy pane
interceptor macos trust --accessibility-prompt   # Single-permission prompt
interceptor macos trust --screen-prompt          # Single-permission prompt
interceptor macos trust --microphone-prompt      # Single-permission prompt
```

Every status is a string from Apple's `AVAuthorizationStatus` vocabulary (`granted | denied | not_determined | restricted`). Mic prompt is non-blocking — re-poll to observe the user's response. See [Permissions](#permissions) above for the response-shape details.

#### Files & Filesystem

```bash
interceptor macos files watch ~/Desktop          # Watch directory for changes
interceptor macos fs read /path/to/file          # Native FileManager read
interceptor macos fs write /path/to/file "..."   # Native FileManager write
interceptor macos fs search "query"              # Spotlight (NSMetadataQuery)
```

See [`docs/native/fs.md`](docs/native/fs.md) for the `fs` domain detail.

#### URL Fetch (`url`)

```bash
interceptor macos url get "https://api.example.com/data"
interceptor macos url post "https://api.example.com/x" --body '{"k":"v"}'
```

URLSession + cookies + ETag + bodyRef sidecar for >64 KB responses. See [`docs/native/url-fetch.md`](docs/native/url-fetch.md).

#### Log Query

```bash
interceptor macos log query --subsystem com.apple.network --level error --last 30s
```

`OSLogStore` query with subsystem/category/level filters. See [`docs/native/log-query.md`](docs/native/log-query.md).

#### OSA Scripts and Apple Events

```bash
interceptor macos script run --jxa '1 + 1'
interceptor macos script run --jxa 'run = argv => argv.join("|")' --args '["alpha","beta"]'
interceptor macos script run --bundle com.brave.Browser --jxa 'target.openLocation("https://example.com")'
interceptor macos script run --jsc '1 + 1'
interceptor macos script run --jsc 'run = argv => argv.join("|")' --args '["alpha","beta"]'
interceptor macos script run --jsc 'host.sqlite("/tmp/example.sqlite", "select 1")' --jsc-host sqlite
interceptor macos script run --jsc 'host.sh("pwd").stdout' --jsc-host shell
interceptor macos script run --script 'tell application "Music" to play'
interceptor macos intent dispatch --script 'tell application id "com.brave.Browser" to open location "https://example.com"'
interceptor macos intent dispatch --jxa '1 + 1'
interceptor macos intent dispatch --bundle com.brave.Browser --jxa 'target.openLocation("https://example.com")'
interceptor macos intent warmup --bundle com.brave.Browser
```

Raw AppleScript/JXA runs through OSAKit; plain `--jsc` runs inside the bridge with JavaScriptCore and does not provide JXA's `Application(...)` host object. Add `--jsc-host [all|fs,sqlite,shell,osa,env]` only when the script needs native host capabilities. Structured `intent dispatch` stays as the Apple Events verb-dispatch surface. With `--bundle` on JXA, the bridge exposes `target = Application("<bundleId>")` and does not activate the target app by default. The older `--javascript` flag remains a compatibility alias for `--jxa`. TCC consent is per (bridge, target_app) pair. See [`docs/native/app-intent.md`](docs/native/app-intent.md).

#### Container Runtime (macOS 26+)

```bash
interceptor macos container run <image>
```

Run an OCI image in Apple's `container` runtime. See [`docs/native/container-run.md`](docs/native/container-run.md).

#### Display & Streaming

```bash
interceptor macos display list                   # All displays (physical + virtual)
interceptor macos display create 1920x1080       # Create virtual display
interceptor macos display remove <id>            # Remove virtual display
interceptor macos stream start --app "Finder"    # Start screen stream
interceptor macos stream frame                   # Latest frame
interceptor macos stream fps                     # Current FPS
interceptor macos stream stop                    # Stop
```

#### Text (selection / visible / full)

```bash
interceptor macos text                           # Read selection / visible / full text from frontmost app
```

#### Overlays

Particles / titans / scene-script / HTML overlays. Panic hotkey `Ctrl+Opt+Cmd+Escape` closes every active overlay regardless of session. See [`docs/native/overlays.md`](docs/native/overlays.md) and [`docs/native/scene-script-cookbook.md`](docs/native/scene-script-cookbook.md).

#### Documents

```bash
interceptor macos pdf info|text|outline|annotations|forms|images|find|attributes|permissions|annotate|strip|merge|split <path>
interceptor macos pdf forms set <path> --field <name> --value <string> [--out <out>]
interceptor macos pdf find <path> "<query>" [--case-sensitive]
interceptor macos pdf merge <p1> <p2> ... --out <out>
interceptor macos pdf split <path> --pages 1-5 --out <out>
interceptor macos detect types | run "<text>" | file <path>
interceptor macos translate text "<text>" --from <bcp47> --to <bcp47>            # macOS 15+
interceptor macos thumbnail <path> [--size N|WxH] [--save] [--out <path>] [--format png|jpeg|heic]
```

See [`docs/native/document.md`](docs/native/document.md) for PDFKit / DataDetection / Translation / QuickLookThumbnailing.

#### Secret vault (keychain-backed credentials, delivered by name)

Passwords and passcodes never travel as literal text. Store them once, then reference them by name on any surface; the daemon resolves the value after logging the action (name only), checks the secret's target allowlist against the real target, and hands it to exactly one delivery leg. The value never appears on argv, in the daemon log, the events file, monitor artifacts, MCP results, or `interceptor diagnose`.

```bash
interceptor macos secret register <name> [--gate none|touchid|biometry] [--target sudo|macos:<bundleId>|browser:<host>|ios|any]... [--reuse <s>]
                                                    # native box (secure field + confirm); default gate: none (unattended)
interceptor macos secret set <name> --stdin         # headless: value from stdin (hidden TTY prompt without --stdin)
interceptor macos secret list                       # names, gates, targets, release counts
interceptor macos secret status                     # backend + Touch ID availability
interceptor macos secret rm <name>
interceptor macos secret unlock <name> --for 30m    # one OS prompt now; releases inside the window skip the prompt
interceptor macos secret lock [<name>]
interceptor macos secret reveal <name>              # human read-back: always OS-gated, TTY only, refused under --json / MCP

interceptor macos sudo --secret <name> [--keep] -- installer -pkg X.pkg -target /   # root via sudo -S stdin
interceptor macos authdialog status                 # is an administrator prompt up? shape: touchid | password
interceptor macos authdialog fill --secret <name> [--submit]   # presses "Use Password" on a Touch ID sheet, types, submits
interceptor macos type [<ref>] --secret <name> [--app X]       # native field (target: macos:<bundleId>)
interceptor type <ref> --secret <name>              # browser field (target: browser:<host>); monitor records ***SECURE***
interceptor type <ref> --browser-login <host> [--user] [--browser <key>]   # fill a saved login from any installed Chromium browser; host must match the live tab
interceptor browser creds list [--host <host>]      # list saved logins across installed Chromium browsers (host + username + browser; no passwords; refused under MCP)
interceptor ios type <ref> --secret <name> | ios keys --secret <name> | ios unlock --secret <name>   # passcode sheets + lock screen (unlock needs a connected resident runner)
```

Items live in the data-protection keychain owned by the signed bridge (login keychain on unsigned dev builds); `~/.interceptor/secrets.json` holds names, gates, targets, and release counts only. Releases are unattended by default; `--gate touchid` asks the OS prompt (Touch ID, Apple Watch, or the Mac password when no sensor is available). A target mismatch fails with `target_denied` and is never retargeted.

#### Chrome saved logins (fill a password you never registered)

When the credential already lives in Chrome's own password manager, you do not need to register it in the vault. `type --chrome-login <host>` reads the saved login for the current page and fills it. Chrome does not fire its autofill dropdown for a synthetic click, so Interceptor reads the credential at rest instead: it fetches the `Chrome Safe Storage` key from the login keychain, decrypts the `Login Data` blob (macOS `v10`, AES-128-CBC) for the matching profile, and hands the value to the same delivery leg as `--secret`. The value never appears on argv, in logs, events, monitor artifacts, or MCP results.

The fill is bound to the page: the requested host must match the live tab's host, and the resolved credential's own origin must match too, so a page can only ever fill its own saved login. Enumeration (`chrome creds list`) returns host + username only, never the password, and is refused for model callers (`INTERCEPTOR_MCP`). macOS only; Chrome's newer app-bound encryption (`v20`) is refused rather than mis-decrypted. Reading `Login Data` requires the daemon to have Full Disk Access.

#### Personal data (TCC-gated)

```bash
interceptor macos auth confirm "<reason>" [--policy biometry|any|biometry-or-watch] [--reuse N]
interceptor macos calendar status|request|list|default|events|event|create|update|delete|move
interceptor macos reminders status|request|lists|all|incomplete|completed|create|update|complete|uncomplete|delete
interceptor macos contacts status|list|contact|me|find|create|update|delete|vcard|changes
interceptor macos photos status|albums|assets|asset|export|export-video|thumbnail|favorite|delete|add-to-album|import|changes
interceptor macos location status|current|monitor|geocode|reverse|distance
interceptor macos music status|search|library|song|album|play|pause|resume|stop|next|previous|now-playing
```

See [`docs/native/personal-data.md`](docs/native/personal-data.md).

#### Distribution

```bash
interceptor macos appintent list|registered|donate|update-parameters|supports
interceptor macos maps search "<query>" | directions --from "<a>" --to "<b>" [--transport mode] | eta
interceptor macos share services|airdrop|email|message|reading-list|desktop-picture|named|text|url
interceptor macos notifications post --title "..." --body "..." [--sound default] [--badge N]
interceptor macos notifications schedule-after --seconds N | schedule-at --date <ISO>
interceptor macos notifications pending|delivered|cancel|cancel-all|dismiss|dismiss-all|categories|badge
```

See [`docs/native/distribution.md`](docs/native/distribution.md).

## macOS Recipes

### Resize browser and open a URL
```bash
interceptor macos app activate "Brave Browser"
interceptor macos windows --app "Brave Browser"
interceptor macos move e1 --x 0 --y 25
interceptor macos resize e1 --width 672 --height 983
interceptor macos keys "Meta+t"
interceptor macos keys "Meta+l"
interceptor macos type "https://example.com"
interceptor macos keys "Return"
```

### Watch a user, learn the workflow, replay it
```bash
interceptor macos monitor start --instruction "file an expense"
# ... user works in native apps ...
interceptor macos monitor stop                   # Summary: 230 events, 2 minutes
interceptor macos monitor export <sid>           # Pretty timeline with timestamps
interceptor macos monitor export <sid> --plan    # Replayable interceptor macos commands
```

### Drive a backgrounded app without raising it
```bash
interceptor macos screenshot --app "Signal"      # Capture occluded window via CGSHWCaptureWindowList
interceptor macos tree --app "Signal"            # AX read auto-wakes via AXManualAccessibility
interceptor macos scroll down --app "Signal" --times 3   # Routes via CGEvent.postToPid
interceptor macos intent dispatch --bundle org.whispersystems.signal-desktop --script '...'
```

End-to-end "type into a backgrounded TextEdit while another app stays frontmost":

```bash
interceptor macos open "TextEdit"                            # background-first; reads AX state
REF=$(interceptor macos focused --app "TextEdit" --json | jq -r '.ref')
interceptor macos type "$REF" "hello, background world"      # → "ax-set value (...)"
interceptor macos value "$REF"                               # confirms the text landed
interceptor macos frontmost                                  # whatever was frontmost is unchanged
```

## macOS Safety

- **Panic hotkey** — `Ctrl+Opt+Cmd+Escape` closes every active overlay regardless of owning session. Bridge-side handler — no agent involvement required.
- **Credentials by name, never by value** — Passwords and passcodes come from the keychain-backed vault (`interceptor macos secret`) and are delivered by name; each secret carries a target allowlist (`sudo`, `macos:<bundleId>`, `browser:<host>`, `ios`) that the daemon checks against the real target before the keychain read. Values never reach argv, logs, events, monitor artifacts, or MCP results.
- **Permission tiers** — Allow (observational) / Ask (interactive: click, type, keys, drag, app quit/hide, clipboard write) / Deny (none by default — tune per environment).
- **TCC tracking** — Bridge ships as `.app` bundle so macOS TCC tracks grants correctly across reinstalls.

See [`docs/native/safety.md`](docs/native/safety.md) for the full safety contract.

---

## Future: Interceptor Windows

The CLI grammar reserves the `interceptor windows` namespace for a future Windows surface (UIA accessibility tree, Win32 input, ETW traces, native window management). It is **not built**, has no timeline, and ships no commands today. When it lands it will be a peer of the Browser and macOS surfaces — same daemon model, same ref convention, same agent loop, separate skill package at `.agents/skills/interceptor-windows/`. Documenting the reservation now keeps anyone from accidentally claiming the namespace for something else.

---

## Agent Instructions

`AGENTS.md` is the canonical repo instruction file for agentic tools. `CLAUDE.md` remains in the repo as a compatibility file for tools that still expect that filename.

Shared repo-local skills live under [`.agents/skills/`](.agents/skills/). Compatibility shims for other agent tools may point at the same backing directory.

The skill packages mirror the surface split:

- [`.agents/skills/interceptor-browser/`](.agents/skills/interceptor-browser/) — Browser surface fast path, network/scene/monitor references.
- [`.agents/skills/interceptor-macos/`](.agents/skills/interceptor-macos/) — macOS surface fast path, daily-driver and specialized-domain references, background-first contract.
- [`.agents/skills/interceptor/`](.agents/skills/interceptor/) — thin index skill: surface decision table + pointers. Kept as a compatibility shim for one release.
- `.agents/skills/interceptor-windows/` — **reserved path, not yet created.** Slot for the future Windows surface; do not create until the surface ships.

`interceptor skills adopt` links these into whichever AI runtimes it detects, and `interceptor skills status` reports one state per skill per runtime:

| State | Meaning | What `adopt` does |
|---|---|---|
| `linked` | Symlink (junction on Windows) already resolves to this pack's skill | nothing |
| `missing` | Nothing at that path | creates the link |
| `foreign` | A symlink pointing somewhere else, or a dangling one | replaces it — `ln -sfn` semantics destroy no data |
| `stale-copy` | A real directory, e.g. a physical copy from an older install | skipped; `--force` replaces it |
| `name-collision` | A directory whose name differs from the skill's **only by case** | skipped, and **`--force` will not touch it either** |

`name-collision` exists because Windows and default-configured APFS are case-insensitive: `lstat` on `skills/interceptor` happily resolves an unrelated `skills/Interceptor/` that another author hand-wrote, which `--force` would then delete. `readdir` reports the true casing, so the two are distinguishable. Rename or remove the existing directory yourself if you want this pack's skill linked there.

## Architecture Notes

No CDP is used for any default operation on the browser surface. Network capture is done by monkey-patching `fetch`/`XHR` in the page's JavaScript context — operating fully in user-space rather than via the debugger protocol. The macOS surface uses Apple-blessed APIs only (Accessibility, ScreenCaptureKit, AVFoundation, Speech, Vision, NaturalLanguage, OSLogStore, NSAppleScript, container runtime). Both surfaces multiplex over the same `interceptor` daemon Unix socket — see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full transport diagram.

## Development Verification

Use the verification command that matches the kind of change you made:

```bash
bun run typecheck    # Static typing across Bun host code and extension code
bun test             # Runtime tests and CLI/parser coverage
bash scripts/build.sh # Build compiled host binaries and extension bundles
```

- Run `bun run typecheck` when you change TypeScript types, runtime wiring, Chrome API usage, Bun socket usage, or any code that crosses host/extension boundaries.
- Run `bun test` when you change parser behavior, monitor/scene helpers, or any logic already covered by the repo test suite.
- Run `bash scripts/build.sh` when you need to verify the actual host binaries and extension bundles still compile.
- For changes that affect browser behavior or shared infrastructure, run all three.

## What NOT to Do

- **Don't take screenshots to understand a page** — use `interceptor tree` and `interceptor text`. Screenshots waste tokens.
- **Don't chain commands without sleep** — the extension needs time to process. `sleep 1` between actions.
- **Don't interact with tabs outside the interceptor group** without `--any-tab`.
- **Don't use CDP commands** (`interceptor network on`) unless you have a specific reason. Passive capture (`interceptor net log`) sees everything without the debugger infobanner.
- **Don't start the daemon manually** — it auto-starts on first command.
- **Don't `interceptor macos app activate` reflexively** — the macOS bridge is background-first. Activate only when the user asks for it.

## Credits

- [Ron Eddings](https://github.com/ronaldeddings/) created Interceptor.
- [Pedram Amini](https://github.com/pedramamini/) provided early feedback on the project. Pedram's platform, [Maestro](https://runmaestro.ai), was used as part of developing this project.
- [Daniel Miessler](https://github.com/danielmiessler/) for graciously coming up with the name `Interceptor` and EPIC project, [PAI](https://github.com/danielmiessler/PAI))
- [Klaus Agnoletti](https://github.com/klausagnoletti/) contributed Microsoft Edge and Vivaldi installer support — [PR #75](https://github.com/Hacker-Valley-Media/Interceptor/pull/75).
- [Alex Tabisz](https://github.com/atabisz/) contributed Linux (browser-only) support and made the macOS CoreGraphics FFI lazy so the daemon imports cleanly on non-Darwin — [PR #83](https://github.com/Hacker-Valley-Media/Interceptor/pull/83).
