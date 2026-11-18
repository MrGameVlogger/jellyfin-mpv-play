#!/usr/bin/env python3
"""Log viewer window for Jellyfin MPV Play.
Port of macapp/Sources/LogWindowController.swift for Linux/GTK3.
"""
import time

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, Pango


# Line colors keyed by marker substrings (checked in order, first match wins).
LINE_COLORS = (
    ("#cc0000", ("ERROR", "STDERR", "FATAL", "\u274c", "\u26a0\ufe0f")),
    ("#b8860b", ("WARNING", "WARN", "warn")),
    ("#007700", ("Connected", "connection established")),
    ("#cc6600", ("Playing", "Episode detected", "File loaded by MPV")),
)

DEFAULT_COLOR = "#000000"

MAX_LINES = 1000


class LogViewerWindow:
    """Window showing live shim log output with color coding."""

    def __init__(self):
        self.line_count = 0
        self.auto_scroll = True

        self.window = Gtk.Window(title="Jellyfin MPV Play - Logs")
        self.window.set_default_size(700, 500)
        self.window.set_size_request(400, 300)
        self.window.set_resizable(True)
        self.window.connect("delete-event", self._on_delete)

        vbox = Gtk.Box()
        vbox.set_orientation(Gtk.Orientation.VERTICAL)
        vbox.set_spacing(0)
        self.window.add(vbox)

        # --- Log text view in a scrolled window (fills the top area) ---
        self.scrolled = Gtk.ScrolledWindow()
        self.scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        self.scrolled.set_hexpand(True)
        self.scrolled.set_vexpand(True)
        vbox.pack_start(self.scrolled, True, True, 0)

        self.textview = Gtk.TextView()
        self.textview.set_editable(False)
        self.textview.set_cursor_visible(False)
        self.textview.set_monospace(True)
        self.textview.set_wrap_mode(Gtk.WrapMode.CHAR)
        self.textview.set_left_margin(8)
        self.textview.set_right_margin(8)
        self.textview.set_top_margin(8)
        self.textview.set_bottom_margin(8)
        self.scrolled.add(self.textview)

        self.buffer = self.textview.get_buffer()
        self._tag_names = {}
        for hex_color, _markers in LINE_COLORS:
            tag = self.buffer.create_tag(foreground=hex_color)
            self._tag_names[hex_color] = tag
        self._tag_names[DEFAULT_COLOR] = self.buffer.create_tag(foreground=DEFAULT_COLOR)

        # --- Bottom button bar ---
        bottom = Gtk.Box()
        bottom.set_orientation(Gtk.Orientation.HORIZONTAL)
        bottom.set_spacing(6)
        bottom.set_margin_top(6)
        bottom.set_margin_bottom(6)
        bottom.set_margin_start(10)
        bottom.set_margin_end(10)
        vbox.pack_start(bottom, False, False, 0)

        # Binary setting on the left (HIG); action buttons bottom-right.
        self.auto_scroll_check = Gtk.CheckButton(label="Auto-scroll")
        self.auto_scroll_check.set_active(True)
        self.auto_scroll_check.connect("toggled", self._on_toggle_auto_scroll)
        bottom.pack_start(self.auto_scroll_check, False, False, 0)

        export_button = Gtk.Button(label="Export\u2026")
        export_button.connect("clicked", lambda _b: self.export_logs())
        bottom.pack_end(export_button, False, False, 0)

        clear_button = Gtk.Button(label="Clear")
        clear_button.connect("clicked", lambda _b: self.clear_log())
        bottom.pack_end(clear_button, False, False, 0)

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def show(self):
        """Present the window (creates it lazily on first use)."""
        self.window.show_all()
        self.window.present()

    def append_log(self, line):
        """Append a timestamped, color-coded log line to the buffer."""
        timestamp = time.strftime("%H:%M:%S")
        log_line = "[{}] {}\n".format(timestamp, line)

        tag = self._color_tag_for_line(line)
        end = self.buffer.get_end_iter()
        self.buffer.insert_with_tags(end, log_line, tag)

        self.line_count += 1

        # Line cap: trim from the start once we exceed MAX_LINES.
        if self.line_count > MAX_LINES:
            start = self.buffer.get_start_iter()
            # Find the midpoint of the buffer, then the end of that line.
            total_len = self.buffer.get_char_count()
            mid = self.buffer.get_iter_at_offset(total_len // 2)
            if not mid.ends_line():
                mid.forward_to_line_end()
            mid.forward_char()
            self.buffer.delete(start, mid)
            self.line_count = self.buffer.get_line_count()

        if self.auto_scroll:
            self._scroll_to_end()

    def copy_full_log(self):
        """Copy the full buffer text to the clipboard."""
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        start, end = self.buffer.get_bounds()
        clipboard.set_text(self.buffer.get_text(start, end, True), -1)

    def export_logs(self):
        """Export the raw log text to a file chosen via a save dialog."""
        dialog = Gtk.FileChooserDialog(
            title="Export Logs",
            parent=self.window,
            action=Gtk.FileChooserAction.SAVE,
        )
        dialog.add_buttons(
            "_Cancel", Gtk.ResponseType.CANCEL,
            "_Save", Gtk.ResponseType.OK,
        )
        dialog.set_do_overwrite_confirmation(True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dialog.set_current_name("jellyfin-mpv-play-{}.log".format(stamp))

        response = dialog.run()
        if response == Gtk.ResponseType.OK:
            filename = dialog.get_filename()
            try:
                start, end = self.buffer.get_bounds()
                text = self.buffer.get_text(start, end, True)
                with open(filename, "w", encoding="utf-8") as handle:
                    handle.write(text)
            except (OSError, UnicodeError) as error:
                self._show_error_alert("Failed to export logs", str(error))
        dialog.destroy()

    def clear_log(self):
        """Clear the text buffer and reset the line counter."""
        self.buffer.set_text("")
        self.line_count = 0

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _color_tag_for_line(self, line):
        for hex_color, markers in LINE_COLORS:
            if any(marker in line for marker in markers):
                return self._tag_names[hex_color]
        return self._tag_names[DEFAULT_COLOR]

    def _scroll_to_end(self):
        end = self.buffer.get_end_iter()
        self.textview.scroll_to_iter(end, 0.0, False, 0.0, 0.0)

    def _on_delete(self, _widget, _event):
        # Hide instead of destroying (isReleasedWhenClosed = false equivalent).
        self.window.hide()
        return True

    def _on_toggle_auto_scroll(self, button):
        self.auto_scroll = button.get_active()
        if self.auto_scroll:
            self._scroll_to_end()

    def _show_error_alert(self, message, secondary):
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            modal=True,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.OK,
            text=message,
        )
        dialog.format_secondary_text(secondary)
        dialog.run()
        dialog.destroy()
