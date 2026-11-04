#!/bin/bash
set -e

# Resolve symlink: follow $0 to its real path
SOURCE="$0"
while [ -L "$SOURCE" ]; do
    DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

CONFIG_FILE="$SCRIPT_DIR/config.js"
EXAMPLE_CONFIG="$SCRIPT_DIR/config.example.js"

# Accept config file as first argument (e.g., ./launch.sh config.work.js)
if [ -n "$1" ] && [[ "$1" != --* ]]; then
    if [[ "$1" = /* ]]; then
        CONFIG_FILE="$1"
    else
        CONFIG_FILE="$SCRIPT_DIR/$1"
    fi
    shift
fi

if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$EXAMPLE_CONFIG" ]; then
        cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
        echo "First run: created config.js from config.example.js"
        echo "Please edit $CONFIG_FILE with your Jellyfin server details and MPV path, then run this again."
        exit 0
    else
        echo "ERROR: config.example.js not found. Bundle may be corrupted." >&2
        exit 1
    fi
fi

NODE_BIN="$SCRIPT_DIR/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: Bundled Node.js not found at $NODE_BIN" >&2
    echo "Bundle may be corrupted. Please re-download." >&2
    exit 1
fi

# Node.js 25+ Linux binaries link against libatomic.so.1; the bundle carries a
# pinned copy in lib/ so minimal distros work without installing it.
if [ -d "$SCRIPT_DIR/lib" ]; then
    export LD_LIBRARY_PATH="$SCRIPT_DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

MPV_PATH=""
# Try to read mpvPath from config.js
if [ -f "$CONFIG_FILE" ]; then
    MPV_CONFIG="$("$NODE_BIN" -e "try { const c=require(process.argv[1]); process.stdout.write(c.mpvPath||''); } catch(e) { process.exit(2) }" "$CONFIG_FILE" 2>/dev/null)" || true
    if [ -n "$MPV_CONFIG" ]; then
        if [[ "$MPV_CONFIG" = */* ]]; then
            # It's a path (absolute or relative with directory component)
            if [[ "$MPV_CONFIG" = /* ]]; then
                MPV_PATH="$MPV_CONFIG"
            elif [ -f "$SCRIPT_DIR/$MPV_CONFIG" ]; then
                MPV_PATH="$SCRIPT_DIR/$MPV_CONFIG"
            else
                MPV_PATH="$MPV_CONFIG"
            fi
        else
            # Bare command name — search PATH
            MPV_PATH="$(command -v "$MPV_CONFIG" || true)"
        fi
    fi
fi

# Fall back to mpv in PATH
if [ -z "$MPV_PATH" ]; then
    MPV_PATH="$(command -v mpv || true)"
fi

if [ -z "$MPV_PATH" ] || [ ! -x "$MPV_PATH" ]; then
    echo "ERROR: mpv not found." >&2
    if [ -n "$MPV_PATH" ]; then
        echo "Configured path is not executable: $MPV_PATH" >&2
    fi
    echo "Install it with your package manager, e.g.:" >&2
    echo "  Ubuntu/Debian:  sudo apt install mpv" >&2
    echo "  Fedora:         sudo dnf install mpv" >&2
    echo "  Arch:           sudo pacman -S mpv" >&2
    echo "Or set mpvPath in config.js to the full path of your mpv binary." >&2
    exit 1
fi

export JELLYFIN_MPV_PATH="$MPV_PATH"

if [ ! -f "$SCRIPT_DIR/shim.js" ]; then
    echo "ERROR: shim.js not found in $SCRIPT_DIR" >&2
    echo "Bundle may be corrupted. Please re-download." >&2
    exit 1
fi

# Install systemd service
if [ "$1" = "--install-service" ]; then
    SERVICE_FILE="$SCRIPT_DIR/linux/jellyfin-mpv-play.service"
    if [ ! -f "$SERVICE_FILE" ]; then
        SERVICE_FILE="$SCRIPT_DIR/jellyfin-mpv-play.service"
    fi
    if [ ! -f "$SERVICE_FILE" ]; then
        echo "ERROR: Service file not found at $SERVICE_FILE" >&2
        exit 1
    fi
    # Patch ExecStart and WorkingDirectory to actual install path
    sed "s|/opt/jellyfin-mpv-play|$SCRIPT_DIR|g" "$SERVICE_FILE" > /tmp/jellyfin-mpv-play.service
    mkdir -p ~/.config/systemd/user
    cp /tmp/jellyfin-mpv-play.service ~/.config/systemd/user/jellyfin-mpv-play.service
    systemctl --user daemon-reload
    systemctl --user enable jellyfin-mpv-play.service
    echo "Service installed and enabled. Start with: systemctl --user start jellyfin-mpv-play"
    echo "View logs with: journalctl --user -u jellyfin-mpv-play -f"
    exit 0
fi

# Uninstall systemd service
if [ "$1" = "--uninstall-service" ]; then
    systemctl --user stop jellyfin-mpv-play.service 2>/dev/null || true
    systemctl --user disable jellyfin-mpv-play.service 2>/dev/null || true
    rm -f ~/.config/systemd/user/jellyfin-mpv-play.service
    systemctl --user daemon-reload
    echo "Service stopped, disabled, and removed."
    exit 0
fi

set +e
cd "$SCRIPT_DIR"

# Check if headless is enabled in config
IS_HEADLESS=false
if [ "$1" = "--headless" ]; then
    IS_HEADLESS=true
elif [ -f "$CONFIG_FILE" ] && "$NODE_BIN" -e "const c=require(process.argv[1]); if(c.headless) process.exit(0); else process.exit(1);" "$CONFIG_FILE" 2>/dev/null; then
    IS_HEADLESS=true
fi

if [ "$IS_HEADLESS" = true ]; then
    nohup "$NODE_BIN" "$SCRIPT_DIR/shim.js" "$CONFIG_FILE" "$@" > /dev/null 2>&1 &
    NODE_PID=$!
    disown $NODE_PID
    CONFIG_BASE=$(basename "$CONFIG_FILE" .js)
    echo "Running headless (PID: $NODE_PID). Logs: $SCRIPT_DIR/data/shim-${CONFIG_BASE}*.log"
    echo "Stop with: kill $NODE_PID"
    exit 0
elif [ ! -t 0 ] && [ "$1" != "--terminal" ]; then
    # Not in a terminal and not explicitly requesting terminal — re-exec in one
    for TERM_CMD in x-terminal-emulator gnome-terminal konsole xfce4-terminal mate-terminal tilix alacritty kitty xterm; do
        if command -v "$TERM_CMD" &>/dev/null; then
            exec "$TERM_CMD" -e "$0" --terminal
        fi
    done
    # No terminal found, fall back to running silently
    CONFIG_BASE=$(basename "$CONFIG_FILE" .js)
    echo "No terminal emulator found. Running silently. Logs: $SCRIPT_DIR/data/shim-${CONFIG_BASE}*.log"
    nohup "$NODE_BIN" "$SCRIPT_DIR/shim.js" "$CONFIG_FILE" "$@" > /dev/null 2>&1 &
    NODE_PID=$!
    disown $NODE_PID
    exit 0
else
    "$NODE_BIN" "$SCRIPT_DIR/shim.js" "$CONFIG_FILE" "$@" &
    NODE_PID=$!
    trap 'kill $NODE_PID 2>/dev/null' INT TERM
    wait $NODE_PID
fi

EXIT_CODE=$?
set -e
if [ $EXIT_CODE -ne 0 ]; then
    echo "" >&2
    echo "Shim exited with error code $EXIT_CODE" >&2
fi
exit $EXIT_CODE
