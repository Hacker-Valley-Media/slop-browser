#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="host"
BUILD_ALL=0
ORIG_MANIFEST_VERSION=""
ORIG_NATIVE_BUILD_CONFIG=""
ORIG_VERSION_SOURCE=""

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
    --all) BUILD_ALL=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

stamp_version() {
  local sha date pkg_version platform_targets agent_dylibs_bundled
  sha=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
  if [[ "$sha" != "dev" ]] && [[ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
    sha="${sha}-dirty"
  fi
  date=$(git show -s --format=%cs HEAD 2>/dev/null || date -u +%Y-%m-%d)
  pkg_version=$(grep '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  if [[ -f cli/version.ts && -z "$ORIG_VERSION_SOURCE" ]]; then
    ORIG_VERSION_SOURCE="$(cat cli/version.ts)"
  fi
  if [[ -f shared/native-build-config.ts && -z "$ORIG_NATIVE_BUILD_CONFIG" ]]; then
    ORIG_NATIVE_BUILD_CONFIG="$(cat shared/native-build-config.ts)"
  fi
  cat > cli/version.ts <<EOF
// Sentinel values used when running from source (\`bun run cli\`).
// scripts/build.sh stamps real build values into this file just before
// each \`bun build --compile\` and restores it afterwards via \`git checkout\`.
export const VERSION = "$pkg_version"
export const BUILD_SHA = "$sha"
export const BUILD_DATE = "$date"
EOF
  platform_targets="false"
  if [[ "${INTERCEPTOR_ENABLE_PLATFORM_TARGETS:-0}" == "1" ]]; then
    platform_targets="true"
  fi
  agent_dylibs_bundled="false"
  if [[ "${INTERCEPTOR_INCLUDE_AGENT_DYLIBS:-0}" == "1" ]]; then
    agent_dylibs_bundled="true"
  fi
  cat > shared/native-build-config.ts <<EOF
/**
 * Build-time defaults for the Runtime Agent surface.
 *
 * scripts/build.sh stamps this file for compiled release artifacts and restores
 * it afterward. Source/dev defaults are the public profile: platform target
 * support and bundled agent dylibs are off unless an explicit research build
 * enables them.
 */
export const NATIVE_PLATFORM_TARGETS_ENABLED = $platform_targets
export const NATIVE_AGENT_DYLIBS_BUNDLED = $agent_dylibs_bundled
EOF
  # Keep extension/manifest.json#version in lockstep with package.json so the
  # extension reports the same version as the CLI / pkg / Sparkle artifacts.
  # Source manifest is restored after build. Without this, the manifest is
  # whatever someone hand-bumped last and silently drifts every release that
  # forgets to bump it.
  if [[ -f extension/manifest.json ]]; then
    if [[ -z "$ORIG_MANIFEST_VERSION" ]]; then
      ORIG_MANIFEST_VERSION=$(grep '"version"' extension/manifest.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
    fi
    sed -i.bak -E 's|("version":[[:space:]]*)"[^"]+"|\1"'"$pkg_version"'"|' extension/manifest.json
    rm -f extension/manifest.json.bak
  fi
}

restore_version() {
  if [[ -n "$ORIG_VERSION_SOURCE" ]]; then
    printf '%s\n' "$ORIG_VERSION_SOURCE" > cli/version.ts
  fi
  if [[ -n "$ORIG_NATIVE_BUILD_CONFIG" ]]; then
    printf '%s\n' "$ORIG_NATIVE_BUILD_CONFIG" > shared/native-build-config.ts
  else
    git checkout shared/native-build-config.ts 2>/dev/null || true
  fi
  # Restore only the version field (not the whole file) so other local changes
  # to the manifest (e.g. new keys) are preserved across builds.
  if [[ -f extension/manifest.json ]]; then
    local orig_version="$ORIG_MANIFEST_VERSION"
    if [[ -z "$orig_version" ]]; then
      orig_version=$(git show HEAD:extension/manifest.json 2>/dev/null | grep '"version"' | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
    fi
    if [[ -n "$orig_version" ]]; then
      sed -i.bak -E 's|("version":[[:space:]]*)"[^"]+"|\1"'"$orig_version"'"|' extension/manifest.json
      rm -f extension/manifest.json.bak
    fi
  fi
}

trap restore_version EXIT
stamp_version

build_extension() {
  echo "Building extension..."
  rm -rf extension/dist
  mkdir -p extension/dist
  bun build extension/src/background.ts --outdir=extension/dist --target=browser
  bun build extension/src/net-buffer-content.ts --outdir=extension/dist --target=browser
  bun build extension/src/content.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-canvas.ts --outdir=extension/dist --target=browser
  bun build extension/src/offscreen.ts --outfile=extension/dist/offscreen.js --target=browser
  bun build extension/src/popup.ts --outfile=extension/dist/popup.js --target=browser
  cp extension/manifest.json extension/dist/
  cp extension/offscreen.html extension/dist/
  cp extension/popup.html extension/dist/
  rm -rf extension/dist/icons
  cp -R extension/icons extension/dist/icons
  # Tesseract.js OCR assets — bundled for offline, cross-platform pixel OCR
  # (browser-only / non-macOS). Loaded from extension-local URLs by the
  # offscreen document; lazy-initialized on first `ocr` request.
  mkdir -p extension/dist/tesseract
  cp node_modules/tesseract.js/dist/worker.min.js extension/dist/tesseract/
  # OEM 1 (LSTM) cores: Tesseract.js picks relaxed-SIMD on Chrome/Brave 116+
  # (the manifest min), with plain SIMD-LSTM as the one-tier fallback.
  cp node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js extension/dist/tesseract/
  cp node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm extension/dist/tesseract/
  cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js extension/dist/tesseract/
  cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm extension/dist/tesseract/
  cp extension/tesseract-assets/eng.traineddata.gz extension/dist/tesseract/
  chmod 644 extension/dist/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist/icons extension/dist/tesseract 2>/dev/null || true
}

build_extension_mv2() {
  echo "Building Electron app extension (MV2)..."
  rm -rf extension/dist-mv2
  mkdir -p extension/dist-mv2
  bun build extension/src/background-electron.ts --outfile=extension/dist-mv2/background-electron.js --target=browser
  cp extension/dist/content.js extension/dist-mv2/content.js
  cp extension/dist/net-buffer-content.js extension/dist-mv2/net-buffer-content.js
  cp extension/dist/inject-canvas.js extension/dist-mv2/inject-canvas.js
  cp extension/dist/offscreen.html extension/dist-mv2/offscreen.html
  cp extension/dist/popup.html extension/dist-mv2/popup.html
  printf '%s\n' 'globalThis.INTERCEPTOR_APP_CONTEXT_ID = "app:electron";' > extension/dist-mv2/electron-config.js
  rm -rf extension/dist-mv2/icons
  cp -R extension/icons extension/dist-mv2/icons
  bun -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const manifest = {
  manifest_version: 2,
  name: "Interceptor Electron App Bridge",
  version: base.version,
  description: "Electron app bridge",
  key: base.key,
  icons: base.icons,
  permissions: ["tabs", "storage", "scripting", "webRequest", "webRequestBlocking", "<all_urls>"],
  background: { scripts: ["electron-config.js", "background-electron.js"], persistent: true },
  browser_action: {
    default_title: "Interceptor",
    default_popup: "popup.html",
    default_icon: base.action && base.action.default_icon ? base.action.default_icon : base.icons
  },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["net-buffer-content.js"], run_at: "document_start", all_frames: true },
    { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_idle", all_frames: true }
  ]
};
fs.writeFileSync("extension/dist-mv2/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
'
  chmod 644 extension/dist-mv2/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist-mv2/icons 2>/dev/null || true
}

build_extension_safari() {
  # Safari Web Extension (MV3). Retarget of the same src tree:
  # native-relay background (background-safari), portable content/inject scripts
  # reused verbatim from dist, and a permission-stripped manifest (Safari has no
  # debugger/tabGroups/offscreen/tabCapture/power/idle/sessions/pageCapture, so
  # OCR/pixel-capture route to the native `interceptor macos` lane, not tesseract).
  echo "Building Safari Web Extension (MV3)..."
  rm -rf extension/dist-safari
  mkdir -p extension/dist-safari
  bun build extension/src/background-safari.ts --outfile=extension/dist-safari/background-safari.js --target=browser
  cp extension/dist/content.js extension/dist-safari/content.js
  cp extension/dist/net-buffer-content.js extension/dist-safari/net-buffer-content.js
  cp extension/dist/inject-net.js extension/dist-safari/inject-net.js
  cp extension/dist/inject-canvas.js extension/dist-safari/inject-canvas.js
  cp extension/dist/popup.js extension/dist-safari/popup.js
  cp extension/popup.html extension/dist-safari/popup.html
  rm -rf extension/dist-safari/icons
  cp -R extension/icons extension/dist-safari/icons
  bun -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const manifest = {
  manifest_version: 3,
  name: "Interceptor",
  version: base.version,
  description: base.description,
  icons: base.icons,
  // Safari-supported permission subset (verified against WKWebExtension.Permission).
  // notifications has no permission constant and the packager rejects it, so it is
  // omitted; notifications route to the native macos lane.
  // declarativeNetRequestWithHostAccess is required by Safari for modifyHeaders and
  // redirect actions; declarativeNetRequest alone only authorizes block and allow.
  permissions: [
    "activeTab", "scripting", "tabs", "storage", "nativeMessaging", "cookies",
    "webNavigation", "declarativeNetRequest", "declarativeNetRequestWithHostAccess",
    "contextMenus", "alarms", "clipboardWrite"
  ],
  host_permissions: ["<all_urls>"],
  commands: base.commands,
  // The bundle is self-contained (bun inlines every import), so no type:module —
  // Safari does not honor a module service worker and warns on the key.
  background: { service_worker: "background-safari.js" },
  // Safari applies the extension-page CSP to its background worker. Keep the
  // loopback endpoints explicit for diagnostic/fallback probes. The selected
  // production path is the containing appex native relay.
  content_security_policy: {
    extension_pages: "script-src '"'"'self'"'"'; object-src '"'"'self'"'"'; connect-src ws://localhost:19222 ws://127.0.0.1:19222"
  },
  action: {
    default_title: "Interceptor",
    default_popup: "popup.html",
    default_icon: base.action && base.action.default_icon ? base.action.default_icon : base.icons
  },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["net-buffer-content.js"], run_at: "document_start", all_frames: true, match_origin_as_fallback: true },
    { matches: ["<all_urls>"], js: ["inject-net.js"], run_at: "document_start", world: "MAIN", all_frames: true, match_origin_as_fallback: true },
    { matches: ["<all_urls>"], js: ["inject-canvas.js"], run_at: "document_start", world: "MAIN", all_frames: true, match_origin_as_fallback: true },
    { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_idle", all_frames: true, match_origin_as_fallback: true }
  ]
};
fs.writeFileSync("extension/dist-safari/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
'
  chmod 644 extension/dist-safari/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist-safari/icons 2>/dev/null || true
}

build_extension_firefox() {
  # Firefox / Gecko WebExtension (MV3). Third retarget of the same src tree:
  # event-page background (background-firefox), content/inject scripts reused
  # verbatim from dist, and a Gecko-shaped manifest.
  #
  # Four things differ from the Chromium manifest and each one is load-bearing:
  #   * background.scripts, not background.service_worker — Gecko implements MV3
  #     with event pages; a service_worker key makes the extension fail to load.
  #   * browser_specific_settings.gecko.id — required, and it is the value the
  #     native-messaging manifest lists under allowed_extensions (Chromium keys
  #     that on chrome-extension:// origins instead), so the two must agree.
  #   * no "key" — that is Chromium's deterministic-id mechanism; Gecko derives
  #     identity from the gecko.id above and warns on the unknown key.
  #   * a reduced permission set — see FIREFOX_DROPPED below.
  echo "Building Firefox WebExtension (MV3)..."
  rm -rf extension/dist-firefox
  mkdir -p extension/dist-firefox
  bun build extension/src/background-firefox.ts --outfile=extension/dist-firefox/background-firefox.js --target=browser
  cp extension/dist/content.js extension/dist-firefox/content.js
  cp extension/dist/net-buffer-content.js extension/dist-firefox/net-buffer-content.js
  cp extension/dist/inject-net.js extension/dist-firefox/inject-net.js
  cp extension/dist/inject-canvas.js extension/dist-firefox/inject-canvas.js
  cp extension/dist/popup.js extension/dist-firefox/popup.js
  cp extension/popup.html extension/dist-firefox/popup.html
  rm -rf extension/dist-firefox/icons
  cp -R extension/icons extension/dist-firefox/icons
  bun -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
// Permissions Gecko has no implementation for. Listing one is not fatal (Firefox
// warns and ignores it) but it would misrepresent the surface to anyone reading
// the manifest, and the matching verbs fail at the API call either way.
const FIREFOX_DROPPED = new Set([
  "tabGroups",     // no browser.tabGroups; tab-group listeners degrade to ungrouped
  "debugger",      // no CDP lane in Gecko
  "power",         // no browser.power; keepawake has no backend
  "offscreen",     // no offscreen documents -> tesseract OCR cannot run
  "tabCapture",    // no browser.tabCapture
  "pageCapture",   // no browser.pageCapture
  "userScripts",   // Gecko userScripts is a different, MV2-shaped API
  "search",        // browser.search exists but with an incompatible shape
]);
const manifest = {
  manifest_version: 3,
  name: "Interceptor",
  version: base.version,
  description: base.description,
  icons: base.icons,
  // Gecko requires an explicit add-on id for native messaging. Keep it in
  // lockstep with allowed_extensions in daemon/com.interceptor.host.firefox.json.
  // strict_min_version 129: content_scripts world:"MAIN" landed in 128 and
  // match_origin_as_fallback in 129, and both are used below.
  browser_specific_settings: {
    gecko: { id: "interceptor@hackervalley.media", strict_min_version: "129.0" }
  },
  permissions: base.permissions.filter((p) => !FIREFOX_DROPPED.has(p)),
  host_permissions: base.host_permissions,
  commands: base.commands,
  // Event page. The bundle is self-contained (bun inlines every import), so no
  // type:module — Gecko accepts it but it buys nothing here.
  background: { scripts: ["background-firefox.js"] },
  content_security_policy: base.content_security_policy,
  action: {
    default_title: "Interceptor",
    default_popup: "popup.html",
    default_icon: base.action && base.action.default_icon ? base.action.default_icon : base.icons
  },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["net-buffer-content.js"], run_at: "document_start", all_frames: true, match_origin_as_fallback: true },
    { matches: ["<all_urls>"], js: ["inject-net.js"], run_at: "document_start", world: "MAIN", all_frames: true, match_origin_as_fallback: true },
    { matches: ["<all_urls>"], js: ["inject-canvas.js"], run_at: "document_start", world: "MAIN", all_frames: true, match_origin_as_fallback: true },
    { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_idle", all_frames: true, match_origin_as_fallback: true }
  ]
};
fs.writeFileSync("extension/dist-firefox/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
'
  chmod 644 extension/dist-firefox/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist-firefox/icons 2>/dev/null || true
}

build_host() {
  echo "Building CLI (host)..."
  bun build cli/index.ts --compile --outfile=dist/interceptor
  echo "Building daemon (host)..."
  bun build daemon/index.ts --compile --outfile=daemon/interceptor-daemon
}

build_macos() {
  echo "Building CLI (macOS arm64)..."
  bun build cli/index.ts --compile --target=bun-darwin-arm64 --outfile=dist/interceptor
  echo "Building daemon (macOS arm64)..."
  bun build daemon/index.ts --compile --target=bun-darwin-arm64 --outfile=daemon/interceptor-daemon
}

# Windows keeps a mandatory write lock on a running .exe, so `bun build
# --compile` over a live binary fails with a bare EPERM. This MUST run before the
# first compile: build_host writes the CLI first (bun appends .exe on a Windows
# host), so a locked daemon would otherwise leave a freshly-built CLI beside a
# stale daemon — a half-updated pair that reads as a clean build (`set -e` does
# exit 1, but the CLI on disk is already new, and the two then disagree on
# protocol).
#
# taskkill is NOT the remedy: the daemon is a browser-launched native-messaging
# host, so the browser respawns it within a second (measured — five kills in a
# row never yielded an unlocked window). What DOES work is what Inno's Restart
# Manager path does: the lock forbids write and delete but permits RENAME, so the
# live image is moved aside and the compile writes a fresh file at the original
# path. The sidelined copy keeps running until its browser drops it, and is
# ignored by git (dist/ is wholly ignored; daemon/*.exe.old-* is an explicit rule
# because daemon/*.exe does NOT match a .exe.old-NNN suffix).
prepare_windows_outputs() {
  local out bak stuck=()
  for out in dist/interceptor.exe daemon/interceptor-daemon.exe; do
    [[ -f "$out" ]] || continue
    # Append zero bytes: opens for write without changing content. A running
    # image refuses it; nothing else here does.
    if (printf '' >> "$out") 2>/dev/null; then
      continue
    fi
    # Reap earlier sidelined copies whose holder has since exited. Done BEFORE
    # the rename below so the glob cannot match the copy we are about to create;
    # still-locked ones simply refuse deletion and are left for the next run.
    rm -f "${out}.old-"* 2>/dev/null || true
    bak="${out}.old-$$"
    if mv "$out" "$bak" 2>/dev/null; then
      echo "  note: $out was locked by a running process — moved aside to $bak"
    else
      stuck+=("$out")
    fi
  done
  if [[ ${#stuck[@]} -eq 0 ]]; then
    return 0
  fi
  echo "" >&2
  echo "ERROR: Windows build target(s) are locked and could not be moved aside:" >&2
  for out in "${stuck[@]}"; do echo "  $out" >&2; done
  echo "" >&2
  echo "       Close the browser that owns the native-messaging host (the daemon is" >&2
  echo "       respawned on demand, so taskkill alone will not free it), then re-run." >&2
  echo "       Stopped before compiling so you don't get a new CLI beside a stale daemon." >&2
  exit 1
}

build_windows_arch() {
  local arch="$1"
  local bun_target stage identity_flag
  case "$arch" in
    x64) bun_target="bun-windows-x64-baseline" ;;
    arm64) bun_target="bun-windows-arm64" ;;
    *) echo "Unsupported Windows architecture: $arch" >&2; exit 1 ;;
  esac

  stage="dist/windows/$arch"
  rm -rf "$stage"
  mkdir -p "$stage/daemon"

  echo "Building CLI (Windows $arch, $bun_target)..."
  bun build cli/index.ts --compile --target="$bun_target" --outfile="$stage/interceptor.exe"
  echo "Building daemon (Windows $arch, $bun_target)..."
  bun build daemon/index.ts --compile --target="$bun_target" --outfile="$stage/daemon/interceptor-daemon.exe"

  cp assets/windows/interceptor.ico "$stage/interceptor.ico"
  identity_flag=()
  if [[ "${INTERCEPTOR_WINDOWS_IDENTITY_MODE:-production}" == "development" ]]; then
    identity_flag=(--development)
  fi
  bun scripts/installer/generate-native-host.ts ${identity_flag[@]+"${identity_flag[@]}"} \
    --output "$stage/daemon/com.interceptor.host.json"

  # Bundle the unpacked browser extension so the installer drops it on disk at
  # {app}\extension — a single, stable place for the user to point "Load
  # unpacked" (Developer mode). Mirrors the macOS package, which ships it under
  # ~/Library/Application Support/Interceptor/extension. Every target that calls
  # build_windows_arch builds the extension first (see the dispatch below), so
  # dist is always current here; fail loud rather than stage a stale copy.
  if [[ ! -f extension/dist/manifest.json ]]; then
    echo "extension/dist is missing — build_extension must run before build_windows_arch" >&2
    exit 1
  fi
  rm -rf "$stage/extension"
  cp -R extension/dist "$stage/extension"
}

build_linux_arch() {
  local arch="$1"
  local bun_target stage

  # x64 uses the -baseline target on purpose. The non-baseline bun-linux-x64
  # build requires AVX2, which is absent under x86-64 emulation (Rosetta /
  # qemu-user, i.e. every amd64 container on an Apple-Silicon host) and on
  # pre-Haswell hardware; the binary SIGILLs on first instruction with no
  # diagnostic. Same rationale as bun-windows-x64-baseline above.
  #
  # The -musl variants target Alpine and other musl distros. A glibc-linked
  # binary does not run there at all (the loader path itself differs), so this
  # is a separate artifact, not a compatibility flag.
  case "$arch" in
    x64)         bun_target="bun-linux-x64-baseline" ;;
    arm64)       bun_target="bun-linux-arm64" ;;
    x64-musl)    bun_target="bun-linux-x64-musl-baseline" ;;
    arm64-musl)  bun_target="bun-linux-arm64-musl" ;;
    *) echo "Unsupported Linux architecture: $arch" >&2; exit 1 ;;
  esac

  stage="dist/linux/$arch"
  rm -rf "$stage"
  mkdir -p "$stage/daemon" "$stage/scripts"

  echo "Building CLI (Linux $arch, $bun_target)..."
  bun build cli/index.ts --compile --target="$bun_target" --outfile="$stage/interceptor"
  echo "Building daemon (Linux $arch, $bun_target)..."
  bun build daemon/index.ts --compile --target="$bun_target" --outfile="$stage/daemon/interceptor-daemon"

  # Native-messaging manifest template. Unlike Windows (registry + a fixed
  # relative path) Linux hosts read an absolute `path` out of the JSON, so the
  # template ships with the __DAEMON_PATH__ placeholder and scripts/install.sh
  # resolves it against wherever the package was extracted.
  cp daemon/com.interceptor.host.json "$stage/daemon/com.interceptor.host.json"
  cp daemon/com.interceptor.host.firefox.json "$stage/daemon/com.interceptor.host.firefox.json"

  # Layout below is exactly what scripts/install.sh expects to find relative to
  # its own parent dir, so the staged tree is directly installable after
  # extraction: `bash scripts/install.sh --browser-only --chrome`.
  if [[ ! -f extension/dist/manifest.json ]]; then
    echo "extension/dist is missing — build_extension must run before build_linux_arch" >&2
    exit 1
  fi
  rm -rf "$stage/extension"
  mkdir -p "$stage/extension"
  cp -R extension/dist "$stage/extension/dist"
  # Gecko retarget ships alongside the Chromium one; scripts/install.sh picks
  # the directory that matches the chosen browser.
  if [[ ! -f extension/dist-firefox/manifest.json ]]; then
    echo "extension/dist-firefox is missing — build_extension_firefox must run before build_linux_arch" >&2
    exit 1
  fi
  cp -R extension/dist-firefox "$stage/extension/dist-firefox"

  cp scripts/install.sh scripts/uninstall.sh "$stage/scripts/"

  # Skill packs next to the CLI binary — resolvePackDir() in cli/commands/skills.ts
  # looks for <dir of argv0>/skills, so `interceptor skills adopt` works from the
  # extracted package without a repo checkout. Mirrors the Windows {app}\skills
  # staging in scripts/installer/interceptor.iss.
  rm -rf "$stage/skills"
  mkdir -p "$stage/skills"
  for pack in interceptor interceptor-browser interceptor-research; do
    cp -R ".agents/skills/$pack" "$stage/skills/$pack"
  done
  find "$stage/skills" -name '._*' -delete 2>/dev/null || true

  chmod 755 "$stage/interceptor" "$stage/daemon/interceptor-daemon"
}

