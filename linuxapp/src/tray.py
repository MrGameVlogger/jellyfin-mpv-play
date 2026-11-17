"""System tray icon and menu.
Port of macapp/Sources/StatusBarController.swift for Linux/GTK.
"""
import os
import gi
gi.require_version("Gtk", "3.0")

# Prefer libayatana-appindicator-glib (AyatanaAppIndicatorGlib) over the
# deprecated libayatana-appindicator (AyatanaAppIndicator3). The glib variant
# is only packaged on newer distros (Ubuntu 25.10+, Debian 14+), so fall back.
try:
    gi.require_version("AyatanaAppIndicatorGlib", "0.1")
    from gi.repository import AyatanaAppIndicatorGlib as AppIndicator
except (ValueError, ImportError):
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator

from gi.repository import Gtk, GLib, Gdk

from node_manager import DISCONNECTED, CONNECTED, PLAYING


class TrayController:
    def __init__(self, node_manager, log_viewer, config_dir):
        self.node_manager = node_manager
        self.log_viewer = log_viewer
        self.config_dir = config_dir
        self.now_playing = None
        self.is_paused_state = False
        self.connection_state = DISCONNECTED

        # Windows (lazy-created)
        self._preferences = None
        self._about = None
        self._help = None

        # Callbacks set by main
        self.on_show_preferences = None
        self.on_show_about = None
        self.on_show_help = None
        self.on_quit = None
        self.on_restart = None

        # Build tray icon
        self.indicator = AppIndicator.Indicator.new(
            "jellyfin-mpv-play",
            "media-playback-start-symbolic",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self._build_menu()

        # Wire node manager observers
        node_manager.now_playing_handler = self._on_now_playing
        node_manager.pause_state_handler = self._on_pause_state

    def update_status(self, status):
        """Called by main when connection status changes."""
        self.connection_state = status
        self._render()

    def _build_menu(self):
        self.menu = Gtk.Menu()

        self.now_playing_item = Gtk.MenuItem(label="Not playing")
        self.now_playing_item.set_sensitive(False)
        self.menu.append(self.now_playing_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        self.pause_item = Gtk.MenuItem(label="Pause")
        self.pause_item.connect("activate", lambda _: self.node_manager.toggle_pause())
        self.menu.append(self.pause_item)

        self.stop_item = Gtk.MenuItem(label="Stop")
        self.stop_item.connect("activate", self._on_stop)
        self.menu.append(self.stop_item)

        self.copy_now_playing_item = Gtk.MenuItem(label="Copy Now Playing")
        self.copy_now_playing_item.connect("activate", self._on_copy_now_playing)
        self.menu.append(self.copy_now_playing_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        logs_item = Gtk.MenuItem(label="Show Logs")
        logs_item.connect("activate", lambda _: self.log_viewer.show())
        self.menu.append(logs_item)

        copy_log_item = Gtk.MenuItem(label="Copy Log to Clipboard")
        copy_log_item.connect("activate", lambda _: self.log_viewer.copy_full_log())
        self.menu.append(copy_log_item)

        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect("activate", lambda _: self._show_preferences())
        self.menu.append(settings_item)

        about_item = Gtk.MenuItem(label="About Jellyfin MPV Play")
        about_item.connect("activate", lambda _: self._show_about())
        self.menu.append(about_item)

        help_item = Gtk.MenuItem(label="Help")
        help_item.connect("activate", lambda _: self._show_help())
        self.menu.append(help_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        open_config_item = Gtk.MenuItem(label="Open Config File")
        open_config_item.connect("activate", self._on_open_config)
        self.menu.append(open_config_item)

        open_folder_item = Gtk.MenuItem(label="Open App Folder")
        open_folder_item.connect("activate", self._on_open_folder)
        self.menu.append(open_folder_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        restart_item = Gtk.MenuItem(label="Restart")
        restart_item.connect("activate", lambda _: self._on_restart())
        self.menu.append(restart_item)

        self.menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit Jellyfin MPV Play")
        quit_item.connect("activate", lambda _: self._on_quit())
        self.menu.append(quit_item)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)

    def _render(self):
        """Single render path — sets icon, tooltip, and menu state."""
        pause_label = "Resume" if self.is_paused_state else "Pause"
        self.pause_item.set_label(pause_label)

        playing = self.now_playing is not None
        self.pause_item.set_sensitive(playing)
        self.stop_item.set_sensitive(playing)
        self.copy_now_playing_item.set_sensitive(playing)

        if self.now_playing:
            title = self.now_playing
            prefix = "Paused — " if self.is_paused_state else ""
            self.now_playing_item.set_label(prefix + title)
            if self.is_paused_state:
                self.indicator.set_icon("media-playback-pause-symbolic")
                self.indicator.set_title(f"Jellyfin MPV Play — Paused — {title}")
            else:
                self.indicator.set_icon("media-playback-start-symbolic")
                self.indicator.set_title(f"Jellyfin MPV Play — {title}")
        else:
            self.now_playing_item.set_label("Not playing")
            if self.connection_state == CONNECTED:
                self.indicator.set_icon("emblem-ok-symbolic")
                self.indicator.set_title("Jellyfin MPV Play — Connected")
            elif self.connection_state == PLAYING:
                self.indicator.set_icon("media-playback-start-symbolic")
                self.indicator.set_title("Jellyfin MPV Play — Playing")
            else:
                self.indicator.set_icon("network-offline-symbolic")
                self.indicator.set_title("Jellyfin MPV Play — Disconnected")

    # ── Node manager observers ─────────────────────────────────────────

    def _on_now_playing(self, title):
        GLib.idle_add(self._set_now_playing, title)

    def _set_now_playing(self, title):
        if title != self.now_playing:
            self.is_paused_state = False
        self.now_playing = title
        if title is None:
            self.is_paused_state = False
        self._render()

    def _on_pause_state(self, is_paused):
        GLib.idle_add(self._set_pause_state, is_paused)

    def _set_pause_state(self, is_paused):
        self.is_paused_state = is_paused
        self._render()

    # ── Menu actions ───────────────────────────────────────────────────

    def _on_stop(self, _):
        self.node_manager.stop_playback()
        self.is_paused_state = False
        self._set_now_playing(None)

    def _on_copy_now_playing(self, _):
        if self.now_playing:
            clipboard = Gtk.Clipboard.get(Gdk.Atom.intern("CLIPBOARD", False))
            clipboard.set_text(self.now_playing, -1)

    def _on_open_config(self, _):
        path = os.path.join(self.config_dir, "config.js")
        if os.path.exists(path):
            self._open_path(path)
        else:
            self._show_alert("Config file not found", "Run the app once to create config.js")

    def _on_open_folder(self, _):
        if os.path.isdir(self.config_dir):
            self._open_path(self.config_dir)

    def _on_restart(self, _):
        if self.on_restart:
            self.on_restart()

    def _on_quit(self, _):
        if self.on_quit:
            self.on_quit()

    def _show_preferences(self):
        if self.on_show_preferences:
            self.on_show_preferences()

    def _show_about(self):
        if self.on_show_about:
            self.on_show_about()

    def _show_help(self):
        if self.on_show_help:
            self.on_show_help()

    def _open_path(self, path):
        import subprocess
        subprocess.Popen(["xdg-open", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _show_alert(self, title, message):
        dialog = Gtk.MessageDialog(
            transient_for=None,
            flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.OK,
            text=title,
        )
        dialog.format_secondary_text(message)
        dialog.run()
        dialog.destroy()
