#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_PATH="$ROOT/daemon/interceptor-daemon"
TEMPLATE_PATH="$ROOT/daemon/com.interceptor.host.json"
# Where the resolved native-messaging manifest is written. A dev checkout keeps
# it next to the daemon; a system-wide install (deb/rpm under /opt) cannot —
# the prefix is root-owned and the manifest is per-user state anyway, since it
# is what the per-user NativeMessagingHosts symlink points at. Fall back to the
# XDG state home, the same root shared/monitor-tasks.ts already uses on Linux.
if [[ -w "$ROOT/daemon" ]] || [[ ! -e "$ROOT/daemon" && -w "$ROOT" ]]; then
  GENERATED_DIR="$ROOT/daemon/.generated"
else
  GENERATED_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/interceptor"
fi
GENERATED_MANIFEST="$GENERATED_DIR/com.interceptor.host.json"
EXTENSION_DIR="$ROOT/extension/dist"
# Gecko variants. Firefox keys native-messaging access on the add-on id
# (allowed_extensions) rather than a chrome-extension:// origin, so it needs its
# own manifest template — and its own extension build, since Gecko MV3 uses an
# event page instead of a service worker. Both are selected in one place below.
GECKO_TEMPLATE_PATH="$ROOT/daemon/com.interceptor.host.firefox.json"
GECKO_GENERATED_MANIFEST="$GENERATED_DIR/com.interceptor.host.firefox.json"
GECKO_EXTENSION_DIR="$ROOT/extension/dist-firefox"
INSTALL_BRIDGE_SCRIPT="$ROOT/scripts/install-bridge.sh"

# ── Platform detection ────────────────────────────────────────────────────────
PLATFORM="$(uname -s)"   # Darwin | Linux

# Profile root (Chromium "User Data" dir) for a browser target on this platform.
# Edge and Vivaldi are Darwin-only in this revision (Linux support deferred to a
# follow-up PRD; their User Data dirs on Linux are ~/.config/microsoft-edge and
# ~/.config/vivaldi but install-detection across distros isn't covered yet).
#
# Google Chrome ships four sibling channels alongside stable — Beta, Canary, Dev,
# and "Chrome for Testing" — each with its own User Data dir under
# ~/Library/Application Support/Google/. Treated here as distinct browser targets
# so a single host can register Interceptor against any combination of them
# without manual symlink fiddling. Darwin-only for now (Linux google-chrome-beta /
# google-chrome-unstable detection across distros isn't covered yet — same
# rationale as Edge/Vivaldi).
profile_root_for() {
  case "$PLATFORM:$1" in
    Darwin:brave)              echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" ;;
    Darwin:chrome)             echo "$HOME/Library/Application Support/Google/Chrome" ;;
    Darwin:chrome-beta)        echo "$HOME/Library/Application Support/Google/Chrome Beta" ;;
    Darwin:chrome-canary)      echo "$HOME/Library/Application Support/Google/Chrome Canary" ;;
    Darwin:chrome-dev)         echo "$HOME/Library/Application Support/Google/Chrome Dev" ;;
    Darwin:chrome-for-testing) echo "$HOME/Library/Application Support/Google/Chrome for Testing" ;;
    Darwin:edge)               echo "$HOME/Library/Application Support/Microsoft Edge" ;;
    Darwin:vivaldi)            echo "$HOME/Library/Application Support/Vivaldi" ;;
    Linux:brave)               echo "$HOME/.config/BraveSoftware/Brave-Browser" ;;
    Linux:chrome)              echo "$HOME/.config/google-chrome" ;;
    Linux:chromium)            echo "$HOME/.config/chromium" ;;
    # Firefox has no Chromium "User Data" dir. Profiles live under
    # ~/.mozilla/firefox/<salt>.<name> and are indexed by profiles.ini, so the
    # Chromium-shaped --profile / --profiles handling does not apply; the
    # callers below special-case it.
    Linux:firefox)             echo "$HOME/.mozilla/firefox" ;;
    *) return 1 ;;
  esac
}

# Native messaging hosts dir for a browser target on this platform.
nm_dir_for() {
  case "$PLATFORM:$1" in
    Darwin:brave)              echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
    Darwin:chrome)             echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    Darwin:chrome-beta)        echo "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts" ;;
    Darwin:chrome-canary)      echo "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" ;;
    Darwin:chrome-dev)         echo "$HOME/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts" ;;
    # Chrome for Testing separated its native-messaging host dir from its user-data
    # dir as of Chrome 146: hosts now live under ~/.../Google/ChromeForTesting/
    # (no spaces), NOT under the user-data dir "Google/Chrome for Testing". Verified
    # against the Chrome native-messaging docs; the dispatch (Step 2) also writes the
    # legacy profile-relative path as a hedge for older builds.
    Darwin:chrome-for-testing) echo "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts" ;;
    Darwin:edge)               echo "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
    Darwin:vivaldi)            echo "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" ;;
    Linux:brave)               echo "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
    Linux:chrome)              echo "$HOME/.config/google-chrome/NativeMessagingHosts" ;;
    Linux:chromium)            echo "$HOME/.config/chromium/NativeMessagingHosts" ;;
    # Gecko keeps native-messaging hosts in one per-user dir for every Firefox
    # profile, outside the profile tree entirely.
    Linux:firefox)             echo "$HOME/.mozilla/native-messaging-hosts" ;;
    *) return 1 ;;
  esac
}