build_bridge() {
  # Swift-only, macOS-only. Warn-and-continue on CI/linux hosts.
  if ! command -v swift >/dev/null 2>&1; then
    echo "Skipping interceptor-bridge (swift toolchain not found)"
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Skipping interceptor-bridge (not on macOS)"
    return 0
  fi
  echo "Building interceptor-bridge (macOS native)..."
  bash scripts/build-bridge.sh
}

# Preflight before any bundling: a locked .exe is a user-fixable condition, and
# there is no point spending an extension build to discover it. The trigger is the
# host target (the default) plus --all, because build_host is what writes
# dist/interceptor.exe and daemon/interceptor-daemon.exe on a Windows host. The
# windows-x64 / windows-arm64 targets stage into dist/windows/<arch>/ instead and
# are not covered here.
if [[ "$BUILD_ALL" == "1" || "$TARGET" == "host" ]]; then
  prepare_windows_outputs
fi

if [[ "$BUILD_ALL" == "1" ]]; then
  build_extension
  build_extension_mv2
  build_extension_safari
  build_extension_firefox
  build_host
  build_macos
  build_windows_arch x64
  build_windows_arch arm64
  build_linux_arch x64
  build_linux_arch arm64
  build_linux_arch x64-musl
  build_linux_arch arm64-musl
  build_bridge
