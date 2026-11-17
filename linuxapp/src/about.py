#!/usr/bin/env python3
"""About window for Jellyfin MPV Play.
Port of macapp/Sources/AboutWindowController.swift for Linux/GTK3.
"""
import os

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, GdkPixbuf

VERSION = "1.17.2"

LINKS = (
    ("GitHub", "https://github.com/MrGameVlogger/jellyfin-mpv-play"),
    ("Jellyfin", "https://jellyfin.org"),
    ("MPV", "https://mpv.io"),
)


class AboutWindow:
    """About dialog window (hidden on close, reused across shows)."""

    def __init__(self):
        self.window = Gtk.Window(title="About Jellyfin MPV Play")
        self.window.set_default_size(420, 350)
        self.window.set_resizable(False)
        self.window.set_position(Gtk.WindowPosition.CENTER)
        self.window.connect("delete-event", self._on_delete)

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        vbox.set_margin_top(16)
        vbox.set_margin_bottom(16)
        vbox.set_margin_start(20)
        vbox.set_margin_end(20)
        vbox.set_halign(Gtk.Align.CENTER)
        self.window.add(vbox)

        # --- Icon ---
        icon = self._load_icon()
        icon.set_halign(Gtk.Align.CENTER)
        vbox.pack_start(icon, False, False, 0)

        # --- Title ---
        title = Gtk.Label()
        title.set_markup('<span size="xx-large" weight="bold">Jellyfin MPV Play</span>')
        title.set_halign(Gtk.Align.CENTER)
        vbox.pack_start(title, False, False, 0)

        # --- Version ---
        version_label = Gtk.Label(label="Version {}".format(VERSION))
        version_label.set_halign(Gtk.Align.CENTER)
        version_label.set_name("about-version")
        style = version_label.get_style_context()
        style.add_class(Gtk.STYLE_CLASS_DIM_LABEL)
        vbox.pack_start(version_label, False, False, 0)

        vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)

        # --- Description ---
        desc = Gtk.Label(
            label=(
                "A native Linux tray application for Jellyfin media playback with MPV.\n"
                "Fork of JohnGlaus/Jellyfin_mpv_play\n"
                "MIT License"
            )
        )
        desc.set_halign(Gtk.Align.CENTER)
        desc.set_justify(Gtk.Justification.CENTER)
        desc.get_style_context().add_class(Gtk.STYLE_CLASS_DIM_LABEL)
        vbox.pack_start(desc, False, False, 0)

        vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)

        # --- Link buttons ---
        links_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        links_box.set_halign(Gtk.Align.CENTER)
        for label, url in LINKS:
            button = Gtk.LinkButton.new_with_label(url, label)
            links_box.pack_start(button, False, False, 0)
        vbox.pack_start(links_box, False, False, 0)

        vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)

        # --- Copyright ---
        copyright_label = Gtk.Label(
            label="Copyright \u00a9 2026 MrGameVlogger. MIT License"
        )
        copyright_label.set_halign(Gtk.Align.CENTER)
        copyright_label.get_style_context().add_class(Gtk.STYLE_CLASS_DIM_LABEL)
        markup = '<span size="small" foreground="#888888">{}</span>'.format(
            GLib.markup_escape_text(copyright_label.get_text(), -1)
        )
        copyright_label.set_markup(markup)
        vbox.pack_start(copyright_label, False, False, 0)

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def present(self):
        """Show the window and bring it to the front."""
        self.window.show_all()
        self.window.present()

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _load_icon(self):
        """Load the app icon SVG; fall back to a stock image on failure."""
        icon_path = os.path.join(
            os.path.dirname(__file__), "..", "resources", "icon-light.svg"
        )
        image = Gtk.Image()
        try:
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(icon_path, 60, 60)
            image.set_from_pixbuf(pixbuf)
        except Exception:
            image = Gtk.Image.new_from_icon_name("help-about", Gtk.IconSize.DIALOG)
            image.set_pixel_size(60)
        return image

    def _on_delete(self, _widget, _event):
        # Hide instead of destroying (isReleasedWhenClosed = false equivalent).
        self.window.hide()
        return True