# Detect whether a browser is installed on this platform. Echoes 1/0.
browser_installed() {
  case "$PLATFORM:$1" in
    Darwin:brave)              [[ -d "/Applications/Brave Browser.app" ]]              && echo 1 || echo 0 ;;
    Darwin:chrome)             [[ -d "/Applications/Google Chrome.app" ]]              && echo 1 || echo 0 ;;
    Darwin:chrome-beta)        [[ -d "/Applications/Google Chrome Beta.app" ]]         && echo 1 || echo 0 ;;
    Darwin:chrome-canary)      [[ -d "/Applications/Google Chrome Canary.app" ]]       && echo 1 || echo 0 ;;
    Darwin:chrome-dev)         [[ -d "/Applications/Google Chrome Dev.app" ]]          && echo 1 || echo 0 ;;
    Darwin:chrome-for-testing) [[ -d "/Applications/Google Chrome for Testing.app" ]]  && echo 1 || echo 0 ;;
    Darwin:edge)               [[ -d "/Applications/Microsoft Edge.app" ]]             && echo 1 || echo 0 ;;
    Darwin:vivaldi)            [[ -d "/Applications/Vivaldi.app" ]]                    && echo 1 || echo 0 ;;
    Linux:brave)    ( command -v brave-browser >/dev/null 2>&1 \
                  || command -v brave >/dev/null 2>&1 ) && echo 1 || echo 0 ;;
    Linux:chrome)   ( command -v google-chrome >/dev/null 2>&1 \
                  || command -v google-chrome-stable >/dev/null 2>&1 ) && echo 1 || echo 0 ;;
    Linux:chromium) ( command -v chromium >/dev/null 2>&1 \
                  || command -v chromium-browser >/dev/null 2>&1 ) && echo 1 || echo 0 ;;
    Linux:firefox)  ( command -v firefox >/dev/null 2>&1 \
                  || command -v firefox-esr >/dev/null 2>&1 ) && echo 1 || echo 0 ;;
    *) echo 0 ;;
  esac
}

# Resolve the launchable executable / app reference for a browser target.
# On macOS this is the .app bundle's main binary (used with `open -a` for the
# parent bundle and pgrep). On Linux this is the binary basename (used with
# pgrep + direct exec).
browser_bin_for() {
  case "$PLATFORM:$1" in
    Darwin:brave)              echo "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" ;;
    Darwin:chrome)             echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
    Darwin:chrome-beta)        echo "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" ;;
    Darwin:chrome-canary)      echo "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" ;;
    Darwin:chrome-dev)         echo "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev" ;;
    Darwin:chrome-for-testing) echo "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" ;;
    Darwin:edge)               echo "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ;;
    Darwin:vivaldi)            echo "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" ;;
    Linux:brave)
      if command -v brave-browser >/dev/null 2>&1; then echo brave-browser
      elif command -v brave >/dev/null 2>&1; then echo brave
      else return 1; fi
      ;;
    Linux:chrome)
      if command -v google-chrome >/dev/null 2>&1; then echo google-chrome
      elif command -v google-chrome-stable >/dev/null 2>&1; then echo google-chrome-stable
      else return 1; fi
      ;;
    Linux:chromium)
      if command -v chromium >/dev/null 2>&1; then echo chromium
      elif command -v chromium-browser >/dev/null 2>&1; then echo chromium-browser
      else return 1; fi
      ;;
    Linux:firefox)
      if command -v firefox >/dev/null 2>&1; then echo firefox
      elif command -v firefox-esr >/dev/null 2>&1; then echo firefox-esr
      else return 1; fi
      ;;
    *) return 1 ;;
  esac
}

# Is the target browser running? On Darwin BROWSER_BIN is the .app binary path,
# which never appears in this script's own argv. On Linux it is a bare name
# (brave, google-chrome) that DOES — `bash install.sh --brave` — so a plain
# `pgrep -f` on that bare name matched the installer itself: every "is the browser
# running" check answered yes, and the "force restart" pkill signalled the
# script (issue #172). Anchor the Linux match to argv[0] so only a process
# launched as the browser counts. Distro wrapper scripts `exec -a "$0"` the
# real binary, so the wrapper name stays in argv[0]; the name is a prefix match
# so google-chrome also covers google-chrome-stable.
browser_pgrep_pattern() {
  if [[ "$PLATFORM" == "Darwin" ]]; then
    printf '%s' "$1"
  else
    printf '^([^ ]*/)?%s' "$1"
  fi
}
browser_running() {
  pgrep -f "$(browser_pgrep_pattern "$1")" >/dev/null 2>&1
}
kill_browser() {
  pkill -TERM -f "$(browser_pgrep_pattern "$1")" 2>/dev/null || true
}

# ── Parse flags ────────────────────────────────────────────────────────────────
SKIP_EXTENSION=0
# Linux tarball installs have no packaging step to put the CLI on PATH, so the
# installer links it itself (off on macOS/Windows, where the pkg/Setup owns it).
LINK_CLI=1
LINK_CLI_DIR=""
BROWSER=""
PROFILE=""
LIST_PROFILES=0
MODE=""           # "" | "browser-only" | "full"
DRY_RUN="${INSTALL_DRY_RUN:-0}"
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --skip-extension) SKIP_EXTENSION=1 ;;
    --brave)              BROWSER="brave" ;;
    --chrome)             BROWSER="chrome" ;;
    --chrome-beta)        BROWSER="chrome-beta" ;;
    --chrome-canary)      BROWSER="chrome-canary" ;;
    --chrome-dev)         BROWSER="chrome-dev" ;;
    --chrome-for-testing) BROWSER="chrome-for-testing" ;;
    --edge)               BROWSER="edge" ;;
    --vivaldi)            BROWSER="vivaldi" ;;
    --chromium)           BROWSER="chromium" ;;
    --firefox)            BROWSER="firefox" ;;
    --no-link-cli)        LINK_CLI=0 ;;
    --link-cli-dir)
      i=$((i + 1))
      LINK_CLI_DIR="${!i}"
      ;;
    --link-cli-dir=*)     LINK_CLI_DIR="${arg#--link-cli-dir=}" ;;
    --profile)
      i=$((i + 1))
      PROFILE="${!i}"
      ;;
    --profile=*) PROFILE="${arg#--profile=}" ;;
    --profiles) LIST_PROFILES=1 ;;
    --browser-only)
      if [[ "$MODE" == "full" ]]; then
        echo "ERROR: --browser-only and --full are mutually exclusive." >&2
        exit 1
      fi
      MODE="browser-only" ;;
    --full)
      if [[ "$MODE" == "browser-only" ]]; then
        echo "ERROR: --browser-only and --full are mutually exclusive." >&2
        exit 1
      fi
      MODE="full" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown flag: $arg" >&2
       echo ""
       echo "Usage: bash scripts/install.sh [MODE] [BROWSER] [OPTIONS]"
       echo ""
       echo "Modes (mutually exclusive; if omitted, you'll be prompted):"
       echo "  --browser-only    Install CLI + daemon + extension only. No macOS bridge."
       echo "                    Smallest footprint, no TCC prompts."
       echo "  --full            Browser-only AND macOS bridge (LaunchAgent + AX +"
       echo "                    ScreenCaptureKit + Apple Events). macOS only."
       echo ""
       echo "Browser:"
       echo "  --brave                Target Brave Browser"
       echo "  --chrome               Target Google Chrome (stable)"
       echo "  --chrome-beta          Target Google Chrome Beta (macOS only in this revision)"
       echo "  --chrome-canary        Target Google Chrome Canary (macOS only in this revision)"
       echo "  --chrome-dev           Target Google Chrome Dev (macOS only in this revision)"
       echo "  --chrome-for-testing   Target Google Chrome for Testing (macOS only in this revision)"
       echo "  --edge                 Target Microsoft Edge (macOS only in this revision)"
       echo "  --vivaldi              Target Vivaldi (macOS only in this revision)"
       echo "  --chromium             Target Chromium (Linux only in this revision)"
       echo "  --firefox              Target Firefox (Linux only in this revision; Gecko build)"
       echo "  --profile <name>       Profile directory name (e.g. \"Default\", \"Profile 2\")"
       echo "  --profiles             List available profiles and exit"
       echo ""
       echo "Options:"
       echo "  --skip-extension  Only install native messaging (skip extension load)"
       echo "  --no-link-cli     Do not symlink the interceptor CLI onto PATH (Linux)"
       echo "  --link-cli-dir D  Symlink the CLI into D instead of ~/.local/bin (Linux)"
       echo "  --dry-run         Print steps without executing them"
       exit 1 ;;
  esac
  i=$((i + 1))