elif [[ "$TARGET" == "host" ]]; then
  build_extension
  build_extension_mv2
  build_extension_safari
  build_extension_firefox
  build_host
  build_bridge
elif [[ "$TARGET" == "macos" ]]; then
  build_extension
  build_extension_mv2
  build_extension_safari
  build_extension_firefox
  build_macos
  build_bridge
elif [[ "$TARGET" == "windows-x64" ]]; then
  build_extension
  build_windows_arch x64
elif [[ "$TARGET" == "windows-arm64" ]]; then
  build_extension
  build_windows_arch arm64
elif [[ "$TARGET" == "windows" ]]; then
  echo "Unsupported target: windows. Use --target=windows-x64 or --target=windows-arm64." >&2
  exit 1
elif [[ "$TARGET" == "linux-x64" ]]; then
  build_extension
  build_extension_firefox
  build_linux_arch x64
elif [[ "$TARGET" == "linux-arm64" ]]; then
  build_extension
  build_extension_firefox
  build_linux_arch arm64
elif [[ "$TARGET" == "linux-x64-musl" ]]; then
  build_extension
  build_extension_firefox
  build_linux_arch x64-musl
elif [[ "$TARGET" == "linux-arm64-musl" ]]; then
  build_extension
  build_extension_firefox
  build_linux_arch arm64-musl
