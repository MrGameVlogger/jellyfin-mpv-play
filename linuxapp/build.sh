#!/usr/bin/env bash
# Build script for Jellyfin MPV Play Linux tray application.
# Creates a self-contained bundle with Python source, shim.js, Node.js, and node_modules.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build/linuxapp"
BUNDLE_NAME="JellyfinMPVPlay-Linux"

echo "Building Jellyfin MPV Play (Linux tray)..."

# ── Preflight ──────────────────────────────────────────────────────────
for f in shim.js package.json config.example.js .node-version; do
    if [ ! -f "$PROJECT_DIR/$f" ]; then
        echo "ERROR: $f not found in $PROJECT_DIR" >&2
        exit 1
    fi
done

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo "ERROR: node_modules/ not found. Run 'npm install' first." >&2
    exit 1
fi

# ── Clean ──────────────────────────────────────────────────────────────
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/resources"

echo "Bundling JS files..."
cp "$PROJECT_DIR/shim.js" "$BUILD_DIR/"
cp "$PROJECT_DIR/package.json" "$BUILD_DIR/"
cp "$PROJECT_DIR/config.example.js" "$BUILD_DIR/"
cp -R "$PROJECT_DIR/node_modules" "$BUILD_DIR/"

echo "Bundling Python sources..."
cp -R "$SCRIPT_DIR/src" "$BUILD_DIR/"
chmod +x "$BUILD_DIR/src/main.py"

# ── Resources ──────────────────────────────────────────────────────────
if [ -f "$PROJECT_DIR/images/icon-light.svg" ]; then
    cp "$PROJECT_DIR/images/icon-light.svg" "$BUILD_DIR/resources/"
fi
if [ -f "$PROJECT_DIR/images/icon-dark.svg" ]; then
    cp "$PROJECT_DIR/images/icon-dark.svg" "$BUILD_DIR/resources/"
fi

# ── Node.js ────────────────────────────────────────────────────────────
NODE_VERSION="$(tr -d '[:space:]' < "$PROJECT_DIR/.node-version")"

# Target architecture: first arg is x86_64|arm64, or auto-detect from host.
# Second arg (optional) is --package to produce a tar.gz.
TARGET_ARCH=""
DO_PACKAGE=false
for arg in "$@"; do
    case "$arg" in
        --package) DO_PACKAGE=true ;;
        x86_64|amd64|aarch64|arm64) TARGET_ARCH="$arg" ;;
    esac
done
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"
case "$TARGET_ARCH" in
    x86_64|amd64) NODE_ARCH="x64"; ARCH_LABEL="x86_64" ;;
    aarch64|arm64) NODE_ARCH="arm64"; ARCH_LABEL="arm64" ;;
    *) echo "ERROR: Unsupported architecture: $TARGET_ARCH (use x86_64 or arm64)" >&2; exit 1 ;;
esac

NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

echo "Bundling Node.js v${NODE_VERSION}..."
if [ ! -d "$BUILD_DIR/node" ]; then
    TMPDIR_NODE="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR_NODE"' EXIT
    cd "$TMPDIR_NODE"
    curl -fL --retry 3 --retry-delay 2 -o "$NODE_TARBALL" "$NODE_URL"

    # Verify checksum
    echo "Verifying checksum..."
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt
    EXPECTED="$(grep -F "$NODE_TARBALL" SHASUMS256.txt | awk '{print $1}')"
    ACTUAL="$(sha256sum "$NODE_TARBALL" | awk '{print $1}')"
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "ERROR: Checksum mismatch for $NODE_TARBALL" >&2
        echo "  Expected: $EXPECTED" >&2
        echo "  Actual:   $ACTUAL" >&2
        rm -f "$NODE_TARBALL" SHASUMS256.txt
        exit 1
    fi
    rm -f SHASUMS256.txt

    echo "Extracting..."
    tar xzf "$NODE_TARBALL"
    mv "node-v${NODE_VERSION}-linux-${NODE_ARCH}" "$BUILD_DIR/node"
    rm -f "$NODE_TARBALL"
    chmod +x "$BUILD_DIR/node/bin/node"

    # Strip npm/corepack to shrink the bundle
    rm -rf "$BUILD_DIR/node/lib/node_modules/npm"
    rm -rf "$BUILD_DIR/node/lib/node_modules/corepack"
    rm -f "$BUILD_DIR/node/bin/npm" "$BUILD_DIR/node/bin/npx" "$BUILD_DIR/node/bin/corepack"
fi

# ── Launcher script ────────────────────────────────────────────────────
echo "Creating launcher..."
cat > "$BUILD_DIR/jellyfin-mpv-play-tray" << 'LAUNCHER'
#!/usr/bin/env bash
# Jellyfin MPV Play Linux tray launcher
# Resolve symlinks so this works from ~/.local/bin or any link.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
    DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

