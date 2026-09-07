#!/bin/bash
# Uninstall Interceptor.
#
# Handles both install paths:
#   • Pkg install (public release):   /Applications, /usr/local/bin,
#     /Library/Application Support/Interceptor (system locations — needs sudo)
#   • Developer install (install.sh): repo-relative, no sudo
#
# Runs on macOS and Linux. The macOS-only steps (LaunchAgent, .app bundle,
# pkgutil receipts) are individually guarded and no-op elsewhere; the
# native-messaging manifest paths switch on `uname -s`.
#
# --bridge-only flag downgrades a full install back to browser-only by
# removing ONLY the Swift-bridge artifacts (LaunchAgent + .app + symlink),
# leaving the daemon / CLI / extension / native-messaging manifest in place.
#
# Run with:
#   sudo bash /Library/Application Support/Interceptor/uninstall.sh   (pkg install)
#   bash scripts/uninstall.sh                                          (dev install — full)
#   bash scripts/uninstall.sh --bridge-only                            (downgrade to browser-only)

set -euo pipefail

# ── Parse flags ────────────────────────────────────────────────────────────────
BRIDGE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --bridge-only) BRIDGE_ONLY=1 ;;
    -h|--help)
      echo "Usage: bash scripts/uninstall.sh [--bridge-only]"
      echo ""
      echo "  (no flags)        Remove everything — both browser and bridge surfaces."
      echo "  --bridge-only     Remove only the macOS bridge (LaunchAgent + .app + symlink),"
      echo "                    leaving the browser-only install (daemon, CLI, extension,"
      echo "                    native messaging manifests) intact. Effectively downgrades"
      echo "                    a full install to browser-only."
      exit 0 ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Use 'bash scripts/uninstall.sh --help' for usage." >&2
      exit 1 ;;
  esac
done

PLATFORM="$(uname -s)"   # Darwin | Linux

USER_HOME="${USER_HOME_OVERRIDE:-$HOME}"
# Honor sudo: prefer the invoking user's home so we clean per-user files even
# when uninstall is run as root. Home layout is /Users/<name> on macOS and
# /home/<name> on Linux, so ask the password database rather than guessing;
# fall back to the macOS convention when getent is unavailable.
if [[ -n "${SUDO_USER:-}" ]]; then
  SUDO_USER_HOME=""
  if command -v getent >/dev/null 2>&1; then
    SUDO_USER_HOME="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)"
  fi
  if [[ -z "$SUDO_USER_HOME" && -d "/Users/$SUDO_USER" ]]; then
    SUDO_USER_HOME="/Users/$SUDO_USER"
  fi
  if [[ -n "$SUDO_USER_HOME" && -d "$SUDO_USER_HOME" ]]; then
    USER_HOME="$SUDO_USER_HOME"
  fi
fi

# Per-user native-messaging manifest locations, per platform. Mirrors
# nm_dir_for() in scripts/install.sh — anything install.sh can write here,
# uninstall must be able to remove.
XDG_CFG="${XDG_CONFIG_HOME:-$USER_HOME/.config}"
if [[ "$PLATFORM" == "Linux" ]]; then
  NM_MANIFESTS=(
    "$XDG_CFG/google-chrome/NativeMessagingHosts/com.interceptor.host.json"
    "$XDG_CFG/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.interceptor.host.json"
    "$XDG_CFG/chromium/NativeMessagingHosts/com.interceptor.host.json"
    # Gecko: one dir per user, outside both the XDG tree and the profile tree.
    "$USER_HOME/.mozilla/native-messaging-hosts/com.interceptor.host.json"
  )
else
  NM_MANIFESTS=(
    "$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.interceptor.host.json"
    "$USER_HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.interceptor.host.json"
    "$USER_HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/com.interceptor.host.json"
    "$USER_HOME/Library/Application Support/Chromium/NativeMessagingHosts/com.interceptor.host.json"
  )
fi

PATH_MARKER_START="# >>> interceptor path >>>"
PATH_MARKER_END="# <<< interceptor path <<<"