elif [[ "$TARGET" == "linux" ]]; then
  echo "Unsupported target: linux. Use --target=linux-x64, linux-arm64, linux-x64-musl, or linux-arm64-musl." >&2
  exit 1
else
  echo "Unsupported target: $TARGET" >&2
  exit 1
fi

# Ad-hoc sign macOS binaries. Apple Silicon SIGKILLs unsigned Mach-O executables
# (symptom: `interceptor` exits 137 / "Killed: 9" with empty output, daemon never
# stays up). `bun build --compile` output can land unsigned or with a malformed
# signature slot, so remove any existing signature then re-sign ad-hoc.
# No --entitlements here: entitlement enforcement only applies under the
# hardened runtime, which ad-hoc signing doesn't enable. Release builds are
# re-signed (--force) with the real identity + entitlements by release.sh.
# Cross-target stages (windows-*, linux-*) produce PE/ELF images that codesign
# cannot sign and that this host cannot execute — signing or smoke-running them
# here would fail the build on a correct artifact.
if [[ "$(uname -s)" == "Darwin" && "$TARGET" != windows-* && "$TARGET" != linux-* ]] && command -v codesign >/dev/null 2>&1; then
  for b in dist/interceptor daemon/interceptor-daemon dist/interceptor-bridge; do
    if [[ -f "$b" ]]; then
      codesign --remove-signature "$b" 2>/dev/null || true
      codesign --force --sign - "$b" && echo "  signed (adhoc): $b"
      codesign --verify --strict "$b"
    fi
  done
  # Smoke check: the exact failure this signing step fixes is a silent
  # Killed:9 at first run, so prove the CLI actually executes.
  if [[ "$TARGET" != windows-* && -x dist/interceptor ]]; then
    ./dist/interceptor --version >/dev/null
    echo "  smoke check: dist/interceptor --version OK"
  fi
