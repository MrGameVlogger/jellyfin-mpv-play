#!/bin/bash

set -e

# Build against the same minimum macOS the app advertises (Info.plist
# LSMinimumSystemVersion). Without this, the binary's minimum OS becomes the
# build machine's SDK default and the app refuses to launch on macOS 13/14.
export MACOSX_DEPLOYMENT_TARGET=13.0

APP_NAME="Jellyfin MPV Play"
BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$BUILD_DIR")"
APP_BUNDLE="$PROJECT_DIR/$APP_NAME.app"
SOURCES_DIR="$BUILD_DIR/Sources"
RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"

NODE_VERSION="22.23.4"
NODE_DIR="$RESOURCES_DIR/node"

echo "Building $APP_NAME..."

# Preflight
for required in "$PROJECT_DIR/shim.js" "$PROJECT_DIR/package.json" "$PROJECT_DIR/config.example.js" "$PROJECT_DIR/images/icon-light.svg" "$PROJECT_DIR/images/icon-dark.svg"; do
    if [ ! -f "$required" ]; then
        echo "ERROR: Missing required file: $required" >&2
        exit 1
    fi
done
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo "ERROR: node_modules not found. Run 'npm install' in $PROJECT_DIR first." >&2
    exit 1
fi

# Clean old build
rm -rf "$APP_BUNDLE"

# Create .app bundle structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$RESOURCES_DIR"

# Copy Info.plist
cp "$BUILD_DIR/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# Copy app icon
cp "$BUILD_DIR/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
cp "$PROJECT_DIR/images/icon-light.svg" "$RESOURCES_DIR/icon-light.svg"
cp "$PROJECT_DIR/images/icon-dark.svg" "$RESOURCES_DIR/icon-dark.svg"

# Bundle JS files into Resources
echo "Bundling JS files..."
cp "$PROJECT_DIR/shim.js" "$RESOURCES_DIR/shim.js"
cp "$PROJECT_DIR/package.json" "$RESOURCES_DIR/package.json"
cp "$PROJECT_DIR/config.example.js" "$RESOURCES_DIR/config.example.js"
cp -R "$PROJECT_DIR/node_modules" "$RESOURCES_DIR/node_modules"

# Download and bundle Node.js
echo "Bundling Node.js v$NODE_VERSION..."
ARCH=$(uname -m)
# A Rosetta 2 translated shell reports x86_64 on Apple Silicon — build native
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    echo "Note: Rosetta 2 translation detected, building arm64."
    ARCH="arm64"
fi
if [ "$ARCH" = "arm64" ]; then
    NODE_ARCH="arm64"
else
    NODE_ARCH="x64"
fi
NODE_TAR="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR"
NODE_TMP="$PROJECT_DIR/.node-tmp"

rm -rf "$NODE_TMP"
mkdir -p "$NODE_TMP"

echo "Downloading $NODE_URL..."
curl -fL --retry 3 --retry-delay 2 "$NODE_URL" -o "$NODE_TMP/$NODE_TAR"

# Verify SHA256 checksum (fixed-string match: dots in the filename are literal)
CHECKSUM_URL="https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
EXPECTED=$(curl -fsL --retry 3 --retry-delay 2 "$CHECKSUM_URL" | grep -F "$NODE_TAR" | awk '{print $1}')
ACTUAL=$(shasum -a 256 "$NODE_TMP/$NODE_TAR" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
    echo "ERROR: Could not download SHASUMS256.txt (or no entry for $NODE_TAR)." >&2
    rm -rf "$NODE_TMP"
    exit 1
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "ERROR: Node.js checksum mismatch!" >&2
    echo "  Expected: $EXPECTED" >&2
    echo "  Actual:   $ACTUAL" >&2
    rm -rf "$NODE_TMP"
    exit 1
fi
echo "Checksum verified."

echo "Extracting..."
tar -xzf "$NODE_TMP/$NODE_TAR" -C "$NODE_TMP"
mv "$NODE_TMP/node-v$NODE_VERSION-darwin-$NODE_ARCH" "$NODE_DIR"
rm -rf "$NODE_TMP"

# Make node executable
chmod +x "$NODE_DIR/bin/node"

# Remove unnecessary npm/corepack to reduce bundle size
rm -rf "$NODE_DIR/lib/node_modules/npm" "$NODE_DIR/lib/node_modules/corepack" 2>/dev/null || true
rm -f "$NODE_DIR/bin/npm" "$NODE_DIR/bin/npx" "$NODE_DIR/bin/corepack" 2>/dev/null || true

echo "Node.js bundled: $NODE_DIR/bin/node ($NODE_ARCH)"

# Compile Swift sources
echo "Compiling Swift sources..."
swiftc \
    -sdk "$(xcrun --show-sdk-path)" \
    -target "$ARCH-apple-macos13.0" \
    -framework Cocoa \
    -framework UserNotifications \
    -O \
    "$SOURCES_DIR"/*.swift \
    -o "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

echo "Build complete: $APP_BUNDLE"
echo "Run with: open \"$APP_BUNDLE\""

# Deploy to /Applications (skip in CI)
if [ -n "$CI" ]; then
    echo "CI environment detected, skipping deploy to /Applications."
else
    DEPLOY_PATH="/Applications/$APP_NAME.app"
    # pgrep can return several PIDs — handle each one
    for pid in $(pgrep -f "$APP_BUNDLE/Contents/MacOS/$APP_NAME" 2>/dev/null || true); do
        kill "$pid" 2>/dev/null || true
    done
    for i in $(seq 1 10); do
        pgrep -f "$APP_BUNDLE/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || break
        sleep 0.5
    done
    for pid in $(pgrep -f "$APP_BUNDLE/Contents/MacOS/$APP_NAME" 2>/dev/null || true); do
        kill -9 "$pid" 2>/dev/null || true
    done
    # Stage next to the target and swap, so a failed copy never leaves
    # /Applications without the app.
    STAGE_PATH="/Applications/$APP_NAME.app.new"
    rm -rf "$STAGE_PATH" 2>/dev/null || true
    if cp -R "$APP_BUNDLE" "$STAGE_PATH" 2>/dev/null; then
        if rm -rf "$DEPLOY_PATH" 2>/dev/null && mv "$STAGE_PATH" "$DEPLOY_PATH" 2>/dev/null; then
            echo "Deployed to: $DEPLOY_PATH"
        else
            echo "WARNING: Could not replace $DEPLOY_PATH (permission denied). Run with sudo or copy manually:"
            echo "  cp -R \"$APP_BUNDLE\" \"$DEPLOY_PATH\""
            rm -rf "$STAGE_PATH" 2>/dev/null || true
        fi
    else
        echo "WARNING: Could not write to /Applications (permission denied). Run with sudo or copy manually:"
        echo "  cp -R \"$APP_BUNDLE\" \"$DEPLOY_PATH\""
    fi
fi