# ── Bridge-only path (downgrade) ──────────────────────────────────────────────
if [[ "$BRIDGE_ONLY" == "1" ]]; then
  echo "==> Downgrading to browser-only mode (--bridge-only)..."

  echo "==> Stopping bridge process..."
  pkill -f "interceptor-bridge" 2>/dev/null || true
  rm -f /tmp/interceptor-bridge.sock /tmp/interceptor-bridge.pid

  echo "==> Removing bridge LaunchAgent..."
  TARGET_UID="$(id -u "${SUDO_USER:-$(id -un)}" 2>/dev/null || id -u)"
  if [[ -n "$TARGET_UID" ]]; then
    launchctl bootout "gui/$TARGET_UID/com.interceptor.bridge" 2>/dev/null || true
  fi
  rm -f "$USER_HOME/Library/LaunchAgents/com.interceptor.bridge.plist"
  if [[ -e "/Library/LaunchAgents/com.interceptor.bridge.plist" ]]; then
    rm -f "/Library/LaunchAgents/com.interceptor.bridge.plist" 2>/dev/null && \
      echo "    removed /Library/LaunchAgents/com.interceptor.bridge.plist" || \
      echo "    /Library/LaunchAgents/com.interceptor.bridge.plist — re-run with sudo"
  fi

  echo "==> Removing bridge .app bundle and symlinks..."
  if [[ -e "$USER_HOME/.local/share/interceptor/interceptor-bridge.app" ]]; then
    rm -rf "$USER_HOME/.local/share/interceptor/interceptor-bridge.app"
  fi
  # If the .local/share/interceptor dir is now empty, drop it.
  rmdir "$USER_HOME/.local/share/interceptor" 2>/dev/null || true
  rm -f "$USER_HOME/.local/bin/interceptor-bridge"
  if [[ -e "/Applications/interceptor-bridge.app" ]]; then
    rm -rf "/Applications/interceptor-bridge.app" 2>/dev/null && \
      echo "    removed /Applications/interceptor-bridge.app" || \
      echo "    /Applications/interceptor-bridge.app — re-run with sudo"
  fi
  if [[ -e "/usr/local/bin/interceptor-bridge" ]]; then
    rm -f "/usr/local/bin/interceptor-bridge" 2>/dev/null || true
  fi

  echo ""
  echo "Bridge removed. Browser-only install remains intact."
  echo "Verify with: interceptor status   (expect 'mode: browser-only')"
  exit 0
fi

# ── Full uninstall (default) ──────────────────────────────────────────────────
echo "==> Stopping interceptor processes..."
pkill -f "interceptor-daemon" 2>/dev/null || true
pkill -f "interceptor-bridge" 2>/dev/null || true

echo "==> Removing runtime files..."
rm -f /tmp/interceptor.sock /tmp/interceptor.pid
rm -f /tmp/interceptor-bridge.sock /tmp/interceptor-bridge.pid

echo "==> Removing native messaging manifests..."
for manifest in "${NM_MANIFESTS[@]}"; do
  rm -f "$manifest"
done

# Read the CLI-link record BEFORE the generated dirs below are deleted — the
# record lives inside one of them. install.sh writes the exact path it linked
# (it honors --link-cli-dir, so the conventional locations are not enough).
CLI_LINK_RECORDS=(
  "${XDG_STATE_HOME:-$USER_HOME/.local/state}/interceptor/cli-link"
  "$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/daemon/.generated/cli-link"
)
RECORDED_LINKS=()
for record in "${CLI_LINK_RECORDS[@]}"; do
  [[ -f "$record" ]] || continue
  while IFS= read -r recorded; do
    [[ -n "$recorded" ]] && RECORDED_LINKS+=("$recorded")
  done < "$record"
  rm -f "$record"
done

# Dev install — clean repo-relative generated dir if present
if [[ -d "$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/daemon/.generated" ]]; then
  rm -rf "$(cd "$(dirname "$0")/.." && pwd)/daemon/.generated"
fi
# System install (deb/rpm under a root-owned /opt) — install.sh writes the
# resolved manifests to the XDG state home instead.
rm -f "${XDG_STATE_HOME:-$USER_HOME/.local/state}/interceptor/com.interceptor.host.json" \
      "${XDG_STATE_HOME:-$USER_HOME/.local/state}/interceptor/com.interceptor.host.firefox.json"
rmdir "${XDG_STATE_HOME:-$USER_HOME/.local/state}/interceptor" 2>/dev/null || true

echo "==> Removing extension metadata from old installs if present..."
rm -f "$USER_HOME/Library/Application Support/Google/Chrome/External Extensions/hkjbaciefhhgekldhncknbjkofbpenng.json"
rm -f "$USER_HOME/Library/Application Support/BraveSoftware/Brave-Browser/External Extensions/hkjbaciefhhgekldhncknbjkofbpenng.json"

