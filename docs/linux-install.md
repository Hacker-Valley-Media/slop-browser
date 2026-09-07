# Install Interceptor on Linux

Interceptor for Linux is browser-only: CLI + daemon + WebExtension. The `interceptor macos *` and `interceptor ios *` surfaces need a macOS host and are gated off automatically — `interceptor status` reports `mode: browser-only` and the macOS/iOS verbs return the surface hint instead of a bridge error.

Supported: glibc x86-64 and arm64 (Ubuntu 22.04+, Debian 12+, Fedora 39+ and equivalents), plus musl builds for Alpine. The x64 build targets the baseline instruction set, so it also runs under x86-64 emulation (Rosetta/qemu) and on pre-AVX2 CPUs.

Supported browsers: **Chrome**, **Chromium**, **Brave** (one MV3 build), and **Firefox** (a separate Gecko build).

## Install from a package

```bash
sudo dpkg -i interceptor-<version>-linux-x64.deb      # Debian / Ubuntu
sudo rpm -i  interceptor-<version>-linux-x64.rpm      # Fedora / RHEL / openSUSE
```

Both install to `/opt/interceptor` and put `interceptor` on `PATH`. They deliberately stop there: registering a native-messaging host writes into `~/.config` or `~/.mozilla`, which is per-user state a root install must not create for one arbitrary user. Finish per user:

```bash
interceptor-install --browser-only --chrome     # or --chromium, --brave, --firefox
```

## Install from a tarball

```bash
tar xzf interceptor-<version>-linux-x64.tar.gz
sudo mv interceptor-<version>-linux-x64 /opt/interceptor
bash /opt/interceptor/scripts/install.sh --browser-only --chrome
```

`install.sh` symlinks the CLI into `~/.local/bin` (override with `--link-cli-dir <dir>`, skip with `--no-link-cli`) and tells you if that directory is not on your `PATH`.

**Alpine / musl:** the musl build links libstdc++ and libgcc dynamically, which bare Alpine does not ship. Install them first, or the binary exits with `Error loading shared library libstdc++.so.6`:

```bash
apk add libstdc++ libgcc
```

## Build from source

```bash
bun install                                        # see .bun-version for the pin
bash scripts/build.sh --target=linux-x64           # linux-arm64, linux-x64-musl, linux-arm64-musl
bash scripts/package-linux.sh --arch x64           # tar.gz + deb + rpm into dist/linux/packages
```

The staged tree in `dist/linux/<arch>/` is directly installable after extraction:

```
interceptor                              the CLI
daemon/interceptor-daemon                the daemon the browser spawns as a native-messaging host
daemon/com.interceptor.host.json         native-host manifest template (Chromium family)
daemon/com.interceptor.host.firefox.json native-host manifest template (Gecko)
extension/dist/                          unpacked MV3 extension — Chrome, Chromium, Brave
extension/dist-firefox/                  unpacked MV3 extension — Firefox
skills/                                  skill packs, found by `interceptor skills adopt`
scripts/install.sh, uninstall.sh
```

Cross-compiling from macOS works too — the same `--target=linux-x64` flag produces the Linux artifacts and skips the macOS signing step.

## Native-messaging host locations

`install.sh` resolves `__DAEMON_PATH__` to the real daemon path and symlinks the manifest into the browser's per-user directory:

