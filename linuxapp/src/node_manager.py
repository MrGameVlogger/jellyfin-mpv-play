"""Shim process management, stdout parsing, and mpv IPC.
Port of macapp/Sources/NodeProcessManager.swift for Linux/GTK.
"""
import os
import re
import glob
import json
import time
import signal
import socket
import subprocess
import threading
from datetime import datetime, timezone

from config_parser import (
    app_support_dir,
    config_path,
    default_ipc_socket_path,
    extract_value,
    selected_config_file_name,
)

# Connection status enum
DISCONNECTED = "disconnected"
CONNECTED = "connected"
PLAYING = "playing"


class NodeProcessManager:
    def __init__(self):
        self.process = None
        self.status = DISCONNECTED
        self.is_playing = False
        self.is_paused = False
        self.now_playing = None
        self.is_stopping_playback = False
        self.restart_count = 0
        self.max_restarts = 5
        self.is_shutting_down = False
        self.ipc_socket_path = default_ipc_socket_path()
        self.log_file = None
        self.log_file_path = None
        self._pending_restart = None
        self._last_error_notification_at = 0
        self._stdout_buf = b""
        self._stderr_buf = b""
        self._shutdown_completion = None
        self._restart_timer = None

        # Callbacks (set by the UI layer)
        self.log_handler = None          # fn(line)
        self.status_handler = None       # fn(status)
        self.notification_handler = None # fn(title, message)
        self.now_playing_handler = None  # fn(title_or_none)
        self.pause_state_handler = None  # fn(is_paused)

    # ── Lifecycle ──────────────────────────────────────────────────────

    def start(self):
        """Spawns the shim process."""
        if self._pending_restart:
            self._pending_restart.cancel()
            self._pending_restart = None

        self._close_log_file()
        if self.process and self.process.poll() is None:
            self._terminate_process()

        self.is_shutting_down = False
        self.is_stopping_playback = False
        self.restart_count = 0

        self._setup_app_support()
        self._load_ipc_socket_path()
        self._open_log_file()

        shim_path = os.path.join(app_support_dir(), "shim.js")
        if not os.path.isfile(shim_path):
            self._log("ERROR: shim.js not found in " + app_support_dir())
            return

        node_path = self._find_node_path()
        if not node_path:
            self._log("ERROR: node not found in bundle or system")
            return

        config_file = selected_config_file_name()
        config_abs = os.path.join(app_support_dir(), config_file)

        try:
            self.process = subprocess.Popen(
                [node_path, shim_path, config_abs],
                cwd=app_support_dir(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, "NODE_PATH": os.path.join(app_support_dir(), "node_modules")},
            )
            self._log(f"Started node shim.js (PID: {self.process.pid})")
        except Exception as e:
            self._log(f"ERROR: Failed to start shim: {e}")
            return

        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        threading.Thread(target=self._watch_process, daemon=True).start()

    def stop(self, completion=None):
        """Stops the shim and cleans up. Calls completion when done."""
        if self.is_shutting_down:
            if completion:
                if self._shutdown_completion:
                    prev = self._shutdown_completion
                    def chained(prev=prev, completion=completion):
                        try:
                            prev()
                        except Exception:
                            pass
                        completion()
                    self._shutdown_completion = chained
                else:
                    self._shutdown_completion = completion
            return

        self.is_shutting_down = True
        if self._pending_restart:
            self._pending_restart.cancel()
            self._pending_restart = None
        if self._restart_timer:
            self._restart_timer.cancel()
            self._restart_timer = None

        self._shutdown_completion = completion

        if self.process and self.process.poll() is None:
            self._terminate_process()
        else:
            self._finish_shutdown()

    def _finish_shutdown(self):
        self._reset_playback_state()
        self.status = DISCONNECTED
        self._emit_status()
        self._cleanup_pipes()
        self._remove_ipc_socket()
        self.restart_count = 0
        self._close_log_file()
        cb = self._shutdown_completion
        self._shutdown_completion = None
        if cb:
            cb()

    def _terminate_process(self):
        try:
            self.process.terminate()
            # SIGKILL fallback after 2s
            timer = threading.Timer(2.0, self._kill_process)
            timer.daemon = True
            timer.start()
        except Exception:
            pass

    def _kill_process(self):
        if self.process and self.process.poll() is None:
            try:
                self.process.kill()
            except Exception:
                pass

    def _watch_process(self):
        """Waits for process exit and handles restart logic."""
        if not self.process:
            return
        code = self.process.wait()
        # Drain remaining output
        self._drain_pipes()
        self._on_process_exit(code)

    def _on_process_exit(self, code):
        self.is_playing = False
        self.now_playing = None
        self._emit_now_playing()
        self.status = DISCONNECTED
        self._emit_status()

        if self.is_shutting_down:
            self._log(f"Process terminated (exit code: {code})")
            self.restart_count = 0
            self._finish_shutdown()
        elif self.restart_count < self.max_restarts:
            self.restart_count += 1
            delay = min(2 ** self.restart_count, 30)
            self._log(
                f"Process exited unexpectedly (code: {code}). "
                f"Restarting in {delay}s... (attempt {self.restart_count}/{self.max_restarts})"
            )
            self._restart_timer = threading.Timer(delay, self.start)
            self._restart_timer.daemon = True
            self._restart_timer.start()
        else:
            self._log(f"Process terminated (exit code: {code})")
            self._log("Max restart attempts reached. Click Restart to try again.")

    # ── Stdout/Stderr parsing ──────────────────────────────────────────

    def _read_stdout(self):
        try:
            while True:
                chunk = self.process.stdout.read1(4096)
                if not chunk:
                    break
                self._stdout_buf += chunk
                self._process_buffer(is_stderr=False)
        except Exception:
            pass

    def _read_stderr(self):
        try:
            while True:
                chunk = self.process.stderr.read1(4096)
                if not chunk:
                    break
                self._stderr_buf += chunk
                self._process_buffer(is_stderr=True)
        except Exception:
            pass

    def _process_buffer(self, is_stderr):
        buf = self._stderr_buf if is_stderr else self._stdout_buf
        nl = buf.rfind(b"\n")
        if nl < 0:
            if len(buf) > 1024 * 1024:
                if is_stderr:
                    self._stderr_buf = b""
                else:
                    self._stdout_buf = b""
            return

        complete = buf[: nl + 1]
        if is_stderr:
            self._stderr_buf = buf[nl + 1 :]
        else:
            self._stdout_buf = buf[nl + 1 :]

        text = complete.decode("utf-8", errors="replace")
        for line in text.split("\n"):
            if line:
                if is_stderr:
                    self._process_log_line("STDERR: " + line)
                else:
                    self._process_log_line(line)

    def _process_log_line(self, line):
        if line.startswith("AV:"):
            return

        if self.log_handler:
            self.log_handler(line)
        self._write_log_file(line)

        lower = line.lower()
        if any(x in lower for x in ("error", "fatal")) or "❌" in line or "⚠️" in line:
            now = time.time()
            if now - self._last_error_notification_at > 30:
                self._last_error_notification_at = now
                if self.notification_handler:
                    truncated = line[:200] + "…" if len(line) > 200 else line
                    self.notification_handler("Error", truncated)

        # State transitions (same substring matching as the macOS app)
        if "WebSocket connection established" in line:
            self.status = CONNECTED
            self.restart_count = 0
            self._emit_status()
            if self.notification_handler:
                self.notification_handler("Connected", "Connected to Jellyfin server")

        elif "Episode detected" in line:
            if self.is_stopping_playback:
                return
            title = line.split("Episode detected:", 1)[-1].strip()
            self.now_playing = title
            self.is_playing = True
            self._emit_now_playing()
            self.status = PLAYING
            self._emit_status()

        elif "File loaded by MPV" in line:
            if self.is_stopping_playback:
                return
            if not self.is_playing:
                self.is_playing = True
                self.status = PLAYING
                self._emit_status()

        elif any(x in line for x in (
            "Starting next episode",
            "Starting previous episode",
            "Starting episode: ",
        )):
            if self.is_stopping_playback:
                return
            for prefix in ("Starting next episode: ", "Starting previous episode: ", "Starting episode: "):
                if prefix in line:
                    self.now_playing = line.split(prefix, 1)[-1].strip()
                    break
            self._emit_now_playing()

        elif "Playback paused" in line:
            if self.is_stopping_playback:
                return
            self.is_paused = True
            self._emit_pause_state()

        elif "Playback resumed" in line:
            if self.is_stopping_playback:
                return
            self.is_paused = False
            self._emit_pause_state()

        elif "No more episodes" in line:
            self.is_stopping_playback = False
            self._reset_playback_state()

        elif any(x in line for x in ("Closing application", "MPV closed", "Process terminated")):
            self.is_stopping_playback = False
            self._reset_playback_state()

    def _reset_playback_state(self):
        self.is_playing = False
        self.is_paused = False
        self.now_playing = None
        self._emit_now_playing()
        self._emit_pause_state()
        self.status = CONNECTED
        self._emit_status()

    # ── mpv IPC ────────────────────────────────────────────────────────

    def send_mpv_command(self, command_str):
        """Sends a raw JSON command to mpv via the IPC socket."""
        def _send():
            try:
                if not os.path.exists(self.ipc_socket_path):
                    return
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(2)
                s.connect(self.ipc_socket_path)
                s.sendall((command_str + "\n").encode())
                s.close()
            except Exception:
                pass

        t = threading.Thread(target=_send, daemon=True)
        t.start()

    def toggle_pause(self):
        if self.is_stopping_playback:
            return
        self.send_mpv_command('{"command": ["cycle", "pause"]}')

    def stop_playback(self):
        self.is_stopping_playback = True
        self._reset_playback_state()
        self.send_mpv_command('{"command": ["quit"]}')
        # Fallback: clear the gate after 15s
        def _clear():
            self.is_stopping_playback = False
        t = threading.Timer(15.0, _clear)
        t.daemon = True
        t.start()

    # ── Emitter helpers ────────────────────────────────────────────────

    def _emit_status(self):
        if self.status_handler:
            self.status_handler(self.status)

    def _emit_now_playing(self):
        if self.now_playing_handler:
            self.now_playing_handler(self.now_playing)

    def _emit_pause_state(self):
        if self.pause_state_handler:
            self.pause_state_handler(self.is_paused)

    def _log(self, line):
        if self.log_handler:
            self.log_handler(line)
        self._write_log_file(line)

    # ── Log file ───────────────────────────────────────────────────────

    def _open_log_file(self):
        data_dir = os.path.join(app_support_dir(), "data")
        os.makedirs(data_dir, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%SZ")
        self.log_file_path = os.path.join(data_dir, f"jellyfin-mpv-play-{stamp}.log")
        try:
            self.log_file = open(self.log_file_path, "a")
        except Exception:
            self.log_file = None

    def _write_log_file(self, line):
        if self.log_file:
            try:
                self.log_file.write(line + "\n")
                self.log_file.flush()
            except Exception:
                self._close_log_file()

    def _close_log_file(self):
        if self.log_file:
            try:
                self.log_file.close()
            except Exception:
                pass
            self.log_file = None

    # ── Helpers ────────────────────────────────────────────────────────

    def _setup_app_support(self):
        d = app_support_dir()
        os.makedirs(os.path.join(d, "data"), exist_ok=True)
        # Copy shim.js and package.json from the project if not present
        for fname in ("shim.js", "package.json", "config.example.js"):
            dest = os.path.join(d, fname)
            if not os.path.exists(dest):
                src = os.path.join(os.path.dirname(__file__), "..", "..", fname)
                if os.path.exists(src):
                    import shutil
                    shutil.copy2(src, dest)
        # Create config.js from example if absent
        cfg = config_path()
        if not os.path.exists(cfg):
            example = os.path.join(d, "config.example.js")
            if os.path.exists(example):
                import shutil
                shutil.copy2(example, cfg)

    def _load_ipc_socket_path(self):
        try:
            with open(config_path()) as f:
                val = extract_value(f.read(), "ipcSocketPath")
                if val:
                    self.ipc_socket_path = val
        except Exception:
            pass

    def _find_node_path(self):
        # 1. Bundled node
        bundled = os.path.join(os.path.dirname(__file__), "..", "node", "bin", "node")
        if os.path.isfile(bundled) and os.access(bundled, os.X_OK):
            if self._node_runs(bundled):
                return bundled
        # 2. System node
        for p in ["/usr/bin/node", "/usr/local/bin/node", "/usr/bin/nodejs"]:
            if os.path.isfile(p) and os.access(p, os.X_OK) and self._node_runs(p):
                return p
        # 3. nvm
        nvm_dir = os.path.expanduser("~/.nvm/versions/node")
        if os.path.isdir(nvm_dir):
            versions = sorted(glob.glob(os.path.join(nvm_dir, "*")), reverse=True)
            for v in versions:
                p = os.path.join(v, "bin", "node")
                if os.path.isfile(p) and os.access(p, os.X_OK) and self._node_runs(p):
                    return p
        return ""

    def _node_runs(self, path):
        try:
            r = subprocess.run(
                [path, "--version"],
                capture_output=True,
                timeout=3,
            )
            return r.returncode == 0
        except Exception:
            return False

    def _cleanup_pipes(self):
        self._stdout_buf = b""
        self._stderr_buf = b""

    def _drain_pipes(self):
        """Reads remaining output from pipes before teardown."""
        try:
            if self.process and self.process.stdout:
                remaining = self.process.stdout.read()
                if remaining:
                    self._stdout_buf += remaining
                    self._process_buffer(is_stderr=False)
            if self.process and self.process.stderr:
                remaining = self.process.stderr.read()
                if remaining:
                    self._stderr_buf += remaining
                    self._process_buffer(is_stderr=True)
        except Exception:
            pass

    def _remove_ipc_socket(self):
        try:
            if os.path.exists(self.ipc_socket_path):
                os.unlink(self.ipc_socket_path)
        except Exception:
            pass
