#!/bin/bash
# Package a staged Linux build (dist/linux/<arch>/) for distribution.
#
#   bash scripts/package-linux.sh --arch x64                  # tar.gz + deb + rpm
#   bash scripts/package-linux.sh --arch x64 --format tar.gz  # just the tarball
#   bash scripts/package-linux.sh --arch x64-musl             # tar.gz only (musl)
#
# Run scripts/build.sh --target=linux-<arch> first; this script never builds.
#
# Install prefix is /opt/interceptor with /usr/bin/interceptor pointing at it.
# The system package deliberately stops there: registering a native-messaging
# host writes into ~/.config or ~/.mozilla, which is per-user state a root
# package install must not create for one arbitrary user. Each user finishes
# with `interceptor-install` (or scripts/install.sh directly).
set -euo pipefail

cd "$(dirname "$0")/.."

ARCH=""
FORMATS=""
OUT_DIR="dist/linux/packages"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)     ARCH="$2"; shift 2 ;;
    --arch=*)   ARCH="${1#--arch=}"; shift ;;
    --format)   FORMATS="$2"; shift 2 ;;
    --format=*) FORMATS="${1#--format=}"; shift ;;
    --out)      OUT_DIR="$2"; shift 2 ;;
    --out=*)    OUT_DIR="${1#--out=}"; shift ;;
    -h|--help)
      echo "Usage: bash scripts/package-linux.sh --arch <x64|arm64|x64-musl|arm64-musl> [--format tar.gz,deb,rpm] [--out DIR]"
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ARCH" ]]; then
  echo "ERROR: --arch is required (x64 | arm64 | x64-musl | arm64-musl)." >&2
  exit 1
fi

STAGE="dist/linux/$ARCH"
if [[ ! -x "$STAGE/interceptor" ]]; then
  echo "ERROR: $STAGE/interceptor not found." >&2
  echo "       Run: bash scripts/build.sh --target=linux-$ARCH" >&2
  exit 1
fi

VERSION="$(grep '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')"

# Architecture naming differs per packaging system; keep the three vocabularies
# explicit rather than string-munging them at each use.
case "$ARCH" in
  x64)        DEB_ARCH="amd64"; RPM_ARCH="x86_64";  LIBC="glibc" ;;
  arm64)      DEB_ARCH="arm64"; RPM_ARCH="aarch64"; LIBC="glibc" ;;
  x64-musl)   DEB_ARCH="";      RPM_ARCH="";        LIBC="musl"  ;;
  arm64-musl) DEB_ARCH="";      RPM_ARCH="";        LIBC="musl"  ;;
  *) echo "ERROR: unsupported --arch '$ARCH'." >&2; exit 1 ;;
esac

# musl targets exist for Alpine, which uses apk, not dpkg or rpm. Producing a
# .deb of a musl-linked binary would install cleanly on Debian and then fail to
# execute, so those formats are refused rather than silently built.
if [[ -z "$FORMATS" ]]; then
  if [[ "$LIBC" == "musl" ]]; then FORMATS="tar.gz"; else FORMATS="tar.gz,deb,rpm"; fi
fi

mkdir -p "$OUT_DIR"
BASENAME="interceptor-$VERSION-linux-$ARCH"

# Common tree assembled once and reused by every format: prefix-relative paths
# exactly as they land on the target system.
PKGROOT="$(mktemp -d)"
trap 'rm -rf "$PKGROOT"' EXIT
mkdir -p "$PKGROOT/opt/interceptor" "$PKGROOT/usr/bin"
cp -R "$STAGE"/. "$PKGROOT/opt/interceptor/"
chmod 755 "$PKGROOT/opt/interceptor/interceptor" "$PKGROOT/opt/interceptor/daemon/interceptor-daemon"

# One wrapper instead of a second copy of the installer: it forwards to the
# packaged scripts/install.sh, which resolves everything relative to its own
# parent dir.
cat > "$PKGROOT/usr/bin/interceptor-install" <<'WRAPPER'
#!/bin/sh
# Register Interceptor's native-messaging host for the CURRENT user.
exec bash /opt/interceptor/scripts/install.sh "$@"
WRAPPER
chmod 755 "$PKGROOT/usr/bin/interceptor-install"
ln -sfn /opt/interceptor/interceptor "$PKGROOT/usr/bin/interceptor"

have() { command -v "$1" >/dev/null 2>&1; }

build_tar() {
  local out="$OUT_DIR/$BASENAME.tar.gz"
  echo "==> tar.gz: $out"
  # Ship the same prefix layout the packages use, under one top-level directory
  # so `tar xzf` never scatters files into $PWD.
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/$BASENAME"
  cp -R "$STAGE"/. "$tmp/$BASENAME/"
  local musl_note=""
  if [[ "$LIBC" == "musl" ]]; then
    # Bun's musl builds link libstdc++/libgcc dynamically and bare Alpine ships
    # neither, so the binary dies with "Error loading shared library
    # libstdc++.so.6" before printing anything of its own.
    musl_note="  0. Alpine only — install the C++ runtime Bun links against:
       apk add libstdc++ libgcc
"
  fi
  cat > "$tmp/$BASENAME/README-INSTALL.txt" <<EOF
Interceptor $VERSION — Linux $ARCH ($LIBC)

$musl_note  1. Move this directory somewhere stable, e.g.:
       sudo mv $BASENAME /opt/interceptor
  2. Put the CLI on PATH:
       ln -sfn /opt/interceptor/interceptor ~/.local/bin/interceptor
  3. Register the native-messaging host for your browser:
       bash /opt/interceptor/scripts/install.sh --browser-only --chrome
     (also: --brave, --chromium, --firefox)
  4. Load the extension — see docs/linux-install.md.

Uninstall: bash /opt/interceptor/scripts/uninstall.sh
EOF
  tar -czf "$out" -C "$tmp" "$BASENAME"
  rm -rf "$tmp"
}