| Browser | Native-messaging host directory |
|---|---|
| Google Chrome | `~/.config/google-chrome/NativeMessagingHosts/` |
| Chromium | `~/.config/chromium/NativeMessagingHosts/` |
| Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` |
| Firefox | `~/.mozilla/native-messaging-hosts/` |

The Chromium-family dirs follow `$XDG_CONFIG_HOME`. Firefox's does not — Gecko keeps one host directory per user, outside both the XDG tree and the profile tree, shared by every Firefox profile. Chrome's other channels, Edge and Vivaldi are not auto-detected on Linux yet; their manifest can be dropped into the matching `~/.config/<product>/NativeMessagingHosts/` by hand.

The two manifests differ in more than location: Chromium authorizes by extension origin (`allowed_origins: ["chrome-extension://…"]`) while Gecko authorizes by add-on id (`allowed_extensions: ["interceptor@hackervalley.media"]`).

## Load the extension

### Chromium and Brave

They honor `--load-extension`, so `install.sh --chromium` / `--brave` loads and launches in one step. It first checks that the target profile has Developer mode on — without it Chromium silently drops the flag and every browser verb would time out.

### Google Chrome

Branded Chrome ignores `--load-extension` on every desktop platform, Linux included. Use the developer flow:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `/opt/interceptor/extension/dist`.
3. Confirm the ID is `hkjbaciefhhgekldhncknbjkofbpenng`.

### Firefox

Firefox has no command-line switch for unpacked add-ons.

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `/opt/interceptor/extension/dist-firefox/manifest.json`.
3. If page verbs return nothing, grant host access: **about:addons → Interceptor → Permissions → "Access your data for all websites"** (Firefox MV3 treats host permissions as optional).

A temporary add-on is dropped when Firefox quits; a signed XPI installs permanently. Firefox registers as the fixed context `firefox`, so with more than one browser connected address it as `--context firefox`.

## Verify

```bash
interceptor init --verbose
interceptor status --verbose
```

Expect `mode: browser-only`, `extension: reachable`, and a `browser:` block listing every configured native-messaging host plus the system default browser (read from `xdg-settings`).

Optional, not linked automatically:

```bash
interceptor skills adopt
```

## Uninstall

```bash
bash /opt/interceptor/scripts/uninstall.sh    # per-user state
sudo dpkg -r interceptor                      # or: sudo rpm -e interceptor
```

`uninstall.sh` removes the native-messaging manifests for all four browsers, the generated manifests, the CLI symlink it created, and daemon runtime files. It leaves recorded monitor sessions (`~/.local/state/interceptor/tasks`) and the browser extension itself in place.

## What is not available on Linux

| Capability | Status |
|---|---|
| `interceptor macos *`, `interceptor ios *` | macOS host only; the surface gate prints the upgrade hint |
| `interceptor upgrade --full` | macOS only (the bridge is Swift/AppKit) |
| `act --os`, `click --trusted`, OS-level input | No backend. The daemon returns an explicit "not supported on this platform" sentinel, tells the extension so at registration, and `interceptor capabilities` reports `os_input: false` |
| Sparkle auto-update (`interceptor update`) | macOS only; reinstall the package |

Firefox additionally lacks, by Gecko API surface:

| Verb | Why |
|---|---|
| `ocr` | No offscreen-document API, so the bundled tesseract worker has nowhere to run |
| `keepawake` | No `browser.power` |
| `macos cdp *` | No `chrome.debugger` |
| `eval` | Gecko applies the extension CSP and has no `userScripts` fallback in this build |
| `bookmarks` (tree form) | `bookmarks.getTree()` rejects on Gecko; `bookmarks --query` works |
| tab groups | No `browser.tabGroups`; grouping degrades to ungrouped, everything else is unaffected |

Everything else — page reads, a11y trees, actions, navigation, tabs/frames, passive fetch/XHR/SSE/WebSocket/BroadcastChannel capture, HAR/pcapng export, DOM-render screenshots, `save`, monitor record, MCP, skills — runs on all four browsers.

## Troubleshooting

**`extension: not reachable`** — the extension is not loaded, or Developer mode is off in the profile the browser actually opened. Re-check the extensions page. On Firefox, a temporary add-on is gone after a restart.

**`binary mismatch` from `interceptor diagnose`** — the daemon path inside the browser's `com.interceptor.host.json` no longer matches the running daemon (usually after moving the package). Re-run `install.sh`.

**A code change does not take effect in Chromium** — a reused profile can keep the previous extension service worker. Launch once with a fresh `--user-data-dir`, or remove and re-add the unpacked extension.

**Chrome/Chromium in a container** — Chromium needs user namespaces for its sandbox. Containers started without them need `--security-opt seccomp=unconfined` (preferred) or the browser launched with `--no-sandbox`.