# Find Python 3 with GTK3 and AppIndicator support
for py in python3 python3.11 python3.10 python3.9; do
    if command -v "$py" &>/dev/null; then
        if "$py" -c "import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk" 2>/dev/null; then
            export PYTHONPATH="$DIR/src:$PYTHONPATH"
            export NODE_PATH="$DIR/node_modules:$NODE_PATH"
            cd "$DIR"
            exec "$py" "$DIR/src/main.py" "$@"
        fi
    fi
done

echo "ERROR: Python 3 with GTK3 (PyGObject) is required." >&2
echo "Install with: sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1" >&2
exit 1
LAUNCHER
chmod +x "$BUILD_DIR/jellyfin-mpv-play-tray"

# ── Desktop entry ──────────────────────────────────────────────────────
cp "$SCRIPT_DIR/jellyfin-mpv-play.desktop" "$BUILD_DIR/"

# ── Install script ─────────────────────────────────────────────────────
echo "Creating install script..."
cat > "$BUILD_DIR/install.sh" << 'INSTALL'
#!/usr/bin/env bash
# Installs Jellyfin MPV Play tray app to ~/.local
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/jellyfin-mpv-play-tray"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"

echo "Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$DESKTOP_DIR" "$AUTOSTART_DIR"

# Copy bundle
cp -R "$SCRIPT_DIR"/* "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/jellyfin-mpv-play-tray"

# Symlink launcher
ln -sf "$INSTALL_DIR/jellyfin-mpv-play-tray" "$BIN_DIR/jellyfin-mpv-play-tray"

# Install icon and use absolute path in desktop entry (avoids icon-theme lookup)
ICON_DIR="$INSTALL_DIR/resources"
if [ -f "$SCRIPT_DIR/resources/icon-light.svg" ]; then
    cp "$SCRIPT_DIR/resources/icon-light.svg" "$ICON_DIR/"
fi

# Install desktop entry (absolute Exec and Icon paths, set working directory)
sed -e "s|Exec=jellyfin-mpv-play-tray|Exec=$BIN_DIR/jellyfin-mpv-play-tray\nPath=$INSTALL_DIR|" \
    -e "s|Icon=jellyfin-mpv-play|Icon=$ICON_DIR/icon-light.svg|" \
    "$SCRIPT_DIR/jellyfin-mpv-play.desktop" > "$DESKTOP_DIR/jellyfin-mpv-play.desktop"

# Update desktop database
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

echo ""
echo "Installed successfully!"
echo "  Launch:     jellyfin-mpv-play-tray"
echo "  App menu:   Should appear in your application menu"
echo ""
echo "To enable autostart at login:"
echo "  cp $DESKTOP_DIR/jellyfin-mpv-play.desktop $AUTOSTART_DIR/"
echo ""
echo "Dependencies (install if missing):"
echo "  sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1 libnotify4"
echo "  (or equivalent for your distro)"
INSTALL
chmod +x "$BUILD_DIR/install.sh"

echo ""
echo "Build complete ($ARCH_LABEL): $BUILD_DIR"
echo "  Run directly:    $BUILD_DIR/jellyfin-mpv-play-tray"
echo "  Install:         $BUILD_DIR/install.sh"

# ── Package ────────────────────────────────────────────────────────────
if [ "$DO_PACKAGE" = true ]; then
    APP_VERSION="$(node -p "require('$PROJECT_DIR/package.json').version" 2>/dev/null || echo "preview")"
    PACKAGE_NAME="JellyfinMPVPlay-Linux-Tray-${ARCH_LABEL}-v${APP_VERSION}"
    PACKAGE_PATH="$PROJECT_DIR/build/${PACKAGE_NAME}.tar.gz"
    echo ""
    echo "Packaging: $PACKAGE_PATH"
    cd "$PROJECT_DIR/build"
    rm -f "$PACKAGE_PATH"
    mv linuxapp "$PACKAGE_NAME"
    tar czf "$PACKAGE_PATH" "$PACKAGE_NAME"
    mv "$PACKAGE_NAME" linuxapp
    echo "  Package: $PACKAGE_PATH"
    echo "  Size: $(du -h "$PACKAGE_PATH" | cut -f1)"
fi
echo ""
echo "Dependencies (required on target system):"
echo "  Python 3.8+ with PyGObject, GTK3, AyatanaAppIndicator3"
echo "  Debian/Ubuntu: sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1 libnotify4"
echo "    (or gir1.2-ayatanaappindicatorglib-2.0 on Ubuntu 25.10+)"
echo "  Fedora: sudo dnf install python3-gobject gtk3 libayatana-appindicator-gtk3 libnotify"
echo "  Arch: sudo pacman -S python-gobject gtk3 libayatana-appindicator libnotify"
