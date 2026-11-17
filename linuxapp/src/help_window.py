"""Scrollable help document window.
Port of macapp/Sources/HelpWindowController.swift for Linux/GTK.
"""
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib


class HelpWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title="Help")
        self.set_default_size(560, 520)
        self.set_size_request(400, 300)
        self.set_resizable(True)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.connect("delete-event", self._on_delete)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        self.add(scrolled)

        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.box.set_margin_top(16)
        self.box.set_margin_bottom(16)
        self.box.set_margin_start(20)
        self.box.set_margin_end(20)
        scrolled.add_with_viewport(self.box)

        self._build_content()

    # -- Markup helpers ------------------------------------------------

    @staticmethod
    def _esc(text):
        return GLib.markup_escape_text(text)

    def _header(self, title):
        lbl = Gtk.Label()
        lbl.set_markup(
            '<span foreground="#ff9800" weight="bold" size="large">%s</span>'
            % self._esc(title)
        )
        lbl.set_xalign(0)
        self.box.pack_start(lbl, False, False, 8)

    def _body(self, text, indent=0):
        lbl = Gtk.Label()
        lbl.set_markup(self._esc(text))
        lbl.set_xalign(0)
        lbl.set_line_wrap(True)
        lbl.set_max_width_chars(58)
        lbl.set_margin_start(indent)
        self.box.pack_start(lbl, False, False, 0)

    def _muted(self, text, indent=0):
        lbl = Gtk.Label()
        lbl.set_markup('<span foreground="#888888">%s</span>' % self._esc(text))
        lbl.set_xalign(0)
        lbl.set_line_wrap(True)
        lbl.set_max_width_chars(58)
        lbl.set_margin_start(indent)
        self.box.pack_start(lbl, False, False, 2)

    def _keybind(self, key, desc):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        key_lbl = Gtk.Label()
        key_lbl.set_markup(
            '<span font_family="monospace" foreground="#666666">%s</span>'
            % self._esc(key)
        )
        key_lbl.set_xalign(0)
        key_lbl.set_width_chars(16)
        row.pack_start(key_lbl, False, False, 0)

        desc_lbl = Gtk.Label()
        desc_lbl.set_markup(self._esc(desc))
        desc_lbl.set_xalign(0)
        desc_lbl.set_line_wrap(True)
        desc_lbl.set_max_width_chars(44)
        row.pack_start(desc_lbl, True, True, 0)
        self.box.pack_start(row, False, False, 2)

    def _qa(self, question, answer):
        q = Gtk.Label()
        q.set_markup('<span weight="bold">%s</span>' % self._esc(question))
        q.set_xalign(0)
        q.set_line_wrap(True)
        q.set_margin_top(4)
        self.box.pack_start(q, False, False, 0)

        a = Gtk.Label()
        a.set_markup('<span foreground="#666666">%s</span>' % self._esc(answer))
        a.set_xalign(0)
        a.set_line_wrap(True)
        a.set_max_width_chars(54)
        a.set_margin_start(16)
        self.box.pack_start(a, False, False, 0)

    def _link(self, text, url):
        lbl = Gtk.Label()
        lbl.set_markup(
            '<a href="%s">%s</a>' % (self._esc(url), self._esc(text))
        )
        lbl.set_xalign(0)
        lbl.set_line_wrap(True)
        lbl.set_max_width_chars(58)
        self.box.pack_start(lbl, False, False, 2)

    def _separator(self):
        sep = Gtk.SeparatorMenuItem()
        self.box.pack_start(sep, False, False, 6)

    # -- Content -------------------------------------------------------

    def _build_content(self):
        # Getting Started
        self._header("Getting Started")
        self._body("1. Open the Jellyfin web interface")
        self._body("2. Find your media")
        self._body("3. Click the cast icon (\"Play on\")")
        self._body("4. Select 'Jellyfin MPV Play'")
        self._body("5. MPV opens with your media")
        self._muted("The tray icon shows connection status and now-playing info.")
        self._separator()

        # Tray Menu Controls
        self._header("Tray Menu Controls")
        self._muted("Click the tray icon to access these controls:")
        self._keybind("Pause / Resume", "Pause or resume playback")
        self._keybind("Stop", "Stop playback and close MPV")
        self._keybind("Copy Now Playing", "Copy the current title to the clipboard")
        self._keybind("Show Logs", "Open the log viewer window")
        self._keybind("Copy Log", "Copy the full log to the clipboard")
        self._keybind("Settings", "Open the settings window")
        self._keybind("About", "Show about information")
        self._keybind("Restart", "Restart the connection to Jellyfin")
        self._keybind("Quit", "Quit Jellyfin MPV Play")
        self._separator()

        # Keyboard Shortcuts (in MPV)
        self._header("Keyboard Shortcuts (in MPV)")
        self._keybind(">", "Next episode")
        self._keybind("<", "Previous episode")
        self._keybind("S", "Skip intro / outro")
        self._keybind("Media Next", "Next episode (media key)")
        self._keybind("Media Previous", "Previous episode (media key)")
        self._separator()

        # Smart Resume
        self._header("Smart Resume")
        self._body(
            "The app remembers where you left off. When you play something "
            "again, it resumes from your last position automatically."
        )
        self._muted("Use 'Play from beginning' in Jellyfin to start fresh instead.")
        self._separator()

        # Troubleshooting
        self._header("Troubleshooting")
        self._qa(
            "MPV doesn't open:",
            "Check that mpvPath is correct in Settings. "
            "Run 'mpv --version' in a terminal to verify.",
        )
        self._qa(
            "Device doesn't appear in Jellyfin:",
            "Verify the server URL, username, and password are correct.",
        )
        self._qa(
            "Black screen or no video:",
            "Check ~/.config/mpv/mpv.conf for valid 'vo' and 'hwdec' settings.",
        )
        self._qa(
            "Shortcuts not working:",
            "Custom keybinds in ~/.config/mpv/input.conf may override the defaults.",
        )
        self._separator()

        # More Info
        self._header("More Info")
        self._link(
            "GitHub: github.com/MrGameVlogger/jellyfin-mpv-play",
            "https://github.com/MrGameVlogger/jellyfin-mpv-play",
        )
        self._link(
            "Upstream: github.com/JohnGlaus/Jellyfin_mpv_play",
            "https://github.com/JohnGlaus/Jellyfin_mpv_play",
        )
        self._link("MPV: mpv.io", "https://mpv.io")
        self._link("Jellyfin: jellyfin.org", "https://jellyfin.org")

    # -- Window behaviour ----------------------------------------------

    def present(self):
        self.show_all()
        Gtk.Window.present(self)

    def _on_delete(self, *_):
        self.hide()
        return True