done

# ── List profiles ──────────────────────────────────────────────────────────────
if [[ "$LIST_PROFILES" == "1" ]]; then
  if [[ -z "$BROWSER" ]]; then
    if   [[ "$(browser_installed brave)"              == "1" ]]; then BROWSER="brave"
    elif [[ "$(browser_installed chrome)"             == "1" ]]; then BROWSER="chrome"
    elif [[ "$(browser_installed chrome-beta)"        == "1" ]]; then BROWSER="chrome-beta"
    elif [[ "$(browser_installed chrome-canary)"      == "1" ]]; then BROWSER="chrome-canary"
    elif [[ "$(browser_installed chrome-dev)"         == "1" ]]; then BROWSER="chrome-dev"
    elif [[ "$(browser_installed chrome-for-testing)" == "1" ]]; then BROWSER="chrome-for-testing"
    elif [[ "$(browser_installed edge)"               == "1" ]]; then BROWSER="edge"
    elif [[ "$(browser_installed vivaldi)"            == "1" ]]; then BROWSER="vivaldi"
    elif [[ "$(browser_installed chromium)"           == "1" ]]; then BROWSER="chromium"
    fi
  fi
  if [[ "$BROWSER" == "firefox" ]]; then
    echo "Firefox does not use Chromium's profile-directory layout."
    echo "Its profiles are indexed by $HOME/.mozilla/firefox/profiles.ini and are"
    echo "selected with 'firefox -P'. Interceptor's native-messaging host is"
    echo "registered once per user ($HOME/.mozilla/native-messaging-hosts) and"
    echo "applies to every profile, so --profile is not needed."
    exit 0
  fi
  PROFILE_ROOT="$(profile_root_for "$BROWSER" || true)"
  if [[ -z "$PROFILE_ROOT" ]]; then echo "No supported browser found."; exit 1; fi

  echo "Available profiles:"
  echo ""
  printf "  %-20s %s\n" "DIRECTORY" "DISPLAY NAME"
  printf "  %-20s %s\n" "---------" "------------"
  for dir in "$PROFILE_ROOT"/*/; do
    name=$(basename "$dir")
    if [[ -f "$dir/Preferences" ]]; then
      if [[ "$PLATFORM" == "Darwin" ]] && command -v plutil >/dev/null 2>&1; then
        display=$(plutil -extract profile.name raw -o - "$dir/Preferences" 2>/dev/null || echo "(unknown)")
      else
        display=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("profile",{}).get("name","(unknown)"))' "$dir/Preferences" 2>/dev/null || echo "(unknown)")
      fi
      printf "  %-20s %s\n" "$name" "$display"
    fi
  done
  echo ""
  echo "Usage: bash scripts/install.sh --brave --profile \"Profile 2\""
  echo "       bash scripts/install.sh --edge --profiles"
  echo "       bash scripts/install.sh --vivaldi --profiles"
  echo "       bash scripts/install.sh --chrome-beta --profiles"
  exit 0
fi

# ── Mode resolution ────────────────────────────────────────────────────────────
# If neither --browser-only nor --full was passed, prompt interactively.
# Default: macOS → "full", anything else → "browser-only" (full mode is mac-only).
if [[ -z "$MODE" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    DEFAULT_MODE="full"
  else
    DEFAULT_MODE="browser-only"
  fi

  # In dry-run / non-interactive contexts, fall back to the platform default
  # rather than blocking on stdin.
  if [[ "$DRY_RUN" == "1" || ! -t 0 ]]; then
    MODE="$DEFAULT_MODE"
    echo "==> Mode not specified; defaulting to '$MODE' (non-interactive)."
  else
    echo "Choose install mode:"
    echo "  browser-only  CLI + daemon + extension. No macOS bridge."
    echo "                No TCC prompts (Screen Recording, Accessibility, etc.)."
    echo "  full          Browser-only PLUS the macOS Swift bridge."
    echo "                Adds 'interceptor macos *' commands; macOS will prompt"
    echo "                for Screen Recording / Accessibility / Apple Events on"
    echo "                first use."
    echo ""
    read -r -p "Mode [browser-only/full] (default: $DEFAULT_MODE): " ANSWER
    ANSWER="${ANSWER:-$DEFAULT_MODE}"
    case "$ANSWER" in
      browser-only|full) MODE="$ANSWER" ;;
      *)
        echo "Unrecognized mode '$ANSWER'. Use --browser-only or --full." >&2
        exit 1 ;;
    esac
  fi
fi

if [[ "$MODE" == "full" && "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: --full mode is macOS only (the Swift bridge is mac-only)." >&2
  echo "       Use --browser-only on this platform." >&2
  exit 1
fi

echo "==> Mode: $MODE"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> DRY RUN — no files will be created or modified."
fi

# ── Browser resolution ────────────────────────────────────────────────────────
# If none of --chrome / --brave / --edge / --vivaldi was passed, prompt or fall
# back to a deterministic default in non-interactive contexts. Valid resolved
# values: "chrome" | "brave" | "edge" | "vivaldi" | "both" (both = chrome+brave
# only — preserved from the upstream contract).
if [[ -z "$BROWSER" ]]; then
  CHROME_INSTALLED=$(browser_installed chrome)
  CHROME_BETA_INSTALLED=$(browser_installed chrome-beta)
  CHROME_CANARY_INSTALLED=$(browser_installed chrome-canary)
  CHROME_DEV_INSTALLED=$(browser_installed chrome-dev)
  CHROME_FOR_TESTING_INSTALLED=$(browser_installed chrome-for-testing)
  BRAVE_INSTALLED=$(browser_installed brave)
  EDGE_INSTALLED=$(browser_installed edge)
  VIVALDI_INSTALLED=$(browser_installed vivaldi)
  CHROMIUM_INSTALLED=$(browser_installed chromium)
  FIREFOX_INSTALLED=$(browser_installed firefox)
  TOTAL_INSTALLED=$(( CHROME_INSTALLED + CHROME_BETA_INSTALLED + CHROME_CANARY_INSTALLED \
                    + CHROME_DEV_INSTALLED + CHROME_FOR_TESTING_INSTALLED \
                    + BRAVE_INSTALLED + EDGE_INSTALLED + VIVALDI_INSTALLED \
                    + CHROMIUM_INSTALLED + FIREFOX_INSTALLED ))

  if (( TOTAL_INSTALLED == 0 )); then
    echo "ERROR: No supported browser found." >&2
    echo "       Install Chrome (stable/Beta/Canary/Dev/for-Testing), Brave, Edge, Vivaldi," >&2
    echo "       Chromium, or Firefox, then re-run." >&2
    exit 1
  fi

  # First installed browser in priority order — the non-interactive default and the
  # interactive prompt default, so we never default to a browser that isn't actually
  # installed (e.g. stable Chrome on a Beta-only host).
  if   [[ "$CHROME_INSTALLED"             == "1" ]]; then DEFAULT_BROWSER="chrome"
  elif [[ "$CHROME_BETA_INSTALLED"        == "1" ]]; then DEFAULT_BROWSER="chrome-beta"
  elif [[ "$CHROME_CANARY_INSTALLED"      == "1" ]]; then DEFAULT_BROWSER="chrome-canary"
  elif [[ "$CHROME_DEV_INSTALLED"         == "1" ]]; then DEFAULT_BROWSER="chrome-dev"
  elif [[ "$CHROME_FOR_TESTING_INSTALLED" == "1" ]]; then DEFAULT_BROWSER="chrome-for-testing"
  elif [[ "$BRAVE_INSTALLED"              == "1" ]]; then DEFAULT_BROWSER="brave"
  elif [[ "$EDGE_INSTALLED"               == "1" ]]; then DEFAULT_BROWSER="edge"
  elif [[ "$VIVALDI_INSTALLED"            == "1" ]]; then DEFAULT_BROWSER="vivaldi"
  elif [[ "$CHROMIUM_INSTALLED"           == "1" ]]; then DEFAULT_BROWSER="chromium"
  else                                                    DEFAULT_BROWSER="firefox"
  fi

  if (( TOTAL_INSTALLED == 1 )); then
    BROWSER="$DEFAULT_BROWSER"
    echo "==> Browser: $BROWSER (only supported browser found)"
  elif [[ "$DRY_RUN" == "1" || ! -t 0 ]]; then
    BROWSER="$DEFAULT_BROWSER"
    echo "==> Browser not specified; defaulting to '$BROWSER' (non-interactive, first installed)."
  else
    echo ""
    echo "Choose target browser:"
    [[ "$CHROME_INSTALLED"             == "1" ]] && echo "  chrome              Google Chrome (stable)"
    [[ "$CHROME_BETA_INSTALLED"        == "1" ]] && echo "  chrome-beta         Google Chrome Beta"
    [[ "$CHROME_CANARY_INSTALLED"      == "1" ]] && echo "  chrome-canary       Google Chrome Canary"
    [[ "$CHROME_DEV_INSTALLED"         == "1" ]] && echo "  chrome-dev          Google Chrome Dev"
    [[ "$CHROME_FOR_TESTING_INSTALLED" == "1" ]] && echo "  chrome-for-testing  Google Chrome for Testing"
    [[ "$BRAVE_INSTALLED"              == "1" ]] && echo "  brave               Brave Browser"
    [[ "$EDGE_INSTALLED"               == "1" ]] && echo "  edge                Microsoft Edge"
    [[ "$VIVALDI_INSTALLED"            == "1" ]] && echo "  vivaldi             Vivaldi"
    [[ "$CHROMIUM_INSTALLED"           == "1" ]] && echo "  chromium            Chromium"
    [[ "$FIREFOX_INSTALLED"            == "1" ]] && echo "  firefox             Firefox (Gecko build)"
    [[ "$CHROME_INSTALLED" == "1" && "$BRAVE_INSTALLED" == "1" ]] && echo "  both                Chrome (stable) and Brave"
    echo ""
    read -r -p "Browser (default: $DEFAULT_BROWSER): " ANSWER
    ANSWER="${ANSWER:-$DEFAULT_BROWSER}"
    case "$ANSWER" in
      chrome|chrome-beta|chrome-canary|chrome-dev|chrome-for-testing|brave|edge|vivaldi|chromium|firefox|both) BROWSER="$ANSWER" ;;
      *)
        echo "Unrecognized browser '$ANSWER'." >&2
        exit 1 ;;
    esac
  fi
fi

echo "==> Browser: $BROWSER"

# Firefox is the one non-Chromium target: different native-host manifest shape,
# different extension build, no --load-extension, no Chromium profile layout.
# Resolve all of that here so the steps below stay single-branch.
IS_GECKO=0
if [[ "$BROWSER" == "firefox" ]]; then
  IS_GECKO=1
  TEMPLATE_PATH="$GECKO_TEMPLATE_PATH"
  GENERATED_MANIFEST="$GECKO_GENERATED_MANIFEST"
  EXTENSION_DIR="$GECKO_EXTENSION_DIR"
fi

# Helper that runs a step or prints it under --dry-run.
run_step() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: $*"
  else
    eval "$@"
  fi
}

# ── Step 1: Generate native messaging manifest ────────────────────────────────
echo "==> [browser] Generating native messaging manifest..."
if [[ "$DRY_RUN" == "1" ]]; then
  echo "    DRY: mkdir -p $GENERATED_DIR"
  echo "    DRY: sed __DAEMON_PATH__ -> $DAEMON_PATH > $GENERATED_MANIFEST"
else
  mkdir -p "$GENERATED_DIR"
  ESCAPED_DAEMON_PATH="$(printf '%s' "$DAEMON_PATH" | sed 's/[&|\\]/\\&/g')"
  sed "s|__DAEMON_PATH__|$ESCAPED_DAEMON_PATH|g" "$TEMPLATE_PATH" > "$GENERATED_MANIFEST"
fi

# ── Step 2: Install native messaging symlinks for chosen browser(s) ───────────
echo "==> [browser] Installing native messaging symlink(s)..."
NM_DIRS=()
case "$BROWSER" in
  chrome)             NM_DIRS+=("$(nm_dir_for chrome)") ;;
  chrome-beta)        NM_DIRS+=("$(nm_dir_for chrome-beta)") ;;
  chrome-canary)      NM_DIRS+=("$(nm_dir_for chrome-canary)") ;;
  chrome-dev)         NM_DIRS+=("$(nm_dir_for chrome-dev)") ;;
  chrome-for-testing)
    # Chrome 146 moved Chrome for Testing's native-messaging host lookup to a
    # dedicated dir (Google/ChromeForTesting/). Write that (canonical for 146+) and
    # ALSO the user-data-dir/NativeMessagingHosts path as a defensive hedge for older
    # builds / alternate lookups — mirrors how other native-messaging tooling handles
    # this boundary. The two targets are distinct dirs, so no double-write.
    NM_DIRS+=("$(nm_dir_for chrome-for-testing)")
    NM_DIRS+=("$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts")
    ;;
  brave)              NM_DIRS+=("$(nm_dir_for brave)") ;;
  edge)               NM_DIRS+=("$(nm_dir_for edge)") ;;
  vivaldi)            NM_DIRS+=("$(nm_dir_for vivaldi)") ;;
  chromium)           NM_DIRS+=("$(nm_dir_for chromium)") ;;
  firefox)            NM_DIRS+=("$(nm_dir_for firefox)") ;;
  both)
    NM_DIRS+=("$(nm_dir_for chrome)")
    NM_DIRS+=("$(nm_dir_for brave)")
    ;;
esac

for dir in "${NM_DIRS[@]}"; do
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: mkdir -p $dir"
    echo "    DRY: ln -sfn $GENERATED_MANIFEST $dir/com.interceptor.host.json"
  else
    mkdir -p "$dir"
    ln -sfn "$GENERATED_MANIFEST" "$dir/com.interceptor.host.json"
    # Order matters: the specific Chrome-branch patterns must precede the generic
    # *Google/Chrome* glob, otherwise Beta/Canary/Dev/for-Testing get labelled
    # "Chrome" and the user can't tell which branch was wired.
    case "$dir" in
      *Google/Chrome\ Beta*)             echo "    Chrome Beta:        $dir/com.interceptor.host.json" ;;
      *Google/Chrome\ Canary*)           echo "    Chrome Canary:      $dir/com.interceptor.host.json" ;;
      *Google/Chrome\ Dev*)              echo "    Chrome Dev:         $dir/com.interceptor.host.json" ;;
      *Google/ChromeForTesting*|*Google/Chrome\ for\ Testing*) echo "    Chrome for Testing: $dir/com.interceptor.host.json" ;;
      *Google/Chrome*|*google-chrome*)   echo "    Chrome:             $dir/com.interceptor.host.json" ;;
      *Brave-Browser*|*BraveSoftware*)   echo "    Brave:              $dir/com.interceptor.host.json" ;;
      *Microsoft\ Edge*)                 echo "    Edge:               $dir/com.interceptor.host.json" ;;
      *Vivaldi*)                         echo "    Vivaldi:            $dir/com.interceptor.host.json" ;;
      *native-messaging-hosts*)          echo "    Firefox:            $dir/com.interceptor.host.json" ;;
      *chromium*|*Chromium*)             echo "    Chromium:           $dir/com.interceptor.host.json" ;;
    esac
  fi
done

# ── Step 3: Load extension into browser via --load-extension ──────────────────
# Takes one arg: "chrome" | "brave" | "edge" | "vivaldi". Reads $SKIP_EXTENSION,
# $PROFILE, $DRY_RUN, $EXTENSION_DIR from the surrounding scope.

# Read extensions.ui.developer_mode from a profile's Preferences JSON.
# Echoes "true" / "false" / "unknown" (file missing, malformed, or key absent).
read_developer_mode() {
  local prefs="$1"
  if [[ ! -f "$prefs" ]]; then echo "unknown"; return 0; fi
  python3 - "$prefs" <<'PY' 2>/dev/null || echo "unknown"
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    v = d.get("extensions", {}).get("ui", {}).get("developer_mode")
    if v is True: print("true")
    elif v is False: print("false")
    else: print("unknown")
except Exception:
    print("unknown")
PY
}

# Toggle extensions.ui.developer_mode = true in a profile's Preferences JSON.
# Must NOT run while the browser owns the file — the browser overwrites on shutdown.
# Returns 0 on success, non-zero on failure (file missing, malformed, browser running).
write_developer_mode_true() {
  local prefs="$1" browser_bin="$2"
  if [[ ! -f "$prefs" ]]; then return 1; fi
  if browser_running "$browser_bin"; then return 2; fi
  python3 - "$prefs" <<'PY' 2>/dev/null || return 3
import json, sys, os, tempfile
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
d.setdefault("extensions", {}).setdefault("ui", {})["developer_mode"] = True
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w") as f:
    json.dump(d, f, separators=(",", ":"))
os.replace(tmp, path)
PY
}

# Locate the interceptor CLI for the post-launch probe. Two layouts ship this
# script: a repo checkout (binary under $ROOT/dist/) and an extracted release
# package (binary at $ROOT, with daemon/, extension/, skills/ beside it — the
# layout `interceptor skills adopt` resolves packs from). Fall back to $PATH for
# an already-installed CLI. Echoes nothing when none is found.
resolve_interceptor_bin() {
  local candidate
  for candidate in "$ROOT/dist/interceptor" "$ROOT/interceptor"; do
    if [[ -x "$candidate" ]]; then echo "$candidate"; return 0; fi
  done
  if command -v interceptor >/dev/null 2>&1; then command -v interceptor; return 0; fi
  return 1
}

# Probe whether the just-launched extension is reachable. Returns 0 if yes.
probe_extension_reachable() {
  local interceptor_bin
  interceptor_bin="$(resolve_interceptor_bin)" || return 0  # nothing to probe with; skip silently
  # status --verbose ends with a per-component breakdown including "extension:"
  "$interceptor_bin" status --verbose 2>/dev/null | grep -qE "^extension:[[:space:]]+reachable"
}

load_extension() {
  local target="$1"

  if [[ "$SKIP_EXTENSION" == "1" ]]; then
    echo ""
    echo "==> [browser] Skipping extension loading (--skip-extension)"
    return 0
  fi

  if [[ ! -d "$EXTENSION_DIR" && "$DRY_RUN" != "1" ]]; then
    echo ""
    echo "==> Extension not built yet. Run: bash scripts/build.sh"
    echo "    Then re-run this script."
    exit 1
  fi

  local BROWSER_APP BROWSER_BIN BROWSER_NAME
  case "$target" in
    brave)              BROWSER_NAME="Brave" ;;
    chrome)             BROWSER_NAME="Chrome" ;;
    chrome-beta)        BROWSER_NAME="Chrome Beta" ;;
    chrome-canary)      BROWSER_NAME="Chrome Canary" ;;
    chrome-dev)         BROWSER_NAME="Chrome Dev" ;;
    chrome-for-testing) BROWSER_NAME="Chrome for Testing" ;;
    edge)               BROWSER_NAME="Edge" ;;
    vivaldi)            BROWSER_NAME="Vivaldi" ;;
    chromium)           BROWSER_NAME="Chromium" ;;
    firefox)            BROWSER_NAME="Firefox" ;;
    *)
      echo "ERROR: load_extension called with unknown browser '$target'." >&2
      return 1 ;;
  esac

  # ── Gecko ───────────────────────────────────────────────────────────────────
  # Firefox has no --load-extension switch and no Chromium developer-mode flag,
  # so none of the Chromium preflight below applies. An unsigned MV3 add-on can
  # be loaded two ways: temporarily via about:debugging (survives until the
  # browser quits, works on release Firefox), or permanently from a signed XPI.
  # Print the path and stop — silently launching Firefox would do nothing.
  if [[ "$target" == "firefox" ]]; then
    echo ""
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "==> [browser] DRY: would print Firefox load instructions for $EXTENSION_DIR"
      return 0
    fi
    echo "==> Firefox loads unpacked add-ons through about:debugging, not a command-line switch."
    echo "    Native messaging metadata has already been installed."
    echo ""
    echo "    Load it (per browser session):"
    echo "      1. Open about:debugging#/runtime/this-firefox"
    echo "      2. Click 'Load Temporary Add-on…'"
    echo "      3. Select $EXTENSION_DIR/manifest.json"
    echo ""
    echo "    Grant host access (Firefox MV3 treats host permissions as optional):"
    echo "      about:addons -> Interceptor -> Permissions -> 'Access your data for all websites'"
    echo ""
    echo "    Verify with: interceptor status --verbose   (expect 'extension: reachable')"
    echo "    A signed XPI installs permanently; temporary add-ons are dropped on quit."
    return 0
  fi
  if [[ "$PLATFORM" == "Darwin" ]]; then
    case "$target" in
      brave)
        BROWSER_APP="/Applications/Brave Browser.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Brave Browser"
        ;;
      chrome)
        BROWSER_APP="/Applications/Google Chrome.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome"
        ;;
      chrome-beta)
        BROWSER_APP="/Applications/Google Chrome Beta.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome Beta"
        ;;
      chrome-canary)
        BROWSER_APP="/Applications/Google Chrome Canary.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome Canary"
        ;;
      chrome-dev)
        BROWSER_APP="/Applications/Google Chrome Dev.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome Dev"
        ;;
      chrome-for-testing)
        BROWSER_APP="/Applications/Google Chrome for Testing.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome for Testing"
        ;;
      edge)
        BROWSER_APP="/Applications/Microsoft Edge.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Microsoft Edge"
        ;;
      vivaldi)
        BROWSER_APP="/Applications/Vivaldi.app"
        BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Vivaldi"
        ;;
    esac
  else
    BROWSER_APP=""
    BROWSER_BIN="$(browser_bin_for "$target" || true)"
    if [[ -z "$BROWSER_BIN" ]]; then
      # A dry run reports the steps it *would* take; it must not depend on the
      # browser actually being installed. The Darwin branch above never probes
      # the filesystem either (it just names the .app), so failing here would
      # make --dry-run behave differently on Linux than on macOS for no reason.
      if [[ "$DRY_RUN" == "1" ]]; then
        BROWSER_BIN="$target"
      else
        echo "ERROR: $BROWSER_NAME binary not found in PATH on this platform." >&2
        return 1
      fi
    fi
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "==> [browser] DRY: would launch $BROWSER_NAME --load-extension=$EXTENSION_DIR"
    return 0
  fi

  # ── Developer-mode preflight ─────────────────────────────────────────────────
  # Chromium silently drops --load-extension when the target profile has Dev
  # mode off — the launch reports success, the extension is dormant, and every
  # subsequent browser-side command times out at 15s. Detect and surface this
  # before launching, with both manual and (with Brave/Chrome closed) automatic
  # remediation.
  local PROFILE_DIR_NAME="${PROFILE:-Default}"
  local PROFILE_PATH
  PROFILE_PATH="$(profile_root_for "$target")/$PROFILE_DIR_NAME"
  local PREFS_PATH="$PROFILE_PATH/Preferences"
  local DEVMODE_STATE
  DEVMODE_STATE="$(read_developer_mode "$PREFS_PATH")"

  if [[ "$DEVMODE_STATE" == "false" || "$DEVMODE_STATE" == "unknown" ]]; then
    echo ""
    echo "==> [browser] $BROWSER_NAME profile '$PROFILE_DIR_NAME' has Developer mode OFF"
    echo "    (or the profile has not been opened yet)."
    echo ""
    echo "    Without Developer mode, --load-extension is silently dropped by Chromium:"
    echo "    the install reports success, the extension never registers, and every"
    echo "    'interceptor open / read / act / …' will time out at 15s."
    echo ""
    echo "    Manual remediation:"
    echo "      1. Quit $BROWSER_NAME entirely."
    echo "      2. Re-launch $BROWSER_NAME, open $(case "$target" in brave) echo brave://extensions/ ;; chrome|chrome-beta|chrome-canary|chrome-dev|chrome-for-testing) echo chrome://extensions/ ;; edge) echo edge://extensions/ ;; vivaldi) echo vivaldi://extensions/ ;; esac), toggle Developer mode ON."
    echo "      3. Quit $BROWSER_NAME again."
    echo "      4. Re-run: bash scripts/install.sh ${MODE:+--$MODE} --$target${PROFILE:+ --profile \"$PROFILE\"}"

    # Offer auto-remediation if and only if the browser is currently closed
    # AND we have a Preferences file to write to. Editing while the browser
    # runs is unsafe — the browser overwrites on shutdown.
    local CAN_AUTO=0
    if [[ -f "$PREFS_PATH" ]] && ! browser_running "$BROWSER_BIN"; then
      CAN_AUTO=1
    fi

    if [[ "$CAN_AUTO" == "1" && -t 0 ]]; then
      echo ""
      read -r -p "    Or: enable Developer mode now (writes Preferences while $BROWSER_NAME is closed)? [y/N] " ANSWER
      if [[ "${ANSWER:-n}" == "y" || "${ANSWER:-n}" == "Y" ]]; then
        if write_developer_mode_true "$PREFS_PATH" "$BROWSER_BIN"; then
          echo "    Developer mode enabled in $PREFS_PATH."
        else
          echo "    Failed to write Preferences (browser may have launched, file missing, or JSON malformed)."
          echo "    Use the manual path above."
          exit 1
        fi
      else
        echo "    Skipped auto-enable. Use the manual path above, then re-run."
        exit 1
      fi
    elif [[ -t 0 ]]; then
      echo ""
      echo "    Auto-enable is unavailable (no Preferences file at '$PREFS_PATH'"
      echo "    or $BROWSER_NAME is still running). Use the manual path."
      exit 1
    else
      # Non-interactive: hard-fail loudly so a wrapper doesn't ship a dormant install.
      exit 1
    fi
  fi

  # Check if browser is already running
  local BROWSER_RUNNING=0
  if browser_running "$BROWSER_BIN"; then
    BROWSER_RUNNING=1
  fi

  if [[ "$BROWSER_RUNNING" == "1" ]]; then
    echo ""
    echo "==> $BROWSER_NAME is already running."
    echo "    To load the extension without browser intervention, $BROWSER_NAME must be restarted."
    echo ""
    echo "    Option 1 — Quit $BROWSER_NAME, then re-run this script."
    echo ""
    echo "    Option 2 — Load manually:"
    echo "      1. Open chrome://extensions"
    echo "      2. Enable Developer Mode"
    echo "      3. Load unpacked → $EXTENSION_DIR"
    echo ""
    echo "    Option 3 — Force restart (will restore tabs on relaunch):"
    read -p "      Quit $BROWSER_NAME and relaunch with extension? [y/N] " CONFIRM
    if [[ "${CONFIRM:-n}" == "y" || "${CONFIRM:-n}" == "Y" ]]; then
      echo "    Quitting $BROWSER_NAME..."
      if [[ "$PLATFORM" == "Darwin" ]]; then
        osascript -e "tell application \"$BROWSER_NAME Browser\" to quit" 2>/dev/null || \
        osascript -e "tell application \"$BROWSER_NAME\" to quit" 2>/dev/null || true
      else
        kill_browser "$BROWSER_BIN"
      fi
      sleep 2
      for j in {1..10}; do
        if ! browser_running "$BROWSER_BIN"; then break; fi
        sleep 1
      done
    else
      echo "    Skipping extension loading."
      return 0
    fi
  fi

  # Chrome stable / Beta / Canary / Dev and Edge (all branded Chromium builds)
  # ignore --load-extension on macOS and Windows desktop. Surface the
  # developer-flow remediation rather than launch a no-op. Brave, Vivaldi, and
  # Chrome for Testing (an unbranded Google-built testing variant) respect
  # --load-extension and fall through to the launch path below.
  if [[ "$target" == "chrome" || "$target" == "chrome-beta" \
     || "$target" == "chrome-canary" || "$target" == "chrome-dev" \
     || "$target" == "edge" ]]; then
    local SCHEMA
    case "$target" in
      chrome|chrome-beta|chrome-canary|chrome-dev) SCHEMA="chrome" ;;
      edge)                                        SCHEMA="edge" ;;
    esac
    echo ""
    echo "==> $BROWSER_NAME ignores --load-extension in branded desktop builds."
    echo "    Use one of these paths instead:"
    echo "      1. Developer flow: open ${SCHEMA}://extensions, enable Developer Mode,"
    echo "         then Load unpacked -> $EXTENSION_DIR"
    echo ""
    echo "    Native messaging metadata has already been installed."
    return 0
  fi

  echo ""
  echo "==> [browser] Launching $BROWSER_NAME with --load-extension..."
  echo "    Extension: $EXTENSION_DIR"

  # Build launch args
  local LAUNCH_ARGS=(--load-extension="$EXTENSION_DIR")
  if [[ -n "$PROFILE" ]]; then
    LAUNCH_ARGS+=(--profile-directory="$PROFILE")
    echo "    Profile:   $PROFILE"
  fi

  if [[ "$PLATFORM" == "Darwin" ]]; then
    open -a "$BROWSER_APP" --args "${LAUNCH_ARGS[@]}"
  else
    nohup "$BROWSER_BIN" "${LAUNCH_ARGS[@]}" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi

  # ── Post-launch reachability probe ──────────────────────────────────────────
  # Wait briefly for the extension to initialize, then probe via
  # `interceptor status --verbose`. If the extension is not reachable, the
  # most likely cause is still a Developer-mode mismatch we couldn't detect
  # (e.g. the Preferences file we read was for a different profile than the
  # browser actually opened). Surface the symptom + remediation rather than
  # report a silent success.
  echo ""
  echo "==> Verifying extension reachability (waits up to 8s)..."
  local probed=0
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if probe_extension_reachable; then probed=1; break; fi
  done

  if [[ "$probed" == "1" ]]; then
    echo "==> Extension loaded into $BROWSER_NAME and reachable."
    echo "    Extension ID: hkjbaciefhhgekldhncknbjkofbpenng"
    [[ -n "$PROFILE" ]] && echo "    Profile: $PROFILE"
  else
    echo "==> WARNING: $BROWSER_NAME launched, but the extension is NOT reachable after 8s."
    echo ""
    echo "    Most common cause: Developer mode is off in the profile $BROWSER_NAME"
    echo "    actually opened (which may differ from the profile this script targeted)."
    echo ""
    echo "    Verify in $BROWSER_NAME:"
    case "$target" in
      brave)                                                                 echo "      1. Open brave://extensions/" ;;
      chrome|chrome-beta|chrome-canary|chrome-dev|chrome-for-testing)        echo "      1. Open chrome://extensions/" ;;
      edge)                                                                  echo "      1. Open edge://extensions/" ;;
      vivaldi)                                                               echo "      1. Open vivaldi://extensions/" ;;
    esac
    echo "      2. Confirm Developer mode is ON (top-right toggle)."
    echo "      3. Confirm 'Interceptor' appears with ID hkjbaciefhhgekldhncknbjkofbpenng."
    echo "      4. If the extension is missing, click 'Load unpacked' and select:"
    echo "         $EXTENSION_DIR"
    echo ""
    echo "    Diagnose with: interceptor status --verbose"
    echo ""
    return 1
  fi
}

# ── Step 3b: put the CLI on PATH (Linux) ──────────────────────────────────────
# macOS installs come from a pkg that writes /usr/local/bin, and Windows Setup
# edits PATH; a Linux tarball has neither, so without this the CLI only works by
# absolute path. Symlink, never copy: an upgrade replaces the target in place.
link_cli_onto_path() {
  [[ "$PLATFORM" == "Linux" ]] || return 0
  [[ "$LINK_CLI" == "1" ]] || return 0

  local cli_bin link_dir link_path
  cli_bin="$(resolve_interceptor_bin || true)"
  if [[ -z "$cli_bin" ]]; then
    echo "==> [cli] Skipping PATH link — no interceptor binary found next to this script."
    return 0
  fi
  # An `interceptor` already on PATH that resolves to this same binary is the
  # steady state after the first install; re-linking it would be noise.
  if command -v interceptor >/dev/null 2>&1; then
    local existing
    existing="$(command -v interceptor)"
    if [[ "$(readlink -f "$existing" 2>/dev/null || echo "$existing")" == "$(readlink -f "$cli_bin" 2>/dev/null || echo "$cli_bin")" ]]; then
      echo "==> [cli] Already on PATH: $existing"
      return 0
    fi
  fi

  link_dir="${LINK_CLI_DIR:-$HOME/.local/bin}"
  link_path="$link_dir/interceptor"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "==> [cli] DRY: mkdir -p $link_dir"
    echo "==> [cli] DRY: ln -sfn $cli_bin $link_path"
    return 0
  fi

  # Refuse to clobber a real file: a symlink is ours to replace, anything else
  # belongs to the user or another package manager.
  if [[ -e "$link_path" && ! -L "$link_path" ]]; then
    echo "==> [cli] NOT linking — $link_path exists and is not a symlink."
    echo "    Remove it or pass --link-cli-dir <dir> to place the link elsewhere."
    return 0
  fi

  mkdir -p "$link_dir"
  ln -sfn "$cli_bin" "$link_path"
  # Record where the link went so uninstall removes exactly this one. Without
  # the record, uninstall can only guess at the conventional dirs and would
  # leave a --link-cli-dir link behind.
  mkdir -p "$GENERATED_DIR"
  printf '%s\n' "$link_path" > "$GENERATED_DIR/cli-link"
  echo "==> [cli] Linked: $link_path -> $cli_bin"
  case ":$PATH:" in
    *":$link_dir:"*) ;;
    *)
      echo "    NOTE: $link_dir is not on your PATH. Add it, e.g.:"
      echo "      echo 'export PATH=\"$link_dir:\$PATH\"' >> ~/.bashrc && exec \$SHELL" ;;
  esac
}

link_cli_onto_path

case "$BROWSER" in
  chrome|chrome-beta|chrome-canary|chrome-dev|chrome-for-testing|brave|edge|vivaldi|chromium|firefox)
    load_extension "$BROWSER" ;;
  both)
    load_extension chrome
    load_extension brave
    ;;
esac

# ── Step 4 (full mode only): Install Swift bridge ──────────────────────────────
# browser-only MUST NOT touch the LaunchAgent or .app bundle.
if [[ "$MODE" == "browser-only" ]]; then
  echo ""
  echo "==> Done. Installed in browser-only mode."
  echo "    No macOS bridge installed; no LaunchAgent written."
  echo "    Test:    interceptor status   (expect 'mode: browser-only')"
  # `upgrade --full` installs the Swift bridge and hard-errors off macOS, so
  # only advertise it where it can actually run.
  if [[ "$PLATFORM" == "Darwin" ]]; then
    echo ""
    echo "    To upgrade later:    interceptor upgrade --full"
  fi
  exit 0
fi

# MODE == "full" past this point.
echo ""
echo "==> [bridge] Chaining into install-bridge.sh..."
if [[ "$DRY_RUN" == "1" ]]; then
  echo "    DRY: bash $INSTALL_BRIDGE_SCRIPT"
  echo "    DRY: would write ~/Library/LaunchAgents/com.interceptor.bridge.plist"
  echo "    DRY: would lsregister ~/.local/share/interceptor/interceptor-bridge.app"
  echo "    DRY: would launchctl bootstrap gui/$(id -u 2>/dev/null || echo "<uid>")"
  echo ""
  echo "==> DRY-RUN complete (full mode)."
  exit 0
fi

if [[ ! -x "$INSTALL_BRIDGE_SCRIPT" && ! -f "$INSTALL_BRIDGE_SCRIPT" ]]; then
  echo "ERROR: $INSTALL_BRIDGE_SCRIPT not found." >&2
  echo "       Build the bridge first: bash scripts/build-bridge.sh" >&2
  exit 1
fi

bash "$INSTALL_BRIDGE_SCRIPT"

echo ""
echo "==> Done. Installed in full computer-use mode."
echo "    Test:    interceptor status   (expect 'mode: full')"
echo "    First 'interceptor macos screenshot' will prompt for Screen Recording."
echo "    First 'interceptor macos act' will prompt for Accessibility."
echo "    First 'interceptor macos intent dispatch' will prompt for Apple Events."