build_deb() {
  if ! have dpkg-deb; then
    echo "==> deb: SKIPPED (dpkg-deb not found)"
    return 0
  fi
  local out="$OUT_DIR/${BASENAME}.deb" tmp
  echo "==> deb: $out"
  tmp="$(mktemp -d)"
  cp -R "$PKGROOT"/. "$tmp/"
  mkdir -p "$tmp/DEBIAN"
  cat > "$tmp/DEBIAN/control" <<EOF
Package: interceptor
Version: $VERSION
Section: web
Priority: optional
Architecture: $DEB_ARCH
Maintainer: Hacker Valley Media <support@hackervalley.media>
Recommends: google-chrome-stable | chromium | brave-browser | firefox
Description: Drive a real signed-in browser from one CLI, built for AI agents
 Interceptor runs as a WebExtension inside your existing Chrome, Chromium,
 Brave, or Firefox session and exposes it through a single CLI: accessibility
 trees, page text, clicks and typing, passive network capture, screenshots,
 and record/replay. Browser-only on Linux; the macOS and iOS surfaces need a
 macOS host.
EOF
  cat > "$tmp/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
echo "Interceptor installed to /opt/interceptor."
echo "Finish setup for your user:  interceptor-install --browser-only --chrome"
echo "  (also: --brave, --chromium, --firefox)"
EOF
  chmod 755 "$tmp/DEBIAN/postinst"
  # dpkg-deb refuses a tree it cannot attribute; normalize before building.
  find "$tmp" -type d -exec chmod 755 {} +
  dpkg-deb --root-owner-group --build "$tmp" "$out" >/dev/null
  rm -rf "$tmp"
}

build_rpm() {
  if ! have rpmbuild; then
    echo "==> rpm: SKIPPED (rpmbuild not found)"
    return 0
  fi
  local out="$OUT_DIR/${BASENAME}.rpm" top
  echo "==> rpm: $out"
  top="$(mktemp -d)"
  mkdir -p "$top/BUILD" "$top/RPMS" "$top/SPECS" "$top/BUILDROOT"
  local buildroot="$top/BUILDROOT/interceptor-$VERSION"
  mkdir -p "$buildroot"
  cp -R "$PKGROOT"/. "$buildroot/"
  cat > "$top/SPECS/interceptor.spec" <<EOF
Name:           interceptor
Version:        $VERSION
Release:        1
Summary:        Drive a real signed-in browser from one CLI, built for AI agents
License:        Elastic-2.0
URL:            https://github.com/Hacker-Valley-Media/Interceptor
BuildArch:      $RPM_ARCH
# The binaries are self-contained Bun builds; nothing is linked at package level.
AutoReqProv:    no

%description
Interceptor runs as a WebExtension inside your existing Chrome, Chromium,
Brave, or Firefox session and exposes it through a single CLI: accessibility
trees, page text, clicks and typing, passive network capture, screenshots,
and record/replay. Browser-only on Linux; the macOS and iOS surfaces need a
macOS host.

%files
/opt/interceptor
/usr/bin/interceptor
/usr/bin/interceptor-install

%post
echo "Interceptor installed to /opt/interceptor."
echo "Finish setup for your user:  interceptor-install --browser-only --chrome"

%changelog
EOF
  # rpmbuild traces its %install/%clean shell with set -x on stderr even when it
  # succeeds; keep the log and only surface it if the build actually fails.
  if ! rpmbuild --define "_topdir $top" \
                --define "_rpmdir $top/RPMS" \
                --buildroot "$buildroot" \
                -bb "$top/SPECS/interceptor.spec" >"$top/rpmbuild.log" 2>&1; then
    echo "ERROR: rpmbuild failed:" >&2
    cat "$top/rpmbuild.log" >&2
    rm -rf "$top"
    return 1
  fi
  local built
  built="$(find "$top/RPMS" -name '*.rpm' -type f | head -1)"
  if [[ -z "$built" ]]; then
    echo "ERROR: rpmbuild produced no package." >&2
    rm -rf "$top"
    return 1
  fi
  cp "$built" "$out"
  rm -rf "$top"
}

IFS=',' read -r -a FORMAT_LIST <<< "$FORMATS"
for fmt in "${FORMAT_LIST[@]}"; do
  case "$fmt" in
    tar.gz) build_tar ;;
    deb)
      if [[ "$LIBC" == "musl" ]]; then
        echo "==> deb: SKIPPED (musl build; Alpine uses apk, and a musl binary will not run on a dpkg distro)"
      else
        build_deb
      fi
      ;;
    rpm)
      if [[ "$LIBC" == "musl" ]]; then
        echo "==> rpm: SKIPPED (musl build; a musl binary will not run on an rpm distro)"
      else
        build_rpm
      fi
      ;;
    *) echo "ERROR: unknown format '$fmt' (tar.gz | deb | rpm)." >&2; exit 1 ;;
  esac
done

echo ""
echo "Packages in $OUT_DIR:"
ls -la "$OUT_DIR" | grep -E "$BASENAME" || true