echo "==> Removing bridge LaunchAgent (both system and per-user paths)..."
TARGET_UID="$(id -u "${SUDO_USER:-$(id -un)}" 2>/dev/null || id -u)"
if [[ -n "$TARGET_UID" ]]; then
  launchctl bootout "gui/$TARGET_UID/com.interceptor.bridge" 2>/dev/null || true
fi
rm -f "$USER_HOME/Library/LaunchAgents/com.interceptor.bridge.plist"
# pkg install puts the LaunchAgent here (system-wide, root-owned)
if [[ -e "/Library/LaunchAgents/com.interceptor.bridge.plist" ]]; then
  rm -f "/Library/LaunchAgents/com.interceptor.bridge.plist" 2>/dev/null && \
    echo "    removed /Library/LaunchAgents/com.interceptor.bridge.plist" || \
    echo "    /Library/LaunchAgents/com.interceptor.bridge.plist — re-run with sudo"
fi

echo "==> Removing per-user bridge .app bundle and symlinks..."
if [[ -e "$USER_HOME/.local/share/interceptor/interceptor-bridge.app" ]]; then
  rm -rf "$USER_HOME/.local/share/interceptor/interceptor-bridge.app"
fi
rmdir "$USER_HOME/.local/share/interceptor" 2>/dev/null || true
rm -f "$USER_HOME/.local/bin/interceptor-bridge"

echo "==> Removing pkg-installed system files (requires sudo to fully clean)..."
if [[ -e "/Applications/interceptor-bridge.app" ]]; then
  rm -rf "/Applications/interceptor-bridge.app" 2>/dev/null && \
    echo "    removed /Applications/interceptor-bridge.app" || \
    echo "    /Applications/interceptor-bridge.app — re-run with sudo"
fi
if [[ -e "/usr/local/bin/interceptor" ]]; then
  rm -f "/usr/local/bin/interceptor" 2>/dev/null && \
    echo "    removed /usr/local/bin/interceptor" || \
    echo "    /usr/local/bin/interceptor — re-run with sudo"
fi
if [[ -e "/usr/local/bin/interceptor-bridge" ]]; then
  rm -f "/usr/local/bin/interceptor-bridge" 2>/dev/null || true
fi
if [[ -e "/Library/Application Support/Interceptor" ]]; then
  rm -rf "/Library/Application Support/Interceptor" 2>/dev/null && \
    echo "    removed /Library/Application Support/Interceptor" || \
    echo "    /Library/Application Support/Interceptor — re-run with sudo"
fi

# Forget the package receipts so a future reinstall starts clean. macOS-only:
# pkgutil does not exist on Linux, and under `set -euo pipefail` the resulting
# empty pipeline exits non-zero and would abort the rest of the uninstall.
if command -v pkgutil >/dev/null 2>&1; then
  pkgutil --pkgs 2>/dev/null | grep -E '^com\.interceptor\.' | while read -r p; do
    pkgutil --forget "$p" >/dev/null 2>&1 || true
  done
fi

echo "==> Removing CLI PATH symlinks created by install.sh..."
# Only ever remove a symlink that points into an Interceptor install — a real
# file, or a link to something else, belongs to the user or another package.
for link in "${RECORDED_LINKS[@]+"${RECORDED_LINKS[@]}"}" \
            "$USER_HOME/.local/bin/interceptor" "/usr/local/bin/interceptor" \
            "${XDG_BIN_HOME:-$USER_HOME/.local/bin}/interceptor"; do
  [[ -L "$link" ]] || continue
  target="$(readlink -f "$link" 2>/dev/null || true)"
  case "$target" in
    */interceptor)
      rm -f "$link" 2>/dev/null && echo "    removed $link -> $target" || \
        echo "    $link — re-run with sudo" ;;
  esac
done

echo "==> Removing legacy CLI install directory if present..."
rm -rf "$USER_HOME/.interceptor"

echo "==> Removing legacy shell PATH hooks if present..."
for target in "$USER_HOME/.zprofile" "$USER_HOME/.zshrc" "$USER_HOME/.bash_profile" "$USER_HOME/.bashrc"; do
  [[ -f "$target" ]] || continue
  perl -0pi -e "s/\\Q$PATH_MARKER_START\\E.*?\\Q$PATH_MARKER_END\\E\\n?//sg" "$target"
done

echo ""
echo "Interceptor uninstalled."
echo ""
echo "Remove the browser extension manually if it is still present:"
echo "  Brave:    brave://extensions/"
echo "  Chrome:   chrome://extensions/"
echo "  Chromium: chrome://extensions/"
echo "  Firefox:  about:addons  (temporary add-ons are dropped when Firefox quits)"