fi

echo "Build complete."
if [[ "$BUILD_ALL" == "1" ]]; then
  echo "  Extension: extension/dist/"
  echo "  Electron extension: extension/dist-mv2/"
  echo "  Safari extension: extension/dist-safari/"
  echo "  Firefox extension: extension/dist-firefox/"
  echo "  Host CLI:   dist/interceptor"
  echo "  Host Daemon: daemon/interceptor-daemon"
  echo "  macOS CLI:  dist/interceptor"
  echo "  macOS Daemon: daemon/interceptor-daemon"
  echo "  macOS Bridge: dist/interceptor-bridge"
  echo "  Windows x64: dist/windows/x64/"
  echo "  Windows ARM64: dist/windows/arm64/"
  echo "  Linux x64: dist/linux/x64/"
  echo "  Linux ARM64: dist/linux/arm64/"
  echo "  Linux x64 (musl): dist/linux/x64-musl/"
  echo "  Linux ARM64 (musl): dist/linux/arm64-musl/"
elif [[ "$TARGET" == "windows-x64" ]]; then
  echo "  Windows x64: dist/windows/x64/"
elif [[ "$TARGET" == "windows-arm64" ]]; then
  echo "  Windows ARM64: dist/windows/arm64/"
elif [[ "$TARGET" == "linux-x64" ]]; then
  echo "  Linux x64: dist/linux/x64/"
elif [[ "$TARGET" == "linux-arm64" ]]; then
  echo "  Linux ARM64: dist/linux/arm64/"
elif [[ "$TARGET" == "linux-x64-musl" ]]; then
  echo "  Linux x64 (musl): dist/linux/x64-musl/"
elif [[ "$TARGET" == "linux-arm64-musl" ]]; then
  echo "  Linux ARM64 (musl): dist/linux/arm64-musl/"
else
  echo "  Extension: extension/dist/"
  echo "  Electron extension: extension/dist-mv2/"
  echo "  Safari extension: extension/dist-safari/"
  echo "  Firefox extension: extension/dist-firefox/"
  echo "  CLI:       dist/interceptor"
  echo "  Daemon:    daemon/interceptor-daemon"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  Bridge:    dist/interceptor-bridge"
  fi
fi
